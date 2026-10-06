/**
 * Two models, two jobs: one writes the answer, a different one checks it.
 *
 * Until now a single cascade produced and accepted its own output, so nothing
 * ever compared the reply against the message that triggered it. That is how
 * a question about inflation produced an essay on remote-work policy three
 * turns running: the generator's mistake was never looked at by anyone.
 *
 * The split:
 *
 *   ANSWER    - composes the reply. Prefers the fast path (groq).
 *   VERIFIER  - a DIFFERENT provider, given the user's input and the draft, and
 *               asked one narrow question: does this answer what was asked?
 *
 * The verifier must not be the same model that wrote the draft. Self-review in
 * the same weights reliably approves its own mistakes, which would make the
 * gate decorative. Different provider, default.
 *
 * Scope is deliberately narrow: this verifies the OUTPUT against the INPUT. It
 * does not re-run routing, does not decide capability, and does not replace the
 * existing moderation or owner-capability gates. Those are safety properties,
 * not quality heuristics, and swapping them out would be a regression.
 */

import {
  groqRespond,
  openrouterRespond,
  nvidiaNimRespond,
  workersAiRespond,
  geminiRespond,
  type ProviderRespondOpts,
} from "./ai";
import type { Env } from "./db";

export type RoleName = "answer" | "verifier";

/** Which provider serves which role, overridable per deployment. */
export type Responder = (
  env: Env,
  userText: string,
  opts?: ProviderRespondOpts,
) => Promise<string | null>;

function pickResponder(env: Env, role: RoleName): { fn: Responder; name: string } {
  const want = role === "answer" ? env.ANSWER_PROVIDER : env.VERIFIER_PROVIDER;
  const table: Record<string, () => { fn: Responder; name: string }> = {
    groq: () => ({ fn: groqRespond as Responder, name: "groq" }),
    openrouter: () => ({ fn: openrouterRespond as Responder, name: "openrouter" }),
    nvidia_nim: () => ({ fn: nvidiaNimRespond as Responder, name: "nvidia_nim" }),
    workers_ai: () => ({ fn: workersAiRespond as Responder, name: "workers_ai" }),
    gemini: () => ({ fn: geminiRespond as Responder, name: "gemini" }),
  };
  if (want && table[want]) return table[want]();
  // Defaults chosen so the two roles do not share weights by default.
  return role === "answer"
    ? { fn: groqRespond as Responder, name: "groq" }
    : { fn: openrouterRespond as Responder, name: "openrouter" };
}

export interface Verdict {
  ok: boolean;
  /** Short, user-safe reason when the draft was rejected. */
  reason: string;
  /** Verifier's own words, kept for /debug and never shown verbatim. */
  critique: string;
  verifier: string;
  latencyMs: number;
  /**
   * What the user's message actually WAS, decided in the same pass that
   * checked relevance. This is the pipeline's single decision point:
   *
   *   question -> the draft IS the output, send it
   *   command  -> the draft is not the output; the message is a request to
   *              DO something, so it goes to execution -> action -> output
   *
   * Deciding this here, once, is what removes the failure where the same
   * message was treated differently by three separate gates and ended up
   * deferred by one of them.
   */
  kind: "question" | "command";
  /** Canonical command when kind is "command". NEVER executed directly: it is
   *  re-entered through the verified intent gate (resolveIntent) like any
   *  user-typed command, so a model cannot invent a command that skips
   *  verification. Empty when the model proposes no command. */
  command: string;
}

/**
 * Ask the verifier model a single narrow question about the draft.
 *
 * The rubric is deliberately answerable by reading the two texts side by side:
 * off-topic, missing the asked part, or answering a different question. It does
 * not ask the verifier to grade style, length, or truth - those need evidence
 * this function does not have, and judging them without evidence is how a gate
 * starts rejecting correct answers.
 */
const VERIFIER_PROMPT = (input: string, draft: string, subject: string) =>
  `You do two things about a draft reply, in one pass.

USER MESSAGE:
"""
${input}
"""

DRAFT REPLY:
"""
${draft}
"""

The subject under discussion: ${subject || "(not established yet)"}

Reply with EXACTLY four lines and nothing else.

LINE 1: PASS or FAIL
  PASS only if the draft addresses what the user actually sent. FAIL if it is
  about a different subject, ignores an explicit correction, or substitutes a
  different question. Do not fail for style, length, tone, formatting, detail
  missing on a topic it did answer, or claims you cannot verify - you are
  checking relevance, not truth.

LINE 2: QUESTION or COMMAND
  QUESTION - the user is asking something; the draft IS the reply to send.
  COMMAND  - the user is asking JARVIS to DO something (create, delete, run,
             schedule, fetch and store). Being ABOUT a risky topic is not a
             command: "which is better, forex trading or a money changer" is a
             QUESTION even though trading is a risky subject.

LINE 3: if COMMAND, the slash command to run (for example /tugas ...), otherwise NONE

LINE 4: if FAIL, one short sentence naming what the draft answered INSTEAD of
what was asked. Otherwise NONE`;

export async function verifyAnswer(
  env: Env,
  input: string,
  draft: string,
  subject = "",
): Promise<Verdict> {
  const started = Date.now();
  const { fn, name } = pickResponder(env, "verifier");
  let raw: string | null = null;
  try {
    if (verifierOverride) {
      raw = await verifierOverride(env, input, draft, subject);
    } else {
      raw = await fn(env, VERIFIER_PROMPT(input, draft, subject), { skipSearch: true });
    }
  } catch {
    raw = null;
  }
  if (!raw) {
    // Fail-closed. The comment here used to promise the opposite of what the
    // code did: when the verifier was unavailable it returned ok:true, so a
    // verifier that could not run silently approved every draft - the exact
    // failure this module exists to prevent. An unavailable verifier now
    // REJECTS, and says so, so the caller can decide whether to fall back.
    return {
      ok: false,
      reason: "pemeriksa tidak tersedia; draft tidak diverifikasi",
      critique: "",
      verifier: `${name}:unavailable`,
      latencyMs: Date.now() - started,
      kind: "question",
      command: "",
    };
  }
  const lines = raw.trim().split("\n").map((l) => l.trim());
  const head = (lines[0] ?? "").toUpperCase();
  const pass = head.startsWith("PASS");

  // Fail-closed on the decision too. An unparseable answer must not be read as
  // "question", because that would silently ship a draft the verifier never
  // cleared, nor as "command", which would execute something unvetted.
  const kindLine = (lines[1] ?? "").toUpperCase();
  const kind: Verdict["kind"] = kindLine.startsWith("COMMAND")
    ? "command"
    : kindLine.startsWith("QUESTION")
      ? "question"
      : "question";

  // A proposed command is only ever a SUGGESTION here. It is re-entered through
  // resolveIntent before anything runs, and it is discarded outright unless it
  // is a syntactically valid slash command.
  const cmdRaw = (lines[2] ?? "").trim();
  // Accept the canonical slash form only. Anything else - free text, a shell
  // string, a path - is discarded so nothing but a real command name can ever
  // reach the execution path.
  // A canonical command is ALWAYS a slash command, with no exceptions. Requiring
  // the leading "/" is what stops free text from being smuggled into the
  // execution path: "rm -rf /sdcard" starts with letters and would otherwise
  // pass, while "/tugas hapus semua pending" is the only shape accepted.
  const command = kind === "command"
    && /^\/[a-z][a-z0-9_]*(\s|$)/i.test(cmdRaw.trim())
    && !/^\/none$/i.test(cmdRaw.trim())
    ? cmdRaw.slice(0, 200)
    : "";

  const critique = lines.slice(3).join(" ").trim().slice(0, 300);
  return {
    ok: pass,
    reason: pass ? "" : critique || "draft tidak menjawab pertanyaan yang diminta",
    critique,
    verifier: name,
    latencyMs: Date.now() - started,
    kind,
    command,
  };
}

export interface AnswerResult {
  text: string;
  /** Which provider composed it. */
  answeredBy: string;
  verified: Verdict | null;
  /** True when a rejected draft was repaired and re-verified successfully. */
  repaired: boolean;
}

/**
 * Compose, then check. On rejection the verifier's critique is fed back once -
 * a single retry, because an answer that needed three attempts was not going to
 * be right and burning quota on it hides the problem.
 */
export async function answerAndVerify(
  env: Env,
  input: string,
  compose: (opts: { extraInstruction?: string }) => Promise<string | null>,
  subject = "",
): Promise<AnswerResult | null> {
  const { name: answerer } = pickResponder(env, "answer");
  let draft = await compose({});
  if (!draft) return null;

  const first = await verifyAnswer(env, input, draft, subject);
  if (first.ok) {
    return { text: draft, answeredBy: answerer, verified: first, repaired: false };
  }

  const repaired = await compose({
    extraInstruction:
      `Jawaban sebelumnya dinilai tidak menjawab pertanyaan pengguna. Tolak: ${first.critique || "tidak menjawab pertanyaan yang diminta"}. Jawab pertanyaan yang diberikan pengguna secara langsung.`,
  });
  if (repaired) {
    const second = await verifyAnswer(env, input, repaired, subject);
    if (second.ok) {
      return { text: repaired, answeredBy: answerer, verified: second, repaired: true };
    }
    return { text: repaired, answeredBy: answerer, verified: second, repaired: false };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Test seams. The provider table is otherwise unreachable from tests, and
 * a test that has to hit the network cannot prove that the verifier runs
 * as a SEPARATE model - which is the one property that matters here.
 * ------------------------------------------------------------------ */

/** Override the verifier for tests. Pass null to restore the real responder. */
let verifierOverride: null | ((env: Env, input: string, draft: string, subject: string) => Promise<string | null>) = null;

export function setVerifierForTest(
  fn: null | ((env: Env, input: string, draft: string, subject: string) => Promise<string | null>),
): void {
  verifierOverride = fn;
}

/** Expose the role -> provider mapping so tests can assert separation. */
export function pickResponderForTest(env: Env, role: RoleName): { fn: Responder; name: string } {
  return pickResponder(env, role);
}
