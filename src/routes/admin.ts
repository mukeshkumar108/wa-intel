import { Router } from "express";
import { generateTodayDigest } from "./digest.js";
import { getStateHistory } from "./state.js";
import { getRecentOneToOneChats } from "./people.js";
import { generateRelationshipSummary, inferDisplayName } from "./relationships.js";
import { callLLM } from "../llm.js";
import { getActiveOpenLoopsFromWindows } from "../services/openLoopsV2Service.js";
import { loadRecentWindowSummary } from "../services/windowAnalysisService.js";
import { RelationshipSummary } from "../types.js";
import { generateUserProfile, getUserProfile } from "../services/userProfileService.js";

export const adminRouter = Router();

function esc(value: any): string {
  const str = value === undefined || value === null ? "" : String(value);
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${esc(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; line-height: 1.5; color: #0f172a; max-width: 1100px; }
    a { color: #0f62fe; text-decoration: none; }
    a:hover { text-decoration: underline; }
    h1 { margin-bottom: 12px; }
    h2 { margin-top: 24px; margin-bottom: 8px; }
    table { border-collapse: collapse; width: 100%; margin-top: 12px; }
    th, td { border: 1px solid #e2e8f0; padding: 8px; }
    th { background: #f8fafc; text-align: left; }
    code, .mono { font-family: Menlo, monospace; }
    details { margin-top: 12px; }
    .muted { color: #475569; }
    .pill { display: inline-block; padding: 4px 10px; border-radius: 12px; background: #e0e7ff; margin-right: 6px; font-size: 12px; color: #1e3a8a; }
    pre { white-space: pre-wrap; word-break: break-word; background: #0f172a; color: #e2e8f0; padding: 12px; border-radius: 8px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 12px 14px; box-shadow: 0 1px 2px rgba(15,23,42,0.05); }
    .card h3 { margin: 0 0 6px 0; font-size: 16px; }
    .stat { font-size: 26px; font-weight: 600; margin: 4px 0; }
    .pill.small { padding: 2px 8px; font-size: 11px; }
    .section { margin-bottom: 18px; }
    .flex { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    .link-row { margin-top: 8px; font-size: 14px; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function formatTs(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return "";
  const d = new Date(ts);
  return d.toLocaleString();
}

adminRouter.get("/", (_req, res) => {
  Promise.all([
    loadRecentWindowSummary(7).catch(() => null),
    getActiveOpenLoopsFromWindows(7).catch(() => []),
    getStateHistory(7).catch(() => ({ snapshots: [], summary: null })),
  ]).then(([windowsSummary, openLoops, stateData]) => {
    const windowCount = windowsSummary?.windows?.length ?? 0;
    const latestMood = windowsSummary?.summary?.avgMood ?? "mixed";
    const topConcern = windowsSummary?.summary?.topConcerns?.[0] ?? "—";

    const openLoopCount = openLoops?.length ?? 0;
    const openLoopTop = openLoops?.[0]?.summary ?? "None";

    const stateSummary = stateData?.summary;
    const avgEnergy = stateSummary?.avgEnergy ? Math.round(stateSummary.avgEnergy) : 0;
    const avgStress = stateSummary?.avgStress ? Math.round(stateSummary.avgStress) : 0;

    const body = `
    <h1>Intel Admin</h1>
    <div class="grid section">
      <div class="card">
        <h3>Windows (last 7 days)</h3>
        <div class="stat">${windowCount}</div>
        <div class="muted">Avg mood: ${esc(latestMood)} · Top concern: ${esc(topConcern)}</div>
        <div class="link-row"><a href="/admin/windows/recent">View windows</a></div>
      </div>
      <div class="card">
        <h3>Open Loops</h3>
        <div class="stat">${openLoopCount}</div>
        <div class="muted">${esc(openLoopTop)}</div>
        <div class="link-row"><a href="/open-loops/active">API</a></div>
      </div>
      <div class="card">
        <h3>Mood &amp; State</h3>
        <div class="stat">${stateSummary ? esc(stateSummary.avgMood ?? "unknown") : "—"}</div>
        <div class="muted">Energy ${avgEnergy} · Stress ${avgStress}</div>
        <div class="link-row"><a href="/admin/state">View state</a></div>
      </div>
      <div class="card">
        <h3>Profile</h3>
        <div class="stat">beta</div>
        <div class="muted">Communication/relational facets</div>
        <div class="link-row"><a href="/admin/me/profile">View profile</a></div>
      </div>
    </div>
    <div class="section">
      <h2>Sections</h2>
      <ul>
        <li><a href="/admin/daily">Daily Digest</a></li>
        <li><a href="/admin/state">Mood &amp; State</a></li>
        <li><a href="/admin/relationships">Relationships</a></li>
        <li><a href="/admin/windows/recent">Window Analysis</a></li>
        <li><a href="/admin/me/profile">My profile (beta)</a></li>
        <li><a href="/admin/me">About Me</a></li>
      </ul>
    </div>
    `;
    res.send(layout("Intel Admin", body));
  }).catch((err) => {
    console.error("Admin / error:", err);
    const fallback = `
    <h1>Intel Admin</h1>
    <p class="muted">Failed to load dashboard cards. Use the links below:</p>
    <ul>
      <li><a href="/admin/daily">Daily Digest</a></li>
      <li><a href="/admin/state">Mood &amp; State</a></li>
      <li><a href="/admin/relationships">Relationships</a></li>
      <li><a href="/admin/windows/recent">Window Analysis</a></li>
      <li><a href="/admin/me/profile">My profile (beta)</a></li>
      <li><a href="/admin/me">About Me</a></li>
    </ul>
    `;
    res.send(layout("Intel Admin", fallback));
  });
});

adminRouter.get("/daily", async (_req, res) => {
  try {
    const digest = await generateTodayDigest();
    const dateLabel = new Date(digest.meta.toTs ?? Date.now()).toDateString();
    const summary = digest.summary;

    const openLoops: Array<{ who?: string; what?: string; category?: string }> = summary.openLoops ?? [];

    const body = `
    <h1>Daily Digest</h1>
    <p class="muted">Today: ${esc(dateLabel)}</p>

    <h2>Summary</h2>
    <p>${esc(summary.narrativeSummary ?? "No summary.")}</p>

    <h2>Key People</h2>
    <ul>
      ${(summary.keyPeople ?? []).map((p) => `<li>${esc(p)}</li>`).join("") || "<li>None</li>"}
    </ul>

    <h2>Key Topics</h2>
    <ul>
      ${(summary.keyTopics ?? []).map((t) => `<li>${esc(t)}</li>`).join("") || "<li>None</li>"}
    </ul>

    <h2>Open Loops (model)</h2>
    <ul>
      ${
        openLoops.length
          ? openLoops
              .map((ol) => {
                const who = esc(ol.who ?? "Unknown");
                const what = esc(ol.what ?? "");
                const cat = esc(ol.category ?? "");
                return `<li><strong>${who}</strong> — ${what} <span class="muted">(${cat})</span></li>`;
              })
              .join("")
          : "<li>None</li>"
      }
    </ul>

    <details>
      <summary>Raw digest JSON</summary>
      <pre>${esc(JSON.stringify(digest, null, 2))}</pre>
    </details>
    `;

    res.send(layout("Daily Digest", body));
  } catch (err: any) {
    console.error("Admin /daily error:", err);
    res.status(500).send(layout("Error", `<p>Failed to load daily digest: ${esc(err?.message ?? err)}</p>`));
  }
});

adminRouter.get("/state", async (req, res) => {
  try {
    const daysParam = Number(req.query.days);
    const days = Number.isFinite(daysParam) ? Math.min(Math.max(daysParam, 1), 30) : 7;
    const { snapshots, summary } = await getStateHistory(days);

    const rows = snapshots
      .map(
        (s) => `
          <tr>
            <td>${esc(s.date)}</td>
            <td>${esc(s.mood)}</td>
            <td>${esc(s.energyLevel)}</td>
            <td>${esc(s.stressLevel)}</td>
            <td>${esc((s.dominantConcerns ?? []).join(", "))}</td>
          </tr>
        `
      )
      .join("");

    const detailsBlocks = snapshots
      .map((s) => {
        const moments = (s.notableMoments ?? [])
          .map((m) => `<li>${esc(formatTs(m.ts))}: ${esc(m.summary)}</li>`)
          .join("");
        return `
          <details>
            <summary>${esc(s.date)} notable moments</summary>
            <ul>${moments || "<li>None</li>"}</ul>
          </details>
        `;
      })
      .join("");

    const body = `
    <h1>Mood &amp; State (last ${esc(String(days))} days)</h1>
    <table>
      <thead>
        <tr><th>Date</th><th>Mood</th><th>Energy</th><th>Stress</th><th>Dominant concerns</th></tr>
      </thead>
      <tbody>
        ${rows || "<tr><td colspan='5'>No data</td></tr>"}
      </tbody>
    </table>

    <h2>Aggregates</h2>
    <ul>
      <li>Average Mood: ${esc(summary.avgMood ?? "unknown")}</li>
      <li>Average Stress: ${esc(Math.round(summary.avgStress ?? 0))}</li>
      <li>Average Energy: ${esc(Math.round(summary.avgEnergy ?? 0))}</li>
      <li>Top Concerns: ${esc((summary.topConcerns ?? []).join(", "))}</li>
      <li>Repeated Self-talk: ${esc((summary.repeatedSelfTalk ?? []).join(", "))}</li>
      <li>Trend (mood/stress/energy): ${esc(
        `${summary.trend?.mood ?? "?"} / ${summary.trend?.stress ?? "?"} / ${summary.trend?.energy ?? "?"}`
      )}</li>
    </ul>

    ${detailsBlocks}
    `;

    res.send(layout("State", body));
  } catch (err: any) {
    console.error("Admin /state error:", err);
    res.status(500).send(layout("Error", `<p>Failed to load state: ${esc(err?.message ?? err)}</p>`));
  }
});

adminRouter.get("/windows/recent", async (req, res) => {
  try {
    const daysParam = Number(req.query.days);
    const days = Number.isFinite(daysParam) ? Math.min(Math.max(daysParam, 1), 60) : 7;
    const { windows, summary } = await loadRecentWindowSummary(days);

    const windowBlocks =
      windows
        .map((w) => {
          const contacts = [...(w.contacts ?? [])]
            .sort(
              (a, b) =>
                (b.importanceScore ?? 0) - (a.importanceScore ?? 0) ||
                b.messagesFromMe +
                  b.messagesFromThem -
                  (a.messagesFromMe + a.messagesFromThem)
            )
            .slice(0, 4)
            .map(
              (c) =>
                `<li>${esc(c.displayName)} <span class="muted">(${esc(
                  String(c.messagesFromMe + c.messagesFromThem)
                )} msgs, ${esc(c.relationshipTrajectoryHint ?? "unknown")})</span></li>`
            )
            .join("");

          const loops = (w.openLoops ?? [])
            .slice(0, 6)
            .map(
              (ol) =>
                `<li><strong>${esc(ol.type)}</strong> ${esc(ol.summary)} <span class="muted">${esc(
                  ol.when ?? ""
                )}</span></li>`
            )
            .join("");

          return `
            <details>
              <summary>${esc(new Date(w.fromTs).toLocaleString())} → ${esc(
                new Date(w.toTs).toLocaleString()
              )}</summary>
              <p>${esc(w.windowSummary ?? "")}</p>
              <p class="muted">Mood: ${esc(w.mood)} · Energy: ${esc(String(w.energyLevel))} · Stress: ${esc(
                String(w.stressLevel)
              )}</p>
              <strong>Top contacts</strong>
              <ul>${contacts || "<li>None</li>"}</ul>
              <strong>Open loops</strong>
              <ul>${loops || "<li>None</li>"}</ul>
            </details>
          `;
        })
        .join("") || "<p>No windows found.</p>";

    const body = `
    <h1>Window Analyses (last ${esc(String(days))} days)</h1>
    <h2>Summary</h2>
    <pre>${esc(JSON.stringify(summary, null, 2))}</pre>

    <h2>Windows</h2>
    ${windowBlocks}

    <details>
      <summary>Raw JSON</summary>
      <pre>${esc(JSON.stringify(windows, null, 2))}</pre>
    </details>
    `;

    res.send(layout("Window Analyses", body));
  } catch (err: any) {
    console.error("Admin /windows/recent error:", err);
    res
      .status(500)
      .send(layout("Error", `<p>Failed to load window analyses: ${esc(err?.message ?? err)}</p>`));
  }
});

adminRouter.get("/relationships", async (_req, res) => {
  try {
    const days = 30;
    const limit = 20;
    const { people } = await getRecentOneToOneChats(days, limit);

    const rows = people
      .map(
        (p) => `
        <tr>
          <td><a href="/admin/relationships/${encodeURIComponent(p.chatId)}">${esc(p.displayName)}</a></td>
          <td class="mono">${esc(p.chatId)}</td>
          <td>${esc(formatTs(p.lastMessageTs))}</td>
          <td>${esc(p.messageCount)}</td>
        </tr>
      `
      )
      .join("");

    const body = `
    <h1>Relationships (last 30 days)</h1>
    <table>
      <thead>
        <tr><th>Name</th><th>chatId</th><th>Last message</th><th>Messages</th></tr>
      </thead>
      <tbody>
        ${rows || "<tr><td colspan='4'>No relationships found</td></tr>"}
      </tbody>
    </table>
    `;

    res.send(layout("Relationships", body));
  } catch (err: any) {
    console.error("Admin /relationships error:", err);
    res.status(500).send(layout("Error", `<p>Failed to load relationships: ${esc(err?.message ?? err)}</p>`));
  }
});

adminRouter.get("/relationships/:chatId", async (req, res) => {
  try {
    const { chatId } = req.params;
    const relationship = await generateRelationshipSummary(chatId, 300);

    const metrics = relationship.metrics;
    const model = relationship.model;

    const body = `
    <h1>Relationship with ${esc(relationship.displayName ?? chatId)}</h1>

    <h2>Overview</h2>
    <p>
      Type: ${esc(relationship.relationshipType ?? "")}<br/>
      Closeness: ${esc(relationship.closeness ?? "")}<br/>
      Tone: ${esc((relationship.toneDescriptors ?? []).join(", "))}<br/>
      Style: ${esc(relationship.communicationStyle ?? "")}<br/>
      Languages: ${esc((relationship.primaryLanguages ?? []).join(", "))}
    </p>

    <h2>Key Topics &amp; Concerns</h2>
    <p><strong>Key topics:</strong> ${(relationship.keyTopics ?? []).map((t) => esc(t)).join(", ")}</p>
    <p><strong>Recurring concerns:</strong> ${(relationship.recurringConcerns ?? []).map((t) => esc(t)).join(", ")}</p>

    ${
      metrics
        ? `<h2>Metrics</h2>
      <ul>
        <li>Total messages: ${esc(metrics.totalMessages)}</li>
        <li>From me / them: ${esc(metrics.fromMeCount)} / ${esc(metrics.fromThemCount)}</li>
        <li>Last 7d / 30d: ${esc(metrics.last7DaysCount)} / ${esc(metrics.last30DaysCount)}</li>
        <li>Days since last message: ${esc(metrics.daysSinceLastMessage ?? "n/a")}</li>
        <li>Share from me: ${
          metrics.totalMessages ? esc(Math.round((metrics.fromMeCount / metrics.totalMessages) * 100)) + "%" : "n/a"
        }</li>
      </ul>`
        : ""
    }

    ${
      model
        ? `<h2>Model</h2>
      <ul>
        <li>Energetic polarity: ${esc(model.energeticPolarity)}</li>
        <li>Initiation: ${esc(model.communicationDynamics.initiationPattern)}</li>
        <li>Consistency: ${esc(model.communicationDynamics.consistency)}</li>
        <li>Typical response time: ${esc(model.communicationDynamics.typicalResponseTime)}</li>
      </ul>`
        : ""
    }

    <h2>Support &amp; Follow-ups</h2>
    <h3>Suggested Ways to Support</h3>
    <ul>${(relationship.suggestedWaysToSupport ?? []).map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
    <h3>Suggested Things to Follow Up On</h3>
    <ul>${(relationship.suggestedThingsToFollowUpOn ?? []).map((s) => `<li>${esc(s)}</li>`).join("")}</ul>

    <h2>Notable Moments</h2>
    <ul>
      ${(relationship.notableMoments ?? [])
        .map((m) => `<li>${esc(formatTs(m.ts))}: ${esc(m.summary)} (${esc(m.role)})</li>`)
        .join("")}
    </ul>

    <details>
      <summary>Raw JSON</summary>
      <pre>${esc(JSON.stringify(relationship, null, 2))}</pre>
    </details>
    `;

    res.send(layout(`Relationship ${relationship.displayName ?? chatId}`, body));
  } catch (err: any) {
    console.error("Admin /relationships/:chatId error:", err);
    res
      .status(500)
      .send(layout("Error", `<p>Failed to load relationship: ${esc(err?.message ?? err)}</p>`));
  }
});

adminRouter.get("/me", async (req, res) => {
  const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);
  const days = clamp(Number(req.query.days) || 14, 7, 60);

  let stateHistory;
  let topPeople: Awaited<ReturnType<typeof getRecentOneToOneChats>>["people"] = [];
  let relationshipSummaries: RelationshipSummary[] = [];
  let openLoops: any[] = [];
  let reflectionText: string | null = null;
  let reflectionError: string | null = null;

  try {
    stateHistory = await getStateHistory(days);
  } catch (err: any) {
    return res
      .status(500)
      .send(layout("Error", `<p>Failed to load state history: ${esc(err?.message ?? err)}</p>`));
  }

  try {
    const peopleResult = await getRecentOneToOneChats(days, 10);
    topPeople = peopleResult.people ?? peopleResult;
  } catch (err: any) {
    console.error("Admin /me: failed to load top people", err);
  }

  try {
    openLoops = await getActiveOpenLoopsFromWindows(14);
  } catch (err: any) {
    console.error("Admin /me: failed to load open loops", err);
  }

  const topRelationshipChats = (topPeople ?? []).slice(0, 5);
  for (const person of topRelationshipChats) {
    try {
      const summary = await generateRelationshipSummary(person.chatId, 300);
      relationshipSummaries.push(summary);
    } catch (err) {
      console.error(`Admin /me: failed to load relationship ${person.chatId}`, err);
    }
  }

  const snapshots = stateHistory.snapshots ?? [];
  const fromDate = snapshots.length > 0 ? snapshots[snapshots.length - 1].date : "n/a";
  const toDate = snapshots.length > 0 ? snapshots[0].date : "n/a";

  const profileInput = {
    range: { from: fromDate, to: toDate },
    stateHistory: snapshots,
    topPeople,
    relationships: relationshipSummaries,
    openLoops: openLoops ?? [],
  };

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    {
      role: "system",
      content: [
        "You are analysing one person's WhatsApp-derived intel.",
        "You see their emotional state per day, their key relationships, and which conversations matter most.",
        "Your job is to tell them who they have ACTUALLY been over this period, not who they claim to be.",
        "Be honest but not cruel. You're like a mirror held up by their higher self.",
        'Respond ONLY as JSON: {"reflection": "<markdown in English>"}',
      ].join(" "),
    },
    {
      role: "user",
      content: [
        "Here is the intel in JSON form:",
        JSON.stringify(profileInput, null, 2),
        "",
        "From this, craft a reflection in English markdown with clear headings:",
        '- "Overall" – a short paragraph summarising who they have been over this period.',
        '- "Where your attention goes" – who they actually pour energy into and how.',
        "- \"Patterns\" – 5-10 bullet points about repeated behaviours, worries, and coping styles.",
        "- \"Relationships\" – 3-6 bullet points about how they show up with key people (e.g. partner, closest friend, community).",
        '- "Tension & self-sabotage" – where they act against what would be best for them.',
        '- "What you might actually want" – a short paragraph guessing their deeper desires based on behaviour.',
        '- "Gentle but blunt reflection" – 3-6 sentences, like a loving but honest friend.',
        "",
        "Focus on concrete observable patterns: who they message at night, who they chase, who they ignore, what they worry about repeatedly.",
      ].join("\n"),
    },
  ];

  try {
    const reflectionResult = await callLLM<{ reflection?: string } | string>("coaching", { messages });
    reflectionText =
      typeof reflectionResult === "string" ? reflectionResult : reflectionResult?.reflection ?? null;
  } catch (err: any) {
    console.error("Admin /me: failed to generate reflection", err);
    reflectionError = err?.message ?? "Failed to generate reflection";
  }

  const stateRows = snapshots
    .map(
      (s) => `
        <tr>
          <td>${esc(s.date)}</td>
          <td>${esc(s.mood)}</td>
          <td>${esc(s.energyLevel)}</td>
          <td>${esc(s.stressLevel)}</td>
          <td>${esc((s.dominantConcerns ?? []).join(", "))}</td>
        </tr>
      `
    )
    .join("");

  const relationshipCards = relationshipSummaries
    .map(
      (r) => `
        <div style="border:1px solid #ddd; padding:8px; margin-bottom:8px;">
          <strong>${esc(r.displayName ?? r.chatId)}</strong><br/>
          Type: ${esc(r.relationshipType ?? "")}, Closeness: ${esc(r.closeness ?? "")}<br/>
          Summary: ${esc(r.overallSummary ?? "")}
        </div>
      `
    )
    .join("");

  const openLoopList = (openLoops ?? [])
    .map((ol) => `<li>${esc(ol.chatId ?? "")}: ${esc(ol.what ?? ol.summary ?? "")}</li>`)
    .join("");

  const topPeopleRows = (topPeople ?? [])
    .map(
      (p) => `
        <tr>
          <td>${esc(p.displayName)}</td>
          <td class="mono">${esc(p.chatId)}</td>
          <td>${esc(p.messageCount)}</td>
        </tr>
      `
    )
    .join("");

  const reflectionHtml = reflectionText
    ? `<pre>${esc(reflectionText)}</pre>`
    : `<p class="muted">Failed to generate reflection${reflectionError ? `: ${esc(reflectionError)}` : ""}</p>`;

  const body = `
    <h1>Me – Combined Intel (last ${esc(String(days))} days)</h1>
    <p>Range: from ${esc(fromDate)} to ${esc(toDate)}</p>

    <h2>AI Reflection</h2>
    ${reflectionHtml}

    <h2>Raw Intel Snapshot</h2>

    <h3>Mood &amp; State (last ${esc(String(days))} days)</h3>
    <table>
      <thead><tr><th>Date</th><th>Mood</th><th>Energy</th><th>Stress</th><th>Concerns</th></tr></thead>
      <tbody>${stateRows || "<tr><td colspan='5'>No data</td></tr>"}</tbody>
    </table>

    <h3>Top People</h3>
    <table>
      <thead><tr><th>Name</th><th>chatId</th><th>Messages</th></tr></thead>
      <tbody>${topPeopleRows || "<tr><td colspan='3'>No people</td></tr>"}</tbody>
    </table>

    <h3>Top Relationship Summaries</h3>
    ${relationshipCards || "<p class='muted'>No relationship summaries available.</p>"}

    <h3>Active Open Loops</h3>
    <ul>${openLoopList || "<li>None</li>"}</ul>
  `;

  res.send(layout("Me – Combined Intel", body));
});

adminRouter.get("/me/profile", async (_req, res) => {
  try {
    let profile = await getUserProfile();
    if (!profile) {
      profile = await generateUserProfile({ force: true });
    }

    res.send(`
      <html>
        <head>
          <title>My Profile</title>
          <style>
            body { font-family: system-ui, sans-serif; padding: 16px; max-width: 900px; margin: 0 auto; }
            pre { white-space: pre-wrap; word-wrap: break-word; background: #111; color: #eee; padding: 12px; border-radius: 4px; }
            h2 { margin-top: 24px; }
          </style>
        </head>
        <body>
          <h1>My Communication Profile (beta)</h1>
          <p><strong>Baseline mood:</strong> ${profile.emotionalPatterns.baselineMood}</p>
          <p><strong>Overall tone:</strong> ${profile.communicationStyle.overallTone.join(", ")}</p>
          <p><strong>Attachment vibe:</strong> ${profile.relationalPatterns.attachmentVibe}</p>
          <p><strong>Who I lean on most:</strong> ${profile.relationalPatterns.whoTheyLeanOn.join(", ") || "—"}</p>
          <p><strong>Current big themes:</strong> ${profile.valuesAndMotivation.currentBigThemes.join(", ") || "—"}</p>
          <h2>Raw JSON</h2>
          <pre>${JSON.stringify(profile, null, 2)}</pre>
        </body>
      </html>
    `);
  } catch (err: any) {
    console.error("Failed to render /admin/me/profile", err);
    res.status(500).send("Failed to render profile");
  }
});
