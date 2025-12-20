# Service A / Service B Runbook

## Responsibilities
- **Service A (WhatsApp / backfill)**: owns chat/message data, coverage, and backfill execution. Key endpoints: `/status`, `/api/coverage/status`, `/api/backfill/targets`, `/api/chats/:chatId/stats`, `/api/debug/state`.
- **Service B (intel / orchestrator)**: scores chats, plans backfill targets, writes intel metrics/artifacts, and calls Service A. Protects intel endpoints with Bearer auth.

## Sources of truth
- **Backfill postings**: `intel_events.type = 'backfill_target_posted'` (written on every successful post). Cooldown decisions rely **only** on these rows.
- **Cooldown**: a chat is “satisfied” only if a recent `backfill_target_posted` exists within `ORCH_TARGET_COOLDOWN_MS`.
- **Targets state (Service A)**: visible in Service A `/api/debug/state.backfillTargets` (or equivalent).
- **Artifacts/runs**: `intel_runs`, `intel_artifacts` for audit history; state file `out/intel/orchestrator_state.json` is observational only.

## Health + single-chat verification (copy/paste)
```bash
# Env you can override:
# SERVICE_A_BASE_URL=http://localhost:3000
# SERVICE_B_BASE_URL=http://localhost:4000
# AUTH_HEADER="Authorization: Bearer test-key"
# CHAT_ID="123@c.us"  # required

./scripts/golden_path_check.sh
```

What it does:
1) Assert Service A `/status` is connected and `startupInfillStatus=done`.
2) Capture Service A `/api/chats/:chatId/stats` before/after.
3) POST `/intel/backfill/chat/:chatId?targetMessages=500` (Service B).
4) Verify `intel_events` has `backfill_target_posted` for the chat.
5) Run `/intel/watermarks/sync` and poll jobs table until drained.
6) Fetch `/intel/chat/:chatId/latest` and assert artifacts exist.

## Expected invariants
- Successful backfill post **always** writes `intel_events.backfill_target_posted` for each chat.
- Cooldown/satisfaction **only** uses those events (not state files).
- Orchestrator posted count should match inserted event rows; mismatch is an error.
- Service A connected + `startupInfillStatus=done` before any scheduled work.

## Quick debugging commands
- Check Service A status: `curl -s ${SERVICE_A_BASE_URL:-http://localhost:3000}/status | jq`
- Inspect backfill targets in A: `curl -s ${SERVICE_A_BASE_URL:-http://localhost:3000}/api/debug/state | jq '.backfillTargets'`
- Recent backfill events: `psql ... -c "select chat_id, ts from intel_events where type='backfill_target_posted' order by ts desc limit 20;"`
- Latest intel artifacts for a chat: `curl -s -H "${AUTH_HEADER:-Authorization: Bearer test-key}" ${SERVICE_B_BASE_URL:-http://localhost:4000}/intel/chat/$CHAT_ID/latest | jq`
