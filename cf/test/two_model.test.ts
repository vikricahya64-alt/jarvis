/**
 * The two-model split.
 *
 * Pins the properties that make this a real gate rather than decoration:
 *
 *  1. The verifier must NOT share weights with the answerer by default. A
 *     model grading its own draft approves its own mistakes.
 *  2. An unavailable verifier must REJECT. The original code returned ok:true
 *     here while its own comment promised the opposite - a verifier that could
 *     not run silently approved everything.
 *  3. A relevance failure must reject without inventing a reason.
 *  4. A rejection is repaired exactly once, then re-verified. Three attempts
 *     would just burn quota and hide the problem.
 *
 * The production drift - a question about inflation answered about remote-work
 * policy, and again after the user said "bukan kerja remote" - is the case the
 * verifier is meant to catch, so it appears here verbatim.
 */
import assert from "node:assert/strict";
import { verifyAnswer, answerAndVerify, pickResponderForTest } from "../src/lib/answer_roles";
import { isInterrogativeRequest } from "../src/lib/command_hierarchy";

/** Records every provider call so tests can prove which role ran. */
function stubProviders(env: any, scripts: Record<string, string[]>) {
  const calls: Array<{ role: string; text: string }> = [];
  env.__calls = calls;
  return {
    calls,
    install() {
      env.GROQ_API_KEY = "k";
      env.OPENROUTER_API_KEY = "k";
    },
    /** Replace the responder table with deterministic answers. */
    patch() { /* replaced below via module-level hook */ },
    scripts,
  };
}

async function main() {
  console.log("two-model answer/verify tests");

  const env: any = { GROQ_API_KEY: "k", OPENROUTER_API_KEY: "k", NVIDIA_NIM_API_KEY: "k", WORKERS_AI: {} as any };

  // --- 1. Roles must not share weights by default --------------------------
  {
    const answerer = pickResponderForTest(env, "answer");
    const verifier = pickResponderForTest(env, "verifier");
    assert.notStrictEqual(
      answerer.name, verifier.name,
      "answerer and verifier must default to different providers, or the gate is decorative",
    );
    console.log(`    answer=${answerer.name}  verify=${verifier.name}`);
  }

  // --- 2. Explicit override is honoured ------------------------------------
  {
    const e = { ...env, ANSWER_PROVIDER: "gemini", VERIFIER_PROVIDER: "nvidia_nim" };
    assert.strictEqual(pickResponderForTest(e, "answer").name, "gemini");
    assert.strictEqual(pickResponderForTest(e, "verifier").name, "nvidia_nim");
  }

  // --- 3. Unavailable verifier must REJECT, not approve --------------------
  {
    // No provider keys at all: every responder returns null.
    const dead: any = {};
    const v = await verifyAnswer(dead, "apa itu inflasi", "Inflasi adalah kenaikan harga.", "inflasi");
    assert.strictEqual(v.ok, false,
      "a verifier that cannot run must reject; approving silently is the bug this replaces");
    assert.match(v.reason, /tidak tersedia/);
    assert.match(v.verifier, /unavailable$/);
  }

  // --- 4. Relevance rejection and repair, exactly once ----------------------
  {
    const composed: string[] = [];
    const verdicts: string[] = [];

    const result = await answerAndVerifyWithStubs(
      env,
      "apa sejarahnya bisa terbentuk kebijakan seperti itu",
      async () => {
        const next = composed.length;
        composed.push(`draft-${next}`);
        return `draft-${next}`;
      },
      () => {
        // first call FAILs (off-topic), second call PASSes
        const v = verdicts.length === 0 ? "FAIL\nmenjawab kebijakan kerja remote, bukan yang ditanyakan"
                                       : "PASS";
        verdicts.push(v);
        return v;
      },
    );

    assert.strictEqual(composed.length, 2, "exactly one repair attempt, then stop");
    assert.strictEqual(verdicts.length, 2, "the repaired draft must be re-verified");
    assert.strictEqual(result?.text, "draft-1", "the repaired draft is what ships");
    assert.strictEqual(result?.repaired, true);
    assert.strictEqual(result?.verified?.ok, true);
  }

  // --- 5. Two failures in a row must not ship an unverified draft ---------
  {
    const composed: string[] = [];
    const result = await answerAndVerifyWithStubs(
      env,
      "tapi sejarah inflasi",
      async () => {
        const next = composed.length;
        composed.push(`draft-${next}`);
        return `draft-${next}`;
      },
      () => "FAIL\ntetap menjawab tentang ruang kerja",
    );
    assert.strictEqual(composed.length, 2, "one repair, then give up - no third attempt");
    assert.strictEqual(result?.verified?.ok, false, "the shipped draft must still be marked rejected");
    assert.strictEqual(result?.repaired, false);
  }

  // --- 6. A clean first pass is returned untouched -------------------------
  {
    let composed = 0;
    const result = await answerAndVerifyWithStubs(
      env,
      "apa itu inflasi",
      async () => { composed++; return "Inflasi adalah kenaikan umum harga."; },
      () => "PASS",
    );
    assert.strictEqual(composed, 1, "a good answer must not be re-composed");
    assert.strictEqual(result?.repaired, false);
    assert.strictEqual(result?.text, "Inflasi adalah kenaikan umum harga.");
  }

  // --- 7. No composer output means no reply at all ------------------------
  {
    const result = await answerAndVerifyWithStubs(env, "x", async () => null, () => "PASS");
    assert.strictEqual(result, null, "a null draft must not become a reply");
  }


  // --- 8. The decision itself: QUESTION vs COMMAND -------------------------
  //
  // The pipeline's single branch point. A QUESTION's answer IS the output; a
  // COMMAND's draft is not, and execution -> action -> output happens instead.
  // The case that motivated it: "which is better regarding inflation, forex
  // trading or a money changer" is a QUESTION despite trading being a risky
  // subject - being ABOUT risk is not asking to DO something.
  {
    const seen: string[] = [];
    const v = await verifyAnswerWithLines(
      env,
      "Lebih baik mana dalam segi inflasi perdagangan forex dan money charger",
      "Forex adalah pasar Actin Jude ??",
      ["PASS", "QUESTION", "NONE", "NONE"].join("\n"),
      seen,
    );
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.kind, "plain", "a risky TOPIC must not be read as a COMMAND");
    assert.strictEqual(v.command, "", "a question carries no command");
  }

  // A real command must be recognised, and its command must survive parsing.
  {
    const v = await verifyAnswerWithLines(
      env,
      "hapus semua tugas pending yang sudah selesai",
      "Pem.handlers ??",
      ["PASS", "COMMAND", "/tugas hapus semua pending", "NONE"].join("\n"),
      [],
    );
    assert.strictEqual(v.kind, "command");
    assert.strictEqual(v.command, "/tugas hapus semua pending", "canonical command must be captured");
  }

  // A proposed command that is not a slash command is discarded, so a model
  // cannot smuggle free text into the execution path.
  {
    const v = await verifyAnswerWithLines(
      env, "hapus yang itu", "ok", ["PASS", "COMMAND", "rm -rf /sdcard", "NONE"].join("\n"), [],
    );
    assert.strictEqual(v.kind, "command");
    assert.strictEqual(v.command, "", "a non-slash command must be discarded");
  }

  // RESEARCH is separated from PLAIN on purpose: collapsing them is what made
  // every message pay for search, and search is the least reliable component.
  {
    const v = await verifyAnswerWithLines(
      env, "harga bitcoin hari ini berapa", "Draft.", ["PASS", "RESEARCH", "NONE", "NONE"].join("\n"), [],
    );
    assert.strictEqual(v.kind, "research", "a live-value question must route to research");
    assert.strictEqual(v.command, "", "research carries no command");
  }

  // An unparseable decision must not be read as an instruction to execute.
  {
    const v = await verifyAnswerWithLines(env, "x", "y", "PASS", []);
    assert.strictEqual(v.kind, "plain", "an unreadable kind must not become a command");
    assert.strictEqual(v.command, "");
  }


  // --- 9. The production case: a comparative question is interrogative -----
  //
  // It has no front interrogative word and no question mark. When it was
  // classified as command-shaped it fell through to the compliance pipeline,
  // where the constitutional guard's "money" keyword (from "money changer")
  // blocked it as a financial ACTION and the user got "Aksi ini saya tunda
  // dulu" - four times, to a plain comparison question.
  {
    const t = "Lebih baik mana dalam segi inflasi perdagangan forex dan money charger";
    assert.strictEqual(isInterrogativeRequest(t), true,
      "comparative questions must be interrogative even without '?'");
    // The exemptions must still hold: a destructive action dressed as a
    // question must not buy its way past the guard.
    assert.strictEqual(isInterrogativeRequest("hapus semua tugas pending?"), false,
      "a destructive action with a question mark is still a command");
    assert.strictEqual(isInterrogativeRequest("/hapus semua"), false,
      "an explicit slash command is never interrogative");
  }

  console.log("  role separation, fail-closed verifier, single repair, no unverified shipping OK");
  console.log("TWO-MODEL TESTS PASSED");
}

/**
 * Drive answerAndVerify with injected composer/verifier so the test does not
 * depend on network providers. answerAndVerify itself takes a compose
 * callback; the verifier is injected through the module's test hook.
 */
async function answerAndVerifyWithStubs(
  env: any,
  input: string,
  compose: () => Promise<string | null>,
  verifierReply: () => string,
): Promise<Awaited<ReturnType<typeof answerAndVerify>>> {
  const { setVerifierForTest } = await import("../src/lib/answer_roles");
  setVerifierForTest(async () => verifierReply());
  try {
    return await answerAndVerify(env, input, async () => compose(), "");
  } finally {
    setVerifierForTest(null);
  }
}

main().catch((e) => {
  console.error("TWO-MODEL TEST FAILED:", e?.message || e);
  process.exit(1);
});

/** verifyAnswer with a scripted verifier reply, for the decision tests. */
async function verifyAnswerWithLines(
  env: any, input: string, draft: string, reply: string, _seen: string[],
) {
  const { setVerifierForTest } = await import("../src/lib/answer_roles");
  setVerifierForTest(async () => reply);
  try {
    return await verifyAnswer(env, input, draft, "");
  } finally {
    setVerifierForTest(null);
  }
}
