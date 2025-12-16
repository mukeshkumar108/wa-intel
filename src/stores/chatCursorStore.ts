import fs from "fs/promises";
import path from "path";

export type ChatCursor = {
  chatId: string;
  lastProcessedTs: number;
  lastProcessedMessageId?: string;
  lastRunToTs?: number;
  updatedAt: number;
};

const DB_PATH = path.join(process.cwd(), "out", "chat_cursors.json");

async function loadAll(): Promise<Record<string, ChatCursor>> {
  try {
    const data = await fs.readFile(DB_PATH, "utf-8");
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === "object") return parsed as Record<string, ChatCursor>;
  } catch (err: any) {
    if (err.code !== "ENOENT") console.error("[chatCursor] loadAll error", err);
  }
  return {};
}

async function saveAll(map: Record<string, ChatCursor>): Promise<void> {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  await fs.writeFile(DB_PATH, JSON.stringify(map, null, 2), "utf-8");
}

export async function getCursor(chatId: string): Promise<ChatCursor | null> {
  const all = await loadAll();
  return all[chatId] ?? null;
}

export async function setCursor(chatId: string, cursor: ChatCursor): Promise<void> {
  const all = await loadAll();
  all[chatId] = cursor;
  await saveAll(all);
}
