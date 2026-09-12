"""
Memory compaction: summarize long-running conversations into the knowledge
base so chat history stays lightweight and old facts remain retrievable.

Runs inside the daily cron. For each user with many chat rows, it:
  1. Pulls the oldest chat_history rows (excluding already-summarized).
  2. Feeds them to Groq (bounded) to produce a concise factual digest.
  3. Stores the digest via store_document (title prefixed MEMORY) so the
     agent can retrieve_docs it later.
  4. Deletes the summarized chat rows.

Idempotent, bounded, and never fatal to the cron.
"""
import logging

logger = logging.getLogger("compaction")

_DAILY_LLM_BUDGET = 20  # seconds for the compaction summarize call


def compact_all_users(threshold: int = 50, limit_rows: int = 40):
    from utils import supabase_client

    # Find users with more than `threshold` chat rows.
    users = _users_over_threshold(threshold)
    for tg_id in users:
        try:
            _compact_user(tg_id, limit_rows)
        except Exception as exc:
            logger.warning(f"Compaction failed for {tg_id}: {exc}")


def _users_over_threshold(threshold: int) -> list:
    from utils import supabase_client
    # Fall back to non-aggregate: just get distinct telegram ids with lots of rows.
    ids = set()
    try:
        rows = supabase_client.get_all_chat_telegram_ids()
        for tid in rows:
            try:
                c = supabase_client.count_chat(tid)
                if c >= threshold:
                    ids.add(tid)
            except Exception:
                continue
    except Exception:
        pass
    return list(ids)


def _compact_user(tg_id: int, limit_rows: int):
    from utils import supabase_client, groq_client, documents

    rows = supabase_client.get_oldest_chat(tg_id, limit_rows)
    if len(rows) < 10:
        return
    transcript = "\n".join(f"{r['role']}: {r['content']}" for r in rows)
    transcript = transcript[:12000]

    groq_client.set_budget(_DAILY_LLM_BUDGET)
    try:
        response = groq_client.sync_completion(
            transcript,
            system_prompt=(
                "You are a memory summarizer. Compress the conversation below "
                "into a concise factual MEMORY note in Indonesian: key facts, "
                "preferences, decisions, and tasks mentioned. Preserve names, "
                "numbers, dates. Ignore pleasantries. No fluff, max 250 words."
            ),
            tool_choice="none",
        )
        digest = (response.choices[0].message.content or "").strip()
    except Exception as exc:
        logger.warning(f"Compaction LLM failed for {tg_id}: {exc}")
        return

    if not digest:
        return
    documents.store_document(f"MEMORY:{tg_id}", digest, source="memory")
    # Remove the compacted rows.
    try:
        supabase_client.delete_chat_ids([r["id"] for r in rows])
    except Exception as exc:
        logger.warning(f"Compaction delete failed for {tg_id}: {exc}")
