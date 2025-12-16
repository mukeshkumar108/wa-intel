import fs from "fs/promises";
import path from "path";
import crypto from "node:crypto";
import { OpenLoopItem } from "./prompts.js";
import {
  OpenLoopRecord,
  OpenLoopStatus,
  OpenLoopDirection,
} from "./types.js";

const DB_PATH = path.join(process.cwd(), "out", "openLoops.json");

async function loadOpenLoops(): Promise<OpenLoopRecord[]> {
  try {
    const data = await fs.readFile(DB_PATH, "utf-8");
    const parsed = JSON.parse(data);

    if (!Array.isArray(parsed)) return [];

    // Backwards compatibility: ensure direction exists
    const list: OpenLoopRecord[] = parsed.map((raw: any) => {
      let direction: OpenLoopDirection;

      if (raw.direction === "me" || raw.direction === "them" || raw.direction === "broadcast") {
        direction = raw.direction;
      } else {
        // Default: if who === "me" → me, else them
        direction = raw.who === "me" ? "me" : "them";
      }

      return {
        id: raw.id,
        sourceMessageId: raw.sourceMessageId,
        chatId: raw.chatId,
        who: raw.who,
        what: raw.what,
        when: raw.when ?? null,
        category: raw.category,
        status: raw.status ?? "open",
        direction,
        timesMentioned: raw.timesMentioned ?? 1,
        firstSeenTs: raw.firstSeenTs ?? Date.now(),
        lastSeenTs: raw.lastSeenTs ?? Date.now(),
      };
    });

    return list;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      // file doesn’t exist yet
      return [];
    }
    console.error("Failed to load openLoops DB:", err);
    return [];
  }
}

async function saveOpenLoops(list: OpenLoopRecord[]): Promise<void> {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  await fs.writeFile(DB_PATH, JSON.stringify(list, null, 2), "utf-8");
}
export { saveOpenLoops, loadOpenLoops };

function nowMs(): number {
  return Date.now();
}

function inferDirection(loop: OpenLoopItem): OpenLoopDirection {
  // If I said it, it’s my responsibility
  if (loop.who === "me") return "me";

  const isGroup = loop.chatId.endsWith("@g.us");

  if (isGroup) {
    // Group chat, someone else speaking → broadcast opportunity
    return "broadcast";
  }

  // 1:1 chat, someone else speaking → I'm waiting on them
  return "them";
}

// Merge freshly extracted openLoops into the stored DB.
// - New items → created as "open"
// - Existing "open" items → timesMentioned++, lastSeenTs updated
// - "done"/"dismissed" items are NOT re-opened, even if seen again.
export async function upsertFromExtraction(
  extracted: OpenLoopItem[]
): Promise<OpenLoopRecord[]> {
  const loops = await loadOpenLoops();
  const now = nowMs();

  // Index by sourceMessageId (WhatsApp message id)
  const bySourceId = new Map<string, OpenLoopRecord>();
  for (const l of loops) {
    bySourceId.set(l.sourceMessageId, l);
  }

  for (const loop of extracted) {
    const existing = bySourceId.get(loop.messageId);
    if (existing) {
      // Only update if still open
      if (existing.status === "open") {
        existing.timesMentioned += 1;
        existing.lastSeenTs = now;
        // Optionally refresh what/when/category if the model refined it
        existing.what = loop.what ?? existing.what;
        existing.when = loop.when ?? existing.when;
        existing.category = loop.category ?? existing.category;

        // Fill direction if missing
        if (!existing.direction) {
          existing.direction = inferDirection(loop);
        }
      }
      continue;
    }

    const record: OpenLoopRecord = {
      id: crypto.randomUUID(),
      sourceMessageId: loop.messageId,
      chatId: loop.chatId,
      who: loop.who,
      what: loop.what,
      when: loop.when ?? null,
      category: loop.category,
      status: "open",
      direction: inferDirection(loop),
      timesMentioned: 1,
      firstSeenTs: now,
      lastSeenTs: now,
    };

    loops.push(record);
    bySourceId.set(record.sourceMessageId, record);
  }

  await saveOpenLoops(loops);
  return loops;
}

export async function getActiveOpenLoops(): Promise<OpenLoopRecord[]> {
  const loops = await loadOpenLoops();
  return loops.filter((l) => l.status === "open");
}

export async function updateOpenLoopStatus(
  id: string,
  status: OpenLoopStatus
): Promise<OpenLoopRecord | null> {
  const loops = await loadOpenLoops();
  const index = loops.findIndex((l) => l.id === id);
  if (index === -1) return null;

  loops[index] = {
    ...loops[index],
    status,
    lastSeenTs: nowMs(),
  };

  await saveOpenLoops(loops);
  return loops[index];
}
