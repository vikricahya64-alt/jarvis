/**
 * Two-model answering: one writes, a DIFFERENT one checks.
 *
 * Replaces the input/output gate + search-processing mechanism, whose routing
 * rules could not be made correct - every production drift traced back to it:
 * a question about the history of inflation came back about remote-work policy,
 * then solo-business management, then workspace organisation, including right
 * after the user said "bukan kerja remote" and "tapi sejarah inflasi".
 *
 * Here nothing is routed by guessed intent. Retrieval happens, the answerer
 * writes from the retrieved passages only, and a second provider asks one
 * narrow question about the result: does this answer the message that arrived?
 * If not, the critique is fed back once and re-checked. If it still fails, the
 * draft is NOT sent.
 *
 * Two properties this deliberately does not do:
 *   - It does not judge truth. The verifier is asked about relevance only,
 *     because grading truthfulness without evidence produces false rejections.
 *   - It does not replace moderation or the owner-capability gates. Those are
 *     safety properties; swapping them for a quality heuristic would be a
 *     regression.
 */
import { retrieveKeyless, renderPassages } from "./keyless_search";
import { answerAndVerify, type AnswerResult } from "./answer_roles";
import { resolveTelegramContext } from "./telegram_context";
import type { Env } from "./db";

const ANSWERER_SYSTEM = `Kamu menjawab pertanyaan pengguna HANYA dari cuplikan hasil pencarian yang diberikan.

Aturan yang tidak boleh dilanggar:
1. Jangan menjawab dari memori. Bila cuplikan tidak memuat jawabannya, katakan terus terang bahwa informasinya tidak ditemukan di sumber, lalu jangan mengarang kelanjutannya.
2. Jawab dalam bahasa pengguna (Indonesia atau Inggris).
3. Sertakan URL sebagai sumber pada setiap klaim penting.
4. Jangan mengarang tahun, angka, nama, atau hukum. Tulis "tidak disebutkan dalam sumber" bila memang tidak ada.
5. Jangan menjawab subjek yang tidak ditanyakan. Kalau pengguna menanyakan sejarah inflasi, jangan menjawab tentang kebijakan kerja remote, telep kerja, atau produktivitas.`;

export interface GroundedResult extends AnswerResult {
  /** Which keyless layers contributed. */
  sources: string[];
  /** Which Telegram direction resolved context, for diagnostics. */
  contextReason: string;
}

export async function answerGrounded(
  env: Env,
  owner: number,
  question: string,
  replyToText?: string,
): Promise<GroundedResult | null> {
  const q = (question ?? "").trim();
  if (!q) return null;

  // Context comes from Telegram, not from guessed intent.
  const ctx = await resolveTelegramContext(env, owner, q, replyToText);

  const retrieval = await retrieveKeyless(q);
  if (retrieval.hits.length === 0) {
    // Fail-closed: without evidence there is nothing to ground an answer, and
    // an ungrounded answer is exactly the failure being replaced.
    return null;
  }
  const passages = renderPassages(retrieval.hits);

  const result = await answerAndVerify(
    env,
    q,
    async ({ extraInstruction }) => {
      const ctxBlock = ctx.prior
        ? `Konteks sebelumnya (hanya bila relevan):\n${ctx.prior.slice(0, 800)}\n\n`
        : "";
      return answerOnce(env, `${ctxBlock}${extraInstruction ? extraInstruction + "\n\n" : ""}`, {
        question: q,
        passages,
      });
    },
    ctx.topic ?? "",
  );
  if (!result) return null;
  return { ...result, sources: retrieval.used, contextReason: ctx.reason };
}

/** Single grounded completion against the answer role. */
async function answerOnce(
  env: Env,
  preamble: string,
  parts: { question: string; passages: string },
): Promise<string | null> {
  const { llmRespond } = await import("./ai");
  const user = `${preamble}Pertanyaan pengguna:
${parts.question}

Hasil pencarian (sumber един-satunya yang boleh dipakai):
${parts.passages}

Tulis jawaban yang menempel pada pertanyaan di atas.`;
  const res = await llmRespond(env, user, { systemOverride: ANSWERER_SYSTEM });
  return res.reply;
}