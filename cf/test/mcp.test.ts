//=====================================================================
// mcp.test.ts — MCP ADAPTER TESTS (both directions + fail-closed rails).
// Run: npm run test:mcp
//
// Covers the two-way MCP decision (Jarvis as MCP server AND client):
//   1. Config parsing — fail-closed allow-list (MCP_SERVERS secret).
//   2. Server direction — /mcp Bearer auth (503/401) + tool registry
//      round-trip over the REAL SDK protocol via InMemoryTransport.
//   3. Client direction — /mcp command rails (unknown alias, allow-list
//      deny, bad JSON) denied BEFORE any network, with a network-seam
//      factory that never leaves the process.
//=====================================================================

import assert from "node:assert";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  parseMcpServers, resolveMcpServer, mcpServers, mcpClientEnabled, mcpTimeoutMs,
} from "../src/lib/mcp/config";
import { buildJarvisMcpServer, handleMcpRequest } from "../src/lib/mcp/server";
import {
  mcpCallTool, mcpLiveToolNames, mcpCommandSummary,
} from "../src/lib/mcp/client";
import type { McpServerEntry, McpChannelFactory, McpCallableResult } from "../src/lib/mcp/client";
import type { Env } from "../src/lib/db";

/** Minimal Env for config/network-free tests. */
function envOf(extra: Partial<Env> = {}): Env {
  return { OWNER_TELEGRAM_ID: "123", ...extra } as unknown as Env;
}

function testConfig() {
  // Fail-closed parsing: anything malformed configures ZERO servers.
  assert.deepStrictEqual(parseMcpServers(undefined), []);
  assert.deepStrictEqual(parseMcpServers(""), []);
  assert.deepStrictEqual(parseMcpServers("not json"), []);
  assert.deepStrictEqual(parseMcpServers("[]"), []);
  assert.deepStrictEqual(parseMcpServers(JSON.stringify({ not: "array" })), []);

  // Invalid entries are dropped, never half-accepted.
  const mixed = JSON.stringify([
    { alias: "x", url: "http://plain.example/mcp" },        // http → rejected
    { alias: "Bad Alias!", url: "https://ok.example/mcp" }, // alias regex → rejected
    { alias: "ok", url: "https://server.example/mcp/", tools: ["ok_tool", "-bad", "2x", ""], timeoutMs: 999999 },
  ]);
  const parsed = parseMcpServers(mixed);
  assert.strictEqual(parsed.length, 1, "only the valid entry survives");
  assert.strictEqual(parsed[0].alias, "ok");
  assert.ok(parsed[0].url.endsWith("server.example/mcp/"), "URL normalized (trailing slash kept)");
  assert.deepStrictEqual(parsed[0].tools, ["ok_tool"], "tools allow-list filtered");
  assert.strictEqual(parsed[0].timeoutMs, 30000, "timeoutMs clamped to 30s");

  // Alias normalization (lowercased) + allow-list cap.
  const upper = parseMcpServers(JSON.stringify([{ alias: "GitHub", url: "https://gh.example/mcp" }]));
  assert.strictEqual(upper[0].alias, "github", "alias normalized to lowercase");
  const many = Array.from({ length: 12 }, (_, i) => ({ alias: `s${i}`, url: "https://s.example/mcp" }));
  assert.strictEqual(parseMcpServers(JSON.stringify(many)).length, 8, "allow-list capped at 8");

  // resolveMcpServer case-insensitive; unknown → undefined (pure, no network).
  const env = envOf({ MCP_SERVERS: JSON.stringify([{ alias: "A", url: "https://a.example/mcp" }]) });
  assert.ok(resolveMcpServer(env, "A"), "resolve by exact alias");
  assert.ok(resolveMcpServer(env, "a"), "resolve case-insensitive");
  assert.strictEqual(resolveMcpServer(env, "nope"), undefined, "unknown alias → undefined");
  assert.deepStrictEqual(mcpServers(env).map((s) => s.alias), ["a"]);

  // Switches + timeout defaulting.
  assert.strictEqual(mcpClientEnabled(envOf()), true, "client on by default");
  assert.strictEqual(mcpClientEnabled(envOf({ MCP_ENABLED: "0" })), false, "MCP_ENABLED=0 turns it off");
  assert.strictEqual(mcpTimeoutMs(envOf()), 20000, "default timeout");
  assert.strictEqual(mcpTimeoutMs(envOf({ MCP_SERVER_TIMEOUT_MS: "7000" })), 7000);
  assert.strictEqual(mcpTimeoutMs(envOf({ MCP_SERVER_TIMEOUT_MS: "999999" })), 30000, "clamped high");
}

async function testServerAuth() {
  const url = "https://jarvis.example/mcp";
  // Unconfigured → 503 (endpoint refuses to exist).
  const unconf = await handleMcpRequest(new Request(url, { method: "POST" }), envOf());
  assert.strictEqual(unconf.status, 503, "no MCP_ACCESS_TOKEN → 503");
  assert.ok((await unconf.text()).includes("MCP_ACCESS_TOKEN"), "503 explains the missing secret");

  const env = envOf({ MCP_ACCESS_TOKEN: "sekret" });
  // Missing token → 401.
  const noAuth = await handleMcpRequest(new Request(url, { method: "POST" }), env);
  assert.strictEqual(noAuth.status, 401, "no bearer → 401");
  // Wrong token → 401.
  const bad = await handleMcpRequest(
    new Request(url, { method: "POST", headers: { authorization: "Bearer salah" } }),
    env,
  );
  assert.strictEqual(bad.status, 401, "wrong bearer → 401");
  // Correct token → served (whatever the MCP exchange answers, never auth 401/503).
  const ok = await handleMcpRequest(
    new Request(url, { method: "POST", headers: { authorization: "Bearer sekret" }, body: "{}" }),
    env,
  );
  assert.notStrictEqual(ok.status, 401);
  assert.notStrictEqual(ok.status, 503);
}

/** Tool registry + two env-only tools over the REAL SDK protocol (in-process). */
async function testServerToolsRoundTrip() {
  const env = envOf({ APP_ENV: "test", MCP_ACCESS_TOKEN: "t" });
  const server = buildJarvisMcpServer(env);
  const client = new Client({ name: "mcp-test", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepStrictEqual(
    names,
    ["connectors_status", "jarvis_ask", "jarvis_status", "memory_save", "memory_search"].sort(),
    "production tool registry is registered",
  );

  const cr = await client.callTool({ name: "connectors_status", arguments: {} });
  assert.notStrictEqual(cr.isError, true, "connector status not an error");
  assert.ok(/Figma|Vercel Connector/i.test(JSON.stringify(cr.content)), "connector status text returned");

  const sr = await client.callTool({ name: "jarvis_status", arguments: {} });
  assert.notStrictEqual(sr.isError, true, "jarvis status not an error");
  assert.ok(/JARVIS/i.test(JSON.stringify(sr.content)), "jarvis status text returned");

  // Schema-valid but handler-rejected input → isError surfaced through the wire.
  const er = await client.callTool({ name: "jarvis_ask", arguments: { text: "" } });
  assert.strictEqual(er.isError, true, "empty ask → tool-level isError");
  assert.ok(/wajib diisi/.test(JSON.stringify(er.content)), "isError carries the message");

  await client.close();
  await server.close();
}

/** Network-seam factory: connects the real SDK Client to a real Jarvis
 *  McpServer over InMemoryTransport — zero network, full protocol. */
async function makeInMemoryChannelFactory(): Promise<McpChannelFactory> {
  return async () => {
    const server = buildJarvisMcpServer(envOf({ APP_ENV: "test" }));
    const client = new Client({ name: "mcp-test", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
    let closed = false;
    return {
      async listTools() {
        return (await client.listTools()).tools.map((t) => t.name);
      },
      async callTool(name, args) {
        return client.callTool({ name, arguments: args as Record<string, unknown> }) as unknown as McpCallableResult;
      },
      async close() {
        if (closed) return;
        closed = true;
        await client.close().catch(() => {});
        await server.close().catch(() => {});
      },
    };
  };
}

async function testClientDirection() {
  const factory = await makeInMemoryChannelFactory();
  const baseEnv = envOf({
    MCP_SERVERS: JSON.stringify([{ alias: "brain", url: "https://jarvis.example/mcp" }]),
  });

  // Unknown alias → rejected BEFORE any channel opens.
  let opened = 0;
  const counting: McpChannelFactory = async () => {
    opened++;
    throw new Error("must never open");
  };
  const unknown = await mcpCallTool(baseEnv, "ghost", "x", "{}", counting);
  assert.strictEqual(unknown.ok, false, "unknown alias fails closed");
  assert.ok(/tidak ada di allow-list/.test(unknown.error ?? ""), "aliases explain the denial");
  assert.strictEqual(opened, 0, "unknown alias never touches the network");

  // Per-server tool allow-list deny → rejected BEFORE any channel opens.
  const denyEnv = envOf({
    MCP_SERVERS: JSON.stringify([
      { alias: "brain", url: "https://jarvis.example/mcp", tools: ["connectors_status"] },
    ]),
  });
  const denied = await mcpCallTool(denyEnv, "brain", "jarvis_status", "{}", counting);
  assert.strictEqual(denied.ok, false, "tool outside allow-list fails closed");
  assert.ok(/tidak diizinkan/.test(denied.error ?? ""), "denials name the tool allow-list");
  assert.strictEqual(opened, 0, "disallowed tool never touches the network");

  // Invalid JSON args → rejected BEFORE any channel opens.
  const badJson = await mcpCallTool(baseEnv, "brain", "connectors_status", "{oops", counting);
  assert.strictEqual(badJson.ok, false, "bad JSON fails closed");
  assert.ok(/JSON valid/.test(badJson.error ?? ""), "bad JSON names the error");
  assert.strictEqual(opened, 0, "bad args never touch the network");

  // Success path through the real protocol (in-memory).
  const good = await mcpCallTool(baseEnv, "brain", "connectors_status", "", factory);
  assert.strictEqual(good.ok, true, "connectors_status succeeds");
  assert.ok(/Figma|Vercel Connector/i.test(good.text ?? ""), "returns connector text");

  // Tool that reports isError surfaces as ok:false with the tool's message.
  const askEmpty = await mcpCallTool(baseEnv, "brain", "jarvis_ask", '{"text": ""}', factory);
  assert.strictEqual(askEmpty.ok, false, "tool-level isError → ok:false");
  assert.ok(/wajib diisi/.test(askEmpty.error ?? ""), "isError message preserved");

  // Tool not advertised by the server → graceful, no fake success.
  const noTool = await mcpCallTool(baseEnv, "brain", "nope_tool", "{}", factory);
  assert.strictEqual(noTool.ok, false, "unknown tool fails closed");
  assert.ok(/tidak tersedia/.test(noTool.error ?? ""), "unknown tool names the server");

  // /mcp list.
  const live = await mcpLiveToolNames(baseEnv, "brain", factory);
  assert.strictEqual(live.ok, true);
  assert.ok((live.tools ?? []).includes("jarvis_status"), "list returns advertised tools");
  const liveBad = await mcpLiveToolNames(baseEnv, "ghost", counting);
  assert.strictEqual(liveBad.ok, false, "list unknown alias fails closed");

  // Master switch off → refused before anything else.
  const off = await mcpCallTool(envOf({ MCP_ENABLED: "0" }), "brain", "connectors_status", "{}", counting);
  assert.strictEqual(off.ok, false, "MCP_ENABLED=0 refuses calls");

  // Summary is configuration-only (no network), mentions both directions.
  const sum = mcpCommandSummary(
    envOf({
      MCP_ACCESS_TOKEN: "t",
      MCP_SERVERS: JSON.stringify([{ alias: "brain", url: "https://jarvis.example/mcp" }]),
    }),
  );
  assert.ok(/adapter dua arah/.test(sum), "summary titles both directions");
  assert.ok(/\*brain\*/.test(sum), "summary lists allow-listed aliases");
  assert.ok(/aktif/.test(sum), "summary marks the server endpoint active");
}

async function main() {
  testConfig();
  await testServerAuth();
  await testServerToolsRoundTrip();
  await testClientDirection();
  console.log("MCP TESTS PASSED");
}

main().catch((e) => {
  console.error("MCP TEST FAILED:", e);
  process.exit(1);
});