#!/usr/bin/env bash
# Run Honest OS database tests on a plain PostgreSQL 16 server (no Docker/Supabase CLI).
#
#   PGHOST=/var/run/postgresql PGPORT=5432 PGUSER=postgres scripts/db-test.sh
#
# Steps: fresh database → Supabase stub → pgTAP shim → every migration in order
# → seed.sql → each supabase/tests/database/*.test.sql in its own psql session.
# Fails if any migration errors, any test prints "not ok", or a plan is not met.
# On Supabase, use `supabase test db` instead (real pgTAP; same test files).
set -euo pipefail
shopt -s nullglob
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="${HONEST_TEST_DB:-honest_test}"
PSQL=(psql -X -q -v ON_ERROR_STOP=1 --no-psqlrc)

"${PSQL[@]}" -d postgres -c "drop database if exists ${DB}" -c "create database ${DB}" >/dev/null
"${PSQL[@]}" -d "${DB}" -c "alter database ${DB} set search_path = \"\$user\", public, extensions" >/dev/null

"${PSQL[@]}" -d "${DB}" -f "${ROOT}/scripts/db/local_supabase_stub.sql" >/dev/null
"${PSQL[@]}" -d "${DB}" -f "${ROOT}/scripts/db/local_pgtap_shim.sql" >/dev/null

echo "== migrations"
for f in "${ROOT}"/supabase/migrations/*.sql; do
  "${PSQL[@]}" -d "${DB}" -f "$f" >/dev/null
  echo "   applied $(basename "$f")"
done
"${PSQL[@]}" -d "${DB}" -f "${ROOT}/supabase/seed.sql" >/dev/null
echo "   applied seed.sql"

echo "== tests"
failed=0; total=0
for t in "${ROOT}"/supabase/tests/database/*.test.sql; do
  out="$("${PSQL[@]}" -d "${DB}" -At -f "$t" 2>&1)" || { echo "$out"; echo "!! $(basename "$t") errored"; failed=$((failed+1)); continue; }
  n_ok=$(grep -c '^ok ' <<<"$out" || true)
  n_bad=$(grep -c '^not ok ' <<<"$out" || true)
  total=$((total + n_ok + n_bad))
  if [[ $n_bad -gt 0 ]] || grep -q '^# Looks like' <<<"$out"; then
    echo "$out" | grep -E '^(not ok|#)'
    echo "FAIL $(basename "$t") (${n_ok} ok, ${n_bad} not ok)"; failed=$((failed+1))
  else
    echo "PASS $(basename "$t") (${n_ok})"
  fi
done

echo "== ${total} assertions, ${failed} failing file(s)"
[[ $failed -eq 0 ]]
