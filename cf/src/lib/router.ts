/**
 * Route the input, then hand it to the path that already exists.
 *
 * The reason this is one model call and not a set of rules: every previous
 * router in this codebase classified intent lexically, and every production
 * drift came from that. A question about the history of inflation was classified
 * as a financial ACTION because the word "per versat" looked risky, and was
 * deferred four times. Regexes cannot be tuned into correctness here, because
 * Indonesian carries the subject in the syntax and any pattern is a guess.
 *
 * So the model is asked, once, which of three things this is:
 *
 *   chat     - a question to answer from what you know
 *   research - a question that needs current or external sources
 *   execute  - a request to DO something
 *
 * Each verdict then enters the path that already exists and is already tested:
 *   chat     -> answerGrounded()  (chat answering + the verifier that stopped drift)
 *   research -> searchAndSynthesize()  (the existing research cascade)
 *   execute  -> act()  (the existing compliance pipeline, which re-verifies the
 *                        command through resolveIntent before anything runs)
 *
 * Deliberately NOT decided here, and why:
 *
 *  - A slash command is unambiguous, so it never reaches this router. Commands
 *    go straight to act(); putting "/status" through a classifier would only add
 *    a way to get it wrong.
 *  - The router CANNOT execute anything. On "execute" it may only propose a
 *    canonical slash command, and that proposal re-enters act() and resolveIntent
 *    exactly like a typed command. A model does not get a private path to an
 *    action.
 *  - An unreadable or low-confidence verdict degrades to "chat", which answers
 *    the question. The alternative - refusing - is what the old gate did to a
 *    perfectly good question, and is the behaviour this replaces.
 */
import { groqSingleShot } from "./ai";
import type { Env } from "./db";

export type Route = "chat" | "research" | "execute";

export interface Routing {
  route: Route;
  /** Why, in the model's words. Kept for /pipeline_diag, never shown raw. */
  reason: string;
  /** Canonical slash command, only ever set on route "execute". */
  command: string;
  /** How the verdict was obtained. */
  source: "model" | "parse-fallback";
  latencyMs: number;
}

const ROUTER_SYSTEM = `You are a router. You decide what KIND of request you received. You do NOT answer it.

Answer with exactly four lines and nothing else.

LINE 1: one of CHAT, RESEARCH, EXECUTE
  CHAT     - the user is asking something you can answer from general knowledge:
             explanations, definitions, history, opinions, how something works.
  RESEARCH - the user needs current, external, or verifiable information that
             you should not answer from memory: live prices, today's news, recent
             releases, specific figures, or anything where being wrong matters.
  EXECUTE  - the user wants JARVIS to DO something: create, delete, run, schedule,
             store, or change state. Asking ABOUT a risky topic is CHAT, not
             EXECUTE.

LINE 2: if EXECUTE, the slash command to run, for example "/tugas ...".
        Otherwise NONE.

LINE 3: if RESEARCH, a short web search query for it. Otherwise NONE.

LINE 4: one short sentence saying why.`;

function parse(raw: string, latencyMs: number): Routing {
  const lines = raw.trim().split("\n").map((l) => l.trim());
  const head = (lines[0] ?? "").toUpperCase();
  const route: Route = head.startsWith("RESEARCH")
    ? "research"
    : head.startsWith("EXECUTE")
      ? "execute"
      : head.startsWith("CHAT")
        ? "chat"
        : "chat"; // fail-safe: answer rather than refuse

  // Only a canonical slash command is accepted, so free text can never be
  // executed. Anything else degrades to chat.
  const cmdRaw = (lines[1] ?? "").trim();
  const command = route === "execute"
    && /^\/[a-z][a-z0-9_]*(\s|$)/i.test(cmdRaw)
    && !/^\/none$/i.test(cmdRaw)
    ? cmdRaw.slice(0, 200)
    : "";

  const reason = (lines[3] ?? "").replace(/^[\d.\s]+/, "").trim().slice(0, 200);
  return {
    route: route === "execute" && !command ? "chat" : route,
    reason: reason || (route === "execute" && !command ? "EXECUTE tanpa perintah kanonik → diperlakukan sebagai chat" : ""),
    command,
    source: "model",
    latencyMs,
  };
}

export async function routeInput(
  env: Env,
  text: string,
): Promise<Routing> {
  const t = (text ?? "").trim();
  if (!t) {
    return { route: "chat", reason: "input kosong", command: "", source: "parse-fallback", latencyMs: 0 };
  }

  // A slash command is not a judgement call. Sending it through a classifier
  // would only create a way for "/status" to be misrouted.
  if (/^\/[a-z]/.test(t)) {
    return {
      route: "execute",
      reason: "perintah slash eksplisit — dilewati oleh router",
      command: t.slice(0, 200),
      source: "parse-fallback",
      latencyMs: 0,
    };
  }

  const start = Date.now();
  const raw = await groqSingleShot(env, {
    label: "router",
    system: ROUTER_SYSTEM,
    user: `USER MESSAGE:\n"""\n${t}\n"""`,
    temperature: 0,
    maxTokens: 200,
  }).catch(() => null);

  if (!raw) {
    // Router unavailable. Answering is the safe degradation: the previous gate
    // refused on exactly this uncertainty, and a refusal to a plain question is
    // the failure this whole mechanism exists to stop.
    return {
      route: "chat",
      reason: "router tidak tersedia; dijawab langsung",
      command: "",
      source: "parse-fallback",
      latencyMs: Date.now() - start,
    };
  }
  return parse(raw, Date.now() - start);
}