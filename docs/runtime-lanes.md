# Service B Runtime Lanes

For each lane: trigger, schedule/env, inputs, outputs, guardrails, and code references.

## Scheduler tick (control loop)
- Trigger: interval tick `ORCH_TICK_MS` (`src/services/orchestratorScheduler.ts`).
- Actions per tick (when due): orchestrate_run, open_loops_refresh_run, daily metrics, job worker, watermarks sync.
- Inputs: Service A `/status` (readiness gate), `/api/coverage/status` (for orchestrate scheduling), orchestrator state file.
- Outputs: updates state file `out/intel/orchestrator_state.json`, `intel_runs`/artifacts for invoked lanes.
- Guardrails: Service A connected + startupInfillStatus done; interval mins in `schedulerConfig`.

## orchestrate_run
- Trigger: Scheduler tick (`src/services/orchestratorScheduler.ts`) when due by `ORCH_ORCHESTRATE_MIN_INTERVAL_MS`; manual `POST /intel/orchestrate/run` (`src/routes/intel.ts`).
- Schedule env: `ORCH_ENABLED`, `ORCH_TICK_MS`, `ORCH_ORCHESTRATE_MIN_INTERVAL_MS`.
- Inputs: Service A `/status`, `/api/coverage/status`, `/api/chats/active`, `/api/messages/chat/:chatId/before`; cooldown from `intel_events` (`getLastBackfillPostedByChatIds`); event-priority from `intel_events`.
- Outputs: `intel_runs` (orchestrate_run), `intel_artifacts` (`orchestrate_result`, `action_plan_snapshot`, `action_plan_result`), `intel_events` (`backfill_target_posted`), state file `out/intel/orchestrator_state.json`, heat JSON/JSONL.
- Guardrails: readiness gate (Service A connected + startupInfillStatus=done), caps `limitChats/limitPerChat`, event priority caps, `ORCH_TARGET_COOLDOWN_MS`, exclude broadcast/groups/lid.
- Code: `orchestrateRun` in `src/services/orchestratorService.ts`.

## watermarks_sync_run
- Trigger: Scheduler tick (~10m) and manual `POST /intel/watermarks/sync` (`src/routes/intel.ts`).
- Inputs: recent messages (Service A), intel_events high-signal, chat pipeline state.
- Outputs: `intel_runs` (watermarks_sync_run), `intel_artifacts` (watermarks_sync_result), enqueues jobs in `jobs` (metrics_daily_chat, signals_events_chat).
- Guardrails: includeGroups=false, exclude broadcast/lid/group.
- Code: route + enqueue in `src/routes/intel.ts`; worker infra in `src/services/jobQueue.ts`.

## Job worker
- Trigger: Scheduler tick claims up to `ORCH_JOB_WORKER_LIMIT` (`orchestratorScheduler.ts`).
- Inputs: `jobs` table (queued with run_after).
- Outputs: job status updates; per job `intel_runs`/`intel_artifacts`; `intel_events` for signals jobs.
- Guardrails: SKIP LOCKED; backoff in `failJob`.
- Code: `processMetricsJob` / `processSignalsJob` in `src/services/orchestratorScheduler.ts`.

## metrics_daily_run
- Trigger: Scheduler daily at `ORCH_DAILY_METRICS_HOUR/MINUTE` (activeOnly=true) and manual `POST /intel/metrics/daily/run`.
- Inputs: Service A chats/messages; recent messages for activeOnly.
- Outputs: `intel_runs` (metrics_daily_run), `intel_artifacts` (metrics_daily_snapshot), files `out/intel/metrics_daily_latest.json` + JSONL.
- Guardrails: `limitChats/limitPerChat`, activeOnly/minMsgs.
- Code: `runDailyMetrics` in `src/services/metricsDailyService.ts`, route `src/routes/intel.ts`.

## metrics_daily_chat (job)
- Trigger: jobs worker (type metrics_daily_chat).
- Outputs: `intel_runs` (metrics_daily_chat), `intel_artifacts` (metrics_daily_chat_snapshot).
- Code: `processMetricsJob` in `src/services/orchestratorScheduler.ts`.

## metrics_timeofday_run
- Trigger: Scheduler daily (same window) and manual `POST /intel/metrics/time-of-day/run`.
- Inputs: Service A chats/messages.
- Outputs: `intel_runs` (metrics_timeofday_run), `intel_artifacts` (metrics_timeofday_snapshot), files `out/intel/metrics_timeofday_latest.json` + JSONL.
- Guardrails: limits, activeOnly/minMsgs.
- Code: `runTimeOfDayMetrics` in `src/services/timeOfDayMetricsService.ts`, route `src/routes/intel.ts`.

## signals_run
- Trigger: Manual `POST /intel/signals/run`.
- Inputs: Service A recent messages; LLM prompt.
- Outputs: `intel_runs` (signals_run), `intel_artifacts` (signals_snapshot).
- Guardrails: limits on chats/messages in route.
- Code: route in `src/routes/intel.ts`.

## signals_events_run
- Trigger: Manual `POST /intel/signals/events/run`.
- Inputs: Service A recent messages; LLM events prompt.
- Outputs: `intel_runs` (signals_run), `intel_artifacts` (signals_events_snapshot), `intel_events` (typed events).
- Code: route in `src/routes/intel.ts`.

## signals_events_chat (job)
- Trigger: jobs worker type signals_events_chat.
- Outputs: `intel_runs` (signals_events_chat), `intel_artifacts` (signals_events_chat_snapshot), `intel_events`.
- Code: `processSignalsJob` in `src/services/orchestratorScheduler.ts`.

## radar_run
- Trigger: Manual `POST /intel/radar/run`.
- Inputs: Service A chats/messages; heat triage prompt.
- Outputs: `intel_runs` (radar_run), `intel_artifacts` (heat_triage_result), files `out/intel/heat_triage_latest.json` + JSONL.
- Code: `runRadar` in `src/services/radarService.ts`, route `src/routes/intel.ts`.

## open_loops_refresh_run
- Trigger: Scheduler tick every `ORCH_OPEN_LOOPS_MIN_INTERVAL_MS` and manual `POST /open-loops/refresh`.
- Outputs: `intel_runs` (open_loops_refresh_run), `intel_artifacts` (open_loops_refresh_result with window/chatsProcessed/loopsAdded/loopsClosed/evidencePointers), files under `out/open-loops`.
- Independence: not coupled to orchestrate.
- Code: `src/routes/openLoops.ts`, scheduler wiring in `src/services/orchestratorScheduler.ts`.
