//=====================================================================
// mcp/server.ts — JARVIS AS AN MCP SERVER (adapter layer, not a brain
// replacement). Exposes the owner's brain as standard tools so any MCP
// host (Claude, other agents, dashboards) drives JARVIS through the SAME
// single door as Telegram — processIntelligence(env, owner, text) — with
// the same owner framing. MCP stays an ADAPTER: routing, rails, budget
// and sovereignty remain in the brain, exactly as the architecture
// comparison concluded.
//
// Mounted at /mcp with Bearer auth (MCP_ACCESS_TOKEN). Fail-closed:
//   * no token configured   → 503 (endpoint refuses to exist)
//   * missing/wrong token   → 401
//   * a tool that throws    → answered as isError, never crashes the exchange
//
// The per-request-factory model (createMcpHandler → McpServerFactory) is
// REQUIRED by the SDK's security posture: every request gets a fresh
// McpServer, nothing is shared across requests. Legacy (2025-era) traffic
// is served by the stateless fallback so old hosts still work.
//=====================================================================

import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import type { Env } from "../db";
import { searchMemory, rememberMemorySmart } from "../db";
import { processIntelligence } from "../intelligence";
import { connectorsStatus } from "../vercel";
import {
  MCP_SERVER_VERSION,
  MCP_MEMORY_TYPES,
  MCP_ASK_TEXT_CAP,
  MCP_ASK_TEXT_CAP_MSG,
  MCP_MEMORY_CONTENT_CAP,
  safeTokenEqual,
  shortErr,
} from "./config";

// Plain JSON-Schema → StandardSchema (no zod dependency; the SDK validates).
const NO_INPUT = fromJsonSchema({ type: "object", properties: {} });

interface JarvisToolArgs {
  text?: unknown;
  query?: unknown;
  k?: unknown;
  content?: unknown;
  type?: unknown;
}

/** Tool-level failure: the run failed but the exchange stays healthy. */
function toolError(text: string): { content: [{ type: "text"; text: string }]; isError: true } {
  return { content: [{ type: "text", text }], isError: true };
}

/** Build one McpServer instance exposing the owner's brain as MCP tools.
 *  Pure constructor — closing over nothing but `env`. Used BOTH by the HTTP
 *  handler (per-request factory) and by InMemoryTransport tests. */
export function buildJarvisMcpServer(env: Env): McpServer {
  const owner = Number(env.OWNER_TELEGRAM_ID || 0);
  const server = new McpServer({ name: "jarvis", version: MCP_SERVER_VERSION });

  server.registerTool(
    "jarvis_ask",
    {
      title: "Tanya otak JARVIS",
      description:
        "Kirim pesan sebagai PEMILIK ke otak JARVIS (proses intelligence penuh: intent, pencarian, LLM cascade, output rails). Terima teks apa pun; balasan adalah jawaban akhir yang sudah selesai. Setara dengan mengetik di Telegram sebagai pemilik.",
      inputSchema: fromJsonSchema({
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      }),
    },
    async (args: unknown) => {
      const a = args as JarvisToolArgs;
      const text = typeof a.text === "string" ? a.text.trim() : "";
      if (!text) return toolError("Parameter 'text' wajib diisi.");
      if (text.length > MCP_ASK_TEXT_CAP) return toolError(MCP_ASK_TEXT_CAP_MSG);
      try {
        const reply = await processIntelligence(env, owner, text);
        return {
          content: [{ type: "text", text: (reply?.text ?? "(tanpa balasan)").slice(0, 6000) }],
        };
      } catch (e) {
        return toolError(`Otak gagal: ${shortErr(e)}`);
      }
    },
  );

  server.registerTool(
    "memory_search",
    {
      title: "Cari memori JARVIS",
      description:
        "Cari ingatan persisten (BM25 FTS5 + semantic Vectorize): fakta, keputusan, konteks, orang. Parameter 'query' wajib; 'k' opsional (1..10, default 5).",
      inputSchema: fromJsonSchema({
        type: "object",
        properties: { query: { type: "string" }, k: { type: "number" } },
        required: ["query"],
      }),
    },
    async (args: unknown) => {
      const a = args as JarvisToolArgs;
      const query = typeof a.query === "string" ? a.query.trim() : "";
      if (!query) return toolError("Parameter 'query' wajib diisi.");
      const k = Math.min(10, Math.max(1, Number(a.k) || 5));
      const rows = await searchMemory(env, query, k);
      if (!rows.length) {
        return { content: [{ type: "text", text: "Tidak ada memori yang cocok." }] };
      }
      const lines = rows.map(
        (r, i) => `[${i + 1}] (${r.type})\n${r.content.slice(0, 300)}${r.content.length > 300 ? "…" : ""}`,
      );
      return { content: [{ type: "text", text: `Hasil pencarian: ${rows.length}\n\n${lines.join("\n\n")}` }] };
    },
  );

  server.registerTool(
    "memory_save",
    {
      title: "Simpan memori JARVIS",
      description:
        "Simpan ingatan persisten (auto-importance). Tipe opsional: fact | decision | context | person (default fact). 'content' wajib, maks 2000 karakter.",
      inputSchema: fromJsonSchema({
        type: "object",
        properties: { content: { type: "string" }, type: { type: "string" } },
        required: ["content"],
      }),
    },
    async (args: unknown) => {
      const a = args as JarvisToolArgs;
      const content = typeof a.content === "string" ? a.content.trim() : "";
      if (!content) return toolError("Parameter 'content' wajib diisi.");
      if (content.length > MCP_MEMORY_CONTENT_CAP) {
        return toolError(`Konten melebihi ${MCP_MEMORY_CONTENT_CAP} karakter.`);
      }
      const want = typeof a.type === "string" ? a.type.trim().toLowerCase() : "fact";
      const type = (MCP_MEMORY_TYPES as readonly string[]).includes(want) ? (want as (typeof MCP_MEMORY_TYPES)[number]) : "fact";
      await rememberMemorySmart(env, content, { type, source: "mcp" });
      return { content: [{ type: "text", text: `✅ Memori tersimpan (${type}).` }] };
    },
  );

  server.registerTool(
    "connectors_status",
    {
      title: "Status konektor eksternal",
      description: "Status lapisan konektor pinjaman (Vercel Connector untuk Figma/Notion, dll). Read-only, tanpa efek samping.",
      inputSchema: NO_INPUT,
    },
    async () => ({
      content: [{ type: "text", text: connectorsStatus(env).slice(0, 2000) }],
    }),
  );

  server.registerTool(
    "jarvis_status",
    {
      title: "Status JARVIS",
      description: "Status adaptor JARVIS (owner, environment, capacity flags). Read-only; tidak menyentuh D1/AI apa pun.",
      inputSchema: NO_INPUT,
    },
    async () => {
      const lines = [
        "🤖 *JARVIS — status adapter*",
        `- Owner: ${owner ? String(owner) : "TIDAK DIKONFIGURASI"}`,
        `- App: jarvis-sovereign (v2 MCP adapter)`,
        `- Env: ${env.APP_ENV ?? "dev"}`,
        `- Worker: ${env.WORKER_URL ?? "-"}`,
        `- Telegram secret: ${env.TELEGRAM_SECRET ? "terpasang" : "tidak terpasang"}`,
        `- Vercel Connector: ${env.VERCEL_CONNECTOR_URL ? "terpasang" : "tidak terpasang"}`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  return server;
}

/** HTTP face for the /mcp endpoint: Bearer auth + per-request McpServer.
 *  Fail-closed ordering: 503 (unconfigured) → 401 (bad token) → serve. */
export async function handleMcpRequest(request: Request, env: Env): Promise<Response> {
  const token = env.MCP_ACCESS_TOKEN;
  if (!token) {
    return Response.json(
      { ok: false, error: "MCP endpoint nonaktif (MCP_ACCESS_TOKEN belum dipasang di Worker)." },
      { status: 503 },
    );
  }
  const authz = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(authz);
  if (!m || !safeTokenEqual(m[1], token)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const handler = createMcpHandler(
    () => buildJarvisMcpServer(env),
    {
      legacy: "stateless",
      maxRequestBodySize: 256 * 1024,
      onerror: (e) => console.error("[mcp server]", e.message),
    },
  );
  return handler.fetch(request);
}