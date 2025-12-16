import crypto from "node:crypto";
import { callLLM, getModelName } from "../llm.js";
import { fetchMessagesSinceWithMeta, FetchResult } from "../whatsappClient.js";
import { buildEAOpenLoopsV1Prompt } from "../prompts.js";
import { toSummaryMessages } from "../prompts.js";
import {
  getLatestChatEAState,
  ChatEAState,
  EAOpenLoop,
  stableLoopId,
  upsertChatEAState,
  clearChatEAState,
} from "../stores/chatEAStateStore.js";
import { getCursor, setCursor } from "../stores/chatCursorStore.js";
import fs from "fs/promises";
import path from "path";
import { normalizeWhen } from "../utils/when.js";
import { appendRun, DropRecord } from "../stores/eaDebugRunsStore.js";

const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeKey(text: string): string {
  return text.toLowerCase().replace(/[^\w]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeIntentKey(key?: string): string | undefined {
  if (!key || typeof key !== "string") return undefined;
  const cleaned = key.toLowerCase().replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length ? cleaned : undefined;
}

function normalizeTaskGoal(text?: string | null): string {
  if (!text) return "";
  let t = text.toLowerCase();
  t = t.replace(/\b(20\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|\d{1,2}(:\d{2})?\s?(am|pm)?|\d{1,2}(st|nd|rd|th)?)\b/g, " ");
  t = t.replace(/[^\w\s]/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  if (/\b(pedrito|black box|testing|test|feedback|link)\b/i.test(text)) return "pedrito_testing";
  return t;
}

function isSmallTalk(summary: string): boolean {
  return /\b(how (are|r) (you|u)|how was your day|good (morning|night)|gm\b|gn\b|hello|hi\b|hey\b|hope you (are|r) (ok|well|good))\b/i.test(
    summary
  );
}

function isInfoToSaveWorthy(summary: string, confidence: number): boolean {
  if (confidence < 0.5) return false;
  return /\b(remember|note|save|address|allergy|flight|booking|reservation|code|tracking|number)\b/i.test(summary);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

function inferEvidence(chatId: string, loop: any, messages: ReturnType<typeof toSummaryMessages>): { evidenceMessageId?: string; evidenceText?: string; inferred: boolean } {
  const tokens = tokenize(`${loop.taskGoal ?? ""} ${loop.summary ?? ""} ${loop.intentKey ?? ""}`);
  if (!tokens.length) return { inferred: false };
  let bestScore = -1;
  let best: ReturnType<typeof toSummaryMessages>[number] | null = null;
  for (const m of messages) {
    const bodyTokens = tokenize(m.body ?? "");
    const overlap = bodyTokens.filter((t) => tokens.includes(t)).length;
    if (overlap === 0) continue;
    const preferOther = (loop.type === "reply_needed" || loop.type === "decision_needed") && !m.fromMe;
    let score = overlap * 10 + (preferOther ? 5 : 0) + m.ts / 1e9;
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  if (!best) return { inferred: false };
  const trimmed = (best.body ?? "").slice(0, 140);
  return { evidenceMessageId: best.id, evidenceText: trimmed, inferred: true };
}

function sanitizeEAResult(
  chatId: string,
  lastMessageId: string | undefined,
  loops: any[],
  messages: ReturnType<typeof toSummaryMessages>,
  cap = 10
): { sanitizedLoops: EAOpenLoop[]; dropped: DropRecord[] } {
  const sanitized: EAOpenLoop[] = [];
  const byKey = new Map<string, EAOpenLoop>();
  const messageById = new Map<string, string>();
  for (const m of messages) {
    messageById.set(m.id, m.body);
  }
  const dropped: DropRecord[] = [];
  const strictEvidence = process.env.STRICT_EVIDENCE === "1";
  if (process.env.DEBUG_INTEL === "1") {
    console.info("[ea-openloops] sanitize evidence mode", { strictEvidence });
  }

  for (const loop of loops ?? []) {
    const summaryRaw = typeof loop?.summary === "string" ? loop.summary : typeof loop?.what === "string" ? loop.what : "";
    const summary = summaryRaw.trim();
    if (!summary) {
      dropped.push({ reason: "empty_summary", loop });
      continue;
    }

    let evidenceMessageId = typeof loop?.evidenceMessageId === "string" ? loop.evidenceMessageId.trim() : typeof loop?.messageId === "string" ? loop.messageId.trim() : undefined;
    let evidenceText = typeof loop?.evidenceText === "string" ? loop.evidenceText.trim() : undefined;
    let evidenceInferred = false;

    const tryInfer = () => {
      const inferred = inferEvidence(chatId, loop, messages);
      if (inferred.evidenceMessageId && messageById.has(inferred.evidenceMessageId)) {
        evidenceMessageId = inferred.evidenceMessageId;
        evidenceText = inferred.evidenceText;
        evidenceInferred = true;
        return true;
      }
      return false;
    };

    if (!evidenceMessageId || !messageById.has(evidenceMessageId)) {
      if (strictEvidence) {
        dropped.push({ reason: "missing_evidence_message", loop });
        continue;
      }
      if (!tryInfer()) {
        if (strictEvidence) {
          dropped.push({ reason: "missing_evidence_message", loop });
          continue;
        }
      }
    }
    const evidenceBody = evidenceMessageId ? messageById.get(evidenceMessageId) ?? "" : "";
    if (evidenceText && evidenceBody && !evidenceBody.includes(evidenceText)) {
      if (strictEvidence) {
        dropped.push({ reason: "evidence_text_not_in_message", loop });
        continue;
      } else {
        if (!tryInfer()) {
          // keep but note inferred flag; evidenceText will be set below
          evidenceInferred = true;
        }
      }
    }
    if (!evidenceText && evidenceBody) {
      const trimmed = evidenceBody.slice(0, 160);
      evidenceText = trimmed;
      evidenceInferred = true;
    }

    let type: EAOpenLoop["type"] = (() => {
      const t = loop?.type;
      if (t === "reply_needed" || t === "decision_needed" || t === "todo" || t === "event_date" || t === "info_to_save" || t === "follow_up") return t;
      const cat = typeof loop?.category === "string" ? loop.category : undefined;
      if (cat === "follow_up") return "follow_up";
      if (cat === "question" || cat === "follow_up") return "reply_needed";
      if (cat === "promise") return "todo";
      if (cat === "time_sensitive") return loop?.when ? "event_date" : "todo";
      return "info_to_save";
    })();

    const actor: EAOpenLoop["actor"] = "me";

    const whenOptions =
      Array.isArray(loop?.whenOptions) && loop.whenOptions.length
        ? loop.whenOptions.filter((w: any) => typeof w === "string" && w.trim().length > 0)
        : [];
    const normalizedWhen = normalizeWhen(
      typeof loop?.when === "string" ? loop.when : null,
      typeof loop?.whenDate === "string" ? loop.whenDate : null
    );
    if (type === "event_date" && !normalizedWhen.hasTime) {
      // Downgrade to todo if no explicit time.
      type = "todo";
    }

    const urgency: EAOpenLoop["urgency"] = (() => {
      if (loop?.urgency === "high" || loop?.urgency === "moderate") return loop.urgency;
      const sev = typeof loop?.severity === "string" ? loop.severity.toLowerCase() : "";
      if (sev === "high") return "high";
      if (sev === "medium") return "moderate";
      return "low";
    })();

    const socialSoft =
      !normalizedWhen.when &&
      /tea|coffee|catch up|catchup|hangout|meet\s?(up)?|dinner|lunch/i.test(summary);

    let importance =
      typeof loop?.importance === "number"
        ? Math.max(1, Math.min(10, Math.round(loop.importance)))
        : typeof loop?.weight === "number"
          ? Math.max(1, Math.min(10, Math.round(loop.weight * 10)))
          : 5;
    if (socialSoft && importance > 7) importance = 7;

    const confidence =
      typeof loop?.confidence === "number"
        ? Math.max(0, Math.min(1, loop.confidence))
        : typeof loop?.confidenceScore === "number"
          ? Math.max(0, Math.min(1, loop.confidenceScore))
          : 0.5;

    const intentKey = normalizeIntentKey(loop?.intentKey);
    const taskGoal = normalizeTaskGoal(intentKey ?? summary);

    if (isSmallTalk(summary)) {
      dropped.push({ reason: "small_talk", loop });
      continue;
    }
    if (type === "info_to_save" && !isInfoToSaveWorthy(summary, confidence)) {
      dropped.push({ reason: "info_not_worthy", loop });
      continue;
    }
    if ((summary.length === 0 || taskGoal.length === 0) || (confidence < 0.3 && !evidenceMessageId)) {
      dropped.push({ reason: "low_confidence_or_empty", loop });
      continue;
    }
    const clean: EAOpenLoop = {
      id: undefined,
      intentKey,
      taskGoal,
      chatId,
      messageId: typeof loop?.messageId === "string" && loop.messageId.length ? loop.messageId : lastMessageId,
      type,
      summary: summary.length > 120 ? summary.slice(0, 120) : summary,
      actor,
      when: normalizedWhen.when,
      whenDate: normalizedWhen.whenDate,
      hasTime: normalizedWhen.hasTime,
      whenOptions,
      status: loop?.status === "done" ? "done" : "open",
      blocked: (() => {
        if (loop?.blocked === true && /wait/i.test(summary)) return true;
        if (/wait(ing)? (for|on)\s+(you|them|reply|response|link|confirm|confirmation)/i.test(summary)) return true;
        if (/\b(send|link|instructions)\b/i.test(summary) && /\b(will send|i will send|once.*looks nicer|finish(ing)?)/i.test(evidenceText ?? summary)) return true;
        return false;
      })(),
      confidence: evidenceInferred ? Math.max(0, Math.min(1, confidence - 0.15)) : confidence,
      importance,
      urgency,
      context: typeof loop?.context === "string" ? loop.context : undefined,
      evidenceMessageId,
      evidenceText: evidenceText ?? evidenceBody.slice(0, 200),
      evidenceInferred: evidenceInferred || loop?.evidenceInferred === true,
    };
    if (!clean.whenDate && !clean.hasTime && typeof loop?.when === "string" && loop.when.trim().length > 0) {
      clean.whenOptions = Array.from(new Set([...(clean.whenOptions ?? []), loop.when.trim()]));
    }
    const dedupeKey = `${chatId}|${actor}|${taskGoal}`;
    if (byKey.has(dedupeKey)) {
      const existing = byKey.get(dedupeKey)!;
      existing.whenOptions = Array.from(new Set([...(existing.whenOptions ?? []), ...whenOptions]));
      existing.when = existing.when ?? normalizedWhen.when;
      existing.whenDate = existing.whenDate ?? normalizedWhen.whenDate;
      existing.hasTime = existing.hasTime || normalizedWhen.hasTime;
      existing.status = existing.status === "done" || clean.status === "done" ? "done" : "open";
      existing.blocked = existing.blocked || clean.blocked;
      existing.importance = Math.max(existing.importance ?? 1, importance);
      existing.confidence = Math.max(existing.confidence ?? 0.5, confidence);
      existing.urgency = existing.urgency === "high" || clean.urgency === "high" ? "high" : existing.urgency === "moderate" || clean.urgency === "moderate" ? "moderate" : "low";
      existing.taskGoal = existing.taskGoal ?? taskGoal;
      continue;
    }
    byKey.set(dedupeKey, clean);
    if (byKey.size >= cap) break;
  }

  for (const loop of byKey.values()) sanitized.push(loop);
  return { sanitizedLoops: sanitized.slice(0, cap), dropped };
}

function deriveRunType(runType?: string | null): "morning" | "evening" | "manual" {
  if (runType === "morning" || runType === "evening" || runType === "manual") return runType;
  const hour = new Date().getHours();
  if (hour >= 5 && hour <= 11) return "morning";
  if (hour >= 17 && hour <= 23) return "evening";
  return "manual";
}

export async function refreshEAOpenLoopsForChat(chatId: string, opts: { force?: boolean; maxNewMessages?: number; runType?: "morning" | "evening" | "manual"; hours?: number } = {}) {
  const force = !!opts.force;
  const maxNewMessages = opts.maxNewMessages ?? 5000;
  const runType = deriveRunType(opts.runType);
  const priorState = force ? null : await getLatestChatEAState(chatId);
  const cursor = force ? null : await getCursor(chatId);
  const windowHours = opts.hours ?? 48;
  const now = Date.now();
  const baseFrom = now - windowHours * 60 * 60 * 1000;
  const sinceTs = force ? baseFrom : Math.max(baseFrom, (cursor?.lastRunToTs ?? 0) - 5 * 60 * 1000);

  const fetchResult: FetchResult = await fetchMessagesSinceWithMeta(sinceTs, maxNewMessages).catch(
    () => ({ messages: [] } as FetchResult)
  );
  let rawMessages = fetchResult.messages ?? [];
  rawMessages = rawMessages.filter((m) => m.chatId === chatId);
  rawMessages.sort((a, b) => a.ts - b.ts);
  const lastTs = rawMessages.length ? rawMessages[rawMessages.length - 1].ts : sinceTs;
  const lastMessageId = rawMessages.length ? rawMessages[rawMessages.length - 1].id : undefined;
  const messages = toSummaryMessages(rawMessages);
  const lastProcessed = cursor?.lastProcessedTs ?? 0;
  const newMessages = messages.filter((m) => m.ts > lastProcessed);
  const contextTail = messages.filter((m) => cursor && m.ts <= lastProcessed).slice(-20);
  if (newMessages.length === 0 && !force) {
    if (cursor) {
      await setCursor(chatId, {
        chatId,
        lastProcessedTs: cursor.lastProcessedTs,
        lastProcessedMessageId: cursor.lastProcessedMessageId,
        lastRunToTs: now,
        updatedAt: Date.now(),
      });
    }
    if (process.env.DEBUG_INTEL === "1") {
      console.info("[ea-openloops] skip chat (no new msgs)", {
        chatId,
        fromTs: sinceTs,
        lastProcessedTs: cursor?.lastProcessedTs,
        newCount: 0,
        contextCount: contextTail.length,
      });
    }
    return priorState;
  }

  const prompt = buildEAOpenLoopsV1Prompt({
    chatId,
    displayName: messages[0]?.displayName ?? chatId,
    isGroup: chatId.endsWith("@g.us"),
    priorOpenLoops: priorState?.openLoops ?? [],
    existingOpenLoops: priorState?.openLoops ?? [],
    contextMessages: contextTail,
    newMessages,
    messages,
    ownerPerspective: "me",
  });

  if (process.env.DEBUG_INTEL === "1") {
    console.info("[ea-openloops] LLM call", {
      chatId,
      model: getModelName("openLoops"),
      priorCount: priorState?.openLoops?.length ?? 0,
      newMsgs: messages.length,
    });
  }

  let result: { openLoops?: any[] } = {};
  try {
    result = await callLLM<any>("openLoops", prompt);
  } catch (err) {
    console.error("[ea-openloops] LLM failed", { chatId, err });
    return priorState;
  }

  if (process.env.DEBUG_INTEL === "1") {
    const firstKeys = result?.openLoops && result.openLoops.length ? Object.keys(result.openLoops[0]) : [];
    console.info("[ea-openloops] raw result", {
      chatId,
      firstLoopKeys: firstKeys,
      countBeforeSanitize: Array.isArray(result.openLoops) ? result.openLoops.length : 0,
    });
  }

  const sanitizedResult = sanitizeEAResult(chatId, lastMessageId, result.openLoops ?? [], messages, 10);
  let openLoops = sanitizedResult.sanitizedLoops;

  // Auto generate follow-up receipt loops for send-style tasks
  const sendKeywords = /\b(send|share|forward|provide|deliver|submit|invoice|email|text|attach|upload|link|invite|docs|documents|instructions|file|address|payment|calendar|schedule)\b/i;
  const followUps: EAOpenLoop[] = [];
  for (const l of openLoops) {
    if (l.actor !== "me") continue;
    if (l.type !== "todo" && l.type !== "reply_needed") continue;
    if (!sendKeywords.test(l.summary) && !sendKeywords.test(l.taskGoal ?? "")) continue;
    if (l.blocked === true) continue;
    const sentEvidence =
      /sent|emailed|forwarded|shared|attached|uploaded|delivered/i.test(l.summary) ||
      /\bhttps?:\/\/\S+/i.test(l.summary) ||
      l.status === "done";
    if (!sentEvidence) continue;
    const targetPerson = (l as any).displayName ?? l.actor ?? "them";
    const artifactMatch = (() => {
      const m = l.summary.match(/\b(link|invite|address|doc|file|instructions|details|payment|calendar)\b/i);
      if (m) return m[0].toLowerCase();
      const tg = (l.taskGoal ?? "").match(/\b(link|invite|address|doc|file|instructions|details|payment|calendar)\b/i);
      return tg ? tg[0].toLowerCase() : null;
    })();
    if (!artifactMatch) continue;
    const baseGoal = l.taskGoal ?? normalizeTaskGoal(l.summary);
    const fuGoal = `follow_up_receipt__${baseGoal}`;
    const whenDate = (() => {
      const d = new Date(lastTs + 24 * 60 * 60 * 1000);
      return d.toISOString().slice(0, 10);
    })();
    // Only one follow-up per dependency
    const existingFU = openLoops.find(
      (ol) => ol.type === "follow_up" && ol.dependsOnTaskGoal === baseGoal && ol.chatId === l.chatId
    );
    if (existingFU) continue;

    followUps.push({
      ...l,
      id: undefined,
      type: "follow_up",
      taskGoal: fuGoal,
      summary: "Follow up: did they receive it?",
      blocked: true,
      when: null,
      whenDate,
      hasTime: false,
      dependsOnTaskGoal: baseGoal,
      context: `Triggered after: ${baseGoal}. Confirm receipt and whether they need anything else.`,
    });
  }
  openLoops = [...openLoops, ...followUps];
  // Unblock follow-ups if base task already done
  const byGoal = new Map<string, EAOpenLoop>();
  for (const l of openLoops) {
    if (l.taskGoal) byGoal.set(l.taskGoal, l);
  }
  openLoops = openLoops.map((l) => {
    if (l.type === "follow_up" && l.dependsOnTaskGoal) {
      const base = byGoal.get(l.dependsOnTaskGoal);
      if (base && base.status === "done") return { ...l, blocked: false };
    }
    return l;
  });

  // Force all actionable items to be owned by the user (actor = "me") so we don't emit mirrored copies.
  openLoops = openLoops.map((l) => ({
    ...l,
    actor: l.type === "info_to_save" ? l.actor : "me",
    lastSeenTs: lastTs,
    id: stableLoopId(chatId, { ...l, actor: l.type === "info_to_save" ? l.actor : "me" }),
  }));

  // Consolidate by chatId + taskGoal to one obligation.
  const precedence = ["decision_needed", "reply_needed", "todo", "follow_up", "info_to_save"] as const;
  const grouped = new Map<string, EAOpenLoop[]>();
  for (const l of openLoops) {
    const key = `${l.chatId}|${l.actor}|${normalizeTaskGoal(l.taskGoal ?? l.summary)}`;
    const arr = grouped.get(key) ?? [];
    arr.push(l);
    grouped.set(key, arr);
  }
  const consolidated: EAOpenLoop[] = [];
  for (const arr of grouped.values()) {
    const best = [...arr].sort((a, b) => precedence.indexOf(a.type as any) - precedence.indexOf(b.type as any))[0];
    const merged = arr.reduce((acc, cur) => {
      const betterType = precedence.indexOf(cur.type as any) < precedence.indexOf(acc.type as any) ? cur.type : acc.type;
      const betterUrgency = (() => {
        const rank: Record<EAOpenLoop["urgency"], number> = { high: 3, moderate: 2, low: 1 };
        return rank[cur.urgency] > rank[acc.urgency] ? cur.urgency : acc.urgency;
      })();
      const whenOptions = Array.from(new Set([...(acc.whenOptions ?? []), ...(cur.whenOptions ?? [])]));
      return {
        ...acc,
        type: betterType,
        when: acc.when ?? cur.when,
        whenDate: acc.whenDate ?? cur.whenDate,
        hasTime: acc.hasTime || cur.hasTime,
        whenOptions,
        status: acc.status === "done" || cur.status === "done" ? "done" : "open",
        blocked: (acc.blocked ?? false) || (cur.blocked ?? false),
        importance: Math.max(acc.importance, cur.importance),
        urgency: betterUrgency,
        confidence: Math.max(acc.confidence, cur.confidence),
        summary: acc.summary.length >= cur.summary.length ? acc.summary : cur.summary,
        dependsOnTaskGoal: acc.dependsOnTaskGoal ?? cur.dependsOnTaskGoal,
        blockedReason: acc.blockedReason ?? cur.blockedReason,
        context: acc.context ?? cur.context,
      };
    }, best);
    if (
      merged.taskGoal === "pedrito_testing" &&
      /send/i.test(merged.summary) &&
      /(test|feedback)/i.test(merged.summary)
    ) {
      merged.blocked = true;
    }
    // Regression check: follow_up summaries must include artifact if mentioning receipt.
    consolidated.push(merged);
  }
  openLoops = consolidated;

  // Persist debug run
  const runRecord = {
    runId: `${Date.now()}`,
    ts: Date.now(),
    chatId,
    messageCount: messages.length,
    fromTs: messages[0]?.ts,
    toTs: messages[messages.length - 1]?.ts,
    rawOpenLoops: result.openLoops ?? [],
    sanitizedOpenLoops: openLoops,
    dropped: sanitizedResult.dropped,
    runType,
  };
  try {
    await appendRun(chatId, runRecord);
  } catch (err) {
    console.error("[ea-openloops] failed to append debug run", err);
  }

  if (process.env.DEBUG_INTEL === "1") {
    console.info("[ea-openloops] after sanitize", {
      chatId,
      rawCount: result.openLoops?.length ?? 0,
      sanitizedCount: openLoops.length,
      droppedCount: sanitizedResult.dropped.length,
      fromTs: sinceTs,
      newCount: newMessages.length,
      contextCount: contextTail.length,
      lastProcessedTsBefore: cursor?.lastProcessedTs,
      lastProcessedTsAfter: newMessages.length ? Math.max(...newMessages.map((m) => m.ts)) : cursor?.lastProcessedTs,
      truncated: fetchResult.truncated,
      total: fetchResult.total,
    });
    if ((result.openLoops?.length ?? 0) > 0 && openLoops.length === 0) {
      const topDrops = sanitizedResult.dropped.slice(0, 2).map((d) => d.reason);
      console.warn("[ea-openloops] warning: raw>0 but sanitized=0", { chatId, topDrops });
    }
    for (const l of openLoops) {
      console.info("[ea-openloops] loop", {
        chatId,
        actor: l.actor,
        intentKey: l.intentKey,
        stableLoopId: l.id,
        lastSeenTs: l.lastSeenTs,
        blocked: l.blocked,
      });
    }
  }

  if (process.env.DEBUG_INTEL === "1") {
    // Already logged above
  }

  const state: ChatEAState = {
    id: "chat-ea-state",
    chatId,
    updatedAt: Date.now(),
    lastProcessedMessageTs: lastTs,
    openLoops,
    modelUsed: getModelName("openLoops"),
  };

  if (force) await clearChatEAState(chatId);
  await upsertChatEAState(state);
  if (newMessages.length) {
    const newCursorTs = Math.max(...newMessages.map((m) => m.ts));
    await setCursor(chatId, {
      chatId,
      lastProcessedTs: newCursorTs,
      lastProcessedMessageId: newMessages[newMessages.length - 1]?.id,
      lastRunToTs: now,
      updatedAt: Date.now(),
    });
  } else {
    await setCursor(chatId, {
      chatId,
      lastProcessedTs: cursor?.lastProcessedTs ?? sinceTs,
      lastProcessedMessageId: cursor?.lastProcessedMessageId,
      lastRunToTs: now,
      updatedAt: Date.now(),
    });
  }
  return state;
}

export async function refreshEAOpenLoopsForRecentChats(
  hours: number,
  opts: { force?: boolean; maxChats?: number; maxNewMessages?: number; runType?: "morning" | "evening" | "manual" } = {}
) {
  const force = !!opts.force;
  const maxChats = opts.maxChats ?? 50;
  const maxNewMessages = opts.maxNewMessages ?? 5000;
  const runType = deriveRunType(opts.runType);
  const sinceTs = Date.now() - hours * 60 * 60 * 1000;
  const meta: FetchResult = await fetchMessagesSinceWithMeta(sinceTs, maxNewMessages).catch(
    () => ({ messages: [] } as FetchResult)
  );
  let rawMessages = meta.messages ?? [];
  rawMessages.sort((a, b) => a.ts - b.ts);

  const byChat = new Map<string, number>();
  for (const m of rawMessages) {
    byChat.set(m.chatId, Math.max(byChat.get(m.chatId) ?? 0, m.ts));
  }
  const chats = Array.from(byChat.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxChats)
    .map(([chatId]) => chatId);

  const results: ChatEAState[] = [];
  let totalFetchedMessages = rawMessages.length;
  let truncatedChatsCount = meta.truncated || meta.hasMore ? 1 : 0;
  for (const chatId of chats) {
    const state = await refreshEAOpenLoopsForChat(chatId, { force, maxNewMessages, runType, hours });
    if (state) results.push(state);
  }

  if (process.env.DEBUG_INTEL === "1") {
    console.info("[ea-openloops] refresh run", {
      runType,
      hours,
      fromTs: sinceTs,
      toTs: Date.now(),
      chatsProcessed: results.length,
      totalFetchedMessages,
      truncatedChatsCount,
    });
  }
  return results;
}

export async function loadAllEAOpenLoops(): Promise<EAOpenLoop[]> {
  try {
    const data = await fs.readFile(path.join(process.cwd(), "out", "chat_ea_state.jsonl"), "utf-8");
    const lines = data.split("\n").filter((l) => l.trim().length > 0);
    const loops: EAOpenLoop[] = [];
    const dedupe = new Map<string, EAOpenLoop>();
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as ChatEAState;
        for (const l of obj.openLoops ?? []) {
          const full = {
            ...l,
            chatId: l.chatId ?? obj.chatId,
            lastSeenTs: (l as any).lastSeenTs ?? obj.updatedAt,
          } as EAOpenLoop;
          const id = stableLoopId(full.chatId ?? "unknown", full);
          const existing = dedupe.get(id);
          if (!existing || (full.lastSeenTs ?? 0) > (existing.lastSeenTs ?? 0)) {
            dedupe.set(id, { ...full, id });
          }
        }
      } catch {
        continue;
      }
    }
    dedupe.forEach((v) => loops.push(v));
    return loops;
  } catch {
    return [];
  }
}
