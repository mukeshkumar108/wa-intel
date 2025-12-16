import fs from "fs/promises";
import path from "path";
import { RelationshipSnapshot } from "./types.js";

const DB_PATH = path.join(process.cwd(), "out", "relationship-snapshots.jsonl");

async function ensureDirExists() {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
}

export async function saveRelationshipSnapshot(snapshot: RelationshipSnapshot): Promise<void> {
  const line = JSON.stringify(snapshot);
  await ensureDirExists();
  await fs.appendFile(DB_PATH, line + "\n", "utf-8");
}

export async function getRelationshipSnapshotsForChat(
  chatId: string,
  limit: number
): Promise<RelationshipSnapshot[]> {
  try {
    const data = await fs.readFile(DB_PATH, "utf-8");
    const lines = data.split("\n").filter((l) => l.trim().length > 0);

    const snapshots: RelationshipSnapshot[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && parsed.chatId === chatId) {
          snapshots.push(parsed as RelationshipSnapshot);
        }
      } catch {
        // ignore malformed lines
      }
    }

    snapshots.sort((a, b) => b.snapshotTs - a.snapshotTs);
    return snapshots.slice(0, limit);
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return [];
    }
    console.error("Failed to read relationship snapshots:", err);
    return [];
  }
}

export async function getLatestRelationshipSnapshotForChat(
  chatId: string
): Promise<RelationshipSnapshot | null> {
  const snapshots = await getRelationshipSnapshotsForChat(chatId, 1);
  return snapshots[0] ?? null;
}

export async function getLatestSnapshots(limit: number): Promise<RelationshipSnapshot[]> {
  try {
    const data = await fs.readFile(DB_PATH, "utf-8");
    const lines = data.split("\n").filter((l) => l.trim().length > 0);
    const latestByChat = new Map<string, RelationshipSnapshot>();
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as RelationshipSnapshot;
        const existing = latestByChat.get(obj.chatId);
        if (!existing || obj.snapshotTs > existing.snapshotTs) {
          latestByChat.set(obj.chatId, obj);
        }
      } catch {
        // ignore malformed
      }
    }
    const all = Array.from(latestByChat.values());
    all.sort((a, b) => (b.lastMessageTs ?? b.snapshotTs) - (a.lastMessageTs ?? a.snapshotTs));
    return all.slice(0, limit);
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    console.error("Failed to read latest relationship snapshots:", err);
    return [];
  }
}
