import crypto from "node:crypto";
import { loadWindowAnalysesForLastDays } from "../windowAnalysisStore.js";
import { WindowOpenLoop } from "../types.js";
import { applyOverrides, loadOverrides } from "../openLoopOverridesStore.js";
import { callLLM } from "../llm.js";
import { loadAllEAOpenLoops } from "./eaOpenLoopsService.js";
import { normalizeWhen } from "../utils/when.js";
import { getRecentOneToOneChats } from "../routes/people.js";
import { fallbackNameFromChatId } from "../utils/displayName.js";
import { fetchContacts } from "../whatsappClient.js";

function clampWhen(loop: any) {
  const parsed = normalizeWhen(loop.when ?? null, loop.whenDate ?? null);
  let when = parsed.when;
  let whenDate = parsed.whenDate;
  let hasTime = parsed.hasTime;

  if (loop.hasTime === false) {
    when = null;
    hasTime = false;
  }
  // Detect midnight placeholder on incoming when.
  if (loop.when && !loop.hasTime) {
    if (process.env.DEBUG_INTEL === "1") {
      console.warn("[openLoops][warn] hasTime=false but when present (clamping)", { id: loop.id, chatId: loop.chatId, when: loop.when });
    }
    when = null;
    hasTime = false;
  }
  if (when) {
    const d = new Date(when);
    const isMidnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
    if (isMidnight && !parsed.hasTime) {
      whenDate = whenDate ?? normalizeWhen(null, loop.when)?.whenDate ?? null;
      when = null;
      hasTime = false;
    } else {
      hasTime = true;
      whenDate = whenDate ?? parsed.whenDate;
    }
  }
  return { ...loop, when, whenDate, hasTime };
}

export interface ActiveOpenLoop extends WindowOpenLoop {
  id: string;
  surfaceType?: "reply_needed" | "decision_needed" | "todo" | "event_date" | "info_to_save" | "follow_up";
  nextActions?: ("draft_reply" | "add_reminder" | "add_calendar" | "mark_done" | "dismiss" | "save_note")[];
  hasFollowUp?: boolean;
  overrideNote?: string;
  stale?: boolean;
  canonicalIntentKey?: string;
  blocked?: boolean;
  whenDate?: string | null;
  hasTime?: boolean;
  taskGoal?: string;
  dependsOnTaskGoal?: string;
  lane?: "now" | "later" | "backlog";
  laneOverride?: "now" | "later" | "backlog";
}

function normalize(text: string | null | undefined): string {
  if (!text) return "";
  return text.toLowerCase().trim();
}

function stripDates(text: string): string {
  let t = text.toLowerCase();
  t = t.replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thurs|fri|sat|sun)\b/g, " ");
  t = t.replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/g, " ");
  t = t.replace(/\b\d{1,2}(st|nd|rd|th)?\b/g, " ");
  t = t.replace(/\b\d{4}\b/g, " ");
  t = t.replace(/[^\w\s]/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function normalizeSummaryWithoutDates(summary: string): string {
  return stripDates(summary);
}

function canonicalIntentKey(loop: WindowOpenLoop): string | undefined {
  const candidates = [
    normalizeIntentKey(loop.intentKey),
    normalizeIntentKey(loop.loopKey),
    normalizeIntentKey(loop.summary ?? ""),
  ].filter(Boolean) as string[];

  const text = `${loop.summary ?? ""} ${loop.loopKey ?? ""} ${loop.intentKey ?? ""}`.toLowerCase();
  if (/(bad|negative|troubling|dark)\s+thought/.test(text)) return "dark_thoughts_support";
  if (/(write|letter).*(dad|father)/.test(text)) return "letter_to_dad";
  if (text.includes("pedrito") || text.includes("black box") || text.includes("testing link") || text.includes("instructions") || text.includes("feedback")) {
    return "pedrito_testing";
  }

  return candidates.find((c) => c && c.length) ?? undefined;
}

function normalizeIntentKey(key?: string | null): string | undefined {
  if (!key || typeof key !== "string") return undefined;
  return key.toLowerCase().replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "");
}

function computeCanonicalIntentKey(loop: WindowOpenLoop): { key?: string; source: string; used: "intentKey" | "loopKey" | "summary" } {
  // Highest priority: explicit intentKey
  if (loop.intentKey && loop.intentKey.trim().length > 0) {
    const base = normalizeIntentKey(loop.intentKey) ?? "";
    const alias = (() => {
      const text = base.toLowerCase();
      if (text.includes("pedrito")) return "pedrito_testing";
      if (/(bad|negative|troubling|dark)_thought/.test(text)) return "dark_thoughts_support";
      if (/letter.*dad/.test(text)) return "letter_to_dad";
      return base;
    })();
    return { key: alias || undefined, source: loop.intentKey, used: "intentKey" };
  }

  // Fallback: loopKey else summary
  const rawBase = loop.loopKey?.trim().length ? loop.loopKey! : loop.summary ?? "";
  const stripped = rawBase
    .replace(/^\d+@[\w.]+_/, "")
    .replace(/^[a-z0-9]+_c_us_/, "")
    .replace(/\b(20\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(rs(day)?)?|fri(day)?|sat(urday)?|sun(day)?|\d{1,2}:\d{2})\b/gi, " ")
    .replace(/[^\w]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const normalized = normalizeIntentKey(stripped);
  const key = normalized && normalized.length <= 60 ? normalized : normalized ? crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 12) : undefined;
  return { key, source: rawBase, used: loop.loopKey?.trim().length ? "loopKey" : "summary" };
}

function normalizeLoopKey(key?: string | null): string | undefined {
  if (!key || typeof key !== "string") return undefined;
  const cleaned = key.toLowerCase().replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "");
  // strip chatId-like prefixes
  return cleaned.replace(/^\d+@[\w.]+_/, "").replace(/^[a-z0-9]+_c_us_/, "");
}

function inferIntentKey(loop: WindowOpenLoop): string | undefined {
  const text = `${loop.summary ?? ""} ${loop.loopKey ?? ""} ${loop.intentKey ?? ""}`.toLowerCase();
  if (text.includes("pedrito") || text.includes("black box") || text.includes("testing link") || text.includes("instructions") || text.includes("feedback")) {
    return "pedrito_testing";
  }
  return loop.intentKey;
}

function buildGroupKey(loop: WindowOpenLoop): string {
  const intent = loop.canonicalIntentKey ?? canonicalIntentKey(loop);
  const lkey = normalizeLoopKey(loop.loopKey);
  if (intent) {
    return [loop.chatId ?? "unknown", intent].join("|");
  }
  if (lkey) {
    return [loop.chatId ?? "unknown", lkey].join("|");
  }
  const summary = normalizeSummaryWithoutDates(loop.summary ?? "");
  const type = loop.type ?? "other";
  return [loop.chatId ?? "unknown", type, summary].join("|");
}

function pickMostRecent<T extends { lastSeenTs?: number }>(items: T[], fallback: T): T {
  return items.reduce((best, item) => {
    if ((item.lastSeenTs ?? 0) > (best.lastSeenTs ?? 0)) return item;
    return best;
  }, fallback);
}

function mergeGroup(key: string, loops: WindowOpenLoop[]): ActiveOpenLoop {
  const sortedByFirstSeen = [...loops].sort((a, b) => (a.firstSeenTs ?? 0) - (b.firstSeenTs ?? 0));
  const stableId =
    sortedByFirstSeen.find((l) => typeof l.id === "string" && l.id.length)?.id ??
    crypto.createHash("sha1").update(key).digest("hex").slice(0, 12);

  const firstSeenTs = Math.min(...loops.map((l) => l.firstSeenTs ?? l.lastSeenTs ?? Date.now()));
  const lastSeenTs = Math.max(...loops.map((l) => l.lastSeenTs ?? l.firstSeenTs ?? Date.now()));
  const timesMentioned = loops.reduce((sum, l) => sum + (l.timesMentioned ?? 1), 0);

  const status = loops.some((l) => l.status === "done") ? "done" : "open";
  const urgency = loops.reduce((best, l) => {
    const rank: Record<WindowOpenLoop["urgency"], number> = { high: 3, moderate: 2, low: 1 };
    return rank[l.urgency] > rank[best] ? l.urgency : best;
  }, "low" as WindowOpenLoop["urgency"]);

  const importance = Math.min(10, Math.max(...loops.map((l) => l.importance ?? 0), 1));
  const confidence = Math.max(...loops.map((l) => l.confidence ?? 0));

  const mergedWhenOptions = (() => {
    const seen = new Set<string>();
    const combined: string[] = [];
    for (const l of [...loops].sort((a, b) => (b.lastSeenTs ?? 0) - (a.lastSeenTs ?? 0))) {
      for (const opt of l.whenOptions ?? []) {
        if (!opt) continue;
        if (seen.has(opt)) continue;
        seen.add(opt);
        combined.push(opt);
        if (combined.length >= 10) break;
      }
      if (combined.length >= 10) break;
    }
    if (combined.length === 0 && typeof loops[0]?.when === "string" && loops[0].when.trim().length > 0) {
      combined.push(loops[0].when);
    }
    return combined;
  })();

  const mostRecent = pickMostRecent(loops, loops[0]!);
  const displayName = mostRecent.displayName ?? sortedByFirstSeen.find((l) => l.displayName)?.displayName;
  const isGroup = typeof mostRecent.isGroup === "boolean" ? mostRecent.isGroup : sortedByFirstSeen.find((l) => typeof l.isGroup === "boolean")?.isGroup;
  const needsUserAction = loops.some((l) => l.needsUserAction === true) ? true : loops.some((l) => l.needsUserAction === false) ? false : undefined;
  const intentKey =
    loops
      .map((l) => l.canonicalIntentKey)
      .find((k) => k && k.length) ??
    loops
      .map((l) => normalizeLoopKey(l.loopKey))
      .find((k) => k && k.length);
  const intentLabels = Array.from(new Set(loops.flatMap((l) => l.intentLabels ?? [])));
  const when = (() => {
    for (const opt of mergedWhenOptions) {
      if (opt && opt.trim().length > 0) return opt;
    }
    return typeof mostRecent.when === "string" ? mostRecent.when : mostRecent.when ?? null;
  })();

  const summary = (() => {
    const candidates = loops
      .map((l) => l.summary ?? "")
      .filter((s) => s && s.length)
      .sort((a, b) => b.length - a.length);
    return candidates[0] ?? mostRecent.summary;
  })();

  if (process.env.DEBUG_INTEL === "1") {
    for (const l of loops) {
      if (l.chatId !== sortedByFirstSeen[0]!.chatId) {
        console.warn("[openLoops] merge skip cross-chat", { key, loopChat: l.chatId, groupChat: sortedByFirstSeen[0]!.chatId });
      }
    }
  }

  return {
    ...mostRecent,
    id: stableId,
    firstSeenTs,
    lastSeenTs,
    timesMentioned,
    status,
    urgency,
    importance,
    confidence,
    displayName,
    isGroup,
    needsUserAction,
    canonicalIntentKey: intentKey,
    intentKey,
    intentLabels,
    summary,
    when,
    whenOptions: mergedWhenOptions,
  };
}

function mapSurfaceType(loop: ActiveOpenLoop): ActiveOpenLoop["surfaceType"] {
  const hasTime = loop.hasTime === true || (!!loop.when && /\d{1,2}:\d{2}|am|pm/i.test(loop.when));
  const loopType = loop.type as any;
  if (loopType === "reply_needed") return "reply_needed";
  if (loopType === "decision_needed") return "decision_needed";
  if (loopType === "follow_up") return "follow_up";
  if (loopType === "event_date") return hasTime ? "event_date" : "todo";
  if (loopType === "todo") return hasTime ? "event_date" : "todo";
  if (loopType === "info_to_save") return "info_to_save";
  return hasTime ? "event_date" : "info_to_save";
}

const NOW_WINDOW_DAYS = 2;
function computeLane(loop: ActiveOpenLoop): "now" | "later" | "backlog" {
  if (loop.laneOverride) return loop.laneOverride;
  const urgencyHigh = loop.urgency === "high";
  const hasTime = loop.hasTime === true;
  const whenMs =
    loop.when && hasTime && !Number.isNaN(Date.parse(loop.when)) ? Date.parse(loop.when) : loop.whenDate && !Number.isNaN(Date.parse(loop.whenDate)) ? Date.parse(loop.whenDate) : null;
  const within48h = whenMs !== null ? whenMs - Date.now() <= NOW_WINDOW_DAYS * 24 * 60 * 60 * 1000 : false;
  if (urgencyHigh || hasTime || within48h) return "now";
  return "backlog";
}

function normalizedProjectKey(loop: any): string {
  const text = `${loop.taskGoal ?? ""} ${loop.summary ?? ""} ${loop.intentKey ?? ""}`.toLowerCase();
  if (/\b(pedrito|black box|testing|test|feedback|link|instructions)\b/.test(text)) return "pedrito_testing";
  return text.replace(/[^\w]+/g, " ").replace(/\s+/g, " ").trim() || "unknown";
}

function consolidateEA(loops: any[]): ActiveOpenLoop[] {
  const precedence = ["decision_needed", "reply_needed", "todo", "follow_up", "info_to_save"] as const;
  const groups = new Map<string, ActiveOpenLoop[]>();
  for (const l of loops) {
    const key = `${l.chatId}|${l.actor}|${normalizedProjectKey(l)}`;
    const arr = groups.get(key) ?? [];
    arr.push(l as ActiveOpenLoop);
    groups.set(key, arr);
  }
  const consolidated: ActiveOpenLoop[] = [];
  for (const [key, arr] of groups.entries()) {
    const best = [...arr].sort((a, b) => precedence.indexOf(a.type as any) - precedence.indexOf(b.type as any))[0];
    const merged = arr.reduce((acc, cur) => {
      const betterType =
        precedence.indexOf(cur.type as any) < precedence.indexOf(acc.type as any) ? cur.type : acc.type;
      const betterUrgency = (() => {
        const rank: Record<ActiveOpenLoop["urgency"], number> = { high: 3, moderate: 2, low: 1 };
        return rank[cur.urgency] > rank[acc.urgency] ? cur.urgency : acc.urgency;
      })();
      const whenOptions = Array.from(new Set([...(acc.whenOptions ?? []), ...(cur.whenOptions ?? [])]));
      // Normalize times before merging
      const normAcc = normalizeWhen(acc.when ?? null, acc.whenDate ?? null);
      const normCur = normalizeWhen(cur.when ?? null, cur.whenDate ?? null);
      const pickWhen = normAcc.hasTime ? normAcc.when : normCur.hasTime ? normCur.when : null;
      const pickWhenDate = normAcc.whenDate ?? normCur.whenDate ?? null;
      return {
        ...acc,
        type: betterType,
        when: pickWhen,
        whenDate: pickWhenDate,
        hasTime: normAcc.hasTime || normCur.hasTime,
        whenOptions,
        status: acc.status === "done" || cur.status === "done" ? "done" : "open",
        blocked: (acc.blocked ?? false) || (cur.blocked ?? false),
        importance: Math.max(acc.importance ?? 0, cur.importance ?? 0),
        urgency: betterUrgency,
        confidence: Math.max(acc.confidence ?? 0, cur.confidence ?? 0),
        summary: acc.summary.length >= cur.summary.length ? acc.summary : cur.summary,
        dependsOnTaskGoal: acc.dependsOnTaskGoal ?? cur.dependsOnTaskGoal,
        blockedReason: (acc as any).blockedReason ?? (cur as any).blockedReason,
        messageId: (cur as any).lastSeenTs > ((acc as any).lastSeenTs ?? 0) ? (cur as any).messageId : (acc as any).messageId,
        lastSeenTs: Math.max(acc.lastSeenTs ?? 0, cur.lastSeenTs ?? 0),
      };
    }, best);
    merged.surfaceType = mapSurfaceType(merged);
    consolidated.push(merged);
  }
  if (process.env.DEBUG_INTEL === "1") {
    const groupsCollapsed = Array.from(groups.entries())
      .map(([k, v]) => ({ key: k, count: v.length }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    console.info("[openLoops][ea consolidate]", { eaBefore: loops.length, eaAfter: consolidated.length, groupsCollapsedTop5: groupsCollapsed });
  }
  return consolidated;
}

function mapNextActions(loop: ActiveOpenLoop): ActiveOpenLoop["nextActions"] {
  const actions: NonNullable<ActiveOpenLoop["nextActions"]> = [];

  const surface = mapSurfaceType(loop);
  if (surface === "reply_needed" || surface === "decision_needed") actions.push("draft_reply");
  if (surface === "event_date") actions.push("add_calendar");
  if (surface === "todo" || surface === "event_date") actions.push("add_reminder");
  if (surface === "info_to_save") actions.push("save_note");

  actions.push("mark_done", "dismiss");
  return Array.from(new Set(actions));
}

async function curateOpenLoops(
  loops: ActiveOpenLoop[]
): Promise<{ openLoops: ActiveOpenLoop[]; narrativeSummary?: string }> {
  if (loops.length === 0) return { openLoops: [] };
  const payload = {
    openLoops: loops.slice(0, 20).map((l) => ({
      chatId: l.chatId,
      displayName: l.displayName,
      isGroup: !!l.isGroup,
      actor: l.actor,
      summary: l.summary,
      when: l.when ?? null,
      whenOptions: l.whenOptions ?? [],
      urgency: l.urgency,
      importance: l.importance,
      intentKey: l.intentKey ?? l.canonicalIntentKey ?? l.loopKey,
      intentLabels: l.intentLabels ?? [],
      loopKey: l.loopKey,
      surfaceType: l.surfaceType,
      timesMentioned: l.timesMentioned ?? 1,
    })),
  };

  const system = `
EA PLATE CURATION — CONCISE AND DEDUPED

You are given structured open loops. Produce 3–10 items max.
- Deduplicate threads that share the same intent; merge into one item with a clear summary.
- Keep provenance: chatId, displayName, isGroup, actor.
- surfaceType must be one of: reply_needed, decision_needed, todo, event_date, info_to_save.
- Only use event_date if when is an explicit meeting/time; otherwise use todo/decision_needed/reply_needed.
- Rewrite summary to be short and actionable.
- Keep intentKey/loopKey if provided; you may simplify intentKey if multiple variants.
Return JSON only:
{
  "openLoops": [ { ...same fields as input..., "surfaceType": "...", "summary": "...", "intentKey"?: string } ],
  "narrativeSummary"?: string // 1-3 lines referencing top items with who/what/next step
}
`.trim();

  const user = `
Input openLoops:
${JSON.stringify(payload, null, 2)}

Rules:
- Output 3–10 items max.
- Merge variants of the same intent (link + instructions + feedback → one item).
- Mention top 3 in narrativeSummary (who/what/next step) in 1–3 lines.
`.trim();

  try {
    const resp = await callLLM<any>("openLoops", {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    if (resp?.openLoops && Array.isArray(resp.openLoops)) {
      const curated: ActiveOpenLoop[] = resp.openLoops.map((l: any, idx: number) => ({
        ...loops[idx],
        ...l,
      }));
      return { openLoops: curated.slice(0, 10), narrativeSummary: resp.narrativeSummary };
    }
  } catch (err) {
    console.error("[openLoops] curateOpenLoops failed", err);
  }
  return { openLoops: loops.slice(0, 10) };
}

function sortActiveLoops(loops: ActiveOpenLoop[]): ActiveOpenLoop[] {
  const urgencyWeight: Record<WindowOpenLoop["urgency"], number> = {
    high: 3,
    moderate: 2,
    low: 1,
  };

  return [...loops].sort((a, b) => {
    const surfaceRank: Record<NonNullable<ActiveOpenLoop["surfaceType"]>, number> = {
      reply_needed: 6,
      decision_needed: 5,
      follow_up: 4,
      event_date: 3,
      todo: 2,
      info_to_save: 1,
    };
    if (!!a.stale !== !!b.stale) return a.stale ? 1 : -1;
    if (a.status !== b.status) {
      return a.status === "open" ? -1 : 1;
    }
    const sa = a.surfaceType ? surfaceRank[a.surfaceType] ?? 0 : 0;
    const sb = b.surfaceType ? surfaceRank[b.surfaceType] ?? 0 : 0;
    if (sa !== sb) return sb - sa;
    if (urgencyWeight[a.urgency] !== urgencyWeight[b.urgency]) {
      return urgencyWeight[b.urgency] - urgencyWeight[a.urgency];
    }
    if ((b.importance ?? 0) !== (a.importance ?? 0)) {
      return (b.importance ?? 0) - (a.importance ?? 0);
    }
    return (b.lastSeenTs ?? 0) - (a.lastSeenTs ?? 0);
  });
}

export async function getActiveOpenLoopsFromWindows(days: number): Promise<ActiveOpenLoop[]> {
  const result = await getCuratedPlateOpenLoops(days);
  return result.openLoops;
}

export async function getCuratedPlateOpenLoops(days: number): Promise<{ openLoops: ActiveOpenLoop[]; narrativeSummary?: string; meta?: any }> {
  // EA chat-based loops are the sole source for the plate. If none, return empty.
  const eaLoops: any[] = await loadAllEAOpenLoops();
  const preCount = eaLoops.length;

  // If EA loops exist, return them directly (with overrides) without canonical merge/curation.
  if (eaLoops.length > 0) {
    const overrides = await loadOverrides();
    const contactsMap = await (async () => {
      try {
        const contacts = await fetchContacts(500);
        const map = new Map<string, { displayName?: string | null; isGroup?: boolean }>();
        for (const c of contacts) {
          map.set(c.chatId, { displayName: c.displayName ?? c.pushname ?? c.savedName, isGroup: c.isGroup });
        }
        return map;
      } catch {
        return new Map<string, { displayName?: string | null; isGroup?: boolean }>();
      }
    })();
    const peopleMap = await (async () => {
      try {
        const { people } = await getRecentOneToOneChats(365, 500);
        const map = new Map<string, string>();
        for (const p of people) map.set(p.chatId, p.displayName ?? p.chatId);
        return map;
      } catch {
        return new Map<string, string>();
      }
    })();
    const mapped: ActiveOpenLoop[] = eaLoops.map((l) => {
      const surfaceType: ActiveOpenLoop["surfaceType"] =
        l.type === "reply_needed" || l.type === "decision_needed" || l.type === "todo" || l.type === "event_date" || l.type === "info_to_save"
          ? l.type
          : "info_to_save";
      return {
        ...l,
        chatId: l.chatId ?? "unknown",
        displayName:
          l.displayName ??
          contactsMap.get(l.chatId ?? "")?.displayName ??
          peopleMap.get(l.chatId ?? "") ??
          fallbackNameFromChatId(l.chatId ?? "unknown"),
        isGroup:
          typeof l.isGroup === "boolean"
            ? l.isGroup
            : contactsMap.get(l.chatId ?? "")?.isGroup ?? !!(l.chatId && l.chatId.includes("@g.us")),
        status: l.status ?? "open",
        blocked: (l as any).blocked ?? false,
        surfaceType,
        nextActions: mapNextActions({ ...l, surfaceType } as ActiveOpenLoop),
        lastSeenTs: (l as any).lastSeenTs ?? Date.now(),
      };
    });
    const consolidated = consolidateEA(mapped);
    const withOverrides = applyOverrides(mapped, overrides).filter((l) => l.status !== "dismissed");
    const sortedEA = sortActiveLoops(consolidated).slice(0, 10);
    const withLane = sortedEA.map((l) => ({ ...l, lane: computeLane(l) }));
    if (process.env.DEBUG_INTEL === "1") {
      console.info("[openLoops] EA plate counts", {
        pre: preCount,
        afterOverride: withOverrides.length,
        curated: withLane.length,
      });
      console.info("[openLoops] source selection", { eaCount: eaLoops.length, windowCount: 0, sourceUsed: "ea" });
    }
    return { openLoops: withLane, meta: { sourceUsed: "ea", eaCount: eaLoops.length, windowCount: 0 } };
  }

  if (process.env.DEBUG_INTEL === "1") {
    console.warn("[openLoops] source selection", { eaCount: 0, windowCount: 0, sourceUsed: "none", warning: "EA store empty; plate intentionally empty (no window fallback)" });
  }
  return { openLoops: [], meta: { sourceUsed: "none", eaCount: 0, windowCount: 0 } };
}
