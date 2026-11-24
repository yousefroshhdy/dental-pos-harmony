#!/usr/bin/env bash
# Stops the local signed-in stack started by scripts/e2e-local/up.sh (app, gateway, PostgREST).
# Leaves PostgreSQL and the honest_e2e_local database alone. Deletes the per-run env file (JWT
# secret, keys, demo password) unless E2E_LOCAL_KEEP_ENV=1, so the next `up` gets a new secret.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CACHE="${ROOT}/.cache/e2e-local"
PIDS="${CACHE}/pids"

for name in app gateway postgrest; do
  pidfile="${PIDS}/${name}.pid"
  [[ -f "${pidfile}" ]] || continue
  pid="$(cat "${pidfile}")"
  if kill -0 "${pid}" 2>/dev/null; then
    kill -TERM -- "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "${pid}" 2>/dev/null || break; sleep 0.25; done
    kill -KILL -- "-${pid}" 2>/dev/null || true
    echo "stopped ${name} (${pid})"
  fi
  rm -f "${pidfile}"
done

if [[ "${E2E_LOCAL_KEEP_ENV:-0}" != "1" ]]; then
  rm -f "${CACHE}/env.local" "${CACHE}/postgrest.conf" "${CACHE}/users.json"
fi
echo "local stack stopped (database honest_e2e_local kept; restart with pnpm e2e:local:up)"
