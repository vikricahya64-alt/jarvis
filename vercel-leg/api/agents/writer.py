"""
Writer agent: preference-aware final formatting of swarm results.

Combines the child-agent outputs into one readable, user-scoped answer. Uses
the Level-3 learning loop (`build_preference_block`) so tone/format choices
the user has taught the bot are honored; falls back to a neutral Indonesian
summary when no preferences exist yet.
"""
import logging

from utils import groq_client, supabase_client

AGENT_TYPE = "writer"

logger = logging.getLogger("agent.writer")

SYSTEM_PROMPT = (
    "Kamu agen WRITER dalam swarm J.A.R.V.I.S. Tugasmu menyatukan hasil "
    "sub-agen menjadi SATU jawaban akhir yang rapi untuk Telegram: "
    "judul pendek, bagian bernomor/poin, kutip sumber bila ada, bahasa "
    "Indonesia ringkas. Jika ini laporan, gunakan tabel Markdown bila "
    "cocok. Yang penting: JANGAN menambah fakta, angka, atau klaim yang "
    "tidak muncul di hasil sub-agen."
)


def run(telegram_id: int, task_input: str, task_id=None, context=None) -> dict:
    """task_input is the concatenated child results (see coordinator)."""
    try:
        pref_block = ""
        try:
            from utils.learning_loop import build_preference_block
            pref_block = build_preference_block(telegram_id, task_input)
        except Exception:
            pref_block = ""
        system = SYSTEM_PROMPT
        if pref_block:
            system = f"{system}\n\nPreferensi pengguna yang sudah dipelajari:\n{pref_block}"
        final = groq_client.plain_completion(system, task_input, max_tokens=1600)
        return {"success": True, "result": (final or "Tidak ada output.").strip(),
                "error": "", "tool_names": []}
    except Exception as exc:
        logger.exception("writer.run failed")
        return {"success": False, "result": "", "error": str(exc)[:400],
                "tool_names": []}


def chunk(text: str, limit: int = 4000) -> list:
    """Telegram-safe chunking used when delivering aggregated answers."""
    if len(text) <= limit:
        return [text]
    chunks, cur = [], ""
    for line in text.splitlines(keepends=True):
        if len(cur) + len(line) > limit:
            chunks.append(cur)
            cur = line
        else:
            cur += line
    if cur:
        chunks.append(cur)
    return chunks or [text[:limit]]