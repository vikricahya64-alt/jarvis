//=====================================================================
// mcp/client.ts — JARVIS AS AN MCP CLIENT (adapter layer). The /mcp command
// invokes a tool on an EXTERNAL, allow-listed MCP server and DMs the
// output — the modern replacement for hand-rolled per-SaaS connectors.
//
// Fail-closed rails (mirror vercel.ts / e2b.ts contract):
//   * unknown alias       → rejected BEFORE any network
//   * tool not in per-server allow-list → rejected BEFORE any network
//   * invalid tool name / invalid JSON args → rejected BEFORE any network
//   * network connect/handshake/call failures → graceful error text
//   * every outbound fetch is bounded (wall-clock timeout + the SDK's own
//     per-request abort via the injected fetch).
//
// The SDK client is behind a tiny transport seam (McpChannelFactory) so the
// command logic is unit-tested over InMemoryTransport with zero network.
//=====================================================================

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Env } from "../db";
import {
  MCP_TOOL_NAME_RE,
  mcpClientEnabled,
  mcpServers,
  mcpTimeoutMs,
  resolveMcpServer,
  shortErr,
  type McpServerEntry,
} from "./config";

export { mcpClientEnabled } from "./config";

/** Structural subset of an MCP tool result (SDK objects satisfy it). */
export interface McpCallableResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

/** One opened, bounded channel to an allow-listed server. */
export interface McpCallableChannel {
  listTools(): Promise<string[]>;
  callTool(name: string, args: unknown): Promise<McpCallableResult>;
  close(): Promise<void>;
}

/** Transport seam — injectable for tests (InMemoryTransport), default = live. */
export type McpChannelFactory = (entry: McpServerEntry, env: Env) => Promise<McpCallableChannel>;

export interface McpCallOutcome {
  ok: boolean;
  text?: string;
  error?: string;
}

export interface McpToolListOutcome {
  ok: boolean;
  tools?: string[];
  error?: string;
}

/** Bounded fetch: every request aborts after the wall-clock budget, and the
 *  abort propagates to the SDK's own in-flight fetch (we take over the
 *  signal, losing our own cancel path — acceptable for a one-shot call). */
function boundedFetch(timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Default channel: real SDK client over Streamable HTTP (2026-07-28 with
 *  auto probe, legacy fallback). Token attached when the entry carries one;
 *  otherwise the connection is unauthenticated (URL itself is a secret). */
async function defaultChannel(entry: McpServerEntry, env: Env): Promise<McpCallableChannel> {
  const client = new Client(
    { name: "jarvis", version: "2.1.0" },
    { versionNegotiation: { mode: "auto" }, listMaxPages: 2 },
  );
  const timeoutMs = entry.timeoutMs ?? mcpTimeoutMs(env);
  const transport = new StreamableHTTPClientTransport(new URL(entry.url), {
    ...(entry.token ? { authProvider: { token: async () => `${entry.token}` } } : {}),
    fetch: boundedFetch(timeoutMs),
  });
  await client.connect(transport);
  let closed = false;
  const teardown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      if (typeof (transport as { terminateSession?: () => Promise<void> }).terminateSession === "function") {
        await (transport as { terminateSession: () => Promise<void> }).terminateSession();
      }
    } catch { /* best-effort */ }
    try {
      await client.close();
    } catch { /* best-effort */ }
  };
  return {
    async listTools() {
      const { tools } = await client.listTools();
      return tools.map((t) => t.name);
    },
    async callTool(name, args) {
      return (await client.callTool({ name, arguments: args as Record<string, unknown> })) as McpCallableResult;
    },
    async close() {
      await teardown();
    },
  };
}

/** Coalesce text content blocks from a tool result into one string. */
function resultText(result: McpCallableResult): string {
  const blocks = result?.content ?? [];
  return blocks
    .map((b) => (b && typeof b.text === "string" && (b.type === "text" || !b.type) ? b.text : ""))
    .filter((s) => s.length > 0)
    .join("\n");
}

function cap(text: string, n: number): string {
  const t = text ?? "";
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** Invoke one tool on one allow-listed MCP server. Never throws. */
export async function mcpCallTool(
  env: Env,
  alias: string,
  toolName: string,
  argsJson: string,
  factory: McpChannelFactory = defaultChannel,
): Promise<McpCallOutcome> {
  if (!mcpClientEnabled(env)) {
    return { ok: false, error: "Perintah /mcp dinonaktifkan (MCP_ENABLED=0)." };
  }
  const entry = resolveMcpServer(env, alias);
  if (!entry) {
    return { ok: false, error: `Server MCP "${alias}" tidak ada di allow-list MCP_SERVERS.` };
  }
  const name = toolName.trim();
  if (!MCP_TOOL_NAME_RE.test(name)) {
    return { ok: false, error: "Nama tool tidak valid." };
  }
  if (entry.tools && !entry.tools.includes(name)) {
    return { ok: false, error: `Tool "${name}" tidak diizinkan pada "${alias}" (daftar MCP_SERVERS.tools).` };
  }
  let args: unknown;
  try {
    args = argsJson.trim() ? JSON.parse(argsJson) : {};
  } catch {
    return { ok: false, error: 'Argumen bukan JSON valid. Contoh: {"query":"halo"}' };
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { ok: false, error: "Argumen harus berupa objek JSON." };
  }
  let channel: McpCallableChannel;
  try {
    channel = await factory(entry, env);
  } catch (e) {
    return { ok: false, error: `Koneksi ke "${alias}" gagal: ${shortErr(e)}` };
  }
  try {
    const names = await channel.listTools();
    if (!names.includes(name)) {
      const available = names.slice(0, 15).join(", ");
      return {
        ok: false,
        error: `Tool "${name}" tidak tersedia di "${alias}".${available ? ` (tersedia: ${available})` : ""}`,
      };
    }
    const result = await channel.callTool(name, args);
    const text = resultText(result);
    if (result.isError) {
      return { ok: false, error: cap(text || "Tool melaporkan kegagalan.", 1500) };
    }
    return { ok: true, text: cap(text || "(tanpa output dari tool)", 3500) };
  } catch (e) {
    return { ok: false, error: `Panggilan tool gagal di "${alias}": ${shortErr(e)}` };
  } finally {
    try {
      await channel.close();
    } catch { /* best-effort */ }
  }
}

/** List the names a server actually advertises (for /mcp list). Never throws. */
export async function mcpLiveToolNames(
  env: Env,
  alias: string,
  factory: McpChannelFactory = defaultChannel,
): Promise<McpToolListOutcome> {
  if (!mcpClientEnabled(env)) {
    return { ok: false, error: "Perintah /mcp dinonaktifkan (MCP_ENABLED=0)." };
  }
  const entry = resolveMcpServer(env, alias);
  if (!entry) {
    return { ok: false, error: `Server MCP "${alias}" tidak ada di allow-list MCP_SERVERS.` };
  }
  try {
    const channel = await factory(entry, env);
    try {
      const tools = await channel.listTools();
      return { ok: true, tools };
    } finally {
      await channel.close().catch(() => {});
    }
  } catch (e) {
    return { ok: false, error: `Tidak bisa membaca tool "${alias}": ${shortErr(e)}` };
  }
}

/** /mcp summary line (no network — configuration only). */
export function mcpCommandSummary(env: Env): string {
  const serverOn = Boolean(env.MCP_ACCESS_TOKEN);
  const entries = mcpServers(env);
  const lines = [
    "🔌 *MCP — adapter dua arah*",
    "",
    `• Endpoint server (/mcp): ${serverOn ? "aktif (token terpasang)" : "nonaktif — pasang MCP_ACCESS_TOKEN"}`,
  ];
  if ((env.MCP_ENABLED ?? "1") === "0") {
    lines.push("• Perintah /mcp: dinonaktifkan (MCP_ENABLED=0)");
  }
  if (!entries.length) {
    lines.push("• Klien: belum ada server di allow-list MCP_SERVERS.");
  } else {
    lines.push(`• Klien: ${entries.length} server terdaftar:`);
    for (const e of entries) {
      const host = e.url.replace(/^https:\/\//i, "").slice(0, 40);
      const toolTag = e.tools ? ` [tools: ${e.tools.join(", ")}]` : "";
      lines.push(`  — *${e.alias}* \`${host}\`${toolTag}`);
    }
  }
  lines.push("", "Pakai: `/mcp <alias> <tool> <json>` · `/mcp list <alias>`.");
  return lines.join("\n");
}