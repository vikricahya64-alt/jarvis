//=====================================================================
// comprehension.ts — ROOT comprehension engine (m9-v11.32).
//
// Visi pemilik (m9-v11.32): semua kemampuan JARVIS (cabang) berakar dari
// kemampuan memahami TEXT/TULISAN (akar). PEMILIK MEMASUKKAN 5 KEMAMPUAN
// FONDASI (rekonstruksi visi, m9-v11.47 — tersurat eksplisit):
//   1. Memahami text/tulisan dalam bentuk apa pun.
//   2. Memahami semua literasi (gaul, formal, teknis, akademik, kreatif).
//   3. Memahami semua bahasa manusia (bukan hanya id/en/ms/jv/su).
//   4. Memahami semua bidang ilmu pengetahuan.
//   5. Adaptasi per sesi pemilik (jawaban pemilik: "untuk saya sendiri").
//
// KEMAMPUAN CABANG (juga dimasukkan pemilik, m9-v11.49 tersurat): memahami &
// MENGGUNAKAN kemampuan sesuai OUTPUT TERBAIK — prinsip substitusi: saat
// kemampuan bawaan memberi output yang tak benar-benar bersumber (model
// knowledge yang dipoles — grounded=false, atau butir yang diminta tak dikutip
// dari pencarian nyata), JARVIS sebagai negosiator MENOLAK output itu dan
// menawarkan eksekutor pinjaman yang output-nya SAMA/LEBIH BAIK (evidence
// di-branch executor_selection.ts; eksekusi tetap menunggu persetujuan pemilik).
//
// REKONSTRUKSI FONDASI KE-6 (m9-v11.47): mampu memahami & MENGGUNAKAN SEMUA
// KEMAMPUAN FONDASI (1-5), kemampuan cabang di atas, DAN semua kemampuan lain
// secara TEPAT — berakar
// dari fondasi 1-4 (pahami teks itulah yang dipahami), bersandar pada 5
// (adaptif per pemilik) dan pada kemampuan cabang (pilih output TERBAIK,
// bukan output yang paling nyaman dihasilkan inline).
//
// PRINSIP SANDARAN SEMUA (m9-v11.51) — pemilik: jangan terpaku pada satu visi
// per kemampuan. SEMUA kemampuan fondasi (1-7) menjadi SANDARAN SEMUA
// kemampuan: tak ada kemampuan yang bertumpu hanya pada satu fondasi; seluruh
// fondasi menyangga setiap kemampuan sekaligus (registri: foundations =
// ALL_FOUNDATIONS, dipaksa testFoundationAnchoring). Konsekuensi arsitektur:
//   - Setiap kemampuan didaftarkan sebagai KONTRAK TEKS (capability_registry):
//     id + ringkasan + pemicu + izin + intent tertunda (parked). Menambah
//     kemampuan = menambah satu kontrak, bukan regex liar per file.
//   - Router membaca kontrak tersebut (resolveCommandCapability /
//     resolveParkedResumeWords / matchWebhookPreCapability / capabilityIntent)
//     dan sumbu-bentuk (intelligence.heavyCapabilityShape, isSourcingOrder).
//   - Pengetahuan-diri (describeAllCapabilities / capabilityContextBlock)
//     DIBANGKITKAN dari kontrak teks — dipakai di /kemampuan dan system prompt
//     sehingga model memahami kemampuan nyata, bukan mengarang.
//   - Karena akar-nya komprehensi teks, "memahami diri" ikut-ikutan paham
//     tiap pembaruan kemampuan tanpa perlu di-rekode per kasus.
//
// Engine ini ADITIF — tidak menghapus cabang apa pun (normalize,
// translate, research, memory, dst). Ia hanya melengkapi
// lapisan persepsi dengan profil pemahaman yang lebih dalam, murni
// deterministic & zero-cost (free tier) sehingga aman dipakai di tiap
// turn. Fail-open: bila teks tak cocok pola apa pun, tetap mengembalikan
// profil netral "umum" — tidak pernah error.
//
// Referensi data:
// - ISO 639-1 language codes
// - UAX #24 Script property untuk deteksi aksara
// - Fungsi umum (function words) untuk deteksi bahasa Latin
//=====================================================================

// ============================================================================
// TYPES
// ============================================================================

/** Aksara utama teks (UAX #24 Script). */
export type Script = "latin" | "hans" | "kana" | "hangul" | "arabic" | "cyrillic" | "devanagari" | "bengali" | "thai" | "greek" | "hebrew" | "tamil" | "unknown";

/** Bahasa utama teks (ISO 639-1 + varian lokal). 'unknown' = tak teridentifikasi. */
export type ComprehendLang =
  | "en" | "id" | "ms" | "jv" | "su" | "es" | "fr" | "de" | "it" | "pt" | "nl"
  | "vi" | "tl" | "tr" | "pl"
  | "ja" | "zh" | "ko" | "ar" | "ru" | "hi" | "bn" | "th" | "el" | "he" | "ta"
  | "unknown";

/** Registrasi literasi teks. */
export type Literacy =
  | "gaul"       // slang / social-media / sangat santai
  | "formal"     // resmi, hormat
  | "teknis"     // kode, API, implementasi
  | "akademik"   // penelitian, ilmiah
  | "kreatif"    // naratif, puitis, imajinatif
  | "sehari-hari" // netral percakapan
  | "mixed"
  | "unknown";

/** Bidang ilmu pengetahuan utama teks. */
export type KnowDomain =
  | "teknologi_ai" | "ekonomi_bisnis" | "kesehatan" | "hukum" | "sains"
  | "agrikultur_pangan" | "lingkungan_iklim" | "olahraga_rekreasi"
  | "sosial_humaniora" | "seni_desain" | "pendidikan" | "milik" | "umum";

/** Hasil pemahaman akar sebuah teks. */
export interface ComprehensionProfile {
  /** Bahasa utama + aksara + confidence 0..1. */
  language: { code: ComprehendLang; name: string; script: Script; confidence: number };
  /** Registrasi literasi + confidence. */
  literacy: { type: Literacy; confidence: number };
  /** Bidang ilmu + confidence. */
  domain: { type: KnowDomain; confidence: number };
  /** Daftar bahasa yang terdeteksi campur (code-switching). */
  mixed: ComprehendLang[];
  /** Rekomendasi adaptasi per-bahasa. */
  adapt: {
    formality: "formal" | "casual" | "netral";
    honorifics: boolean;
    tone: "santai" | "hangat-menghargai" | "teknis-lugas" | "ilmiah" | "kreatif";
  };
}

// ============================================================================
// LANGUAGE TABLES
// ============================================================================

export const LANG_NAMES: Record<ComprehendLang, string> = {
  en: "Inggris", id: "Indonesia", ms: "Melayu", jv: "Jawa", su: "Sunda",
  es: "Spanyol", fr: "Prancis", de: "Jerman", it: "Italia", pt: "Portugis", nl: "Belanda",
  vi: "Vietnam", tl: "Tagalog", tr: "Turki", pl: "Polandia",
  ja: "Jepang", zh: "Mandarin", ko: "Korea", ar: "Arab", ru: "Rusia",
  hi: "Hindi", bn: "Bengali", th: "Thai", el: "Yunani", he: "Ibrani", ta: "Tamil",
  unknown: "Tidak diketahui",
};

/** Function-word scoring per bahasa Latin (frasa umum khas bahasa). */
const LATIN_PATTERNS: Record<Extract<ComprehendLang, "en" | "id" | "ms" | "jv" | "su" | "es" | "fr" | "de" | "it" | "pt" | "nl" | "vi" | "tl" | "tr" | "pl">, RegExp[]> = {
  en: [
    /\b(?:the|and|is|are|was|were|you|your|what|where|when|why|how|with|have|has|this|that|it's|could|would|about|for|from|of|to|in|on)\b/gi,
  ],
  id: [
    /\b(?:yang|dan|di|ke|dari|itu|ini|saya|kamu|aku|untuk|dengan|tidak|bisa|sudah|belum|akan|harus|karena|kepada|pada|ada|juga|apa|yang)\b/gi,
  ],
  ms: [
    /\b(?:adalah|ialah|dan|di|ke|dari|saya|kamu|anda|untuk|dengan|tidak|boleh|sudah|belum|akan|harus|kerana|sebagai|yang|ini|itu)\b/gi,
  ],
  jv: [
    /\b(?:iku|iku|karo|saka|uga|wis|durung|aku|kowe|kula|sampeyan|neng|ing|menyang|sing|kanggo|lha|yo|opo|piye)\b/gi,
  ],
  su: [
    /\b(?:ieu|eta|jeung|ti|ka|ku|anjeun|kuring|nyeh|nu|ngan|moal|tiasa|abdi|sareng|sae|getol)\b/gi,
  ],
  es: [
    /\b(?:el|la|los|las|es|son|con|por|para|usted|que|como|donde|cual|cómo|muy|también|pero|más|puedo)\b/gi,
  ],
  fr: [
    /\b(?:le|la|les|est|sont|avec|pour|vous|que|qui|comment|où|très|aussi|mais|plus|peut|pas)\b/gi,
  ],
  de: [
    /\b(?:der|die|das|und|ist|sind|mit|für|sie|ich|was|wo|wie|sehr|auch|aber|mehr|kann|nicht)\b/gi,
  ],
  it: [
    /\b(?:il|la|lo|gli|sono|con|per|tu|che|come|dove|molto|anche|ma|può|non)\b/gi,
  ],
  pt: [
    /\b(?:o|a|os|as|é|são|com|para|você|que|como|onde|muito|também|mas|pode|não)\b/gi,
  ],
  nl: [
    /\b(?:de|het|en|is|zijn|met|voor|je|wat|waar|hoe|heel|ook|maar|kan|niet)\b/gi,
  ],
  vi: [
    /\b(?:và|cho|của|là|có|không|bạn|anh|chị|em|tôi|ở|trong|với|nhưng|này|đó|được|phải|sẽ|đã)\b/gi,
  ],
  tl: [
    /\b(?:ang|ng|nga|sa|si|ay|ako|ikaw|kayo|namin|ninyo|ba|po|opo|oo|hindi|kasi|para|may|mayroon|gusto)\b/gi,
  ],
  tr: [
    /\b(?:bir|ve|bu|şu|o|ben|sen|siz|biz|için|ile|gibi|ama|de|da|mi|ne|nerede|nasıl|çok|var|yok|istediğim)\b/gi,
  ],
  pl: [
    /\b(?:i|w|na|z|do|to|jest|są|ty|ja|my|wy|czy|co|gdzie|jak|bardzo|ale|może|nie|mam|chcę)\b/gi,
  ],
};

/** Deteksi aksara utama (UAX #24) + bahasa non-Latin yang pasti. */
function detectScriptAndExotic(text: string): { script: Script; lang: ComprehendLang; confidence: number } {
  // Kana (hiragana/katakana) → Jepang pasti.
  if (/[\u3040-\u30ff]/.test(text)) return { script: "kana", lang: "ja", confidence: 0.98 };
  // Hangul → Korea.
  if (/[\uac00-\ud7af]/.test(text)) return { script: "hangul", lang: "ko", confidence: 0.98 };
  // Han (CJK ideograf) + belum ada kana → Mandarin (Jepang biasanya juga pakai kana).
  if (/[\u4e00-\u9fff]/.test(text)) return { script: "hans", lang: "zh", confidence: 0.96 };
  // Arab/Persia block.
  if (/[\u0600-\u06ff]/.test(text)) return { script: "arabic", lang: "ar", confidence: 0.95 };
  // Cyrillic → Rusia (common default; uk/bg/sr diserap ke ru).
  if (/[\u0400-\u04ff]/.test(text)) return { script: "cyrillic", lang: "ru", confidence: 0.85 };
  // Devanagari → Hindi.
  if (/[\u0900-\u097f]/.test(text)) return { script: "devanagari", lang: "hi", confidence: 0.95 };
  // Bengali (Bengali block).
  if (/[\u0980-\u09ff]/.test(text)) return { script: "bengali", lang: "bn", confidence: 0.95 };
  // Thai.
  if (/[\u0e00-\u0e7f]/.test(text)) return { script: "thai", lang: "th", confidence: 0.97 };
  // Greek.
  if (/[\u0370-\u03ff]/.test(text)) return { script: "greek", lang: "el", confidence: 0.97 };
  // Hebrew.
  if (/[\u0590-\u05ff]/.test(text)) return { script: "hebrew", lang: "he", confidence: 0.95 };
  // Tamil.
  if (/[\u0b80-\u0bff]/.test(text)) return { script: "tamil", lang: "ta", confidence: 0.95 };
  return { script: "latin", lang: "unknown", confidence: 0 };
}

/**
 * Deteksi bahasa universal — SATU-SATUNYA mesin deteksi bahasa JARVIS (f3)
 * sejak jarvis_language.ts dihapus (m9-v11.51+).
 * Skor function-word untuk bahasa Latin + deteksi aksara untuk non-Latin.
 * Deterministic, fail-open (unknown bila tak cocok).
 */
export function detectLanguageUniversal(text: string): ComprehensionProfile["language"] {
  const t = (text || "").trim();
  if (!t) {
    return { code: "unknown", name: LANG_NAMES.unknown, script: "unknown", confidence: 0 };
  }

  const exotic = detectScriptAndExotic(t);
  if (exotic.lang !== "unknown") {
    return { code: exotic.lang, name: LANG_NAMES[exotic.lang], script: exotic.script, confidence: exotic.confidence };
  }

  // Latin → function-word scoring.
  let best: { code: ComprehendLang; score: number } = { code: "unknown", score: 0 };
  let second = 0;
  for (const [code, pats] of Object.entries(LATIN_PATTERNS) as Array<[keyof typeof LATIN_PATTERNS, RegExp[]]>) {
    let score = 0;
    for (const p of pats) {
      const m = t.match(p);
      if (m) score += m.length;
    }
    if (score > best.score) {
      second = best.score;
      best = { code, score };
    } else if (score === best.score && score > 0) {
      // tie → treat as mixed (code-switching) later; keep first as primary
      second = score;
    }
  }

  if (best.score === 0) {
    // Latin tanpa function-word khas: teks sangat pendek / nama / kode.
    return { code: "unknown", name: LANG_NAMES.unknown, script: "latin", confidence: 0.2 };
  }
  // margin rule: bila bahasa kedua hampir menyusul → langkah campur (mixed)
  // masih dikembalikan primary + flag mixed via `mixed` field di profile.
  const confidence = Math.min(1, best.score / 8);
  return { code: best.code, name: LANG_NAMES[best.code], script: "latin", confidence: Math.max(0.4, confidence) };
}

// ============================================================================
// LITERACY REGISTER
// ============================================================================

/** Kosa-tanda khas tiap registrasi literasi (deterministic). */
const LITERACY_MARKERS: Record<Exclude<Literacy, "mixed" | "unknown">, RegExp[]> = {
  gaul: [
    /\b(?:wkwk|wkwkwk|bgt|bgtt|nggak|ngga|gak|gk|gaa|akwoak|fyp|dm|kepo|toxic|okay|okeh|hehe|haha|hihi|pls|plis|btw|fyh|sigma|jungkook|tbh|idc|idk)\b/i,
    /(!{2,}|\.{3,})/,
  ],
  formal: [
    /\b(?:yang terhormat|dengan hormat|bersama ini|kami sampaikan|dimohon|diharapkan|hormat kami|ayat|pasal|sebagaimana|berdasarkan|menindaklanjuti|ybs|Bapak|Ibu)\b/i,
  ],
  teknis: [
    /\b(?:api|endpoint|server|client|database|query|sql|deploy|bug|fix|commit|repo|repository|code|coding|script|function|variable|class|async|await|array|string|integer|boolean|framework|library|package|npm|git|docker|runtime|dependency)\b/i,
    /(`[^`]*`|```|=>|===|function\s+\w+\s*\(|\bconst\s+\w+\s*=)/,
  ],
  akademik: [
    /\b(?:penelitian|riset|studi|hipotesis|metodologi|metodology|tinjauan pustaka|literature review|variabel|sampel|data|hipotetis|analisis|analisa|teori|empiris|kualitatif|kuantitatif|temuan|kesimpulan|abstrak|jurnal)\b/i,
  ],
  kreatif: [
    /\b(?:bayangkan|andai|cerita|narasi|karakter|alur|tema|metafora|imajinasi|mimpi|puisi|syair|tokoh|setting|latar|dialog|deskripsi|lukisan|sketsa)\b/i,
  ],
  "sehari-hari": [
    /\b(?:halo|hai|hey|kenapa|bagaimana|gimana|mau|ingin|tolong|bantu|kamu|saya|apakah|sudah|belum|terima kasih|makasih)\b/i,
  ],
};

/** Deteksi registrasi literasi teks. Deterministic, fail-open → "sehari-hari". */
export function detectLiteracy(text: string): ComprehensionProfile["literacy"] {
  const t = (text || "").trim();
  if (!t) return { type: "unknown", confidence: 0 };

  let best: { type: Exclude<Literacy, "mixed" | "unknown">; score: number } = { type: "sehari-hari", score: 0 };
  for (const [type, pats] of Object.entries(LITERACY_MARKERS) as Array<[Exclude<Literacy, "mixed" | "unknown">, RegExp[]]>) {
    let score = 0;
    for (const p of pats) {
      const m = t.match(p);
      if (m) score += type === "sehari-hari" ? m.length : m.length * 1.5;
    }
    if (score > best.score) best = { type, score };
  }

  if (best.score === 0) return { type: "unknown", confidence: 0.15 };
  const confidence = Math.min(1, best.score / 4);
  return { type: best.type, confidence: Math.max(0.4, confidence) };
}

// ============================================================================
// KNOWLEDGE DOMAIN
// ============================================================================

const DOMAIN_MARKERS: Record<Exclude<KnowDomain, "umum">, RegExp[]> = {
  teknologi_ai: [
    /\b(?:ai|ml|llm|gpt|model|training|inference|dataset|neural|machine learning|deep learning|cloud|kubernetes|python|javascript|typescript|programming|algorithm|crypto|blockchain|web3|token|nft|gpu|cpu|api|framework|frontend|backend)\b/i,
  ],
  ekonomi_bisnis: [
    /\b(?:ekonomi|bisnis|pasar|saham|investasi|kripto|crypto?|keuangan|finansial|fintech|modal|keuntungan|laba|rugi|inflasi|harga jual|produk|pemasaran|marketing|analisis bisnis|startup|bisnis online|raksasa|raket)\b/i,
  ],
  kesehatan: [
    /\b(?:kesehatan|medis|dokter|gejala|penyakit|obat|vitamin|nutrisi|imun|tubuh|jiwa|mental|terapi|diagnosa|pasien|rumah sakit|gizi|darah|jantung)\b/i,
  ],
  hukum: [
    /\b(?:hukum|undang-undang|uu|pasal|peraturan|perdata|pidana|konstitusi|jaksa|pengadilan|advokat|hakim|saksi|gugatan|norma|legal|zakat|hapus|ancaman)\b/i,
  ],
  sains: [
    /\b(?:fisika|kimia|biologi|astronomi|matematika|rumus|atom|sel|gravitasi|kuantum|planet|bintang|galaksi|ekosistem|evolusi|teori relativitas|energi|reaksi|molekul)\b/i,
    /\b(?:genetika|dna|rnase?|fotosintesis|termodinamika|mekanika|foton|elektron|isotop|teropong|teleskop|partikel|pembuluh|angiogenesis|ensim|enzim|protein|metabolisme)\b/i,
  ],
  agrikultur_pangan: [
    /\b(?:pertanian|tanaman|panen|bibit|pupuk|lahan|irigasi|benih|sayur|sayuran|buah|padi|gandum|jagung|kebun|petani|ternak|beternak|pakan|komoditas pangan|resep|masakan|bumbu|memasak|menanak|gizi?)\b/i,
  ],
  lingkungan_iklim: [
    /\b(?:lingkungan|iklim|cuaca|hujan|kemarau|pemanasan global|emisi|karbon|polusi|polutan|limbah|daur ulang|recycle|ekosistem|keberlanjutan|energi terbarukan|panel surya|walhi?|su-?hu bumi)\b/i,
  ],
  olahraga_rekreasi: [
    /\b(?:sepak bola|lari|berlari|bola|badminton|bulu tangkis|renang|bersepeda|gym|fitness|latihan|kebugaran|olimpik|turnamen|pertandingan|skor|liga|tim|pemain|liga inggris|meraton|marathon)\b/i,
  ],
  sosial_humaniora: [
    /\b(?:sosial|psikologi|filsafat|sejarah|budaya|sosiologi|politik|antropologi|etika|masyarakat|komunikasi|identitas|religi|agama|norma sosial|kebenaran)\b/i,
  ],
  seni_desain: [
    /\b(?:desain|design|logo|poster|gambar|lukisan|foto|fotografi|warna|tipografi|layout|branding|identitas visual|ilustrasi|animasi|video|musik|film|estetika)\b/i,
  ],
  pendidikan: [
    /\b(?:belajar|pelajar|pendidikan|sekolah|kuliah|universitas|materi|tugas|ujian|pr|skripsi|jurusan|kurikulum|guru|dosen|kelas)\b/i,
  ],
  milik: [
    /\b(?:jarvis|biyono|vsco|boutique)\b/i,
  ],
};

/** Deteksi bidang ilmu utama. Deterministic, fail-open → "umum". */
export function detectKnowledgeDomain(text: string): ComprehensionProfile["domain"] {
  const t = (text || "").trim();
  if (!t) return { type: "umum", confidence: 0.15 };

  let best: { type: Exclude<KnowDomain, "umum">; score: number } | null = null;
  for (const [domain, pats] of Object.entries(DOMAIN_MARKERS) as Array<[Exclude<KnowDomain, "umum">, RegExp[]]>) {
    let score = 0;
    for (const p of pats) {
      const m = t.match(p);
      if (m) score += m.length;
    }
    if (!best || score > best.score) best = { type: domain, score };
  }

  if (!best || best.score === 0) return { type: "umum", confidence: 0.2 };
  const confidence = Math.min(1, best.score / 3);
  return { type: best.type, confidence: Math.max(0.4, confidence) };
}

// ============================================================================
// ADAPTATION MAP (per-bahasa)
// ============================================================================

interface AdaptHints {
  formality: "formal" | "casual" | "netral";
  honorifics: boolean;
  tone: ComprehensionProfile["adapt"]["tone"];
}

const ADAPT: Record<ComprehendLang, AdaptHints> = {
  en: { formality: "netral", honorifics: false, tone: "santai" },
  id: { formality: "casual", honorifics: true, tone: "hangat-menghargai" },
  ms: { formality: "casual", honorifics: true, tone: "hangat-menghargai" },
  jv: { formality: "formal", honorifics: true, tone: "hangat-menghargai" },
  su: { formality: "formal", honorifics: true, tone: "hangat-menghargai" },
  es: { formality: "casual", honorifics: false, tone: "hangat-menghargai" },
  fr: { formality: "casual", honorifics: false, tone: "hangat-menghargai" },
  de: { formality: "netral", honorifics: false, tone: "teknis-lugas" },
  it: { formality: "casual", honorifics: false, tone: "hangat-menghargai" },
  pt: { formality: "casual", honorifics: false, tone: "hangat-menghargai" },
  nl: { formality: "netral", honorifics: false, tone: "teknis-lugas" },
  ja: { formality: "formal", honorifics: true, tone: "hangat-menghargai" },
  zh: { formality: "formal", honorifics: true, tone: "hangat-menghargai" },
  ko: { formality: "formal", honorifics: true, tone: "hangat-menghargai" },
  ar: { formality: "formal", honorifics: true, tone: "hangat-menghargai" },
  ru: { formality: "netral", honorifics: false, tone: "teknis-lugas" },
  hi: { formality: "casual", honorifics: true, tone: "hangat-menghargai" },
  bn: { formality: "formal", honorifics: true, tone: "hangat-menghargai" },
  th: { formality: "formal", honorifics: true, tone: "hangat-menghargai" },
  el: { formality: "netral", honorifics: false, tone: "teknis-lugas" },
  he: { formality: "formal", honorifics: true, tone: "hangat-menghargai" },
  ta: { formality: "formal", honorifics: true, tone: "hangat-menghargai" },
  vi: { formality: "formal", honorifics: true, tone: "hangat-menghargai" },
  tl: { formality: "netral", honorifics: true, tone: "hangat-menghargai" },
  tr: { formality: "netral", honorifics: false, tone: "teknis-lugas" },
  pl: { formality: "netral", honorifics: false, tone: "teknis-lugas" },
  unknown: { formality: "netral", honorifics: false, tone: "santai" },
};

/** Registrasi literacy → tone rekomendasi (silang dengan map bahasa). */
const LITERACY_TONE: Record<Literacy, ComprehensionProfile["adapt"]["tone"] | "default"> = {
  gaul: "santai",
  formal: "hangat-menghargai",
  teknis: "teknis-lugas",
  akademik: "ilmiah",
  kreatif: "kreatif",
  "sehari-hari": "santai",
  mixed: "default",
  unknown: "default",
};

// ============================================================================
// MAIN ENTRY
// ============================================================================

/**
 * Pahami teks secara universal (akar): bahasa, literasi, bidang, adaptasi.
 * Deterministic & fail-open — selalu kembalikan profil valid.
 */
export function comprehend(text: string): ComprehensionProfile {
  const lang = detectLanguageUniversal(text);

  // Bahasa non-Latin / jelas → hanya 1 bahasa. Latin → cek code-switching:
  // bila terdapat >=2 function-word khas bahasa Latin lain selain primary.
  const mixed: ComprehendLang[] = [];
  if (lang.script === "latin" && lang.code !== "unknown") {
    const patterns = LATIN_PATTERNS as Record<string, RegExp[]>;
    for (const [other, pats] of Object.entries(patterns)) {
      if (other === lang.code) continue;
      let hits = 0;
      for (const p of pats) {
        const m = text.match(p);
        if (m) hits += m.length;
      }
      if (hits >= 2) mixed.push(other as ComprehendLang);
    }
  }

  const literacy = detectLiteracy(text);
  const domain = detectKnowledgeDomain(text);

  const adaptBase = ADAPT[lang.code];
  const literacyTone = LITERACY_TONE[literacy.type];
  const tone = literacyTone === "default" ? adaptBase.tone : literacyTone;

  return {
    language: lang,
    literacy,
    domain,
    mixed,
    adapt: {
      formality: adaptBase.formality,
      honorifics: adaptBase.honorifics,
      tone,
    },
  };
}

/**
 * Ringkasan profil untuk yang bisa disuntikkan ke prompt (catatan pemahaman).
 * Diterjemahkan alami, bukan JSON mentah — agar model memahami arah adaptasi.
 */
export function comprehensionNote(profile: ComprehensionProfile): string {
  const name = profile.language.name;
  const canMix = profile.mixed.length
    ? ` campur ${profile.mixed.map((l) => LANG_NAMES[l] ?? l).join(", ")}`
    : "";
  const litMap: Record<Literacy, string> = {
    gaul: "bahasa santai/slang", formal: "bahasa resmi", teknis: "bahasa teknis",
    akademik: "bahasa ilmiah", kreatif: "bahasa kreatif", "sehari-hari": "bahasa sehari-hari",
    mixed: "campuran", unknown: "belum jelas",
  };
  const domMap: Record<KnowDomain, string> = {
    teknologi_ai: "teknologi/AI", ekonomi_bisnis: "ekonomi/bisnis", kesehatan: "kesehatan",
    hukum: "hukum", sains: "sains", agrikultur_pangan: "pertanian/pangan",
    lingkungan_iklim: "lingkungan/iklim", olahraga_rekreasi: "olahraga/rekreasi",
    sosial_humaniora: "sosial/humaniora",
    seni_desain: "seni/desain", pendidikan: "pendidikan", milik: "diri sendiri (JARVIS/pemilik)",
    umum: "umum",
  };
  const tone = profile.adapt.tone === "hangat-menghargai"
    ? "hangat dan menghargai"
    : profile.adapt.tone === "teknis-lugas"
      ? "teknis dan lugas"
      : profile.adapt.tone === "santai"
        ? "santai"
        : profile.adapt.tone === "ilmiah"
          ? "ilmiah"
          : "kreatif";
  return (
    `Pemahaman input: bahasa ${
      name === "Tidak diketahui" ? "belum teridentifikasi" : profile.language.name
    }${canMix} (${litMap[profile.literacy.type]}), ` +
    `bidang ${domMap[profile.domain.type] === "umum" ? "belum terpola" : domMap[profile.domain.type]}. ` +
    `Arah adaptasi: bicara ${tone}, gunakan bahasa yang sama dengan pemilik, ` +
    `${profile.adapt.honorifics ? "gunakan sapaan yang menghargai" : "sapaan sederhana"}.`
  );
}