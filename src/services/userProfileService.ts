import { callLLM, getModelFor, getModelName } from "../llm.js";
import { RelationalFacetContact, UserProfile } from "../types.js";
import { loadLatestUserProfile, saveUserProfile } from "../userProfileStore.js";
import { getRecentStateSnapshots } from "./stateService.js";
import { getRecentWindows } from "./windowAnalysisService.js";
import { getTopRelationshipsFromSnapshots } from "./relationshipService.js";

const USER_PROFILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function getUserProfile(): Promise<UserProfile | null> {
  return loadLatestUserProfile();
}

export async function generateUserProfile(options?: { force?: boolean }): Promise<UserProfile> {
  const existing = await loadLatestUserProfile();
  if (existing && !options?.force) {
    const age = Date.now() - existing.meta.generatedAt;
    if (age < USER_PROFILE_MAX_AGE_MS) return existing;
  }

  const [windows, stateSnapshots, topRelationships] = await Promise.all([
    getRecentWindows({ hours: 72, limit: 30 }),
    getRecentStateSnapshots(7),
    getTopRelationshipsFromSnapshots(30, 5),
  ]);

  const system = `
You are building a single JSON "user communication profile" for ONE user based on their recent chat-derived intel.

You are NOT doing diagnosis or therapy.
You are describing: tone, patterns, relational tendencies, coping habits, values, and risk edges.
You must be neutral, non-judgmental, specific, and grounded in observable behaviour.

Inputs you will receive:
- windows: recent window analyses (each with mood, contacts, summaries, openLoops, etc.)
- stateSnapshots: recent daily state snapshots (mood, stress, themes).
- topRelationships: a small set of important relationship summaries / rollups (including any romantic partner).

Your job:
- Infer how THIS USER tends to communicate overall (not just in one chat).
- Infer their typical tone, habits, emotional and relational patterns, and current big themes.
- Use the relationship info to populate:
  - relationalPatterns
  - relationalFacets (primaryPartner, romanticInterests, sexualPartners, closeFriends)
  - valuesAndMotivation
  - strengths and riskEdges

Relational facets:
- "primaryPartner" is at most one person, usually a very high-closeness romantic partner.
- "romanticInterests" are people the user appears romantically interested in (even if not official).
- "sexualPartners" should ONLY be set if the chat clearly implies a sexual/physical relationship or encounter.
- "closeFriends" are non-romantic, emotionally important anchors.

Naming rules:
- "displayName" must be a canonical identifier: real name if available, otherwise the contact label (e.g. "+502 5835 0994" or "Ashley Ayala").
- NEVER use pet names ("booboo", "mi amorcito") as displayName.
- If pet names are visible, put ONE representative pet name in "petName" instead.
- Do NOT invent names that aren't in the inputs.

If you can't reasonably infer something:
- For strings, use "unknown".
- For arrays, you may return [] only if truly nothing is inferable.
- Do NOT add a nested "userProfile" property.
- Do NOT mirror entire relationship models verbatim; summarise.

Output:
- A single JSON object matching the TypeScript "UserProfile" type, including the optional "relationalFacets" block.
`.trim();

  const userPayload = `
Recent window analyses (truncated):
${JSON.stringify(windows, null, 2)}

Recent state snapshots:
${JSON.stringify(stateSnapshots, null, 2)}

Top relationships (snapshots):
${JSON.stringify(topRelationships, null, 2)}
`.trim();

  let response: Partial<UserProfile> & Record<string, any> = {};
  try {
    response = await callLLM<Partial<UserProfile> & Record<string, any>>("userProfile", {
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPayload },
      ],
    });
  } catch (err) {
    console.error("[userProfile] LLM call failed", {
      model: getModelName("userProfile"),
      error: (err as Error)?.message ?? err,
    });
    throw err;
  }

  if ("userProfile" in response) {
    delete (response as any).userProfile;
  }

  const normalizeFacetContact = (c: any): RelationalFacetContact | null => {
    if (!c || typeof c !== "object") return null;
    if (!c.chatId || typeof c.chatId !== "string") return null;

    const displayNameRaw =
      typeof c.displayName === "string" && c.displayName.trim() ? c.displayName.trim() : c.chatId;
    const petName = typeof c.petName === "string" && c.petName.trim() ? c.petName.trim() : undefined;
    const lowerDisplay = displayNameRaw.toLowerCase();
    const knownPetLike = ["booboo", "boo", "mi amor", "mi amorcito", "gugui"];
    const finalDisplayName = knownPetLike.includes(lowerDisplay) && petName ? c.chatId : displayNameRaw;

    const kinds =
      Array.isArray(c.kind) && c.kind.length
        ? (c.kind.filter((k: any) =>
            ["primary_partner", "romantic_interest", "sexual_partner", "close_friend", "family", "other"].includes(k)
          ) as RelationalFacetContact["kind"])
        : (["other"] as RelationalFacetContact["kind"]);

    return {
      chatId: c.chatId,
      displayName: finalDisplayName,
      kind: kinds,
      petName,
    };
  };

  const facetsRaw = (response as any).relationalFacets || {};
  const primaryPartner = normalizeFacetContact(facetsRaw.primaryPartner);
  const romanticInterests = Array.isArray(facetsRaw.romanticInterests)
    ? (facetsRaw.romanticInterests.map(normalizeFacetContact).filter(Boolean) as RelationalFacetContact[])
    : [];
  const sexualPartners = Array.isArray(facetsRaw.sexualPartners)
    ? (facetsRaw.sexualPartners.map(normalizeFacetContact).filter(Boolean) as RelationalFacetContact[])
    : [];
  const closeFriends = Array.isArray(facetsRaw.closeFriends)
    ? (facetsRaw.closeFriends.map(normalizeFacetContact).filter(Boolean) as RelationalFacetContact[])
    : [];

  const profile: UserProfile = {
    id: "user-profile",
    communicationStyle: response.communicationStyle ?? {
      overallTone: [],
      typicalLength: "mixed",
      emojiUsage: "medium",
      languages: [],
    },
    emotionalPatterns: response.emotionalPatterns ?? {
      baselineMood: "unknown",
      reactivity: "medium",
      lateNightPatterns: [],
      stressTriggers: [],
    },
    relationalPatterns: response.relationalPatterns ?? {
      attachmentVibe: "",
      whoTheyLeanOn: [],
      conflictStyle: "",
      consistency: "",
    },
    copingAndHabits: response.copingAndHabits ?? {
      copingStrategies: [],
      selfSoothing: [],
      selfSabotagePatterns: [],
    },
    valuesAndMotivation: response.valuesAndMotivation ?? {
      explicitValues: [],
      implicitValues: [],
      currentBigThemes: [],
    },
    riskEdges: response.riskEdges ?? {
      burnoutRisk: "medium",
      heartRisk: "medium",
      patternsToWatch: [],
    },
    strengths: response.strengths ?? {
      relational: [],
      personal: [],
    },
    relationalFacets: {
      primaryPartner: primaryPartner ?? undefined,
      romanticInterests,
      sexualPartners,
      closeFriends,
    },
    meta: {
      generatedAt: Date.now(),
      modelUsed: getModelFor("userProfile"),
      windowsCoveredHours: 72,
      relationshipsCovered: topRelationships.length,
      stateDaysCovered: stateSnapshots.length,
    },
  };

  await saveUserProfile(profile);
  return profile;
}
