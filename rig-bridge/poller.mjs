//=====================================================================
// poller.mjs — rig-bridge: klaim task JARVIS dan eksekusi headless.
//
// Arah: mesin lokal → worker (polling). Worker tidak pernah memanggil ke
// sini (tidak ada ingress). Satu-satunya penulisan status adalah:
//   1. POST /agent/claim  (pending → running, atomik di worker)
//   2. POST /agent/done   (running → done|failed + DM owner oleh worker)
//
// Zero dependency, Node 22+. Fail-closed: kegagalan eksekusi selalu
// dilaporkan sebagai failed (kecuali kegagalan SEBELUM klaim, yang murni
// local). Mirror ke `rig queue` best-effort, tidak pernah menggagalkan.
//=====================================================================

import { execFile, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const RESULT_CAP = 60000;
const ERROR_CAP = 3000;

function cfg() {
  const worker = (process.env.JARVIS_WORKER_URL ?? "").replace(/\/+$/, "");
  const token = process.env.JARVIS_AGENT_TOKEN ?? "";
  if (!worker) throw new Error("config: JARVIS_WORKER_URL belum diset");
  if (!token) throw new Error("config: JARVIS_AGENT_TOKEN belum diset");
  return {
    worker,
    token,
    executorCmd: (process.env.EXECUTOR_CMD ?? "codex exec").split(" ").filter(Boolean),
    pollMs: Number(process.env.POLL_INTERVAL_MS ?? 20000),
    runTimeoutMs: Number(process.env.RUN_TIMEOUT_MS ?? 18 * 60 * 1000),
    queueSeat: process.env.RIG_QUEUE_SEAT ?? "tugas-build@tugas",
    queueMirror: (process.env.RIG_QUEUE_MIRROR ?? "1") !== "0",
    host: (process.env.HOSTNAME ?? "rig-host").slice(0, 40),
  };
}

async function api(c, path, body) {
  const url = `${c.worker}${path}?token=${encodeURIComponent(c.token)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 401) throw new Error("auth: AGENT_TOKEN ditolak worker (401)");
  if (!res.ok) throw new Error(`http: ${path} → ${res.status}`);
  return res.json();
}

async function mirrorQueue(c, task) {
  if (!c.queueMirror) return;
  try {
    const dir = mkdtempSync(join(tmpdir(), "rig-bridge-"));
    const f = join(dir, `task-${task.id}.md`);
    writeFileSync(f, `# Tugas worker #${task.id} (owner ${task.owner_id})\n\n${task.task}\n`);
    await execFileAsync("rig", [
      "queue", "create",
      "--destination", c.queueSeat,
      "--body-file", f,
      "--tags", `jarvis-task:${task.id}`,
    ], { timeout: 30000 });
  } catch (e) {
    console.error(`[mirror] rig queue gagal (best-effort): ${String(e).slice(0, 160)}`);
  }
}

const LAMPIRAN_CAP = 15 * 1024 * 1024;

/** Unduh lampiran <dlurl:...> (cermin workflow jarvis-delegate.yml): URL
 *  worker /dl/<uuid> (unguessable + TTL 30 mnt). Strip marker agar secret
 *  per-file tidak sampai ke prompt/log; append catatan path agar eksekutor
 *  tahu apa yang dibaca. Gagal unduh → lanjut tanpa file (fail-open
 *  parsial, dicatat). Tidak pernah throw. */
async function fetchLampiran(taskText) {
  const m = taskText.match(/<dlurl:([^>]*)>/);
  if (!m) return { text: taskText, file: null };
  const url = m[1];
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > LAMPIRAN_CAP) throw new Error(`ukuran ${buf.length}`);
    const ext = (taskText.match(/lampiran *"[^"]*\.([A-Za-z0-9]{1,5})"/) ?? [])[1] ?? "bin";
    const dir = mkdtempSync(join(tmpdir(), "rig-bridge-dl-"));
    const file = join(dir, `lampiran.${ext}`);
    writeFileSync(file, buf);
    console.log(`[lampiran] ${buf.length} byte → ${file}`);
    const text = taskText.replace(/<dlurl:[^>]*>/, "") +
      `\n[LAMPIRAN] Baca berkas ${file} — itulah lampiran yang harus dianalisis. Jangan hapus berkasnya.`;
    return { text, file };
  } catch (e) {
    console.error(`[lampiran] unduh gagal (lanjut tanpa file): ${String(e).slice(0, 140)}`);
    return { text: taskText.replace(/<dlurl:[^>]*>/, ""), file: null };
  }
}

function runHeadless(c, taskText) {  const [cmd, ...args] = c.executorCmd;
  const prompt = [
    "Kamu adalah eksekutor tugas JARVIS. Kerjakan instruksi di bawah dan",
    "tulis LAPORAN AKHIR saja (Bahasa Indonesia, fakta vs analisis dipisah",
    "bila relevan). Jangan sebut kamu adalah model tertentu.",
    "",
    "=== TUGAS ===",
    taskText,
  ].join("\n");
  return new Promise((resolve) => {
    const p = spawn(cmd, [...args, prompt], { timeout: c.runTimeoutMs, shell: false });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", (e) => resolve({ ok: false, output: "", error: `spawn: ${String(e).slice(0, 300)}` }));
    p.on("close", (code) => resolve({
      ok: code === 0,
      output: out,
      error: code === 0 ? "" : `exit ${code}: ${err.slice(0, 500)}`.trim(),
    }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cycle(c) {
  // 1. Klaim — satu-satunya transisi pending→running yang sah.
  const claim = await api(c, "/agent/claim", {
    executor: "rig",
    run_id: `rig:${c.host}:${Date.now()}`,
  });
  if (!claim?.ok || claim.empty || !claim.task) return "empty";
  const task = claim.task;
  console.log(`[claim] #${task.id} owner=${task.owner_id} run_id=${task.run_id ?? "-"}`);
  await mirrorQueue(c, task);

  // 2. Eksekusi headless (cermin `opencode run` di runner GH).
  let result = "";
  let status = "done";
  let error = "";
  try {
    const withFile = await fetchLampiran(task.task);
    const r = await runHeadless(c, withFile.text);
    if (r.ok) {
      result = r.output.trim().slice(0, RESULT_CAP);
      if (!result) {
        status = "failed";
        error = "eksekutor selesai tanpa output";
      }
    } else {
      status = "failed";
      error = (r.error || r.output).trim().slice(0, ERROR_CAP) || "eksekutor gagal tanpa pesan";
    }
  } catch (e) {
    status = "failed";
    error = `poller: ${String(e).slice(0, 300)}`;
  }

  // 3. Lapor — worker yang memfinalisasi + DM owner (first-win, anti-replay).
  await api(c, "/agent/done", {
    task_id: task.id,
    status,
    result,
    error,
    artifact_url: "",
  });
  console.log(`[${status}] #${task.id} dilaporkan`);
  return status;
}

async function main() {
  const once = process.argv.includes("--once");
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("pakai: JARVIS_WORKER_URL=... JARVIS_AGENT_TOKEN=... node poller.mjs [--once]");
    return;
  }
  const c = cfg();
  for (;;) {
    try {
      const r = await cycle(c);
      if (once) return;
      if (r === "empty") await sleep(Number.isFinite(c.pollMs) && c.pollMs > 0 ? c.pollMs : 20000);
    } catch (e) {
      // Gagal SEBELUM klaim (jaringan/auth/config): jangan lapor done —
      // task tetap pending di worker. Backoff lalu coba lagi.
      console.error(`[loop] ${String(e).slice(0, 220)}`);
      if (once) {
        console.error("[once] berhenti karena error sebelum klaim");
        process.exitCode = 1;
        return;
      }
      await sleep(30000);
    }
  }
}

main();
