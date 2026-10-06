/**
 * The Telegram command menu actually gets registered.
 *
 * Context: the bot ran with an empty menu because setMyCommands() misread the
 * shape of call()'s return value. call() resolves with `data.result`, and for
 * setMyCommands Telegram's result is the bare boolean `true`, so the old
 * `(res as {ok?: boolean})?.ok ?? false` evaluated to false on every single
 * call - including successful ones. ensureTelegramCommands() then never
 * believed it had succeeded, and the marker it uses as a rate limiter was
 * never written, so nothing ever retried either.
 *
 * These tests pin the shape contract so the failure cannot come back quietly.
 */
import assert from "node:assert/strict";
import { setMyCommands, getWebhookInfo } from "../src/lib/telegram";

type Captured = { url: string; body: Record<string, unknown> };

const env = { TELEGRAM_TOKEN: "test-token" };

/** Run fn with globalThis.fetch stubbed by a Telegram API responder. */
async function withTelegram<T>(
  responder: (req: Captured) => { status?: number; payload: unknown },
  fn: () => Promise<T>,
): Promise<{ value: T; calls: Captured[] }> {
  const realFetch = globalThis.fetch;
  const calls: Captured[] = [];
  try {
    (globalThis as any).fetch = async (url: any, init: any) => {
      const req: Captured = { url: String(url), body: init?.body ? JSON.parse(init.body) : {} };
      calls.push(req);
      const { status = 200, payload } = responder(req);
      return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    };
    const value = await fn();
    return { value, calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** A SUCCESSFUL setMyCommands must report success. */
async function testSuccessReportsTrue() {
  const { value, calls } = await withTelegram(
    () => ({ payload: { ok: true, result: true } }),
    () => setMyCommands(env),
  );
  assert.strictEqual(
    value, true,
    "setMyCommands must report success when Telegram accepts the menu",
  );
  assert.match(calls[0].url, /\/setMyCommands$/, "must hit the setMyCommands endpoint");
}

/** The regression itself, pinned as an executable explanation. */
async function testOldShapeIsTheBug() {
  const response = { ok: true, result: true } as { ok: boolean; result: boolean };
  assert.strictEqual(
    Boolean((response.result as unknown as { ok?: boolean })?.ok ?? false),
    false,
    "reading .ok off call()'s return (data.result) yields false - the old bug",
  );
}

/** The menu must carry real commands, not an empty array. */
async function testMenuPayloadIsValid() {
  const { calls } = await withTelegram(
    () => ({ payload: { ok: true, result: true } }),
    () => setMyCommands(env),
  );
  const commands = calls[0].body.commands as { command: string; description: string }[];
  assert.ok(Array.isArray(commands) && commands.length > 0,
    "setMyCommands must send a non-empty command list");
  for (const c of commands) {
    assert.ok(c.command && /^[a-z0-9_]{1,32}$/.test(c.command),
      `invalid command name for the Telegram menu: ${c.command}`);
    assert.ok(c.description && c.description.length <= 256,
      `description missing or too long for /${c.command}`);
    assert.ok(!c.description.includes("\n"),
      `Telegram rejects newlines in command descriptions (/${c.command})`);
  }
}

/** A REJECTED menu must report failure so the next tick retries. */
async function testRejectionReportsFalse() {
  const { value } = await withTelegram(
    () => ({ status: 400, payload: { ok: false, error_code: 400, description: "Bad Request: commands too much" } }),
    () => setMyCommands(env),
  );
  assert.strictEqual(value, false, "setMyCommands must report failure when Telegram rejects it");
}

/** Sibling helper: getWebhookInfo also gets data.result, so it reads .url off
 *  the result and must keep callback_query in allowed_updates - otherwise the
 *  cron re-registers the webhook on every tick forever. */
async function testWebhookInfoShape() {
  const { value } = await withTelegram(
    () => ({
      payload: {
        ok: true,
        result: {
          url: "https://example.workers.dev/webhook",
          pending_update_count: 0,
          allowed_updates: ["message", "callback_query"],
        },
      },
    }),
    () => getWebhookInfo(env),
  );
  assert.strictEqual(value.url, "https://example.workers.dev/webhook",
    "getWebhookInfo must read fields off data.result");
  assert.strictEqual(value.pending_update_count, 0);
  assert.ok(value.allowed_updates?.includes("callback_query"),
    "callback_query must stay in allowed_updates or the cron re-registers forever");
}

async function main() {
  console.log("telegram command menu tests");
  await testSuccessReportsTrue();
  await testOldShapeIsTheBug();
  await testMenuPayloadIsValid();
  await testRejectionReportsFalse();
  await testWebhookInfoShape();
  console.log("  success shape + rejection + payload + webhook shape OK");
  console.log("TELEGRAM MENU TESTS PASSED");
}

main().catch((e) => {
  console.error("TELEGRAM MENU TEST FAILED:", e.message || e);
  process.exit(1);
});