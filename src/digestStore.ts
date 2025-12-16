import fs from "fs/promises";
import path from "path";
import { DailyDigestSnapshot } from "./types.js";

const DB_PATH = path.join(process.cwd(), "out", "daily-digest.jsonl");

async function ensureDir() {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
}

export async function saveDailyDigestSnapshot(date: string, snapshot: DailyDigestSnapshot) {
  await ensureDir();
  const payload: DailyDigestSnapshot = {
    ...snapshot,
    date: snapshot.date ?? date,
  };
  await fs.appendFile(DB_PATH, JSON.stringify(payload) + "\n", "utf-8");
}

export async function getDailyDigestSnapshot(date: string): Promise<DailyDigestSnapshot | null> {
  try {
    const data = await fs.readFile(DB_PATH, "utf-8");
    const lines = data.split("\n").filter((l) => l.trim().length > 0);
    let latest: DailyDigestSnapshot | null = null;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.date === date) {
          latest = obj;
        }
      } catch {
        // ignore malformed
      }
    }
    return latest;
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    console.error("Failed to load daily digest snapshot:", err);
    return null;
  }
}

export async function getRecentDailyDigests(days: number): Promise<DailyDigestSnapshot[]> {
  try {
    const data = await fs.readFile(DB_PATH, "utf-8");
    const lines = data.split("\n").filter((l) => l.trim().length > 0);
    const parsed: DailyDigestSnapshot[] = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        // ignore malformed
      }
    }
    parsed.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
    return parsed.slice(0, days);
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    console.error("Failed to load daily digests:", err);
    return [];
  }
}
