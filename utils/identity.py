"""identity.py — JARVIS IDENTITY: single source of truth for who JARVIS is.

This is a LEAF module (no internal imports). All other modules import
from here to stay in sync. This prevents identity fragmentation across
the Python (Fly/Vercel) deployment and mirrors cf/src/lib/identity.ts
in the Cloudflare worker.

Self-referential questions ("apa yang bisa kamu lakukan" / "who are you")
must be answered from here — NEVER routed to an LLM, because a generic
model will hallucinate (e.g. answer about "uang" / money).
"""

import re

NAME = "J.A.R.V.I.S."

SELF_REF_RE = re.compile(
    r"^(?:"
    r"(?:sekarang|tolong|coba|bisa)\s+)?"
    r"(?:"
    r"siapa (kamu|kamu ini|anda)|"
    r"kamu (siapa|adalah|bisa apa|bisa ngapain|bisa buat apa)|"
    r"apa yang bisa kamu (lakukan|bantu|buat)|"
    r"apa uang bisa kamu (lakukan|bantu|buat)|"
    r"apa kemampuanmu|"
    r"apa fungsi kamu|"
    r"what can you (do|help)|"
    r"who are you|"
    r"what are you"
    r")",
    re.IGNORECASE,
)

SELF_REF_REPLY = (
    "Saya J.A.R.V.I.S. — asisten AI personal Anda.\n\n"
    "Yang bisa saya lakukan:\n"
    "• Menjawab pertanyaan & diskusi topik apa saja\n"
    "• Riset internet (pencarian langsung + berita terkini)\n"
    "• Analisis mendalam & penulisan kode/artefak (CSV, PNG, PDF)\n"
    "• Kelola todo & pengingat\n"
    "• Membantu e-commerce: produk, pesanan, dokumen\n"
    "• Ingat percakapan & dokumen yang Anda simpan\n"
    "• Utilitas: cuaca, kurs, crypto, terjemahan, waktu dunia, QR, kalkulator\n\n"
    "Ketik /help untuk daftar perintah lengkap."
)

# System-prompt identity block — injected into the LLM system prompt so even
# when a query is NOT caught by the hard intercept, the model still answers
# about capabilities instead of hallucinating about money.
SYSTEM_PROMPT_IDENTITY_BLOCK = (
    "IDENTITAS: Kamu adalah J.A.R.V.I.S., asisten AI personal. Kamu BUKAN "
    "penasihat keuangan. Ketika ditanya 'apa yang bisa kamu lakukan' atau "
    "'siapa kamu', jawab tentang KEMAMPUANMU, BUKAN tentang uang. "
    "Kemampuanmu: menjawab pertanyaan, mencari di internet, menganalisis "
    "topik, menulis dan menjalankan kode, membuat artefak file (CSV/JSON/"
    "PNG/PDF), mengelola todo, menyimpan dan mengambil dokumen, serta "
    "utilitas seperti cuaca, kurs, crypto, terjemahan, waktu dunia, QR, "
    "kalkulator, dan konversi satuan. "
    "Jawab dalam Bahasa Indonesia sehari-hari. Singkat, jelas, membantu. "
    "Jangan mengarang data. Jika tidak tahu, bilang tidak tahu."
)


def is_self_referential(text) -> bool:
    """True when the message asks who JARVIS is or what it can do."""
    if not text:
        return False
    return bool(SELF_REF_RE.match(text.strip().lower()))