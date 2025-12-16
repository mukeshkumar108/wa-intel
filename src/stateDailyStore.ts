import fs from "fs/promises";
import path from "path";
import { DailyStateSnapshot } from "./types.js";

const DB_PATH = path.join(process.cwd(), "out", "state-daily.jsonl");

async function ensureDir() {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
}

export async function saveDailyStateSnapshot(snapshot: DailyStateSnapshot): Promise<void> {
  await ensureDir();
  await fs.appendFile(DB_PATH, JSON.stringify(snapshot) + "\n", "utf-8");
}

export async function getDailyStateSnapshots(days: number): Promise<DailyStateSnapshot[]> {
  try {
    const data = await fs.readFile(DB_PATH, "utf-8");
    const lines = data.split("\n").filter((l) => l.trim().length > 0);
    const parsed: DailyStateSnapshot[] = [];

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        parsed.push(obj as DailyStateSnapshot);
      } catch {
        // ignore malformed lines
      }
    }

    parsed.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : b.toTs - a.toTs));
    return parsed.slice(0, days);
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    console.error("Failed to read daily state snapshots:", err);
    return [];
  }
}

export async function getDailyStateSnapshotByDate(date: string): Promise<DailyStateSnapshot | null> {
  try {
    const data = await fs.readFile(DB_PATH, "utf-8");
    const lines = data.split("\n").filter((l) => l.trim().length > 0);
    let best: DailyStateSnapshot | null = null;

    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as DailyStateSnapshot;
        if (obj.date !== date) continue;
        if (!best || obj.toTs > best.toTs) {
          best = obj;
        }
      } catch {
        // ignore malformed lines
      }
    }

    return best;
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    console.error("Failed to read daily state snapshots by date:", err);
    return null;
  }
}
