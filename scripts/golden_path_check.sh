#!/usr/bin/env bash
set -euo pipefail

SERVICE_A_BASE_URL="${SERVICE_A_BASE_URL:-http://localhost:3000}"
SERVICE_B_BASE_URL="${SERVICE_B_BASE_URL:-http://localhost:4000}"
AUTH_HEADER="${AUTH_HEADER:-Authorization: Bearer test-key}"
CHAT_ID="${CHAT_ID:-}"

if [[ -z "${CHAT_ID}" ]]; then
  echo "ERROR: CHAT_ID env is required" >&2
  exit 1
fi

echo "== Checking Service A status =="
status_json="$(curl -fsS "${SERVICE_A_BASE_URL}/status")"
node --input-type=module -e "
  const s = ${status_json};
  if (s.state !== 'connected' && s.clientState !== 'connected') {
    console.error('Service A not connected', s);
    process.exit(1);
  }
  if (s.startupInfillStatus !== 'done') {
    console.error('Service A startupInfillStatus not done', s.startupInfillStatus);
    process.exit(1);
  }
"
echo "Service A connected and startup infill done."

echo "== Fetching stats before =="
curl -fsS -H "${AUTH_HEADER}" "${SERVICE_A_BASE_URL}/api/chats/${CHAT_ID}/stats" || true
echo

echo "== Posting backfill target via Service B =="
curl -fsS -X POST -H "${AUTH_HEADER}" \
  "${SERVICE_B_BASE_URL}/intel/backfill/chat/${CHAT_ID}?targetMessages=500" | jq .

echo "== Verifying backfill_target_posted event =="
node --input-type=module -e "
  import { pool } from '../dist/db.js';
  const chatId = '${CHAT_ID}';
  const since = Date.now() - 24*60*60*1000;
  const run = async () => {
    const res = await pool.query(
      'select count(*) as count, max(ts) as newest from intel_events where type='\"'\"'backfill_target_posted'\"'\"' and chat_id=$1 and ts >= $2',
      [chatId, since]
    );
    console.log(res.rows[0]);
    await pool.end();
    const count = Number(res.rows[0]?.count ?? 0);
    if (count < 1) {
      console.error('Missing backfill_target_posted event for chat', chatId);
      process.exit(1);
    }
  };
  run();
"

echo "== Running watermarks sync =="
curl -fsS -X POST -H "${AUTH_HEADER}" \
  "${SERVICE_B_BASE_URL}/intel/watermarks/sync?runType=scheduled" | jq .

echo "== Polling jobs table for drain =="
for i in {1..5}; do
  node --input-type=module -e "
    import { pool } from '../dist/db.js';
    const run = async () => {
      const res = await pool.query('select status, count(*) from jobs group by status');
      console.log(res.rows);
      await pool.end();
      const pending = res.rows.reduce((sum, r) => sum + (r.status === 'queued' || r.status === 'running' ? Number(r.count) : 0), 0);
      if (pending > 0) process.exit(2);
    };
    run();
  " && { echo "Jobs drained."; break; } || sleep 2
done

echo "== Fetching chat artifacts =="
curl -fsS -H "${AUTH_HEADER}" "${SERVICE_B_BASE_URL}/intel/chat/${CHAT_ID}/latest" | jq .

echo "== Fetching stats after =="
curl -fsS -H "${AUTH_HEADER}" "${SERVICE_A_BASE_URL}/api/chats/${CHAT_ID}/stats" || true
echo

echo "Golden path check complete."
