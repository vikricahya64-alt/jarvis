"""
Level 3 spec facade - Adaptive Learning Engine.

After every completed task the orchestrator inspects the interaction and
extracts durable user preferences (tone, format, currency, verbosity...).
Those are stored per-user and injected into the NEXT task's system prompt
before any Groq call (see utils/learning_loop.build_preference_block).

This module exposes the Level 3 contract `reflect_and_learn(...)` and
re-exports the retrieval helpers used by the orchestrator. All logic lives
in utils/learning_loop.py to avoid duplication.
"""
from utils.learning_loop import (
    reflect as reflect_and_learn,
    build_preference_block,
    retrieve_preferences,
    store_preference,
)

__all__ = [
    "reflect_and_learn",
    "build_preference_block",
    "retrieve_preferences",
    "store_preference",
]