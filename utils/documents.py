"""
Document knowledge base utilities.

Keyword-first retrieval (gratis, andal): documents are split into chunks,
stored in Supabase, and retrieved by keyword matching (ILIKE). This avoids
the cold-start / disk limits of running an embedding model in the free-tier
infrastructure, and can be upgraded to vector search later.
"""
import re
import httpx
from utils import supabase_client

CHUNK_SIZE = 900
CHUNK_OVERLAP = 100


def chunk_text(text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list:
    """
    Split text into overlapping chunks on paragraph/sentence boundaries.
    Returns a list of (index, chunk_text).
    """
    text = re.sub(r"\n{3,}", "\n\n", text or "").strip()
    if not text:
        return []
    if len(text) <= size:
        return [(0, text)]

    # Split into paragraphs first, then pack them.
    paragraphs = re.split(r"\n\s*\n", text)
    chunks = []
    current = ""
    idx = 0
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        if len(current) + len(para) + 1 <= size:
            current = (current + "\n\n" + para).strip()
        else:
            if current:
                chunks.append((idx, current))
                idx += 1
            # If a single paragraph is larger than size, hard-split it.
            while len(para) > size:
                chunks.append((idx, para[:size]))
                idx += 1
                para = para[size - overlap:]
            current = para
    if current:
        chunks.append((idx, current))
    return chunks


# ------------------------------------------------------------------
# Store
# ------------------------------------------------------------------
def store_document(title: str, content: str, source: str = "telegram") -> dict:
    """Chunk a document, store it in Supabase, return a summary."""
    base, key = supabase_client._config()
    chunks = chunk_text(content)
    if not chunks:
        return {"success": False, "error": "Empty document"}

    with httpx.Client(timeout=supabase_client._TIMEOUT) as client:
        headers = {**supabase_client._auth_headers(), "Prefer": "return=representation"}
        res = client.post(
            f"{base}/rest/v1/documents",
            json={"title": title, "source": source},
            headers=headers,
        )
        supabase_client._raise_for(res, "documents.insert")
        doc = res.json()[0]

        rows = [
            {"document_id": doc["id"], "chunk_index": i, "content": c}
            for i, c in chunks
        ]
        res = client.post(
            f"{base}/rest/v1/document_chunks",
            json=rows,
            headers=supabase_client._auth_headers(),
        )
        supabase_client._raise_for(res, "document_chunks.insert")

    return {
        "success": True,
        "document_id": doc["id"],
        "title": title,
        "chunks": len(chunks),
        "characters": len(content),
    }


# ------------------------------------------------------------------
# Retrieve (keyword-first)
# ------------------------------------------------------------------
def retrieve_docs(query: str, top_k: int = 5) -> list:
    """
    Search the knowledge base by keyword. Returns the most relevant chunks
    joined with their document title. Uses ILIKE over the whole query plus
    per-token matches for a lightweight relevance score.
    """
    # Use "similarity" sorting via trigram when available, else fallback.
    text = (query or "").strip()
    if not text:
        return []

    base, key = supabase_client._config()

    # Normalized tokens for per-keyword scoring.
    tokens = [t for t in re.split(r"\W+", text.lower()) if len(t) >= 3][:8]

    with httpx.Client(timeout=supabase_client._TIMEOUT) as client:
        headers = supabase_client._auth_headers()

        rows = []
        for tok in tokens:
            res = client.get(
                f"{base}/rest/v1/document_chunks",
                params={
                    "select": "id,content,document_id,documents(title)",
                    "content": f"ilike.%{tok}%",
                    "limit": str(top_k),
                },
                headers=headers,
            )
            supabase_client._raise_for(res, "document_chunks.select")
            for r in res.json():
                r["_tok"] = tok
                rows.append(r)

        # Deduplicate by chunk id and score by number of distinct tokens hit.
        best = {}
        for r in rows:
            cid = r["id"]
            if cid not in best:
                best[cid] = {"hits": set(), "row": r}
            best[cid]["hits"].add(r["_tok"])

        ranked = sorted(
            best.values(),
            key=lambda x: (-len(x["hits"]), len(x["row"]["content"])),
        )[:top_k]

        results = []
        for item in ranked:
            row = item["row"]
            doc_title = None
            if isinstance(row.get("documents"), dict):
                doc_title = row["documents"].get("title")
            results.append({
                "title": doc_title or "untitled",
                "content": row["content"],
                "score": len(item["hits"]),
            })
        return results