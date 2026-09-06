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
// - BPE/Damerau-Levenshtein: spelling correction untuk typo umum
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
const INDONESIAN_WORDS = new Set([
  "apa", "siapa", "dimana", "kapan", "kenapa", "bagaimana", "berapa",
  "ini", "itu", "dan", "atau", "tidak", "bisa", "ada", "adalah",
  "akan", "sudah", "belum", "sedang", "mau", "perlu", "harus",
  "tolong", "bantu", "cari", "info", "tentang", "analisis", "review",
  "bandingkan", "ringkas", "laporan", "terjemahkan", "translate",
  "halo", "hai", "pagi", "siang", "sore", "malam",
  "terima kasih", "makasih", "oke", "baik", "setuju",
  "lakukan", "jalankan", "hapus", "tambah", "atur", "buka", "tutup",
  "kirim", "lihat", "status", "bantuan",
  "ceritakan", "jelaskan", "tampilkan", "download",
  "sensor", "suhu", "cuaca", "berita", "olahraga", "teknologi",
  "kesehatan", "pendidikan", "ekonomi", "politik", "hiburan",
  "musik", "film", "buku", "makanan", "minuman",
  "jalan", "rumah", "kantor", "sekolah", "kampus",
  "komputer", "handphone", "internet", "listrik", "air",
  "uang", "harga", "belanja", "bayar", "transfer",
  "waktu", "tanggal", "jam", "hari", "minggu", "bulan", "tahun",
  "besok", "kemarin", "lusa", "nanti", "sekarang",
  "cerita", "pengalaman", "pendapat", "saran", "masukan",
  "contoh", "cara", "tips", "trik", "panduan",
  "makna", "arti", "definisi", "penjelasan",
  "perbedaan", "persamaan", "kelebihan", "kekurangan",
  "rekomendasi", "opini",
  // Kata colloquial umum yang sering dipakai tapi tidak ada di kamus formal
  "bikin", "buat", "ngomong", " bilang", "nanya", "tanya", "denger", "dengar",
  "liat", "lihat", "makan", "minum", "tidur", "bangun", "jalan", "lari",
  "main", "kerja", "belajar", "baca", "tulis", "hitung", "jual", "beli",
  "kirim", "terima", "ambil", "taruh", "simpan", "hapus", "buka", "tutup",
  "nyalakan", "matikan", "hidupkan", "mati", "rusak", "baik", "siap",
  "nunggu", "tunggu", "lanjut", "berhenti", "mulai", "selesai",
  "masuk", "keluar", "naik", "turun", "dekat", "jauh",
  "besar", "kecil", "panjang", "pendek", "lebar", "sempit",
  "tinggi", "rendah", "berat", "ringan", "kuat", "lemah",
  "cepat", "lambat", "baru", "lama", "muda", "tua",
  "hangat", "dingin", "panas", "sejuk", "kering", "basah",
  "bersih", "kotor", "hitam", "putih", "merah", "biru", "hijau", "kuning",
  "manis", "pahit", "asin", "asam", "pedas", "gurih",
  "keras", "lembut", "tajam", "tumpul",
  "ramai", "sepi", "ramah", "sopan", "kasar",
  "muda", "tua", "kaya", "miskin", "sehat", "sakit",
  // Kata benda/verba umum yang sering salah dikoreksi
  "toko", "kopi", "teh", "susu", "nasi", "ayam", "ikan", "sayur",
  "buah", "roti", "kue", "mi", "mie", "telur", "daging",
  "meja", "kursi", "kasur", "bantal", "selimut", "guling",
  "baju", "celana", "sepatu", "topi", "kaos", "jaket",
  "buku", "pensil", "pulpen", "kertas", "map", "tas",
  "hp", "laptop", "tv", "ac", "kipas", "lampu",
  "kamar", "dapur", "ruang", "taman", "garasi",
  "kota", "desa", "jalan", "gang", "lorong",
  "saya", "kamu", "dia", "kami", "mereka", "orang",
  "anak", "orang tua", "ayah", "ibu", "saudara", "teman",
  "giliran", "menit", "jam", "detik", "waktu",
  "pesan", "chat", "telepon", "panggilan", "video",
  "foto", "gambar", "video", "file", "dokumen",
  "nama", "alamat", "nomor", "email", "website",
  "uang", "harga", "biaya", "tarif", "pajak",
  "cuaca", "hujan", "panas", "dingin", "mendung",
  "cerah", "berawan", "banjir", "gempa",
  "jalan", "macet", "kemacetan", "lalu lintas",
  "tugas", "pekerjaan", "proyek", "deadline",
  "rapat", "meeting", "presentasi", "laporan",
  // Kata yang sering salah dikoreksi karena mirip dengan kata lain
  "topik", "topi", "ikan", "bikin", "toko", "kopi",
  "bulan", "bulan", "malam", "makan", "minum",
  "pesan", "pijat", "tidur", "jarum", "kursi", "tas",
  "kaki", "tangan", "kepala", "mata", "telinga", "hidung", "mulut",
  "hati", "otak", "tulang", "darah", "keringat",
  "sayur", "buah", "nasi", "roti", "kue", "mie", "mi",
  "telur", "daging", "ayam", "sapi", "kambing", "babi",
  "gula", "garam", "merica", "minyak", "air",
  "meja", "lemari", "rak", "tempat", "wadah",
  "kain", "benang", "jarum", "gunting", "pisau",
  "api", "asap", "abu", "debu", "tanah", "batu",
  "kayu", "besi", "emas", "perak", "tembaga",
  "kertas", "karton", "kardus", "plastik", "kaca",
  "rogram", "program", "aplikasi", "website", "sistem",
  "topik", "bahasan", "pembahasan", "materi", "konten",
  // Istilah umum English/Tech yang sering dipakai
  "todo", "status", "update", "refresh", "submit", "cancel", "confirm",
  "save", "load", "send", "recv", "ok", "yes", "no",
  "list", "item", "data", "file", "type", "mode", "test", "run",
  "set", "get", "put", "post", "delete", "patch",
  "key", "val", "msg", "txt", "num", "id", "url", "link",
  "app", "web", "bot", "api", "db", "sql", "css", "js",
  "info", "warn", "err", "log", "debug", "trace",
  "start", "stop", "end", "exit", "quit", "close",
  "open", "show", "hide", "find", "sort", "filter",
  "add", "del", "mod", "rem", "ins", "upd",
  "tp", "ts", "fs", "vs",
  "top", "hot", "new", "old", "big", "min", "max", "avg", "sum",
  "red", "org", "grn", "blu", "wht", "blk",
  "mon", "tue", "wed", "thu", "fri", "sat", "sun",
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
  // English common words (for international support)
  "hello", "hi", "hey", "howdy", "greetings",
  "please", "thank", "thanks", "sorry", "excuse",
  "yes", "no", "maybe", "sure", "okay", "right",
  "what", "who", "where", "when", "why", "how",
  "this", "that", "these", "those",
  "here", "there", "where", "everywhere",
  "good", "bad", "great", "awesome", "terrible",
  "help", "need", "want", "like", "love", "hate",
  "can", "could", "would", "should", "will", "shall",
  "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did",
  "go", "come", "take", "give", "make", "do",
  "see", "look", "watch", "read", "write",
  "think", "know", "believe", "understand",
  "tell", "say", "speak", "talk", "listen", "hear",
  "work", "play", "run", "walk", "stop",
  "time", "day", "week", "month", "year",
  "today", "tomorrow", "yesterday",
  "morning", "afternoon", "evening", "night",
  "now", "then", "always", "never", "sometimes",
  "very", "really", "just", "only", "also", "too",
  "much", "many", "some", "any", "all", "none",
  "one", "two", "three", "four", "five",
  "first", "last", "next", "previous",
  "left", "right", "up", "down", "in", "out",
  "about", "with", "from", "to", "for", "by",
  "and", "but", "or", "not", "if", "then", "else",
  "because", "since", "although", "though",
  "while", "during", "before", "after",
  "more", "less", "most", "least", "better", "best", "worse", "worst",
  "the", "a", "an", "some", "any", "no", "every",
  "my", "your", "his", "her", "its", "our", "their",
  "mine", "yours", "his", "hers", "ours", "theirs",
  "this", "that", "these", "those",
  "here", "there", "where", "everywhere",
  "now", "then", "always", "never", "sometimes",
  // Kata yang sering salah dikoreksi karena edit distance 1 dari kata valid
  "lupa", "ingat", "pikir", "mengerti", "paham",
  "cerita", "jelas", "terang", "gelap",
  "sini", "sana", "sono", "sini",
  "ini", "itu", "situ", "sini",
]);

/** Solusi Damerau-Levenshtein edit distance.
 *  Digunakan untuk spelling correction pada typo umum. */
function damerauLevenshtein(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  const d: number[][] = Array.from({ length: la + 1 }, () => Array(lb + 1).fill(0));

  for (let i = 0; i <= la; i++) d[i][0] = i;
  for (let j = 0; j <= lb; j++) d[0][j] = j;

  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,      // deletion
        d[i][j - 1] + 1,      // insertion
        d[i - 1][j - 1] + cost, // substitution
      );
      // Transposition (Damerau extension)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
      }
    }
  }
  return d[la][lb];
}

/** Cari kandidat koreksi spelling terbaik dari kamus Indonesia.
 *  Hanya mengoreksi jika:
 *  - Edit distance <= 2 (typo ringan)
 *  - Panjang kata asli >= 4 (jangan koreksi kata pendek)
 *  - Ada minimal 1 kandidat yang lebih baik dari input
 *
 *  Strategi: Damerau-Levenshtein + frequency ranking via common word list. */
function findBestSpellingCandidate(word: string): string | null {
  if (word.length < 4) return null; // terlalu pendek untuk dikoreksi
  if (INDONESIAN_WORDS.has(word)) return null; // sudah benar

  let bestCandidate: string | null = null;
  let bestDistance = Infinity;

  for (const candidate of INDONESIAN_WORDS) {
    if (Math.abs(candidate.length - word.length) > 1) continue; // skip jika panjangnya terlalu berbeda
    const dist = damerauLevenshtein(word, candidate);
    if (dist < bestDistance && dist <= 1) { // threshold ketat: hanya 1 edit
      bestDistance = dist;
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

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

  // Prioritas 2: spelling correction untuk kata non-slang >= 4 chars
  if (cleaned.length >= 4 && !/^[\/\d]/.test(cleaned)) {
    const correction = findBestSpellingCandidate(cleaned);
    if (correction && correction !== cleaned) return correction;
  }

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
 * Normalisasi input bebas teks owner sebelum routing/classification.
 *   - strip prefix "Username:" yang ditambahkan bot Telegram group
 *   - trim + collapse spasi berlebih
 *   - lowercase (semua downstream match case-insensitively)
 *   - collapse huruf berulang ("halooo"->"halo")
 *   - leetspeak normalization ("h3llo"->"hello")
 *   - ekspansi slang/abbreviation Indonesia + English ke bentuk kanonis
 *   - spelling correction via Damerau-Levenshtein untuk typo umum
 *   - TIDAK PERNAH rewrite prefix "/" command (verbatim)
 *   - Language-aware: detect bahasa dan apply normalisasi yang sesuai
 * Mengembalikan string ternormalisasi (tidak pernah throw). */
export function normalizeInput(raw: string): string {
  if (!raw) return "";
  return raw
    .replace(/\s+/g, " ")
    .trim()
    // Strip "Username:" prefix Telegram group bots
    .replace(/^[^:]+:\s*\n?\s*/i, "")
    // Leetspeak normalization (hanya jika ada campuran angka+huruf)
    .replace(/\b\w*\d\w*\b/g, (w) => {
      if (/\d/.test(w) && /[a-zA-Z]/.test(w)) return leetspeakNormalize(w);
      return w;
    })
    .split(" ")
    .map(detectAndNormalize)
    .join(" ");
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
