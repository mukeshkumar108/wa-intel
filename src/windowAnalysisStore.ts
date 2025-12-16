import fs from "fs/promises";
import path from "path";
import { WindowAnalysis } from "./types.js";

const DB_PATH = path.join(process.cwd(), "out", "window-analyses.jsonl");

async function ensureDir() {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
}

async function readAllAnalyses(): Promise<WindowAnalysis[]> {
  try {
    const data = await fs.readFile(DB_PATH, "utf-8");
    const lines = data.split("\n").filter((line) => line.trim().length > 0);
    const parsed: WindowAnalysis[] = [];

    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as WindowAnalysis;
        parsed.push(obj);
      } catch {
        // ignore malformed lines
      }
    }

    // Sort newest first for convenience
    parsed.sort((a, b) => b.fromTs - a.fromTs);
    return parsed;
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    console.error("Failed to read window analyses:", err);
    return [];
  }
}

export async function saveWindowAnalysis(analysis: WindowAnalysis): Promise<void> {
  await ensureDir();
  await fs.appendFile(DB_PATH, JSON.stringify(analysis) + "\n", "utf-8");
}

export async function loadWindowAnalysesBetween(fromTs: number, toTs: number): Promise<WindowAnalysis[]> {
  const all = await readAllAnalyses();
  return all.filter((wa) => wa.fromTs >= fromTs && wa.toTs <= toTs);
}

export async function loadRecentWindowAnalyses(hours: number): Promise<WindowAnalysis[]> {
  const now = Date.now();
  const cutoff = now - hours * 60 * 60 * 1000;
  const all = await readAllAnalyses();
  return all.filter((wa) => wa.fromTs >= cutoff && wa.toTs <= now);
}

export async function loadWindowAnalysesForLastDays(days: number): Promise<WindowAnalysis[]> {
  const now = Date.now();
  const fromTs = now - days * 24 * 60 * 60 * 1000;
  return loadWindowAnalysesBetween(fromTs, now);
}
