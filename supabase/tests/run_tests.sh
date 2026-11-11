#!/usr/bin/env bash
# Loads the schema into a throwaway local Postgres + PostGIS and runs checks.
# Supabase's auth schema is stubbed so the migration can run outside Supabase.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
DATA="$(mktemp -d)"
PORT=55432
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DATA"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$DATA/log" start >/dev/null
sleep 2
PSQL=(psql -h /tmp -p $PORT -U postgres -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -c "create database nav;"
"${PSQL[@]}" -d nav -f "$HERE/supabase_stub.sql"
"${PSQL[@]}" -d nav -f "$HERE/../migrations/0001_init.sql"
"${PSQL[@]}" -d nav -f "$HERE/tests.sql"
echo "ALL TESTS PASSED"
