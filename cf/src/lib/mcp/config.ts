//=====================================================================
// mcp/config.ts — MCP adapter configuration (fail-closed, allow-listed).
//
// JARVIS speaks MCP in TWO directions (the "USB-C port" decision — MCP is
// an ADAPTER, the brain stays home):
//   1. SERVER — POST/GET /mcp exposes Jarvis tools to external MCP hosts,
//      authenticated by MCP_ACCESS_TOKEN (see mcp/server.ts).
//   2. CLIENT — the /mcp command invokes tools on EXTERNAL MCP servers the
//      owner allow-lists in the MCP_SERVERS secret (see mcp/client.ts).
//
// Security posture (mirrors vercel.ts / e2b.ts): EVERYTHING FAILS CLOSED.
// A bad/absent MCP_SERVERS value configures ZERO servers; an invalid entry
// is dropped, never half-accepted; aliases are validated identifiers; URLs
// must be https://; the per-server `tools` field is an optional
// DENY-BY-DEFAULT allow-list. No network is ever attempted for a
// disallowed alias or tool.
//=====================================================================

import type { Env } from "../db";

export const MCP_SERVER_VERSION = "jarvis-2.1.0";
// Per-call wall-clock budget for an outbound MCP tool invocation (bounded,
// like every other fetch in this worker). Per-server timeoutMs overrides.
export const MCP_DEFAULT_TIMEOUT_MS = 20000;
// Allow-list size cap — the client surface stays tiny by construction.
export const MCP_MAX_ALIASES = 8;
export const MCP_TOOL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;
export const MCP_ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const MCP_MEMORY_TYPES = ["fact", "decision", "context", "person"] as const;
export const MCP_ASK_TEXT_CAP = 4000;
export const MCP_ASK_TEXT_CAP_MSG = `Pesan melebihi ${MCP_ASK_TEXT_CAP} karakter — minta dipecah.`;
export const MCP_MEMORY_CONTENT_CAP = 2000;

/** One allow-listed external MCP server (parsed from the MCP_SERVERS secret). */
export interface McpServerEntry {
  alias: string;
  url: string;
  token?: string;
  /** Optional tool allow-list; when present, tools outside it are DENIED. */
  tools?: string[];
  /** Optional per-server timeout override (ms), clamped 1s..30s. */
  timeoutMs?: number;
}

/** Parse the MCP_SERVERS secret into an allow-list. Fail-closed: anything
 *  malformed configures ZERO servers; invalid entries are dropped never
 *  half-accepted. Never throws. */
export function parseMcpServers(raw: string | undefined | null): McpServerEntry[] {
  if (!raw || !raw.trim()) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: McpServerEntry[] = [];
  for (const item of data) {
    if (out.length >= MCP_MAX_ALIASES) break;
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const alias = typeof rec.alias === "string" ? rec.alias.trim().toLowerCase() : "";
    const urlRaw = typeof rec.url === "string" ? rec.url.trim() : "";
    if (!MCP_ALIAS_RE.test(alias)) continue;
    if (!/^https:\/\//i.test(urlRaw)) continue;
    let url: string;
    try {
      url = new URL(urlRaw).toString();
    } catch {
      continue;
    }
    const tools = Array.isArray(rec.tools)
      ? (rec.tools as unknown[])
          .map((t) => (typeof t === "string" ? t.trim() : ""))
          .filter((t) => MCP_TOOL_NAME_RE.test(t))
          .slice(0, 64)
      : undefined;
    const token = typeof rec.token === "string" && rec.token.trim() ? rec.token : undefined;
    const timeoutMs =
      typeof rec.timeoutMs === "number" && Number.isFinite(rec.timeoutMs)
        ? Math.min(30000, Math.max(1000, Math.round(rec.timeoutMs)))
        : undefined;
    out.push({ alias, url, token, tools: tools && tools.length ? tools : undefined, timeoutMs });
  }
  return out;
}

/** The allow-listed servers for this environment (re-parsed each call; tiny). */
export function mcpServers(env: Env): McpServerEntry[] {
  return parseMcpServers(env.MCP_SERVERS);
}

/** Resolve one allow-listed server by alias (case-insensitive). Pure. */
export function resolveMcpServer(env: Env, alias: string): McpServerEntry | undefined {
  const key = alias.trim().toLowerCase();
  return mcpServers(env).find((e) => e.alias === key);
}

/** Aliases in allow-list order (for /mcp summaries). */
export function mcpAliases(env: Env): string[] {
  return mcpServers(env).map((e) => e.alias);
}

/** Master switch for the /mcp command surface (MCP_ENABLED=0 turns it off). */
export function mcpClientEnabled(env: Env): boolean {
  return (env.MCP_ENABLED ?? "1") !== "0";
}

/** Wall-clock budget for one outbound MCP call (env override, else default). */
export function mcpTimeoutMs(env: Env, fallback = MCP_DEFAULT_TIMEOUT_MS): number {
  const raw = parseInt(env.MCP_SERVER_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(raw)) return Math.min(30000, Math.max(1000, raw));
  return fallback;
}

/** True when the server-side /mcp endpoint can authenticate callers. */
export function mcpServerConfigured(env: Env): boolean {
  return Boolean(env.MCP_ACCESS_TOKEN);
}

/** Constant-time token comparison (discourages timing side channels on the
 *  shared Bearer secret). Length is intentionally revealed (standard). */
export function safeTokenEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Shorten an error into a Telegram-safe one-liner. */
export function shortErr(e: unknown, cap = 200): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.trim().slice(0, cap) || "kesalahan tidak dikenal";
}