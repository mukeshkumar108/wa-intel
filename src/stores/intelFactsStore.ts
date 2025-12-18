// Simple append/read store for intel facts.
import fs from "fs/promises";
import path from "path";

export type IntelFactRecord = {
  chatId: string;
  chatDisplayName?: string | null;
  isGroup?: boolean;
  type: "EVENT" | "EMOTION_CONCERN" | "RELATIONSHIP_DYNAMIC";
  epistemicStatus: "event_claim" | "self_report" | "observed_pattern" | "hypothesis";
  summary: string;
  entities: string[];
  when?: string | null;
  whenDate?: string | null;
  timeCertainty?: "explicit" | "implied" | "unknown";
  timeMention?: string | null;
  attributedTo?: "ME" | "OTHER" | "UNKNOWN";
  signalScore?: number;
  evidenceMessageId: string;
  evidenceText: string;
  ts: number;
  runType?: string;
  storedAt: number;
};

const FACTS_PATH = path.join(process.cwd(), "out", "intel", "intel_facts.jsonl");
const STATE_PATH = path.join(process.cwd(), "out", "intel", "intel_state.json");
const INDEX_PATH = path.join(process.cwd(), "out", "intel", "intel_index.json");

export type IntelState = {
  lastBootstrapRunAt?: number;
  bootstrapSinceTs?: number;
  byChat?: Record<string, { lastProcessedTs?: number }>;
  chatScores?: Record<
    string,
    {
      factCount: number;
      messagesProcessed: number;
      emotionCount: number;
      relationshipCount: number;
      eventCount: number;
      avgSignalScore: number;
      groupNoisePenalty: number;
      chatIntelScore: number;
      chatDisplayName?: string | null;
      isGroup?: boolean;
    }
  >;
};

async function ensureDir() {
  await fs.mkdir(path.dirname(FACTS_PATH), { recursive: true });
}

export async function appendIntelFacts(facts: IntelFactRecord[]): Promise<void> {
  if (!facts.length) return;
  await ensureDir();
  const lines = facts.map((f) => JSON.stringify(f));
  await fs.appendFile(FACTS_PATH, lines.join("\n") + "\n", "utf-8");
}

async function loadIndex(): Promise<Record<string, number>> {
  try {
    const data = await fs.readFile(INDEX_PATH, "utf-8");
    return JSON.parse(data) as Record<string, number>;
  } catch (err: any) {
    if (err.code !== "ENOENT") console.error("[intel] read index error", err);
    return {};
  }
}

async function saveIndex(idx: Record<string, number>): Promise<void> {
  await ensureDir();
  await fs.writeFile(INDEX_PATH, JSON.stringify(idx, null, 2), "utf-8");
}

function dedupeKey(f: IntelFactRecord): string {
  return `${f.chatId}:${f.type}:${f.evidenceMessageId}`;
}

export async function appendIntelFactsDedup(
  facts: IntelFactRecord[]
): Promise<{ written: number; deduped: number }> {
  if (!facts.length) return { written: 0, deduped: 0 };
  const idx = await loadIndex();
  const fresh: IntelFactRecord[] = [];
  let deduped = 0;
  for (const f of facts) {
    const key = dedupeKey(f);
    if (idx[key]) {
      deduped++;
      continue;
    }
    fresh.push(f);
    idx[key] = f.storedAt ?? Date.now();
  }
  if (fresh.length) {
    await appendIntelFacts(fresh);
    await saveIndex(idx);
  }
  return { written: fresh.length, deduped };
}

export async function getRecentIntelFacts(limit = 50): Promise<IntelFactRecord[]> {
  try {
    const data = await fs.readFile(FACTS_PATH, "utf-8");
    const lines = data
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(-limit);
    return lines.map((l) => JSON.parse(l) as IntelFactRecord);
  } catch (err: any) {
    if (err.code !== "ENOENT") console.error("[intel] read facts error", err);
    return [];
  }
}

export async function readIntelState(): Promise<IntelState> {
  try {
    const data = await fs.readFile(STATE_PATH, "utf-8");
    return JSON.parse(data) as IntelState;
  } catch (err: any) {
    if (err.code !== "ENOENT") console.error("[intel] read state error", err);
    return {};
  }
}

export async function writeIntelState(state: IntelState): Promise<void> {
  await ensureDir();
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}
