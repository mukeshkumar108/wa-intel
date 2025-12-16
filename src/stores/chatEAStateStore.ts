import fs from "fs/promises";
import path from "path";
import crypto from "node:crypto";

export type EAOpenLoop = {
  id?: string;
  chatId?: string;
  messageId?: string;
  intentKey?: string;
  taskGoal?: string;
  type: "reply_needed" | "decision_needed" | "todo" | "event_date" | "info_to_save" | "follow_up";
  summary: string;
  actor: "me" | "them" | string;
  when?: string | null;       // datetime ISO only when explicit time present
  whenDate?: string | null;   // YYYY-MM-DD for date-only
  hasTime?: boolean;
  whenOptions?: string[];
  status: "open" | "done";
  blocked?: boolean;
  dependsOnTaskGoal?: string;
  lastSeenTs?: number;
  blockedReason?: string;
  confidence: number;
  importance: number;
  urgency: "low" | "moderate" | "high";
  context?: string;
  evidenceMessageId?: string;
  evidenceText?: string;
  evidenceInferred?: boolean;
  evidenceSummary?: string;
  lane?: "now" | "later" | "backlog";
};

export type ChatEAState = {
  id: "chat-ea-state";
  chatId: string;
  updatedAt: number;
  lastProcessedMessageTs: number;
  openLoops: EAOpenLoop[];
  modelUsed: string;
};

const DB_PATH = path.join(process.cwd(), "out", "chat_ea_state.jsonl");

async function ensureDir() {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
}

function normalizeIntentKey(key?: string): string | undefined {
  if (!key || typeof key !== "string") return undefined;
  const cleaned = key.toLowerCase().replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length ? cleaned : undefined;
}

function canonicalTaskKey(loop: EAOpenLoop): string {
  const goal = normalizeIntentKey(loop.taskGoal);
  if (goal) return goal;
  const base = normalizeIntentKey(loop.intentKey);
  if (base) return base;
  const fromSummary = normalizeIntentKey(loop.summary);
  if (fromSummary && fromSummary.length <= 60) return fromSummary;
  if (fromSummary) {
    return crypto.createHash("sha1").update(fromSummary).digest("hex").slice(0, 12);
  }
  return "unknown";
}

export async function getLatestChatEAState(chatId: string): Promise<ChatEAState | null> {
  try {
    const data = await fs.readFile(DB_PATH, "utf-8");
    const lines = data.split("\n").filter((l) => l.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]) as ChatEAState;
        if (obj.chatId === chatId) return obj;
      } catch {
        continue;
      }
    }
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    console.error("Failed to read chatEAState:", err);
  }
  return null;
}

export function stableLoopId(chatId: string, loop: EAOpenLoop): string {
  if (loop.id) return loop.id;
  const owner = loop.actor === "me" ? "me" : "them";
  const task = canonicalTaskKey(loop);
  const hash = crypto.createHash("sha1").update(`${chatId}|${owner}|${task}`).digest("hex").slice(0, 12);
  return `${chatId}-${hash}`;
}

async function loadAllStates(): Promise<ChatEAState[]> {
  try {
    const data = await fs.readFile(DB_PATH, "utf-8");
    const lines = data.split("\n").filter((l) => l.trim().length > 0);
    const states: ChatEAState[] = [];
    for (const line of lines) {
      try {
        states.push(JSON.parse(line) as ChatEAState);
      } catch {
        continue;
      }
    }
    return states;
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    console.error("Failed to load chatEAState:", err);
    return [];
  }
}

function dedupeLoops(chatId: string, loops: EAOpenLoop[], fallbackTs: number): EAOpenLoop[] {
  const map = new Map<string, EAOpenLoop>();
  for (const l of loops) {
    const id = stableLoopId(chatId, l);
    const lastSeenTs = l.lastSeenTs ?? fallbackTs;
    const existing = map.get(id);
    if (!existing || (lastSeenTs ?? 0) > (existing.lastSeenTs ?? 0)) {
      map.set(id, { ...l, id, chatId, lastSeenTs });
    } else {
      // merge fields from newer
      existing.whenOptions = Array.from(new Set([...(existing.whenOptions ?? []), ...(l.whenOptions ?? [])]));
      existing.when = existing.when ?? l.when;
      existing.status = existing.status === "done" || l.status === "done" ? "done" : "open";
      existing.blocked = (existing.blocked ?? false) || (l.blocked ?? false);
      existing.confidence = Math.max(existing.confidence ?? 0, l.confidence ?? 0);
      existing.importance = Math.max(existing.importance ?? 1, l.importance ?? 1);
      existing.urgency =
        existing.urgency === "high" || l.urgency === "high"
          ? "high"
          : existing.urgency === "moderate" || l.urgency === "moderate"
            ? "moderate"
            : "low";
      existing.lastSeenTs = Math.max(existing.lastSeenTs ?? 0, lastSeenTs ?? 0);
      map.set(id, existing);
    }
  }
  return Array.from(map.values());
}

export async function clearChatEAState(chatId: string): Promise<void> {
  const states = await loadAllStates();
  const filtered = states.filter((s) => s.chatId !== chatId);
  await ensureDir();
  const lines = filtered.map((s) => JSON.stringify(s)).join("\n");
  await fs.writeFile(DB_PATH, lines.length ? lines + "\n" : "", "utf-8");
}

export async function upsertChatEAState(state: ChatEAState): Promise<void> {
  const states = await loadAllStates();
  const others = states.filter((s) => s.chatId !== state.chatId);
  const prior = states.find((s) => s.chatId === state.chatId);
  const mergedLoops = dedupeLoops(
    state.chatId,
    [...(prior?.openLoops ?? []), ...(state.openLoops ?? [])],
    state.updatedAt
  );
  const newState: ChatEAState = { ...state, openLoops: mergedLoops };
  const all = [...others, newState];
  await ensureDir();
  const lines = all.map((s) => JSON.stringify(s)).join("\n");
  await fs.writeFile(DB_PATH, lines.length ? lines + "\n" : "", "utf-8");
}
