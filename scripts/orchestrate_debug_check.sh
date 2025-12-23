#!/usr/bin/env bash
set -euo pipefail

SERVICE_B_BASE_URL="${SERVICE_B_BASE_URL:-http://localhost:4000}"
AUTH_HEADER="${AUTH_HEADER:-Authorization: Bearer test-key}"

echo "Running orchestrate with debug..."
resp="$(curl -fsS -X POST -H "${AUTH_HEADER}" "${SERVICE_B_BASE_URL}/intel/orchestrate/run?runType=manual&debug=true")"
echo "${resp}" | jq '{ok, runId, planArtifactId, targetsPlanned, targetsPosted, postedMode, actionsPlanned, actionsExecuted}'

echo "Explain snapshot/result (latest)..."
curl -fsS -H "${AUTH_HEADER}" "${SERVICE_B_BASE_URL}/intel/orchestrate/explain" | jq '{snapshot: .snapshot?.payload?.evidence?, result: .result?.payload?.results?}'
