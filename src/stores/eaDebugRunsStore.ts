import fs from "fs/promises";
import path from "path";

export interface DropRecord {
  reason: string;
  loop: any;
}

export interface EARunRecord {
  runId: string;
  ts: number;
  chatId: string;
  messageCount: number;
  fromTs?: number;
  toTs?: number;
  runType?: "morning" | "evening" | "manual";
  rawOpenLoops: any[];
  sanitizedOpenLoops: any[];
  dropped: DropRecord[];
}

const BASE_DIR = path.join(process.cwd(), "out", "ea_runs");

async function ensureDir(chatId?: string) {
  await fs.mkdir(chatId ? path.join(BASE_DIR, chatId) : BASE_DIR, { recursive: true });
}

export async function appendRun(chatId: string, run: EARunRecord): Promise<void> {
  await ensureDir(chatId);
  const file = path.join(BASE_DIR, chatId, `${chatId}.jsonl`);
  await fs.appendFile(file, JSON.stringify(run) + "\n", "utf-8");
}

export async function readLatestRun(chatId: string): Promise<EARunRecord | null> {
  try {
    const file = path.join(BASE_DIR, chatId, `${chatId}.jsonl`);
    const data = await fs.readFile(file, "utf-8");
    const lines = data.split("\n").filter((l) => l.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]) as EARunRecord;
      } catch {
        continue;
      }
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") console.error("[eaDebugRuns] readLatestRun error", err);
  }
  return null;
}

export async function summarizeRuns(hours: number): Promise<{
  totalRuns: number;
  totalRaw: number;
  totalSanitized: number;
  dropReasons: Record<string, number>;
  chatsWithZeroAfterRaw: string[];
  latestDropReasons?: Record<string, number>;
  runTypeCounts?: Record<string, number>;
}> {
  await ensureDir();
  let totalRuns = 0;
  let totalRaw = 0;
  let totalSanitized = 0;
  const dropReasons: Record<string, number> = {};
  const latestDropReasons: Record<string, number> = {};
  const runTypeCounts: Record<string, number> = {};
  const zeroChats = new Set<string>();
  const cutoff = Date.now() - hours * 60 * 60 * 1000;

  try {
    const chatDirs = await fs.readdir(BASE_DIR);
    for (const chatId of chatDirs) {
      const file = path.join(BASE_DIR, chatId, `${chatId}.jsonl`);
      let data: string;
      try {
        data = await fs.readFile(file, "utf-8");
      } catch {
        continue;
      }
      const lines = data.split("\n").filter((l) => l.trim().length > 0);
      let latestRun: EARunRecord | null = null;
      for (const line of lines) {
        try {
          const run = JSON.parse(line) as EARunRecord;
          if (run.ts < cutoff) continue;
          totalRuns += 1;
          totalRaw += run.rawOpenLoops?.length ?? 0;
          totalSanitized += run.sanitizedOpenLoops?.length ?? 0;
          const rt = run.runType ?? "manual";
          runTypeCounts[rt] = (runTypeCounts[rt] ?? 0) + 1;
          for (const d of run.dropped ?? []) {
            const key = d.reason ?? "unknown";
            dropReasons[key] = (dropReasons[key] ?? 0) + 1;
          }
          if (!latestRun || run.ts > latestRun.ts) latestRun = run;
        } catch {
          continue;
        }
      }
      if (latestRun) {
        if ((latestRun.rawOpenLoops?.length ?? 0) > 0 && (latestRun.sanitizedOpenLoops?.length ?? 0) === 0) {
          zeroChats.add(latestRun.chatId);
        }
        for (const d of latestRun.dropped ?? []) {
          const key = d.reason ?? "unknown";
          latestDropReasons[key] = (latestDropReasons[key] ?? 0) + 1;
        }
      }
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") console.error("[eaDebugRuns] summarizeRuns error", err);
  }

  return { totalRuns, totalRaw, totalSanitized, dropReasons, chatsWithZeroAfterRaw: Array.from(zeroChats), latestDropReasons, runTypeCounts };
}
