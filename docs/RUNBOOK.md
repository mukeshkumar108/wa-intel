# Service A / Service B Runbook

## Responsibilities
- **Service A (WhatsApp / backfill)**: owns chat/message data, coverage, and backfill execution. Key endpoints: `/status`, `/api/coverage/status`, `/api/backfill/targets`, `/api/chats/:chatId/stats`, `/api/debug/state`.
- **Service B (intel / orchestrator)**: scores chats, plans backfill targets, writes intel metrics/artifacts, and calls Service A. Protects intel endpoints with Bearer auth.

## Sources of truth
- **Backfill postings**: `intel_events.type = 'backfill_target_posted'` (written on every successful post). Cooldown decisions rely **only** on these rows.
- **Cooldown**: a chat is “satisfied” only if a recent `backfill_target_posted` exists within `ORCH_TARGET_COOLDOWN_MS`.
- **Targets state (Service A)**: visible in Service A `/api/debug/state.backfillTargets` (or equivalent).
- **Artifacts/runs**: `intel_runs`, `intel_artifacts` for audit history; state file `out/intel/orchestrator_state.json` is observational only.

## Ops/debug overview
- Service B orchestrates by pulling coverage/status + messages from Service A and writing plan/result artifacts to `intel_artifacts` (`action_plan_snapshot`, `action_plan_result`) and evidence rows to `intel_events.backfill_target_posted`.
- Cooldown gating only checks `intel_events.backfill_target_posted` within `ORCH_TARGET_COOLDOWN_MS` (env); `targetsPosted` should mirror those events.
- Debug a run:
  1) Run orchestrate with debug: `curl -s -X POST -H "${AUTH_HEADER:-Authorization: Bearer test-key}" "${SERVICE_B_BASE_URL:-http://localhost:4000}/intel/orchestrate/run?runType=manual&debug=true" | jq`.
  2) Note `planArtifactId` and fetch it: `curl -s -H "${AUTH_HEADER}" "${SERVICE_B_BASE_URL:-http://localhost:4000}/intel/artifacts/${planArtifactId}" | jq`.
  3) Latest plan: `curl -s -H "${AUTH_HEADER}" "${SERVICE_B_BASE_URL:-http://localhost:4000}/intel/artifacts/latest?type=plan" | jq`.
  4) Interpret gating: `targetDecisions` shows candidates, filters, cooldown/priority reasons (`dropReasons`, `cooldownRemainingMs`, `eventPriority`), and which chats were posted (`posted=true`).
  5) Verify cooldown evidence by chat: `curl -s -H "${AUTH_HEADER}" "${SERVICE_B_BASE_URL:-http://localhost:4000}/intel/chat/$CHAT_ID/latest" | jq '{artifacts,eventCounts}'` (counts include `backfill_target_posted` from the last 7d).
  6) Service A reachability errors return `ok=false` with `error=service_a_unreachable` instead of hanging.

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

## Golden path manual checklist (no script)
1) Confirm Service A ready: `curl -s ${SERVICE_A_BASE_URL:-http://localhost:3000}/status | jq '{state,startupInfillStatus}'` (expect connected + done).
2) Inspect coverage/targets: `curl -s -H "${AUTH_HEADER:-Authorization: Bearer test-key}" ${SERVICE_A_BASE_URL:-http://localhost:3000}/api/debug/state | jq '.backfillTargets'`.
3) Post a backfill target manually (Service B): `curl -s -X POST -H "${AUTH_HEADER}" "${SERVICE_B_BASE_URL:-http://localhost:4000}/intel/backfill/chat/$CHAT_ID?targetMessages=500"`.
4) Run orchestrate: `curl -s -X POST -H "${AUTH_HEADER}" "${SERVICE_B_BASE_URL:-http://localhost:4000}/intel/orchestrate/run?runType=manual&debug=true" | jq`.
5) Check explain/action plan: `curl -s -H "${AUTH_HEADER}" "${SERVICE_B_BASE_URL:-http://localhost:4000}/intel/orchestrate/explain?latest=manual" | jq`.
6) Verify backfill events: `psql ... -c "select chat_id, ts from intel_events where type='backfill_target_posted' order by ts desc limit 20;"`.
7) Verify artifacts: `curl -s -H "${AUTH_HEADER}" ${SERVICE_B_BASE_URL:-http://localhost:4000}/intel/chat/$CHAT_ID/latest | jq`.
8) Review health: `curl -s -H "${AUTH_HEADER}" ${SERVICE_B_BASE_URL:-http://localhost:4000}/intel/health/summary | jq`.
