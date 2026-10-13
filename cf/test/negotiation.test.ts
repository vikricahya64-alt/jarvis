//=====================================================================
// negotiation.test.ts — single-pass router /tugas (tanpa LLM/jaringan).
// Run: npm run test:nego
//
// Mencakup fungsi murni + jalur fail-closed tanpa model:
//  - parseRouterReply: kontrak JENIS:/ISI: ketat; prosa/model-ngawur → null
//  - isQuestionLine: hanya baris interogatif lolos (kasus Q1-rangkuman)
//  - isVagueTask: "pilih opsi tindakan yang tepat" → vague; tugas aksi → tidak
//  - compileDeterministic: tempel apa adanya, tanpa tebakan baru
//  - routeTaskInput jalur vague: tanpa menyentuh llmRespond (env kosong)
// Jalur model (callRouter/answerPending/refineFinal) butuh LLM → diuji
// lewat live Telegram, bukan di sini (konvensi repo).
//=====================================================================

import assert from "node:assert";
import {
  parseRouterReply, isQuestionLine, isVagueTask, compileDeterministic,
  routeTaskInput, VAGUE_TASK_QUESTION,
} from "../src/lib/negotiation";

function testParseRouterReply() {
  const perintah = parseRouterReply("JENIS: PERINTAH\nISI: Riset harga emas hari ini, tulis ringkasan markdown.");
  assert.deepStrictEqual(perintah, {
    kind: "perintah",
    instruksi: "Riset harga emas hari ini, tulis ringkasan markdown.",
  }, "perintah valid");

  const tanya = parseRouterReply("JENIS: PERTANYAAN\nISI: Output akhirnya mau dalam bentuk apa?");
  assert.deepStrictEqual(tanya, {
    kind: "pertanyaan",
    tanya: "Output akhirnya mau dalam bentuk apa?",
  }, "pertanyaan valid");

  // Kasus bug live: model mengembalikan rangkuman prosa sebagai "pertanyaan".
  const ngawur = parseRouterReply(
    "JENIS: PERTANYAAN\nISI: Berikut rangkuman lengkap tentang bekerja remote yang mencakup tantangan utama",
  );
  assert.strictEqual(ngawur, null, "prosa non-interogatif DITOLAK");

  assert.strictEqual(parseRouterReply("halo, apa kabar"), null, "tanpa kontrak → null");
  assert.strictEqual(parseRouterReply("JENIS: BINGUNG\nISI: sesuatu yang cukup panjang di sini"), null, "JENIS asing → null");
  assert.strictEqual(parseRouterReply("JENIS: PERINTAH\nISI: pendek"), null, "ISI <10 char → null");
  assert.strictEqual(parseRouterReply("JENIS: PERINTAH"), null, "tanpa ISI → null");
}

function testIsQuestionLine() {
  assert.strictEqual(
    isQuestionLine("Berikut rangkuman lengkap tentang bekerja remote yang mencakup tantangan utama"),
    false, "pernyataan BUKAN pertanyaan",
  );
  assert.strictEqual(isQuestionLine("Output akhirnya mau dalam bentuk apa?"), true, "? lolos");
  assert.strictEqual(isQuestionLine("Sebutkan format output yang kamu mau"), true, "kata tanya awal lolos");
  assert.strictEqual(isQuestionLine("pendek?"), false, "terlalu pendek ditolak");
  assert.strictEqual(isQuestionLine("x".repeat(201) + "?"), false, "terlalu panjang ditolak");
}

function testIsVagueTask() {
  assert.strictEqual(isVagueTask("pilih opsi tindakan yang tepat"), true, "kasus live → vague");
  assert.strictEqual(isVagueTask("tolong"), true, "tanpa aksi → vague");
  assert.strictEqual(isVagueTask(""), true, "kosong → vague");
  assert.strictEqual(isVagueTask("riset harga emas hari ini"), false, "ada kata kerja → tidak vague");
  assert.strictEqual(isVagueTask("buatkan laporan markdown"), false, "ada kata kerja → tidak vague");
  assert.strictEqual(isVagueTask("berapa harga emas hari ini?"), false, "kalimat tanya → tidak vague");
}

function testCompileDeterministic() {
  const out = compileDeterministic("riset emas", "Output seperti apa?", "markdown, 1 halaman");
  assert.ok(out.startsWith("riset emas"), "tugas dipertahankan verbatim");
  assert.ok(out.includes("markdown, 1 halaman"), "jawaban ditempel");
  assert.strictEqual(compileDeterministic("riset emas", "Q?", ""), "riset emas", "jawaban kosong → tugas saja");
}

async function testVagueBypass() {
  // Jalur vague TAK BOLEH menyentuh llmRespond: env kosong (tanpa key apa
  // pun) harus tetap mengembalikan pertanyaan baku — bukti tanpa network.
  const r = await routeTaskInput({} as never, 1, "pilih opsi tindakan yang tepat");
  assert.deepStrictEqual(r, { kind: "pertanyaan", tanya: VAGUE_TASK_QUESTION }, "vague → pertanyaan baku, tanpa LLM");
}

async function main() {
  testParseRouterReply();
  testIsQuestionLine();
  testIsVagueTask();
  testCompileDeterministic();
  await testVagueBypass();
  console.log("NEGOTIATION TESTS PASSED");
}

main().catch((e) => {
  console.error("NEGOTIATION TEST FAILED:", e);
  process.exit(1);
});
