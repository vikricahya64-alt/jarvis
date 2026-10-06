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

  // --- Direction 3: a genuinely new question gets a genuinely fresh start ----
  {
    const env = fakeKV();
    await recordTurn(env, OWNER, "user", "apa itu inflasi dan apa yang menyebabkannya");
    await recordTurn(env, OWNER, "assistant", "Inflasi adalah kenaikan umum harga barang dan jasa.");
    const c = await resolveTelegramContext(env, OWNER, "jelaskan perbedaan mesin turbo dan mesin biasa", undefined);
    assert.strictEqual(c.kind, "new");
    assert.strictEqual(c.isContinuation, false);
    assert.strictEqual(c.topic, null, "no topic forced onto the model");
    // The day's turns must NOT be injected here. An earlier version passed them
    // as "background", and that compounded the drift: once an answer went
    // off-topic, every following turn was steered by it.
    assert.strictEqual(c.prior, "", "a new question must not inherit the day's turns");
    assert.match(c.reason, /tidak dipakai/);
  }

  // --- Direction 0: an explicit correction overrides everything -------------
  //
  // Verbatim from production. The user had just been told about remote-work
  // policy, said "bukan kerja remote", and got solo-business advice instead;
  // then said "tapi sejarah inflasi" and got workspace advice. The correction
  // itself was being answered from the context it rejected.
  {
    const env = fakeKV();
    await recordTurn(env, OWNER, "user", "apa itu inflasi");
    await recordTurn(env, OWNER, "assistant", "Kebijakan kerja remote muncul pada era 1990-an.");
    const c1 = await resolveTelegramContext(env, OWNER, "bukan kerja remote", undefined);
    assert.strictEqual(c1.kind, "new", "a rejection is never a continuation");
    assert.strictEqual(c1.isContinuation, false);
    assert.strictEqual(c1.prior, "", "rejected context must be discarded, not passed along");
    assert.match(c1.reason, /koreksi eksplisit/);
    assert.match(c1.reason, /kerja remote/, "the rejected phrase is named for diagnosis");

    const c2 = await resolveTelegramContext(env, OWNER, "tapi sejarah inflasi", undefined);
    assert.strictEqual(c2.kind, "new", "'tapi ...' is also a correction");
    assert.strictEqual(c2.prior, "", "no steering from the rejected thread");
    assert.match(c2.reason, /koreksi eksplisit/);
    assert.match(c2.reason, /sejarah inflasi/);
  }

  // A correction wins even when Telegram supplied a reply_to_message.
  {
    const env = fakeKV();
    const c = await resolveTelegramContext(
      env, OWNER, "bukan kerja remote", "Kebijakan kerja remote muncul tahun 1990-an.",
    );
    assert.strictEqual(c.kind, "new", "an explicit rejection outranks the reply signal");
    assert.strictEqual(c.prior, "", "the replied-to text is exactly what was rejected");
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
    assert.strictEqual(c.prior, "", "and the day's turns must NOT steer a fresh question");
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