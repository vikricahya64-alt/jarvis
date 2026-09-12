"""
J.A.R.V.I.S. Level 8 Memory Graph

Temporal, private knowledge graph built from conversations and sensor data.
Design goals on the free tier:

  * NO external embedding API — we synthesize a deterministic 768-dim vector
    (character n-gram feature hashing, L2-normalized) so pgvector's cosine
    search (`search_memory_nodes`) works offline and free. Dims match the
    Level 8 schema (vector(768)).
  * ENTITIES ARE ANONYMIZED — never write raw PII into memory_nodes here.
    Any real names/addresses stay in the DB, not the graph node embeds.
  * Graph is preferred over pure vector similarity for traversal: we store
    nodes + weighted edges and use `get_memory_neighbors` to hop edges.
  * Uses Groq only for entity/relation *extraction* (structured JSON), never
    for storage. Deterministic embeddings need no network.

Synchronous library (no asyncio).
"""
import os
import re
import json
import time
import hashlib
import datetime
from collections import Counter

try:
    from utils import groq_client
    from utils import supabase_client
except ImportError:  # allow bare import for local tests
    groq_client = None
    supabase_client = None

EMBED_DIM = 768          # matches sql/level8_schema.sql vector(768)
_STOP = {"", "the", "a", "an", "of", "and", "or", "to", "for", "in",
         "on", "at", "with", "is", "are", "was", "were", "my", "your"}


# --------------------------------------------------------------------------
# Deterministic local embedding (no API cost)
# --------------------------------------------------------------------------
def embed_text(text: str) -> list:
    """Produce a 768-dim, L2-normalized embedding from character n-grams.
    Deterministic (same text -> same vector), so pgvector cosine search is
    meaningful offline. Cheap and privacy-safe (hashing, no external call)."""
    vec = [0.0] * EMBED_DIM
    if not text:
        return vec
    lowered = text.lower()
    for n in (2, 3, 4):  # char n-grams
        for i in range(0, max(0, len(lowered) - n + 1)):
            gram = lowered[i:i + n]
            h = int.from_bytes(hashlib.blake2b(gram.encode(),
                                               digest_size=16).digest()[:8],
                               "big") % EMBED_DIM
            vec[h] += 2.0  # positive weight on present grams
    for extra in _token_ngrams(lowered):
        h = int.from_bytes(hashlib.blake2b(extra.encode(),
                                           digest_size=16).digest()[:8],
                           "big") % EMBED_DIM
        vec[h] += 1.0
    norm = (sum(v * v for v in vec)) ** 0.5 or 1.0
    return [round(v / norm, 6) for v in vec]


def _token_ngrams(lowered: str) -> list:
    toks = [t for t in lowered.split() if t not in _STOP]
    # word-level bigram signatures
    return ["_".join(toks[i:i + 2]) for i in range(max(0, len(toks) - 1))]


def cosine(a: list, b: list) -> float:
    """Simple cosine similarity helper (for tests + offline fallback)."""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = (sum(x * x for x in a)) ** 0.5 or 1.0
    nb = (sum(y * y for y in b)) ** 0.5 or 1.0
    return dot / (na * nb)


# --------------------------------------------------------------------------
# Entity / relation extraction via Groq (structured JSON, anonymized)
# --------------------------------------------------------------------------
_ENT_PROMPT = (
    "Extract named entities from the conversation. Return ONLY a JSON array "
    "of objects, each with keys: {'entity': string, 'type': string}. Use "
    "GENERIC anonymized labels for people/places (e.g. 'user_friend_A', "
    "'place_B'); never return real personal names, addresses, phone numbers, "
    "or identifiers. Cap at 12 entities. types: person|place|concept|project|"
    "tech|time|object. No markdown, no trailing text."
)


def extract_entities(text: str) -> list:
    """Return [{'entity', 'type'}, ...] via Groq. Falls back to keyword-ish
    extraction on any failure (never raises)."""
    if not text or not groq_client:
        return []
    try:
        out = groq_client.plain_completion(_ENT_PROMPT, (text or "")[:3000],
                                           max_tokens=600, temperature=0.0)
        arr = json.loads(out)
        if not isinstance(arr, list):
            raise ValueError("not a list")
        return [e for e in arr if isinstance(e, dict) and e.get("entity")][:12]
    except Exception:
        return _keyword_extract(text)


def _keyword_extract(text: str) -> list:
    """Cheap deterministic fallback: tokenize, anonymize, cap count."""
    toks = [t for t in re.findall(r"[A-Za-z]{4,}", (text or "").lower())
            if t not in _STOP]
    seen = []
    for t in toks[:16]:
        if t not in seen:
            seen.append(t)
    return [{"entity": f"concept_{hashlib.sha1(t.encode()).hexdigest()[:8]}",
             "type": "concept", "_label": t} for t in seen[:12]]


def extract_relations(entities, text: str, max_edges: int = 8) -> list:
    """Infer undirected edges between co-mentioned entities.
    Returns [{'source','target','relation','strength'}]. Deterministic:
    entities that co-occur are connected with strength by co-occurrence."""
    text_l = (text or "").lower()
    edges = []
    count = Counter()
    bands = [(e.get("_label", "") or e.get("entity", "")) for e in entities]
    for i in range(len(bands)):
        for j in range(i + 1, len(bands)):
            a, b = bands[i], bands[j]
            if not a or not b or a == b:
                continue
            if a in text_l and b in text_l:
                count[(a, b)] += 1
    for (a, b), c in count.most_common(max_edges):
        edges.append({
            "source": a, "target": b, "relation": "co_occurs",
            "strength": round(min(1.0, 0.35 + 0.15 * c), 3),
        })
    return edges


# --------------------------------------------------------------------------
# Persist (store) with help from supabase_client
# --------------------------------------------------------------------------
def store_conversation(telegram_id: int, text: str, konteks: dict = None) -> dict:
    """Upsert memory nodes + edges from a conversation. Always anonymize.
    Returns a summary dict. Safe when supabase is unreachable."""
    entities = extract_entities(text)
    edges = extract_relations(entities, text)
    stats = {"nodes": 0, "edges": 0, "hashed": EMBED_DIM}
    if not supabase_client:
        return {**stats, "entities": entities}
    for ent in entities:
        label = ent.get("_label") or ent.get("entity", "")
        if not label:
            continue
        key = f"{label}|{telegram_id}"
        nid = _stable_node_id(telegram_id, label)
        supabase_client.upsert_memory_node(
            telegram_id, entity=key, ntype=ent.get("type", "concept"),
            embedding=embed_text(label), node_id=nid,
        )
        stats["nodes"] += 1
    for ed in edges:
        nid_a = _stable_node_id(telegram_id, ed["source"])
        nid_b = _stable_node_id(telegram_id, ed["target"])
        supabase_client.add_memory_edge(
            telegram_id, nid_a, nid_b, ed["relation"],
            strength=ed["strength"])
        stats["edges"] += 1
    return {**stats, "entities": entities, "edges": edges}


def _stable_node_id(telegram_id: int, label: str) -> str:
    """Stable id for a (owner, anonymized-label) node so edges can reference
    it consistently across calls."""
    h = hashlib.sha1(f"{telegram_id}|{label}".encode()).hexdigest()[:16]
    return f"mem_{h}"


# --------------------------------------------------------------------------
# Query — vector search first, then graph traversal
# --------------------------------------------------------------------------
def query_memory(telegram_id: int, query: str, limit: int = 5) -> dict:
    """Augment generation with memory: embed query -> vector search -> hop
    graph edges of the top hit. Returns context dict the orchestrator can
    inject into a prompt. Never raises."""
    result = {"query": query, "nodes": [], "neighbors": [], "decayed": []}
    if not supabase_client:
        return result
    embedding = embed_text(query)          # 768-dim, free
    hits = supabase_client.search_memory(telegram_id, embedding, limit=limit)
    result["nodes"] = hits or []
    # traverse edges from the strongest hit
    if hits and hits[0].get("id"):
        result["neighbors"] = (
            supabase_client.get_memory_neighbors(telegram_id,
                                                 hits[0]["id"], limit=20) or [])
    # apply temporal decay on what we surfaced
    result["decayed"] = decay(hits, now=None)
    return result


def decay(nodes: list, now: float = None, half_life_days: float = 30.0) -> list:
    """Exponential time-decay of strength based on age. Returns updated dicts.
    Uses 'strength' if present else 'score'.""" 
    now = now or time.time()
    out = []
    for n in nodes or []:
        s = n.get("strength", n.get("score", 0.0))
        # last_seen could be stored; default to now so no immediate decay
        last = n.get("last_seen")
        if not last:
            out.append({**n, "decayed_strength": s})
            continue
        try:
            ts = datetime.datetime.fromisoformat(last).timestamp()
        except Exception:
            ts = now
        age_days = max(0.0, (now - ts) / 86400.0)
        factor = 0.5 ** (age_days / half_life_days)
        out.append({**n, "decayed_strength": round(s * factor, 3),
                    "age_days": round(age_days, 1)})
    return out


def memory_context_block(telegram_id: int, query: str):
    """Convenience for the orchestrator: returns a human-readable sentence of
    what the graph recalls, to splice into a system prompt (string)."""
    m = query_memory(telegram_id, query)
    labels = [n.get("entity") or n.get("_label") for n in m["nodes"][:3]]
    if not labels:
        return ""
    return ("[recall] " + ", ".join(filter(None, labels)) + " "
            f"(+{len(m['neighbors'])} related)")


if __name__ == "__main__":
    import sys
    tid = int(sys.argv[1]) if len(sys.argv) > 1 else -1
    q = sys.argv[2] if len(sys.argv) > 2 else "apa itu proyek bawah laut?"
    e = embed_text(q)
    print(json.dumps({"dim": len(e), "sample": e[:5],
                      "context": memory_context_block(tid, q)}, indent=2))