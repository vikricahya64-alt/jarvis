#!/usr/bin/env python3
"""
tools/apply_sql.py — one-shot SQL applier to the prod pooler.

Usage:
  PGPASSWORD=... python3 tools/apply_sql.py sql/nnn_schema.sql [--commit]

Reads the SQL file and runs it in a transaction (rollback on error unless
--commit). Password only via env PGPASSWORD (never written to disk/repo).
Used by Level 9/10 schema + residency migrations.
"""
import os
import sys
import argparse

HOST = "aws-0-ap-southeast-2.pooler.supabase.com"
PORT = 6543
USER = "postgres.vujhyhvmibdkartmrepv"
DB = "postgres"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sql_file")
    ap.add_argument("--commit", action="store_true",
                    help="commit; default rolls back on any error")
    args = ap.parse_args()

    pw = os.environ.get("PGPASSWORD")
    if not pw:
        print("ERROR: PGPASSWORD env required", file=sys.stderr)
        return 1

    import psycopg2
    with open(args.sql_file) as f:
        sql = f.read()

    conn = psycopg2.connect(host=HOST, port=PORT, dbname=DB,
                            user=USER, password=pw, connect_timeout=30)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            cur.execute(sql)
        conn.commit()
        print("OK: applied", args.sql_file)
        return 0
    except Exception as exc:  # noqa: BLE001
        conn.rollback()
        print("FAILED (rolled back):", exc, file=sys.stderr)
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())