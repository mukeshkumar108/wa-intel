import fs from "fs/promises";
import path from "path";
import { UserProfile } from "./types.js";

const DB_PATH = path.join(process.cwd(), "out", "userProfile.jsonl");

async function ensureDir() {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
}

export async function saveUserProfile(profile: UserProfile): Promise<void> {
  await ensureDir();
  const line = JSON.stringify(profile);
  await fs.appendFile(DB_PATH, line + "\n", "utf-8");
}

export async function loadLatestUserProfile(): Promise<UserProfile | null> {
  try {
    const data = await fs.readFile(DB_PATH, "utf-8");
    const lines = data.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) return null;
    const last = lines[lines.length - 1];
    return JSON.parse(last) as UserProfile;
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    console.error("Failed to load user profile:", err);
    return null;
  }
}
