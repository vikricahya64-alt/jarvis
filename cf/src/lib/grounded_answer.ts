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
import { groqSingleShot, openrouterRespond } from "./ai";
import { retrieveKeyless, renderPassages } from "./keyless_search";
import { answerAndVerify, type AnswerResult } from "./answer_roles";
import { resolveTelegramContext } from "./telegram_context";
import type { Env } from "./db";

const ANSWERER_SYSTEM = `Kamu menjawab pertanyaan pengguna. Sumber mungkin tersedia; lihat aturan 1.

Aturan yang tidak boleh dilanggar:
1. Bila cuplikan hasil pencarian diberikan: jawab HANYA dari cuplikan itu, dan bila cuplikan tidak memuat jawabannya katakan terus terang tidak ditemukan.
   Bila TIDAK ada cuplikan (tertulis "tidak ada hasil pencarian"): jawab dari pengetahuanmu seperti biasa, tapi JANGAN mengarang sitasi, tautan, angka, atau tahun.
2. Jawab dalam bahasa pengguna (Indonesia atau Inggris).
3. Tulis seperti orang ngobrol, bukan seperti laporan. Bahasa sehari-hari, kalimat pendek, kata yang dipakai orang tiap hari. Hindari bahasa academic: "merujuk pada", "memiliki fungsi penting dalam", "berdasarkan hasil penelitian", "pada dasarnya", "dapat disimpulkan bahwa", "merupakan suatu bentuk dari". Kalau suatu istilah memang harus dipakai, jelaskan sekali dengan bahasa biasa.
4. JANGAN menulis sitasi di dalam teks. Tidak ada 【1†url】, tidak ada kurung siku berisi sumber, tidak ada daftar URL, tidak ada nomor catatan kaki. Pengguna chat di Telegram, bukan baca jurnal - penanda sitasi hanya jadi noise.
5. Jangan mengarang tahun, angka, nama, atau hukum. Tulis "tidak disebutkan dalam sumber" bila memang tidak ada.
6. Jangan menjawab subjek yang tidak ditanyakan. Kalau pengguna menanyakan sejarah inflasi, jangan menjawab tentang kebijakan kerja remote, telep kerja, atau produktivitas.
7. Panjang secukupnya. Satu topik deserving satu sampai tiga paragraf pendek, bukan esai.`;

export interface GroundedResult extends AnswerResult {
  /** Which keyless layers contributed. */
  sources: string[];
  /** Which Telegram direction resolved context, for diagnostics. */
  contextReason: string;
  /** The subject this answer is about. Anchors the reply to a topic so a later
   *  turn cannot slide onto something else. Empty when the message was a fresh
   *  question with no established subject. */
  topic: string;
}

/**
 * Retrieval is SUPPLEMENTARY. It grounds the answer when it can; it never
 * decides whether there is an answer at all.
 *
 * This inverts a dependency I had set up backwards. Making the reply depend on
 * a successful search meant the reliability of the whole bot was capped by
 * scraped HTML endpoints: measured live, DDG alternates 10 hits / HTTP 202
 * challenge across identical requests and Bing's parse goes empty under repeat
 * load, while every LLM provider's breaker sits closed with zero failures.
 * A question with three usable sources was answered with silence, and the
 * empty result then fell through to the constitutional guard, which blocked it
 * as a financial action because the sentence contained the word "money".
 *
 * So: retrieve, then compose either way.
 *   passages present -> answer strictly from them and cite them
 *   no passages      -> answer normally, and cite nothing
 * The verifier still runs on both, because relevance is what stopped the
 * drift, and that check never depended on search.
 */
export async function answerGrounded(
  env: Env,
  owner: number,
  question: string,
  replyToText?: string,
): Promise<GroundedResult | null> {
  const q = (question ?? "").trim();
  if (!q) return null;

  const ctx = await resolveTelegramContext(env, owner, q, replyToText);

  // Best effort, and never the reason a reply does not happen.
  const retrieval = await retrieveKeyless(q).catch(() => ({ hits: [], used: [] as string[] }));
  const passages = retrieval.hits.length ? renderPassages(retrieval.hits) : "";
  const evidence = passages
    ? `Hasil pencarian (sumber satu-satunya yang boleh dipakai):\n${passages}\n\n`
    : `Tidak ada hasil pencarian yang bisa dipercaya untuk pertanyaan ini. Jawab dari pengetahuanmu, ` +
      `DAN JANGAN mengarang sitasi, tautan, angka, atau tahun. Kalau tidak yakin, katakan tidak yakin.\n\n`;

  const result = await answerAndVerify(
    env,
    q,
    async ({ extraInstruction }) => {
      const ctxBlock = ctx.prior ? `Konteks sebelumnya (hanya bila relevan):\n${ctx.prior.slice(0, 800)}\n\n` : "";
      return answerOnce(env, `${ctxBlock}${extraInstruction ? extraInstruction + "\n\n" : ""}`, {
        question: q,
        passages: evidence,
      });
    },
    ctx.topic ?? "",
  );
  if (!result) return null;

  return {
    ...result,
    sources: retrieval.used,
    contextReason: ctx.reason,
    // Prefer the continued subject; otherwise the question itself is the topic.
    topic: ctx.topic ?? q.slice(0, 80),
  };
}

/**
 * One grounded completion, from the answer role.
 *
 * This used to go through llmRespond() - the full brain, with its provider
 * cascade, its search branch, its understand/clarify branches. That was both
 * the wrong tool and a flaky one: llmRespond() can branch into search synthesis
 * or decline to answer, and when it returned null the whole grounded answer was
 * silently dropped and the message fell through to the compliance pipeline,
 * where the constitutional guard blocked it. Measured on the exact production
 * question: retrieval returned 4 hits, then answer was null.
 *
 * The answerer's whole job is "write from these passages". groqSingleShot is
 * that and nothing more, and it is already used for the intent gate. A second
 * provider is tried only if the first is unavailable, so a single provider
 * hiccup no longer costs the user their answer.
 */
async function answerOnce(
  env: Env,
  preamble: string,
  parts: { question: string; passages: string },
): Promise<string | null> {
  const user = `${preamble}Pertanyaan pengguna:
${parts.question}

${parts.passages}Tulis jawaban yang menempel pada pertanyaan di atas.`;

  const first = await groqSingleShot(env, {
    label: "grounded-answer",
    system: ANSWERER_SYSTEM,
    user,
    temperature: 0.2,
    maxTokens: 1200,
  }).catch(() => null);
  if (first && first.trim().length > 0) return first;

  // Same answer role, second provider. Different weights would be wrong here -
  // the answerer must stay one model - so this is a fallback for availability,
  // not a second opinion.
  return openrouterRespond(env, user, { topic: parts.question }).catch(() => null);
}