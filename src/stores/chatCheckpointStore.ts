import fs from "fs/promises";
import path from "path";

export type ChatCheckpoint = {
  chatId: string;
  lastProcessedTs: number;
  lastProcessedMessageId?: string;
  updatedAt: number;
};

const DB_PATH = path.join(process.cwd(), "out", "chatCheckpoints.json");

async function ensureDir() {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
}

export async function loadChatCheckpoints(): Promise<Record<string, ChatCheckpoint>> {
  try {
    const data = await fs.readFile(DB_PATH, "utf-8");
    const parsed = JSON.parse(data);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Record<string, ChatCheckpoint>;
  } catch (err: any) {
    if (err.code === "ENOENT") return {};
    console.error("Failed to load chat checkpoints:", err);
    return {};
  }
}

export async function saveChatCheckpoints(map: Record<string, ChatCheckpoint>): Promise<void> {
  await ensureDir();
  await fs.writeFile(DB_PATH, JSON.stringify(map, null, 2), "utf-8");
}

export async function getCheckpoint(chatId: string): Promise<ChatCheckpoint | undefined> {
  const all = await loadChatCheckpoints();
  return all[chatId];
}

export async function setCheckpoint(chatId: string, checkpoint: ChatCheckpoint): Promise<void> {
  const all = await loadChatCheckpoints();
  all[chatId] = checkpoint;
  await saveChatCheckpoints(all);
}
