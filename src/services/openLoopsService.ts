import { fetchRecentMessages } from "../whatsappClient.js";
import { toSummaryMessages, buildOpenLoopsPrompt, OpenLoopItem } from "../prompts.js";
import { callLLM, getModelName } from "../llm.js";
import { getActiveOpenLoops, saveOpenLoops, loadOpenLoops } from "../openLoopsStore.js";
import { SummaryRequestMessage, OpenLoopRecord } from "../types.js";

function attachWhoToOpenLoops(loops: OpenLoopItem[], messages: SummaryRequestMessage[]): OpenLoopItem[] {
  const index = new Map<string, SummaryRequestMessage>();
  for (const m of messages) index.set(m.id, m);
  return (loops ?? []).map((loop) => {
    const msg = index.get(loop.messageId);
    let who = loop.who;
    if (msg) {
      who = msg.fromMe ? "me" : msg.displayName || "them";
    } else if (!who) {
      who = "unknown";
    }
    return { ...loop, who };
  });
}

export async function scanAndStoreOpenLoops(opts?: {
  limit?: number;
  messages?: SummaryRequestMessage[];
  window?: { from: number; to: number };
}) {
  const limit = opts?.limit ?? 300;
  const messages =
    opts?.messages ??
    (() => {
      return [];
    })();

  let msgs = messages;
  if (!msgs || msgs.length === 0) {
    const raw = await fetchRecentMessages(limit);
    msgs = toSummaryMessages(raw);
  }

  msgs.sort((a, b) => a.ts - b.ts);
  if (msgs.length === 0) return { openLoops: await getActiveOpenLoops(), messageCount: 0, activeOpenLoops: await getActiveOpenLoops() };

  const prompt = buildOpenLoopsPrompt(msgs);
  const result = await callLLM<{ openLoops: OpenLoopItem[] }>("openLoops", prompt);
  const extracted = attachWhoToOpenLoops(result.openLoops ?? [], msgs);
  const merged = await mergeAndSaveOpenLoops(extracted);
  const active = merged.filter((l) => l.status === "open");

  const openLoopsInWindow =
    opts?.window && opts.window.from !== undefined && opts.window.to !== undefined
      ? active.filter((l) => l.lastSeenTs >= opts.window!.from && l.lastSeenTs <= opts.window!.to)
      : active;

  return { openLoops: sortByPriority(active), messageCount: msgs.length, activeOpenLoops: sortByPriority(active), openLoopsInWindow: sortByPriority(openLoopsInWindow) };
}

export async function loadActiveOpenLoops() {
  const active = await getActiveOpenLoops();
  return sortByPriority(active);
}

// Build a normalized key to group similar open loops for the same chat/category/direction.
function buildOpenLoopKey(loop: OpenLoopRecord): string {
  const base = [loop.chatId, loop.direction ?? "unknown", loop.category ?? "unknown"].join("|");
  const normalizedWhat = normalizeWhat(loop.what ?? "");
  return `${base}|${normalizedWhat}`;
}

function normalizeWhat(text: string): string {
  let t = text.toLowerCase();
  t = t.replace(/[^\w\s]/g, " ");
  t = t.replace(/\b(please|hey|just|can you|could you|would you|kindly)\b/g, " ");
  t = t.replace(/\b(sat|saturday)\b/g, "saturday");
  t = t.replace(/\b(sun|sunday)\b/g, "sunday");
  t = t.replace(/\b(mon|monday)\b/g, "monday");
  t = t.replace(/\b(tue|tues|tuesday)\b/g, "tuesday");
  t = t.replace(/\b(wed|weds|wednesday)\b/g, "wednesday");
  t = t.replace(/\b(thu|thurs|thursday)\b/g, "thursday");
  t = t.replace(/\b(fri|friday)\b/g, "friday");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function mergeLoopRecord(existing: OpenLoopRecord, incoming: OpenLoopRecord): OpenLoopRecord {
  const timesMentioned =
    (existing.timesMentioned ?? 1) + (incoming.timesMentioned ?? 1);
  const firstSeenTs = Math.min(existing.firstSeenTs ?? Date.now(), incoming.firstSeenTs ?? Date.now());
  const lastSeenTs = Math.max(existing.lastSeenTs ?? Date.now(), incoming.lastSeenTs ?? Date.now());

  const when = pickPreferredString(existing.when, incoming.when);
  const what = pickPreferredString(existing.what, incoming.what);

  const status =
    existing.status === "done" || incoming.status === "done"
      ? "done"
      : existing.status ?? incoming.status ?? "open";

  const mergedWhat = what ?? existing.what ?? incoming.what ?? "";

  return {
    ...existing,
    who: existing.who ?? incoming.who,
    what: mergedWhat,
    when,
    category: existing.category ?? incoming.category,
    direction: existing.direction ?? incoming.direction,
    status,
    timesMentioned,
    firstSeenTs,
    lastSeenTs,
  };
}

function pickPreferredString(a?: string | null, b?: string | null): string | null {
  if (a && !b) return a;
  if (b && !a) return b;
  if (!a && !b) return null;
  // choose longer / more descriptive
  return (b ?? "").length > (a ?? "").length ? b ?? null : a ?? null;
}

async function mergeAndSaveOpenLoops(extracted: OpenLoopItem[]): Promise<OpenLoopRecord[]> {
  const now = Date.now();
  const existing = await loadOpenLoops();

  // Convert extracted items into OpenLoopRecord-like structures to merge with existing
  const incoming: OpenLoopRecord[] = extracted.map((loop) => ({
    id: loop.messageId, // temporary; will be replaced if merged into existing
    sourceMessageId: loop.messageId,
    chatId: loop.chatId,
    who: loop.who,
    what: loop.what,
    when: loop.when ?? null,
    category: loop.category,
    status: (loop as any)?.status === "done" ? "done" : "open",
    direction: loop.chatId.endsWith("@g.us") ? "broadcast" : loop.who === "me" ? "me" : "them",
    timesMentioned: 1,
    firstSeenTs: now,
    lastSeenTs: now,
  }));

  const byKey = new Map<string, OpenLoopRecord>();

  for (const loop of existing) {
    const key = buildOpenLoopKey(loop);
    byKey.set(key, loop);
  }

  for (const inc of incoming) {
    const key = buildOpenLoopKey(inc);
    const current = byKey.get(key);
    if (current) {
      const merged = mergeLoopRecord(current, inc);
      merged.id = current.id; // keep stable id
      merged.sourceMessageId = current.sourceMessageId;
      byKey.set(key, merged);
    } else {
      // new record with stable id = sourceMessageId (or uuid if desired)
      byKey.set(key, inc);
    }
  }

  const mergedList = Array.from(byKey.values());
  await saveOpenLoops(mergedList);
  return mergedList;
}

// Heuristic to sort loops by importance/urgency.
export function computePriorityScore(loop: OpenLoopRecord): number {
  let score = 0;
  switch (loop.category) {
    case "time_sensitive":
      score += 40;
      break;
    case "promise":
      score += 30;
      break;
    case "follow_up":
      score += 25;
      break;
    case "question":
      score += 20;
      break;
    default:
      break;
  }

  switch (loop.direction) {
    case "them":
      score += 15;
      break;
    case "me":
      score += 5;
      break;
    case "broadcast":
    default:
      break;
  }

  const whenText = (loop.when ?? "").toLowerCase();
  if (/\b(today|tomorrow|this saturday|this sunday|this monday|this tuesday|this wednesday|this thursday|this friday)\b/.test(whenText)) {
    score += 20;
  }

  score += Math.min(10, (loop.timesMentioned ?? 1) * 2);

  const daysOld = (Date.now() - (loop.lastSeenTs ?? Date.now())) / (1000 * 60 * 60 * 24);
  score -= Math.min(20, Math.floor(daysOld));

  return score;
}

function sortByPriority(loops: OpenLoopRecord[]): OpenLoopRecord[] {
  return [...loops].sort((a, b) => computePriorityScore(b) - computePriorityScore(a));
}
