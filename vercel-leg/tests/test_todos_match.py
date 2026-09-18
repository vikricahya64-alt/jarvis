"""
Pure-logic tests for the todo fuzzy matcher (_match_todo / _clean_match).

Runs offline (no Supabase/Groq): only imports utils.todos, whose HTTP
client functions are lazy. Usable both via pytest and as a plain script:
    python -m pytest tests/test_todos_match.py -v
    python tests/test_todos_match.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from utils.todos import _match_todo, _clean_match


def _rows():
    return [
        {"id": 1, "text": "beli telur"},
        {"id": 2, "text": "beli Susu, dan roti!"},
        {"id": 3, "text": "topup game"},
    ]


def test_clean_match_strips_verbs():
    assert _clean_match("hapus todo telur") == "telur"
    assert _clean_match("Hapus Todo beli telur") == "beli telur"
    assert _clean_match("hapus todo no 3 beli telur") == "beli telur"
    assert _clean_match("delete task susu") == "susu"
    assert _clean_match("telur") == "telur"


def test_match_substring_case_insensitive():
    assert _match_todo(_rows(), "telur")["id"] == 1
    assert _match_todo(_rows(), "beli telur")["id"] == 1
    assert _match_todo(_rows(), "Hapus Todo beli susu")["id"] == 2
    assert _match_todo(_rows(), "hApUs ToDo sUsU")["id"] == 2


def test_match_token_coverage():
    assert _match_todo(_rows(), "roti susu")["id"] == 2


def test_match_no_result():
    assert _match_todo(_rows(), "jadwal dokter") is None
    assert _match_todo([], "telur") is None


def test_match_index_and_id():
    assert _match_todo(_rows(), "2")["id"] == 2
    rows = [dict(r, id=str(r["id"])) for r in _rows()]
    assert _match_todo(rows, "1")["text"] == "beli telur"


def main():
    for fn in (test_clean_match_strips_verbs, test_match_substring_case_insensitive,
               test_match_token_coverage, test_match_no_result,
               test_match_index_and_id):
        fn()
    print("TODO MATCH TESTS PASSED")


if __name__ == "__main__":
    main()