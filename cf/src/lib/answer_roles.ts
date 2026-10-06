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

/** The one routing decision, taken by the verifier in the same pass that
 *  checks relevance.
 *
 *  plain    - the draft IS the output; send it
 *  research - the question needs external sources; re-enter the existing spine
 *              (processIntelligence), which owns its search branches
 *  command  - the draft is not the output; re-enter act() with a canonical
 *              command, so it is re-verified before anything runs
 *
 *  Naming these from one place is the point. An earlier iteration shipped a
 *  separate router module alongside this file, which meant two sources could
 *  disagree about the same message. One decision, one definition.
 */
export type AnswerKind = "plain" | "research" | "command";

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

/**
 * The verifier's providers in the order they may be tried.
 *
 * The verifier being unreachable is an infrastructure failure, not a judgement
 * about the draft. Treating it as a rejection meant a single provider outage
 * turned every question into "I can't answer that with a source I trust" -
 * observed live when openrouter went down and "apa itu bitcoin" got no answer
 * even though the retrieval had five hits and the draft was fine.
 *
 * Role separation is preserved: the answerer's provider is tried last, because
 * a verifier that shares weights with the answerer checks less than one that
 * does not. A different provider still verifies; the same one does not.
 */
function verifierCandidates(env: Env): { fn: Responder; name: string }[] {
  const all: { fn: Responder; name: string }[] = [
    { fn: workersAiRespond as Responder, name: "workers_ai" },
    { fn: geminiRespond as Responder, name: "gemini" },
    { fn: nvidiaNimRespond as Responder, name: "nvidia_nim" },
  ];
  const answerer = (env.ANSWER_PROVIDER || "groq").toLowerCase();
  const primary = pickResponder(env, "verifier");
  return [
    primary,
    ...all.filter((c) => c.name !== primary.name && c.name !== answerer),
    ...(answerer !== primary.name ? [{ fn: groqRespond as Responder, name: answerer }] : []),
  ];
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
  kind: AnswerKind;
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
  `USER MESSAGE:
"""
${input}
"""

DRAFT REPLY:
"""
${draft}
"""

Subject: ${subject || "(none yet)"}

Reply with EXACTLY four lines and nothing else.

LINE 1: PASS or FAIL
  PASS if the draft answers what the user actually asked, in ordinary spoken
  Indonesian - the way a helpful person would say it out loud, not like a
  report. FAIL if the draft is about something else, ignores a correction the
  user made, or answers a different question than the one sent.
  Ignore length, tone, formatting and detail level. Judge the answer, not the
  writing.

LINE 2: PLAIN, RESEARCH or COMMAND
  Classify the QUESTION on LINE 1, never the draft. A draft that states today's
  price from memory does not make the question general knowledge.
  PLAIN    - answerable from general knowledge; the draft is the reply.
  RESEARCH - needs live or current data: today's values, recent events.
  COMMAND  - the user wants JARVIS to DO something.
  A question asking what a word MEANS is PLAIN, however many sources the draft
  quotes.

LINE 3: if COMMAND, the slash command to run, otherwise NONE

LINE 4: if FAIL, one short sentence on what the draft answered instead.
Otherwise NONE`;


export async function verifyAnswer(
  env: Env,
  input: string,
  draft: string,
  subject = "",
): Promise<Verdict> {
  const started = Date.now();
  const candidates = verifierCandidates(env);
  let name = candidates[0].name;
  let raw: string | null = null;
  const prompt = VERIFIER_PROMPT(input, draft, subject);
  if (verifierOverride) {
    // Test seam: a fixed verdict, no provider involved.
    try {
      raw = await verifierOverride(env, input, draft, subject);
    } catch {
      raw = null;
    }
  } else {
    for (const c of candidates) {
      try {
        const out = await c.fn(env, prompt, { skipSearch: true });
        if (out && out.trim()) {
          raw = out;
          name = c.name;
          break;
        }
      } catch {
        // Try the next provider. An unreachable verifier is an infrastructure
        // failure, so it must not be mistaken for a verdict on the draft.
      }
    }
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
      kind: "plain",
      command: "",
    };
  }
  const lines = raw.trim().split("\n").map((l) => l.trim());
  const head = (lines[0] ?? "").toUpperCase();
  const pass = head.startsWith("PASS");

  // Fail-closed on the decision too. An unparseable verdict must never read as
  // "command" (would execute something unvetted) nor ship as cleared (was never
  // checked), so it degrades to "plain" with the answer withheld by ok=false.
  const kindLine = (lines[1] ?? "").toUpperCase();
  let kind: AnswerKind = "plain";
  if (kindLine.startsWith("COMMAND")) kind = "command";
  else if (kindLine.startsWith("RESEARCH")) kind = "research";
  else if (kindLine.startsWith("PLAIN") || kindLine.startsWith("QUESTION")) kind = "plain";

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
