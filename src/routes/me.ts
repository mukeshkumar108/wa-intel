import { Router } from "express";
import { generateUserProfile, getUserProfile } from "../services/userProfileService.js";

export const meRouter = Router();

meRouter.get("/profile", async (_req, res) => {
  try {
    let profile = await getUserProfile();
    if (!profile) {
      profile = await generateUserProfile({ force: true });
    }
    res.json({ profile });
  } catch (err: any) {
    console.error("Failed to get user profile", err);
    res.status(500).json({ error: "Failed to get user profile" });
  }
});

meRouter.post("/profile/refresh", async (_req, res) => {
  try {
    const profile = await generateUserProfile({ force: true });
    res.json({ profile });
  } catch (err: any) {
    console.error("Failed to refresh user profile", err);
    res.status(500).json({ error: "Failed to refresh user profile" });
  }
});
