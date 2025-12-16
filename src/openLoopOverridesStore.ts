import fs from "fs/promises";
import path from "path";

type OverrideTarget = {
  id: string;
  chatId: string;
  loopKey?: string;
  status: "open" | "done" | "dismissed";
  lastSeenTs?: number;
  overrideNote?: string;
};

export interface OpenLoopOverride {
  key: string; // chatId|loopKey or id
  status?: "open" | "done" | "dismissed";
  snoozeUntil?: number;
  note?: string;
  laneOverride?: "now" | "later" | "backlog";
  updatedAt: number;
}

const DB_PATH = path.join(process.cwd(), "out", "openLoopOverrides.json");

async function loadOverrides(): Promise<OpenLoopOverride[]> {
  try {
    const data = await fs.readFile(DB_PATH, "utf-8");
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item: any) => {
        const key = typeof item?.key === "string" ? item.key : null;
        if (!key) return null;
        return {
          key,
          status: item?.status === "open" || item?.status === "done" || item?.status === "dismissed" ? item.status : undefined,
          snoozeUntil: typeof item?.snoozeUntil === "number" ? item.snoozeUntil : undefined,
          note: typeof item?.note === "string" ? item.note : undefined,
          updatedAt: typeof item?.updatedAt === "number" ? item.updatedAt : Date.now(),
        } as OpenLoopOverride;
      })
      .filter((o): o is OpenLoopOverride => !!o);
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    console.error("Failed to load openLoopOverrides:", err);
    return [];
  }
}

async function saveOverrides(list: OpenLoopOverride[]): Promise<void> {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  await fs.writeFile(DB_PATH, JSON.stringify(list, null, 2), "utf-8");
}

export function buildOverrideKey(loop: OverrideTarget): string {
  if (loop.loopKey) return `${loop.chatId}|${loop.loopKey}`;
  return loop.id;
}

export function applyOverrides<T extends OverrideTarget>(loops: T[], overrides: OpenLoopOverride[], now = Date.now()): T[] {
  const byKey = new Map<string, OpenLoopOverride>();
  for (const ov of overrides) {
    byKey.set(ov.key, ov);
  }

  const result: T[] = [];

  for (const loop of loops) {
    const keys = [buildOverrideKey(loop), loop.id];
    const override = keys.map((k) => byKey.get(k)).find(Boolean);
    if (!override) {
      result.push(loop);
      continue;
    }

    if (override.snoozeUntil && now < override.snoozeUntil) continue;
    if (override.status === "dismissed") continue;

    const patched: T = {
      ...loop,
      status: override.status ?? loop.status,
      lastSeenTs: Math.max(loop.lastSeenTs ?? 0, override.updatedAt ?? loop.lastSeenTs ?? 0),
      overrideNote: override.note,
      laneOverride: override.laneOverride ?? (loop as any).laneOverride,
    } as T & { overrideNote?: string };

    result.push(patched);
  }

  return result;
}

export async function upsertOverride(override: OpenLoopOverride): Promise<void> {
  const list = await loadOverrides();
  const index = list.findIndex((o) => o.key === override.key);
  if (index >= 0) {
    list[index] = { ...list[index], ...override, updatedAt: override.updatedAt ?? Date.now() };
  } else {
    list.push({ ...override, updatedAt: override.updatedAt ?? Date.now() });
  }
  await saveOverrides(list);
}

export { loadOverrides, saveOverrides };
