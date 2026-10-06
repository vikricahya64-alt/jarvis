/**
 * The Telegram-based context gate.
 *
 * Regression cover for a real failure: a question about the history of
 * inflation was answered about remote-work policy. The turn before it existed
 * in no store, and Telegram's reply_to_message - the one signal that states
 * "I am continuing THIS" - was not modelled in TelegramMessage at all, so it
 * was discarded on the floor.
 *
 * These tests pin the two directions and, just as importantly, the third
 * outcome: a genuinely new question must NOT be treated as a continuation.
 * Conflating those two is what produced the invented subject.
 */
import assert from "node:assert/strict";
import { resolveTelegramContext, looksLikeContinuation, recordTurn } from "../src/lib/telegram_context";

// Minimal KV double: get with JSON, put with TTL.
function fakeKV(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  return {
    store,
    CONFIG_KV: {
      async get(k: string, type?: string) {
        if (!(k in store)) return null;
        // Workers KV's json type hands back the parsed value, not a string.
        return type === "json" ? store[k] : JSON.stringify(store[k]);
      },
      async put(k: string, v: string) {
        store[k] = JSON.parse(v);
      },
    },
  } as never;
}

const OWNER = 4242;

async function main() {
  console.log("telegram context tests");

  // --- Direction 1: an explicit Telegram reply wins over everything ---------
  {
    const env = fakeKV();
    const c = await resolveTelegramContext(
      env, OWNER, "apa sejarahnya dan mengapa memilih sistem itu",
      "Inflasi adalah kenaikan umum harga barang dan jasa",
    );
    assert.strictEqual(c.kind, "reply", "reply_to_message must win");
    assert.strictEqual(c.isContinuation, true);
    assert.match(c.prior, /Inflasi/, "the replied-to text must be the prior turn");
    assert.match(c.reason, /di-reply/);
    // This is the exact case that drifted: no subject in the message, subject
    // taken from the message above.
    assert.ok(c.topic && /Inflasi/i.test(c.topic), `topic must come from the prior message, got ${c.topic}`);
  }

  // --- Direction 2: same day, STRONG continuation --------------------------
  {
    const env = fakeKV();
    await recordTurn(env, OWNER, "user", "apa itu inflasi");
    await recordTurn(env, OWNER, "assistant", "Inflasi adalah kenaikan umum harga barang dan jasa.");
    const c = await resolveTelegramContext(env, OWNER, "mengapa memilih sistem itu", undefined);
    assert.strictEqual(c.kind, "today", "a strong refer-back continues today");
    assert.strictEqual(c.isContinuation, true);
    assert.match(c.prior, /inflasi/);
    assert.match(c.reason, /hari ini/);
  }

  // --- Direction 3 for a SUGGESTIVE follow-up: not forced, but not starved ---
  //
  // This is the production case verbatim. "apa sejarahnya dalam sejarah" has no
  // strong refer-back, so it must NOT be force-anchored to yesterday's topic -
  // that is what produced the invented subject. But it must still RECEIVE the
  // day's turns, which is the part the old design got wrong: it received nothing
  // at all, because nothing was ever written to any store.
  {
    const env = fakeKV();
    await recordTurn(env, OWNER, "user", "apa itu inflasi dan apa yang menyebabkannya");
    await recordTurn(env, OWNER, "assistant", "Inflasi adalah kenaikan umum harga barang dan jasa.");
    const c = await resolveTelegramContext(env, OWNER, "apa sejarahnya dalam sejarah", undefined);
    assert.strictEqual(c.kind, "new", "suggestive wording must not be force-anchored");
    assert.strictEqual(c.isContinuation, false, "must not inherit the previous subject as a topic");
    assert.strictEqual(c.topic, null, "no topic forced onto the model");
    assert.match(c.prior, /apa itu inflasi/, "but the day's turns ARE supplied as background");
    assert.match(c.prior, /assistant:/, "both sides of the exchange");
    assert.match(c.reason, /latar belakang/);
  }

  // --- Direction 3: a NEW question after a busy day must not latch ---------
  {
    const env = fakeKV();
    await recordTurn(env, OWNER, "user", "apa itu inflasi dan apa yang menyebabkannya");
    await recordTurn(env, OWNER, "assistant", "Kenaikan umum harga barang dan jasa.");
    // Full, self-contained new question: it names its own subject.
    const c = await resolveTelegramContext(
      env, OWNER, "jelaskan различи cara kerja mesin turbo pada mesin mobil-modern", undefined,
    );
    assert.strictEqual(c.kind, "new", "a self-contained question is not a continuation");
    assert.strictEqual(c.isContinuation, false, "must NOT be treated as continuation - this is the drift case");
    assert.strictEqual(c.topic, null, "no topic may be inherited from the previous turn");
    // The day's turns are still offered as background, not as the subject.
    assert.match(c.prior, /inflasi/, "day's turns remain available as background");
  }

  // --- Empty state: brand new user ------------------------------------------
  {
    const env = fakeKV();
    const c = await resolveTelegramContext(env, 999, "apa itu inflasi", undefined);
    assert.strictEqual(c.kind, "new");
    assert.strictEqual(c.prior, "");
    assert.strictEqual(c.isContinuation, false);
  }

  // --- Continuation classifier ---------------------------------------------
  {
    // Strong signals: refer back unambiguously.
    assert.strictEqual(looksLikeContinuation("lanjutkan"), true);
    assert.strictEqual(looksLikeContinuation("teruskan"), true);
    assert.strictEqual(looksLikeContinuation("mengapa memilih sistem itu"), true, "anaphora 'sistem itu'");
    assert.strictEqual(looksLikeContinuation("kenapa?"), true, "bare follow-up");
    assert.strictEqual(looksLikeContinuation("sebabnya?"), true, "bare follow-up");
    assert.strictEqual(looksLikeContinuation("selain itu?"), true);
    assert.strictEqual(looksLikeContinuation("itu"), true, "short message");

    // The regression that caused the drift: these must NOT latch onto the
    // previous subject. Each one names its own subject and is a complete
    // question, so treating it as a continuation is what handed the model a
    // subject the user never asked about.
    assert.strictEqual(
      looksLikeContinuation("apa itu inflasi dan apa yang menyebabkannya dalam sejarah"),
      false,
      "a self-contained first question must be NEW, not a continuation",
    );
    assert.strictEqual(
      looksLikeContinuation("jelaskan apa itu inflasi dan apa penyebabnya dalam sejarah ekonomi dunia"),
      false,
    );
    assert.strictEqual(
      looksLikeContinuation("jelaskan perbedaan cara kerja mesin turbo pada mobil modern"),
      false,
    );
    assert.strictEqual(looksLikeContinuation(""), false);
  }

  // --- Dedup: the same turn must not be stored twice ----------------------
  {
    const env = fakeKV();
    await recordTurn(env, OWNER, "user", "apa itu inflasi");
    await recordTurn(env, OWNER, "user", "apa itu inflasi");
    const keys = Object.keys((env as unknown as { store: Record<string, unknown> }).store);
    assert.strictEqual(keys.length, 1, "one log key for this owner+day");
    const turns = (env as unknown as { store: Record<string, unknown[]> }).store[keys[0]];
    assert.strictEqual(turns.length, 1, "duplicate turn must not be appended twice");
  }

  // --- Empty replies are not stored ---------------------------------------
  {
    const env = fakeKV();
    await recordTurn(env, OWNER, "assistant", "");
    const keys = Object.keys((env as unknown as { store: Record<string, unknown> }).store);
    assert.strictEqual(keys.length, 0, "an empty reply must not create the log");
  }

  console.log("  reply direction + today direction + new-topic rejection + dedup OK");
  console.log("TELEGRAM CONTEXT TESTS PASSED");
}

main().catch((e) => {
  console.error("TELEGRAM CONTEXT TEST FAILED:", e?.message || e);
  process.exit(1);
});