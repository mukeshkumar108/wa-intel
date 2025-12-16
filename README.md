# wa-intel (Service B)

Node/TypeScript API that turns WhatsApp messages from Service A into an EA‑style “what’s on your plate” feed (open loops) plus digest/intel endpoints. Stores are file-based under `out/` so it can run anywhere (local or Docker).

## Architecture (quick map)
- `src/index.ts` wires Express + API key middleware (all routes except `/health*`).
- External dependency: Service A (WhatsApp ingestor) via `whatsappClient.ts` (`WHATSAPP_BASE`, `WHATSAPP_API_KEY`).
- LLM: OpenRouter via `OPENROUTER_API_KEY` (`llm.ts` registry).
- EA loops: incremental per-chat pipeline in `eaOpenLoopsService.ts`, state in `out/chat_ea_state.jsonl`, cursors in `out/chat_cursors.json`, debug runs in `out/ea_runs/`.
- Plate assembly: `openLoopsV2Service.ts` returns EA loops only, enriches displayName/isGroup from contacts/people.
- Digest: `digestService.ts` builds day summaries using messages + active loops.
- Window insights (mood/themes/etc): `windowAnalysisService.ts` (kept for context, not for plate).
- Health & admin: `routes/health.ts`, `routes/openLoopsRefresh.ts`, `routes/onboardingPrime.ts`.

## Key routes (API)
- `GET /health` – basic liveness.
- `GET /health/deps` – pings Service A, reports latency/ok.
- `POST /open-loops/refresh?hours=6&force=false&limit=5000&runType=manual` – updates EA loops incrementally (uses cursor + time window).
- `GET /open-loops/active` – current plate (EA loops only), includes `displayName`, `isGroup`, and meta sourceUsed.
- `GET /digest/today` – day digest built from active loops + summaries.
- `GET /debug/ea/latest?chatId=...` / `GET /debug/ea/summary?hours=24` – debug runs (no prod impact).
- Relationships/people/state windows: `/relationships/*`, `/people`, `/state/*`, `/windows/*` (context/insights; not used for plate).
- Onboarding prime: `POST /onboarding/prime?hours=6` (runs refresh + digest); API-key protected.

## Running locally
```bash
npm install
npm run dev          # tsx watch
# or
npm run build && node dist/index.js
```

Required env vars:
- `WHATSAPP_BASE` (Service A base URL)
- `WHATSAPP_API_KEY`
- `OPENROUTER_API_KEY`
- `B_API_KEY` (optional API auth; if set, must send `Authorization: Bearer ...`)
- Optional: `OPENROUTER_MODEL` (default `openai/gpt-4.1-mini`), `PORT` (default 4000), `USER_TZ_OFFSET_HOURS`.

## Docker / Compose
- `Dockerfile` builds a 2-stage Node 20 Alpine image; runs `node dist/index.js` on port 4000 (0.0.0.0).
- `docker-compose.yml` defines `intel-api` (binds 4000, mounts named volume to `/app/out`) and optional `intel-scheduler` (supercronic with `cron/ea-refresh.cron`). Use `.env` for secrets.

## Data stores (file-based under `out/`)
- `chat_ea_state.jsonl` – latest EA loops per chat.
- `chat_cursors.json` – per-chat cursor (last processed ts/id, last run).
- `ea_runs/<chatId>.jsonl` – debug runs (raw/sanitized/dropped).
- Other window/intel stores remain append-only for insights.

## How refresh works (EA loops)
1) Compute `fromTs` = max(window start, lastRunToTs-5m overlap) unless `force=true`.
2) Fetch messages since `fromTs` from Service A (`/api/messages/since?ts=...&limit=...`).
3) Build LLM prompt with contextTail + newMessages + existingOpenLoops; sanitize/normalize; generate follow-ups deterministically.
4) Store loops + cursor; write debug run.

## Quick smoke commands
```bash
curl -X POST "http://localhost:4000/open-loops/refresh?hours=6&force=true&limit=5000" | jq
curl "http://localhost:4000/open-loops/active" | jq
curl "http://localhost:4000/digest/today" | jq
```

## Git hygiene
- Secrets/data are not committed: `.env`, `out/`, `node_modules/`, `dist/` are ignored. Keep `.env` local; use placeholders in `.env.example` if needed.
