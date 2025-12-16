# Open Loops (Window V2) — How It Works

## What we do now
- **Window pass (4h slices):** Single LLM call for window-level mood/events/relationshipMentions. This keeps the overall context.
- **Per-chat open loops:** For each chat in the window (capped to last 150 msgs by default), we run the open-loop prompt. This guarantees chatId/actor attribution and avoids cross-chat bleed. The per-chat call also returns optional `chatSummary`, `chatMood`, `chatThemes`, `chatTone`, `keyMoments`, and ask counts (`asksFromThem`/`asksFromMe`). Per-chat loops are deduped before saving (by intentKey → loopKey → normalized summary) and normalized with contact displayName. Incremental mode uses checkpoints: if no new messages since last run, the per-chat LLM call is skipped; otherwise we process only the delta plus a small overlap. Force=true backfill ignores checkpoints.
- **Normalization & merge:**
  - Chat metadata is built from window messages (contactMeta). If a loop lacks chatId/displayName/isGroup, we fill it deterministically: match actor→displayName, else single contact, else highest-volume contact in that window.
  - Summary fallback: `summary || what || action || description || context` (trimmed); drop only if all are empty.
  - Type inference: map `category` to window types; we may further infer from `loopKey`/summary if needed.
  - Merge/dedupe lives in `openLoopsV2Service` (loopKey, whenOptions, etc.).
- **Per-chat enrichment:** Per-chat chatSummary/mood/themes/tone/keyMoments/ask counts are merged into contact slices (`windowSummary`, `toneDescriptors`, `dominantConcerns`, `moments`, `asksFromThem/Me`).
- **Prompt hints:** Open-loop prompt now also asks for `chatSummary`, `chatMood`, `chatThemes`, `chatTone`, `keyMoments`, ask counts, plus `intentKey`/`intentLabels` and `loopKey` for better consolidation.

## Files & responsibilities
- `src/services/windowAnalysisService.ts`
  - Window pass: mood/events/relationshipMentions.
  - Per-chat pass: `extractOpenLoopsPerChat` calls `buildOpenLoopsPrompt` per chat, builds contactMeta, fills missing chatId/actor, uses checkpoints for incremental runs, and dedupes per chat.
  - Normalization: chatId inference, summary fallback, loop metadata clamp, merge of per-chat summary into contact slices.
- `src/prompts.ts`
  - `buildOpenLoopsPrompt` extended to return `chatSummary`, `chatMood`, `chatThemes`.
- `src/services/openLoopsV2Service.ts`
  - Merge/dedupe/sort open loops across windows; applies overrides.
- `src/openLoopOverridesStore.ts`
  - Overrides (done/dismiss/snooze).

## Current limits / next tweaks
- Still one window LLM call for mood/events; open loops are per chat.
- If types come back as "other", we can add a local keyword inference.
- If we want richer per-chat intel, extend the per-chat prompt to include key moments / tone (using the same call).

## How to refresh data locally
1) Restart the server after code changes.
2) Backfill a short range (e.g., 48h) to re-run per-chat loops with the new prompt/logic:
   ```
   curl -X POST "http://localhost:4000/v2/windows/backfill?hours=48&force=true"
   ```
3) Inspect:
   ```
   curl "http://localhost:4000/open-loops/active" | jq
   curl "http://localhost:4000/digest/today" | jq
   ```
