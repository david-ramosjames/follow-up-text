#!/usr/bin/env bash
# Walks the whole system: sign in, configure, start a series from Slack (both the
# shorthand and the message-shortcut form), send the texts, then reply and opt out.
#
# It stands up a stub in place of the Quo API, so nothing real is texted, and it
# signs its Slack requests properly so the signature checks are exercised too.
#
#   TEST_DATABASE_URL=postgresql://localhost/followups_e2e ./tests/e2e/run.sh
#
# The database is dropped and recreated, so point it at a scratch one.
set -euo pipefail

DB_URL="${TEST_DATABASE_URL:-postgresql://127.0.0.1:5432/followups_e2e}"
PORT="${E2E_PORT:-3000}"
STUB_PORT="${E2E_STUB_PORT:-4999}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cleanup() {
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  [[ -n "${STUB_PID:-}" ]] && kill "$STUB_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "Resetting the scratch database..."
psql "$DB_URL" -c "select 1" >/dev/null 2>&1 || { echo "Cannot reach $DB_URL"; exit 1; }
psql "$DB_URL" -q -c "drop schema public cascade; create schema public;"

echo "Starting the Quo stub on $STUB_PORT..."
node "$ROOT/tests/e2e/quo-stub.mjs" >/tmp/quo-stub.log 2>&1 &
STUB_PID=$!

echo "Starting the server on $PORT..."
DATABASE_URL="$DB_URL" \
QUO_API_KEY="test-key" \
QUO_API_BASE="http://127.0.0.1:$STUB_PORT/v1" \
QUO_WEBHOOK_TOKEN="quo-token-abc" \
SLACK_SIGNING_SECRET="slack-signing-secret-xyz" \
ADMIN_PASSWORD="letmein-please-1234" \
PUBLIC_URL="http://127.0.0.1:$PORT" \
PORT="$PORT" \
  node "$ROOT/server/index.js" >/tmp/followups-e2e.log 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && break
  sleep 1
done

node "$ROOT/tests/e2e/walkthrough.mjs"
