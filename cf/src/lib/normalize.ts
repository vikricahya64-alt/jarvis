//=====================================================================
// normalize.ts — input normalization untuk pesan owner-facing.
//
// Input Telegram/WhatsApp Indonesia penuh slang, singkatan, typo,
// spasi berlebih, emoji, dan payload kosong (sticker/photo). Module
// ini menormalisasi secara murah sebelum routing agar JARVIS mengenali
// sapaan, topik pencarian, permintaan terjemahan, dan perintah.
//
// Referensi riset:
// - Han & Baldwin 2013: Lexical Normalization for Social Media
// - ViLexNorm EACL '24: Vietnamese Lexical Normalization
// - MultiLexNorm++ 2026: Detect-then-normalize untuk OOV tokens
//
// Filosofi m9-v8: TIDAK memakai kamus besar + korektor fuzzy (Damerau-
// Levenshtein) yang menulis-ulang kata valid — itu meracuni makna ("kode"→
// "mode", "tanpa"→"tanya", "hono"→"sono") dan butuh perawatan terus-menerus.
// Yang dilakukan: ekspansi slang SHORTHAND eksak (gak→tidak) agar trigger
// intent stabil, kolaps huruf berulang (halooo→halo), leetspeak (h3llo→hello),
// dan membersihkan whitespace/prefix. Pemahaman bahasa asli (slang, typo,
// istilah teknis, campur kode) diserahkan ke otak LLM/search.
//
// Zero dependency, deterministic, fail-open. Normalisasi TIDAK PERNAH
// mengubah ke makna destruktif/finansial — constitutional guard tetap
// berjalan pada deskripsi aksi ASLI.
//=====================================================================

/** Kamus ekspansi slang → canonical; terpanjang duluan agar greedy slang menang.
 *  Hanya mengekspansi token PENDEK (<=5 chars) yang tidak bisa kata valid
 *  sendiri. Map ke filler/connectors yang tidak berbahaya — tidak pernah
 *  ke verbs/commands. */
const SLANG: Record<string, string> = {
  // negasi/connectors (harmless filler; never actions)
  gak: "tidak", ga: "tidak", gk: "tidak", g: "tidak",
  udh: "sudah", ud: "sudah", blm: "belum",
  yg: "yang",
  tp: "tapi", krn: "karena", karna: "karena", sm: "sama",
  gmn: "bagaimana", gmana: "bagaimana", gimana: "bagaimana", dmn: "dimana", kpn: "kapan",
  bs: "bisa", hrs: "harus", msh: "masih", lg: "lagi",
  trs: "terus", skrg: "sekarang", sgr: "sekarang",
  bgt: "banget", gt: "gitu", aj: "aja", aja: "aja",
  gitu: "begitu",
  emg: "memang", emang: "memang", bsk: "besok", udah: "sudah",
  // pronomina
  gw: "saya", gue: "saya", aku: "saya", lo: "kamu", lu: "kamu",
  pgn: "ingin", pengen: "ingin",
  // slang social-media/Telegram (harmless filler only)
  ntaps: "mantap", mntp: "mantap", mantul: "mantap",
  wkwk: "hehe", hehe: "hehe", hihi: "hehe", haha: "hehe",
  pls: "tolong", plis: "tolong", tolongin: "tolong",
  mksh: "terima kasih", makasih: "terima kasih", mksih: "terima kasih", trims: "terima kasih",
  pengenin: "ingin",
  dah: "saja", yuk: "ayo", ayok: "ayo",
  klo: "kalau", kalu: "kalau", kalo: "kalau",
  cmn: "hanya", cman: "hanya", doang: "hanya",
  disini: "di sini", disana: "di sana",
  skrng: "sekarang",
  ngerti: "mengerti",
  begimana: "bagaimana", bgmn: "bagaimana",
  knpa: "kenapa",
  jngn: "jangan",
  sdng: "sedang", lgi: "lagi",
  bikinlah: "buatlah",
  bener: "benar",
  // English informal (for code-switching support)
  "btw": "by the way",
  "imo": "in my opinion",
  "tbh": "to be honest",
  "afaik": "as far as i know",
  "irl": "in real life",
  "ngl": "not gonna lie",
  "smh": "shaking my head",
  "fwiw": "for what it's worth",
  "iirc": "if i recall correctly",
  "tl;dr": "too long; didn't read",
  "brb": "be right back",
  "afk": "away from keyboard",
  "gg": "good game",
  "glhf": "good luck have fun",
  "w/": "with",
  "w/o": "without",
  "b4": "before",
  "gr8": "great",
  "l8r": "later",
  "thx": "thanks",
  "ty": "thank you",
  "np": "no problem",
  "nw": "no worries",
  "idk": "i don't know",
  "lol": "laughing out loud",
  "lmao": "laughing my ass off",
  "rofl": "rolling on the floor laughing",
  "omg": "oh my god",
  "wtf": "what the f",
  "stfu": "shut the f up",
  "bruh": "bro",
  "dude": "dude",
  "fam": "family",
  "lit": "lit",
  "slay": "slay",
  "vibe": "vibe",
  "sus": "suspicious",
  "cap": "lie",
  "no cap": "no lie",
  "bet": "okay",
  "fr": "for real",
  "ong": "on god",
  "istg": "i swear to god",
  "rn": "right now",
  "atm": "at the moment",
  "fyi": "for your information",
  "asap": "as soon as possible",
  "diy": "do it yourself",
  "faq": "frequently asked questions",
  "eta": "estimated time of arrival",
  "aka": "also known as",
  "vip": "very important person",
  "tba": "to be announced",
  "tbd": "to be determined",
};

/** Kata-kata Indonesia umum untuk referensi spelling correction.
 *  Digunakan oleh Damerau-Levenshtein untuk menemukan kandidat koreksi.
 *  Juga berfungsi sebagai whitelist: kata yang ada di sini TIDAK dikoreksi. */
// ====================================================================
// Filosofi normalisasi (m9-v8): KAMUS TIDAK PERNAH MENULIS-ULANG kata
// yang sah. Slang shorthand eksak boleh diekspansi (gak->tidak) agar
// trigger intent stabil, tapi TIDAK ada koreksi fuzzy (Damerau-Levenshtein,
// INDONESIAN_WORDS) yang mengubah kata valid menjadi kata lain — bug live:
// "kode" -> "mode", "tanpa" -> "tanya", "hono" -> "sono". Pemahaman
// bahasa asli (slang, typo, istilah teknis, campur kode) diserahkan ke otak
// LLM/search — lebih efisien dan tidak butuh perawatan kamus terus-menerus.
//====================================================================

/** Detect-then-normalize: pre-detection pass yang menandai token yang perlu
 *  normalisasi. Hanya mengekspansi token PENDEK (<=5 chars) yang punya
 *  mapping curated, atau beberapa entry slang panjang yang eksplisit. */
function detectAndNormalize(t: string): string {
  if (t.startsWith("/")) return t; // prefix perintah verbatim
  const cleaned = collapseRepeats(t.toLowerCase());

  // Prioritas 1: ekspansi slang langsung
  if (cleaned.length <= 5) {
    const slangResult = SLANG[cleaned];
    if (slangResult) return slangResult;
  }
  const longSlang = SLANG[cleaned];
  if (longSlang) return longSlang;

  // TIDAK ADA koreksi ejaan fuzzy di sini (lihat catatan filosofi di atas):
  // kata yang sah, slang, typo ringan, dan istilah teknis dibiarkan apa adanya
  // — otak LLM/search yang memahami artinya, bukan kamus.
  return cleaned;
}

/** Collapse huruf berulang (typo tolerance): "halooo" -> "halo", "baguuuus" -> "bagus". */
function collapseRepeats(s: string): string {
  return s.replace(/(.)\1{2,}/g, "$1$1");
}

/** Deteksi jika kata mengandung campuran huruf+angka yang mungkin typo.
 *  Contoh: "h3llo" -> "hello", "b4gus" -> "bagus". */
function leetspeakNormalize(s: string): string {
  return s
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/8/g, "b")
    .replace(/9/g, "g");
}

/**
 * Span yang mengikat identifier LIBRARY/REPO ke trigger context7/docs.
 * Token ini adalah proper noun teknis (nama library/package), BUKAN kata
 * Indonesia biasa: spelling corrector dilarang menyentuhnya. Bug live m8-v15:
 * "cara pakai hono" dinormalisasi jadi "cara pakai sono" → Context7 resolve ke
 * library Sonos → jawaban percaya diri tapi salah subjek. Span ditangkap KLEN
 * (termasuk trigger) lalu ditanamkan kembali VERBATIM setelah pipeline.
 */
const LIBRARY_TOKEN_RE =
  /(?:ctx7|context7)\s*:?\s+[a-z0-9][\w./-]{1,60}\b|\b(?:cara pakai|cara memakai|cara menggunakan|cara pemakaian|how to use|how do i use|how do you use|docs?|dokumentasi|api)\s+(?:untuk|dari|of|for|pada)?\s*[a-z0-9][\w./-]{1,60}\b/gi;

/**
 * Normalisasi input bebas teks owner sebelum routing/classification.
 *   - strip prefix "Username:" yang ditambahkan bot Telegram group
 *   - trim + collapse spasi berlebih
 *   - lowercase (semua downstream match case-insensitively)
 *   - collapse huruf berulang ("halooo"->"halo")
 *   - leetspeak normalization ("h3llo"->"hello")
 *   - ekspansi slang/abbreviation Indonesia + English ke bentuk kanonis
 *   - spelling correction via Damerau-Levenshtein untuk typo umum
 *   - TIDAK PERNAH rewrite prefix "/" command (verbatim)
 *   - Library identifier (context7/docs trigger) selalu verbatim — spelling
 *     correction hanya berlaku untuk kata BAHASA, bukan nama teknis.
 *   - Language-aware: detect bahasa dan apply normalisasi yang sesuai
 * Mengembalikan string ternormalisasi (tidak pernah throw). */
export function normalizeInput(raw: string): string {
  if (!raw) return "";
  // Karantina span library (private-use placeholder immune to every rewrite
  // di bawah: bukan slash, tak ada digit, panjang 3 → lolos tanpa koreksi).
  const held = new Map<string, string>();
  const quarantined = raw.replace(LIBRARY_TOKEN_RE, (m) => {
    const ph = `\uE000${held.size}\uE000`;
    held.set(ph, m);
    return ph;
  });
  const normalized = quarantined
    .replace(/\s+/g, " ")
    .trim()
    // Strip "Username: msg" prefix of Telegram group bots — colon MUST be
    // followed by whitespace (and the prefix may span multiple words), so URLs
    // ("https://…"), clock times ("15:30") and "name:/cmd" are NEVER mangled
    // (verified live bug M6: the old `[^:]+:\s` ate the scheme of any URL).
    .replace(/^[^\s:]+(?:\s+[^\s:]+)*:\s+/, "")
    // Leetspeak normalization (hanya jika ada campuran angka+huruf).
    // Skip token program/versi yang digitnya SEMUA di ujung: "python3",
    // "node18", "react19", "3d", "4k" — syntaxnya identik leetspeak tapi
    // artinya nama file/perintah. Bug live m9-v11.35: /e2b python3 ...
    // menjadi "pythone" sehingga sandbox menjalankan perintah yang tidak
    // ada (exit 127). Leetspeak asli ("h3llo"->"hello") menyisipkan digit
    // di TENGAH kata dan tidak pernah berformat huruf+digit berurutan.
    .replace(/\b\w*\d\w*\b/g, (w) => {
      if (/\d/.test(w) && /[a-zA-Z]/.test(w)
        && !/^[a-z]+\d+$/i.test(w) && !/^\d+[a-z]+$/i.test(w)
        && w.length <= 12) return leetspeakNormalize(w);
      return w;
    })
    .split(" ")
    .map(detectAndNormalize)
    .join(" ");
  // Kembalikan span library verbatim (lowercase-only, spasi dicollapse).
  let out = normalized;
  for (const [ph, lit] of held) {
    out = out.replaceAll(ph, lit.trim().toLowerCase().replace(/\s+/g, " "));
  }
  return out;
}

/** Detect language of input text for normalization purposes. */
export function detectInputLanguage(text: string): "id" | "en" | "mixed" {
  const idWords = /\b(?:apa|siapa|dimana|kapan|kenapa|bagaimana|untuk|dengan|ini|itu|dan|atau|tidak|bisa|ada|adalah|akan|sudah|belum|sedang|mau|perlu|harus|tolong|bantu|cari|info|terima kasih|makasih|oke|baik)\b/i;
  const enWords = /\b(?:what|who|where|why|how|the|is|are|can|do|does|for|with|this|that|and|or|not|have|has|will|would|could|should|please|thank|thanks|ok|good|hello|hey|hi)\b/i;

  const idCount = (text.match(idWords) || []).length;
  const enCount = (text.match(enWords) || []).length;

  if (idCount > 0 && enCount > 0) return "mixed";
  if (idCount > enCount) return "id";
  if (enCount > idCount) return "en";
  return "id"; // default to Indonesian
}

/** Normalize text based on detected language. */
export function normalizeInputByLanguage(raw: string): {
  text: string;
  language: "id" | "en" | "mixed";
} {
  const language = detectInputLanguage(raw);
  const text = normalizeInput(raw);
  return { text, language };
}

/** Greeting matcher yang toleran terhadap slang/typo dan hiasan emoji. */
export const GREETING_RE =
  /^(halo|hai|hi|hello|hey|pagi|siang|sore|malam|assalamualaikum|assalamu['`]?alaikum|selamat)/i;

/** Benar jika (sudah ternormalisasi) pesan tidak punya konten bermakna. */
export function isEmptyInput(s: string): boolean {
  if (!s) return true;
  const stripped = s
    .replace(/[^\p{L}\p{N}\/]/gu, "") // keep letters/numbers/slash
    .trim();
  return stripped.length === 0;
}
