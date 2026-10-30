// A stand-in for the Danny API that runs inside the page, so the real front end can be clicked through with no server.
// The routing decisions come from the real router (apps/api/src/brain/router.ts). Everything else is simulated:
// replies are canned, nothing is sent anywhere, and state resets when the page reloads.
import { estimateTokens, FEATURES, nextTier, route, type Feature, type Tier } from "../../api/src/brain/router";

type Level = "ok" | "near" | "critical";
type Step = { id: string; text: string; status: "todo" | "doing" | "done" | "blocked"; dueAt: string | null };
type Goal = { id: string; title: string; notes: string; status: "active" | "done" | "dropped"; createdBy: "user" | "danny"; dueAt: string | null; nextReviewAt: string; lastReviewedAt: string | null; steps: Step[] };
type Approval = { id: string; kind: string; title: string; payload: Record<string, unknown>; status: string; createdAt: string; decidedAt: string | null; executed: boolean };
type Req = { id: string; tier: Tier; model: string; feature: string; downshifted: boolean; escalated: boolean; retryOf: string | null; source: "chat" | "agent"; status: "ok" | "failed" | "blocked"; costMicros: number; at: number };

const MODELS: Record<Tier, string> = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" };
// US$ per million tokens: input, output
const PRICE: Record<Tier, [number, number]> = { haiku: [0.1, 0.5], sonnet: [2, 10], opus: [4, 20] };
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const DAY = 86_400_000;
const uid = () => crypto.randomUUID();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const S = {
  killSwitch: false,
  dailyCapUsd: 2,
  monthlyCapUsd: 30,
  agentEnabled: true,
  agentRunsPerDay: 6,
  agentRunsToday: 0,
  agentLastRunAt: null as string | null,
  spentTodayMicros: 120_000, // some history, so the meters aren't empty
  spentMonthMicros: 4_100_000,
  memory: [
    { id: uid(), content: "Marlene Hendricks prefers texts, not calls", createdAt: iso(Date.now() - 3 * DAY) },
    { id: uid(), content: "Justin charges $450 for a Google Business Profile setup", createdAt: iso(Date.now() - 2 * DAY) },
  ],
  goals: [] as Goal[],
  approvals: [] as Approval[],
  connections: [] as { id: string; provider: string; label: string; status: string; createdAt: string }[],
  messages: [] as { role: "user" | "assistant"; text: string; at: string }[],
  requests: [] as Req[],
};

S.goals.push({
  id: uid(), title: "Land three new Google Business Profile clients", notes: "Local plumbers around Barrie. Started with the Hendricks referral.", status: "active", createdBy: "user", dueAt: iso(Date.now() + 20 * DAY),
  nextReviewAt: iso(Date.now() + DAY), lastReviewedAt: null,
  steps: [
    { id: uid(), text: "List 20 plumbers with weak Google listings", status: "done", dueAt: null },
    { id: uid(), text: "Draft the first outreach email", status: "doing", dueAt: iso(Date.now() + 2 * DAY) },
    { id: uid(), text: "Call the five closest", status: "todo", dueAt: null },
  ],
});
S.approvals.push({
  id: uid(), kind: "send_email", title: "Email to marlene@hendricksplumbing.ca: Invoice 114", status: "pending", createdAt: iso(Date.now() - 3_600_000), decidedAt: null, executed: false,
  payload: { to: "marlene@hendricksplumbing.ca", subject: "Invoice 114", body: "Hi Marlene,\n\nA quick nudge on invoice 114 from the profile setup. No rush if it's in the mail.\n\nJustin" },
});

// ---- budget, the same thresholds as the server ----
const usd = (m: number) => m / 1e6;
function level(): Level {
  const f = Math.max(S.dailyCapUsd > 0 ? usd(S.spentTodayMicros) / S.dailyCapUsd : 1, S.monthlyCapUsd > 0 ? usd(S.spentMonthMicros) / S.monthlyCapUsd : 1);
  return f >= 0.95 ? "critical" : f >= 0.8 ? "near" : "ok";
}
const blocked = (): "kill_switch" | "cap_reached" | "month_cap_reached" | null =>
  S.killSwitch ? "kill_switch" : usd(S.spentTodayMicros) >= S.dailyCapUsd ? "cap_reached" : usd(S.spentMonthMicros) >= S.monthlyCapUsd ? "month_cap_reached" : null;
const BLOCKED_TEXT = {
  kill_switch: "Danny is stopped. Turn him back on in settings.",
  cap_reached: "Daily spend cap reached. Raise it in settings or wait until tomorrow (UTC).",
  month_cap_reached: "Monthly spend cap reached. Raise it in settings or wait until next month (UTC).",
};
function charge(tier: Tier, inTok: number, outTok: number) {
  const [pi, po] = PRICE[tier];
  const m = Math.ceil(inTok * pi + outTok * po);
  S.spentTodayMicros += m;
  S.spentMonthMicros += m;
  return m;
}

// ---- canned replies ----
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)]!;
const firstName = (m: string) => /\b(?:to|for|with)\s+([A-Za-z]{2,})/.exec(m)?.[1] ?? "Marlene";
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function listMemory() {
  return S.memory.length ? `Here's what I have:\n${S.memory.map((m) => `- ${m.content}`).join("\n")}` : "Nothing saved yet.";
}
function listGoals() {
  const g = S.goals.filter((x) => x.status === "active");
  return g.length ? `Active goals:\n${g.map((x) => `- ${x.title} (${x.steps.filter((s) => s.status === "done").length}/${x.steps.length} steps done)`).join("\n")}` : "No active goals.";
}

type Emit = (e: Record<string, unknown>) => void;
function addApproval(kind: string, title: string, payload: Record<string, unknown>, emit: Emit) {
  const a: Approval = { id: uid(), kind, title, payload, status: "pending", createdAt: iso(), decidedAt: null, executed: false };
  S.approvals.unshift(a);
  emit({ type: "approval", id: a.id, title });
  emit({ type: "tool", name: kind === "send_email" ? "send_email" : "request_approval", status: "queued" });
}
function addGoal(title: string, by: "user" | "danny", steps: string[]) {
  const g: Goal = { id: uid(), title, notes: "", status: "active", createdBy: by, dueAt: null, nextReviewAt: iso(Date.now() + DAY), lastReviewedAt: null, steps: steps.map((t) => ({ id: uid(), text: t, status: "todo", dueAt: null })) };
  S.goals.unshift(g);
  return g;
}

/** What the simulated model "says" for this request, and what it does along the way. */
function compose(text: string, d: { feature: Feature; tier: Tier; reason: string }, emit: Emit, retry: string | null): string {
  const t = text.trim();
  if (retry) {
    const label = cap(d.tier);
    return `${label} here, taking a second pass at "${retry.slice(0, 80)}${retry.length > 80 ? "…" : ""}".\n\nI went slower on this one: checked the details against what I know about you, tightened the wording, and cut anything that didn't help. If it still isn't right, tell me what's off and I'll fix that part.`;
  }
  if (/^\s*remember\b/i.test(t) || /\bprefers?\b/i.test(t)) {
    const fact = t.replace(/^\s*remember( that)?\s*/i, "").replace(/\.$/, "");
    S.memory.unshift({ id: uid(), content: cap(fact), createdAt: iso() });
    emit({ type: "tool", name: "remember", status: "ran" });
    return "Got it. Saved.";
  }
  if (d.feature === "reminder") return `Noted. I'll bring it up when it's time: "${t.replace(/^\s*(please\s+)?remind me( to)?\s*/i, "").slice(0, 90)}".`;
  if (d.feature === "email") {
    const who = cap(firstName(t));
    addApproval("send_email", `Email to ${who.toLowerCase()}@example.ca: Quick follow-up`, { to: `${who.toLowerCase()}@example.ca`, subject: "Quick follow-up", body: `Hi ${who},\n\nFollowing up on what we talked about. Happy to answer any questions, and I can have the next step ready by Friday.\n\nJustin` }, emit);
    return `Drafted it. It's in Waiting for your tap. Nothing goes out until you approve.`;
  }
  if (d.feature === "client_post") {
    addApproval("post", "Google Business post: spring tune-up special", { draft: "Spring tune-ups are booked through the end of the month. Call before Friday and we'll waive the call-out fee. Serving Barrie and Innisfil." }, emit);
    return "Wrote the post and put it in Waiting. It won't publish until you approve it.";
  }
  if (d.feature === "planning" || /\bgoal\b/i.test(t)) {
    const title = cap(t.replace(/^.*?\b(my goal is|goal is|plan(?: for)?|i want to)\s*(to\s+)?/i, "").replace(/[.?!]+$/, "")).slice(0, 120) || "New goal";
    const g = addGoal(title, "user", ["Define what done looks like", "List the first five actions", "Block time for the first one"]);
    emit({ type: "tool", name: "set_goal", status: "ran" });
    return `Tracking it as a goal with three first steps. I'll look it over again ${new Date(g.nextReviewAt).toLocaleDateString([], { weekday: "long" })}. Edit the plan in Goals.`;
  }
  if (d.feature === "multi_step") {
    return "Here's how I'd split it:\n1. Get the facts straight first.\n2. Draft the piece that needs your approval.\n3. Line up the follow-up.\n\nSay go and I'll start on step one.";
  }
  if (d.feature === "lookup") {
    if (/remember|know about me/i.test(t)) return listMemory();
    if (/goal|plate|on my/i.test(t)) return listGoals();
    if (/spend|spent|cost/i.test(t)) return `You've used $${usd(S.spentTodayMicros).toFixed(2)} today and $${usd(S.spentMonthMicros).toFixed(2)} this month.`;
    return pick(["Short answer: yes, as far as I know.", "Not that I've got on file. Want me to note it?", "Last I checked, that's still open."]);
  }
  if (d.reason === "user_asked_opus") return "Opus here. I took the long way round on this one:\n\nThe short version is to decide the price before you decide the package. Quote the outcome, keep the scope tight, and let the first client's results set the next quote.";
  return pick(["Morning. What's first?", "Got it.", "Fine. What do you need?", "Understood. Anything else on that?"]);
}

async function streamText(text: string, emit: Emit) {
  for (const w of text.split(/(\s+)/)) {
    if (w) emit({ type: "text", text: w });
    if (w.trim()) await sleep(14);
  }
}

function sse(run: (emit: Emit) => Promise<void>) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(c) {
      try {
        await run((e) => c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)));
      } finally {
        c.close();
      }
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}

const logReq = (r: Omit<Req, "id" | "at"> & { id?: string }) => S.requests.push({ id: r.id ?? uid(), at: Date.now(), ...r });
const lastChat = () => [...S.requests].reverse().find((r) => r.source === "chat" && r.status === "ok") ?? null;

async function chat(body: { message?: string; retryOf?: string; model?: string; feature?: string }) {
  return sse(async (emit) => {
    await sleep(120);
    const b = blocked();
    const retryRow = body.retryOf ? S.requests.find((r) => r.id === body.retryOf) : null;
    if (b) {
      logReq({ tier: "haiku", model: "none", feature: body.feature ?? "chat", downshifted: false, escalated: false, retryOf: body.retryOf ?? null, source: "chat", status: "blocked", costMicros: 0 });
      return emit({ type: "error", code: b, message: BLOCKED_TEXT[b] });
    }
    if (body.retryOf) {
      if (!retryRow || retryRow.id !== lastChat()?.id) return emit({ type: "error", code: "cannot_retry", message: "That isn't your latest answer, so it can't be redone." });
      if (retryRow.tier === "opus") return emit({ type: "error", code: "cannot_retry", message: "That answer already came from the biggest model." });
    }
    const prevUser = [...S.messages].reverse().find((m) => m.role === "user" && m.text !== "Answer that again, better.")?.text ?? "";
    let text = body.retryOf ? "Answer that again, better." : (body.message ?? "");
    const simulateFail = /\/fail\b/.test(text);
    text = text.replace(/\/fail\b\s*/, "").trim() || text;

    const lv = level();
    const historyChars = S.messages.slice(-40).reduce((n, m) => n + m.text.length, 0);
    const d = route({
      feature: (retryRow ? retryRow.feature : (body.feature && (FEATURES as readonly string[]).includes(body.feature) ? body.feature : "chat")) as Feature,
      message: text,
      promptTokens: estimateTokens(6000 + historyChars),
      askedForOpus: body.model === "opus",
      atLeast: retryRow ? (nextTier(retryRow.tier) ?? undefined) : undefined,
      level: lv,
    });
    if (retryRow && ["haiku", "sonnet", "opus"].indexOf(d.tier) <= ["haiku", "sonnet", "opus"].indexOf(retryRow.tier)) {
      logReq({ tier: d.tier, model: "none", feature: d.feature, downshifted: true, escalated: false, retryOf: retryRow.id, source: "chat", status: "blocked", costMicros: 0 });
      return emit({ type: "error", code: "no_headroom", message: "You're close to your spend cap, so Danny can't use a bigger model right now." });
    }

    const requestId = uid();
    let tier: Tier = d.tier;
    let escalated = false;
    const info = () => ({ type: "route", requestId, tier, model: MODELS[tier], feature: d.feature, reason: escalated ? "sonnet_failed_twice" : d.reason, downshifted: d.downshifted, escalated });
    S.messages.push({ role: "user", text: body.retryOf ? "Answer that again, better." : text, at: iso() });
    emit(info());

    if (simulateFail) {
      // The same retry rules as the server: one retry on the same model; Sonnet failing twice moves to Opus unless a cap is near.
      await sleep(250);
      emit({ type: "retry" });
      await sleep(250);
      if (tier === "sonnet" && d.canEscalate) {
        emit({ type: "retry" });
        tier = "opus";
        escalated = true;
        emit(info());
        await sleep(250);
      } else {
        logReq({ id: requestId, tier, model: MODELS[tier], feature: d.feature, downshifted: d.downshifted, escalated: false, retryOf: body.retryOf ?? null, source: "chat", status: "failed", costMicros: 0 });
        emit({ type: "retry" });
        return emit({ type: "error", code: "model_failed", message: "The model call failed. Nothing was charged for this step. Try again." });
      }
    }

    const reply = compose(text, { feature: d.feature, tier, reason: d.reason }, emit, body.retryOf ? prevUser : null);
    await streamText(reply, emit);
    const inTok = 700 + Math.ceil((historyChars + text.length) / 4);
    const outTok = Math.ceil(reply.length / 3.2) + (tier === "haiku" ? 20 : 200);
    const cost = charge(tier, inTok, outTok);
    S.messages.push({ role: "assistant", text: reply, at: iso() });
    logReq({ id: requestId, tier, model: MODELS[tier], feature: d.feature, downshifted: d.downshifted, escalated, retryOf: body.retryOf ?? null, source: "chat", status: "ok", costMicros: cost });
    emit({ type: "done" });
  });
}

// ---- the other routes ----
const J = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const goalView = (g: Goal) => g;

function settingsView() {
  return {
    dailyCapUsd: S.dailyCapUsd, monthlyCapUsd: S.monthlyCapUsd, killSwitch: S.killSwitch,
    spentTodayUsd: usd(S.spentTodayMicros), spentMonthUsd: usd(S.spentMonthMicros),
    agentEnabled: S.agentEnabled, agentRunsPerDay: S.agentRunsPerDay, agentRunsToday: S.agentRunsToday, agentLastRunAt: S.agentLastRunAt, schedulerOn: true,
  };
}

async function handle(method: string, url: URL, body: any): Promise<Response> {
  const p = url.pathname;
  await sleep(60 + Math.random() * 120);
  if (p === "/healthz") return J({ ok: true });
  if (p === "/v1/me") return J({ user: { id: "preview-user", email: "you@preview.danny", name: "Justin" }, workspaceId: "preview-ws", role: "admin", isOwner: true });
  if (p.startsWith("/v1/auth/")) return J({ ok: true }, p.endsWith("accept-invite") ? 201 : 200);

  if (p === "/v1/settings") {
    if (method === "PATCH") {
      if (body.dailyCapUsd !== undefined) S.dailyCapUsd = body.dailyCapUsd;
      if (body.monthlyCapUsd !== undefined) S.monthlyCapUsd = body.monthlyCapUsd;
      if (body.killSwitch !== undefined) S.killSwitch = body.killSwitch;
      if (body.agentEnabled !== undefined) S.agentEnabled = body.agentEnabled;
      if (body.agentRunsPerDay !== undefined) S.agentRunsPerDay = body.agentRunsPerDay;
    }
    return J(settingsView());
  }
  if (p === "/v1/usage") {
    const rows = ["haiku", "sonnet", "opus"].map((t) => {
      const r = S.requests.filter((x) => x.tier === t && x.status !== "blocked");
      return { tier: t, requests: r.length, costUsd: usd(r.reduce((n, x) => n + x.costMicros, 0)), answerBetter: r.filter((x) => x.retryOf).length, downshifted: r.filter((x) => x.downshifted).length, escalated: r.filter((x) => x.escalated).length };
    }).filter((r) => r.requests);
    return J({ month: { spentUsd: usd(S.spentMonthMicros), capUsd: S.monthlyCapUsd }, today: { spentUsd: usd(S.spentTodayMicros), capUsd: S.dailyCapUsd }, budgetLevel: level(), byTier: rows });
  }

  if (p === "/v1/chat" && method === "POST") return chat(body);
  if (p === "/v1/chat/history") {
    const l = lastChat();
    return J({ messages: S.messages.slice(-Number(url.searchParams.get("limit") ?? 50)), lastRequest: l ? { id: l.id, tier: l.tier, model: l.model, feature: l.feature, downshifted: l.downshifted } : null });
  }

  if (p === "/v1/memory") {
    if (method === "POST") { const m = { id: uid(), content: body.content, createdAt: iso() }; S.memory.unshift(m); return J({ item: m }, 201); }
    return J({ items: S.memory });
  }
  if (p.startsWith("/v1/memory/") && method === "DELETE") { S.memory = S.memory.filter((m) => m.id !== p.split("/").pop()); return J({ ok: true }); }

  if (p === "/v1/approvals") {
    const st = url.searchParams.get("status");
    return J({ items: S.approvals.filter((a) => !st || a.status === st) });
  }
  const dec = /^\/v1\/approvals\/([^/]+)\/decision$/.exec(p);
  if (dec) {
    const a = S.approvals.find((x) => x.id === dec[1] && x.status === "pending");
    if (!a) return J({ error: "not_pending_or_not_found" }, 409);
    a.status = { approve: "approved", changes: "changes_requested", drop: "dropped" }[body.decision as "approve"];
    a.decidedAt = iso();
    let note = "Recorded. Nothing has been sent.";
    if (body.decision === "approve" && a.kind === "send_email") {
      if (S.connections.some((c) => c.provider === "resend")) { a.executed = true; note = `Sent to ${(a.payload as { to: string }).to}. (Simulated: nothing really left this page.)`; }
      else note = "Approved. Nothing was sent: no email account is linked yet. Add one in Settings.";
    }
    return J({ item: a, note });
  }

  if (p === "/v1/connections") {
    if (method === "POST") { const c = { id: uid(), provider: body.provider, label: body.label ?? "", status: "active", createdAt: iso() }; S.connections.unshift(c); return J({ item: c }, 201); }
    return J({ items: S.connections });
  }
  if (p.startsWith("/v1/connections/") && method === "DELETE") { S.connections = S.connections.filter((c) => c.id !== p.split("/").pop()); return J({ ok: true }); }

  if (p === "/v1/goals") {
    if (method === "POST") {
      if (S.goals.filter((g) => g.status === "active").length >= 12) return J({ error: "limit", message: "Already tracking 12 active goals. Finish or drop one first." }, 409);
      const g = addGoal(body.title, "user", (body.steps ?? []).map((s: { text: string }) => s.text));
      if (body.notes) g.notes = body.notes;
      return J({ item: goalView(g) }, 201);
    }
    const closed = url.searchParams.get("closed") === "true";
    return J({ items: S.goals.filter((g) => closed || g.status === "active").map(goalView) });
  }
  const gm = /^\/v1\/goals\/([^/]+)(?:\/steps(?:\/([^/]+))?)?$/.exec(p);
  if (gm) {
    const g = S.goals.find((x) => x.id === gm[1]);
    if (!g) return J({ error: "not_found" }, 404);
    if (p.includes("/steps")) {
      if (method === "POST") {
        if (g.steps.length + body.steps.length > 15) return J({ error: "limit", message: "A goal holds at most 15 steps. Mark some done, or split this into a second goal." }, 409);
        for (const s of body.steps) g.steps.push({ id: uid(), text: s.text, status: "todo", dueAt: null });
        return J({ ok: true }, 201);
      }
      const s = g.steps.find((x) => x.id === gm[2]);
      if (!s) return J({ error: "not_found" }, 404);
      if (body.status) s.status = body.status;
      if (body.text) s.text = body.text;
      return J({ ok: true });
    }
    for (const k of ["title", "notes", "status"] as const) if (body[k] !== undefined) (g as any)[k] = body[k];
    if (body.status === "active") g.nextReviewAt = iso();
    return J({ ok: true });
  }

  if (p === "/v1/agent/run" && method === "POST") {
    const b = blocked();
    if (b) return J({ ran: false, reason: b });
    if (S.agentRunsToday >= S.agentRunsPerDay) return J({ ran: false, reason: "run_limit" });
    S.agentRunsToday++;
    S.agentLastRunAt = iso();
    const g = S.goals.find((x) => x.status === "active");
    const lv = level();
    const tier = route({ feature: "planning", message: "", promptTokens: 6000, level: lv }).tier;
    const cost = charge(tier, 4200, 650);
    if (!g) { logReq({ tier, model: MODELS[tier], feature: "planning", downshifted: tier !== "sonnet", escalated: false, retryOf: null, source: "agent", status: "ok", costMicros: cost }); return J({ ran: true, message: null, costUsd: usd(cost), steps: 1 }); }
    g.steps.push({ id: uid(), text: "Send the first five pitches (draft is in Waiting)", status: "todo", dueAt: null });
    g.nextReviewAt = iso(Date.now() + 3 * DAY);
    g.lastReviewedAt = iso();
    g.notes = "Pitch drafted. Waiting on your tap before anything goes out.";
    S.approvals.unshift({ id: uid(), kind: "send_email", title: "Email to info@barriecomfort.ca: Your Google listing", status: "pending", createdAt: iso(), decidedAt: null, executed: false, payload: { to: "info@barriecomfort.ca", subject: "Your Google listing", body: "Hi,\n\nI noticed your Google Business Profile is missing hours and photos. I fix that for local businesses, usually in a day. Want me to send a quick before-and-after?\n\nJustin" } });
    const message = `Added a step to "${g.title}" and drafted a pitch. It's in Waiting for your tap. I'll look again in three days.`;
    S.messages.push({ role: "assistant", text: message, at: iso() });
    logReq({ tier, model: MODELS[tier], feature: "planning", downshifted: tier !== "sonnet", escalated: false, retryOf: null, source: "agent", status: "ok", costMicros: cost });
    return J({ ran: true, message, costUsd: usd(cost), steps: 3 });
  }

  if (p === "/v1/admin/invite-requests") return J({ items: [] });
  if (p === "/v1/admin/invites" || p.endsWith("/approve")) return J({ inviteUrl: "https://preview.invalid/accept?token=simulated", expiresInDays: 7 });
  if (p === "/v1/admin/usage") return J({ users: [{ userId: "preview-user", email: "you@preview.danny", todayUsd: usd(S.spentTodayMicros), last30DaysUsd: usd(S.spentMonthMicros) }] });
  if (p === "/v1/admin/routing") {
    const r = S.requests.filter((x) => x.status !== "blocked");
    return J({ users: [{ userId: "preview-user", email: "you@preview.danny", monthUsd: usd(S.spentMonthMicros), monthlyCapUsd: S.monthlyCapUsd, requests: r.length, haiku: r.filter((x) => x.tier === "haiku").length, sonnet: r.filter((x) => x.tier === "sonnet").length, opus: r.filter((x) => x.tier === "opus").length, answerBetter: r.filter((x) => x.retryOf).length, downshifted: r.filter((x) => x.downshifted).length, escalated: r.filter((x) => x.escalated).length }] });
  }
  return J({ error: "not_found" }, 404);
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, location.href);
  if (!url.pathname.startsWith("/v1/") && url.pathname !== "/healthz") return realFetch(input, init);
  let body: any = {};
  try { body = init?.body ? JSON.parse(String(init.body)) : {}; } catch { /* no body */ }
  return handle((init?.method ?? "GET").toUpperCase(), url, body);
};

// ---- a thin banner and a list of things worth trying ----
const css = document.createElement("style");
css.textContent = `body{box-sizing:border-box;padding-top:28px}
#pv{position:fixed;inset:0 0 auto 0;height:28px;z-index:9999;display:flex;align-items:center;gap:12px;padding:0 12px;background:#cdf03c;color:#0f1211;font:500 11px/1 "IBM Plex Mono",monospace;letter-spacing:.06em;text-transform:uppercase}
#pv b{font-weight:600}#pv span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#pv button{flex:none;background:#0f1211;color:#cdf03c;border:0;height:20px;padding:0 8px;font:inherit;cursor:pointer}
#pvt{position:fixed;top:28px;right:0;width:min(380px,100%);max-height:calc(100% - 28px);overflow:auto;z-index:9998;background:#171b19;color:#e9ede6;border:1px solid #2a312d;padding:14px 16px;font:400 14px/1.45 Barlow,sans-serif}
#pvt h3{margin:0 0 8px;font:700 20px/1 "Barlow Condensed",sans-serif;text-transform:uppercase}#pvt li{margin:0 0 8px;list-style:disc;margin-left:18px}#pvt code{font-family:"IBM Plex Mono",monospace;font-size:12px;color:#cdf03c}`;
document.head.append(css);
const bar = document.createElement("div");
bar.id = "pv";
bar.innerHTML = `<b>Preview</b><span>Nothing is sent</span><button type="button" aria-expanded="false">Things to try</button>`;
const tips = document.createElement("div");
tips.id = "pvt";
tips.hidden = true;
tips.innerHTML = `<h3>Things to try</h3><ul>
<li>Chat: <code>hey</code> then <code>Draft an email to Marlene about invoice 114</code>. Watch the model chip change.</li>
<li>Tap <b>Answer better</b> under a reply. It goes one size up.</li>
<li><code>Opus: what should I charge a plumber?</code> asks for Opus by name.</li>
<li><code>/fail draft an email to Bob</code> makes Sonnet fail twice and moves to Opus.</li>
<li><code>Remind me to call Bob at 3</code>, <code>what do you remember about me?</code>, <code>my goal is to land 5 roofers</code>.</li>
<li><b>Settings</b>: you've used $0.12 today. Set the daily cap to <code>0.15</code> (80%: he drops a size), <code>0.125</code> (96%: Haiku only) or <code>0.1</code> (over: he stops). Then chat.</li>
<li><b>Goals</b>: tap a step to cycle it, press Review now.</li>
<li><b>Waiting</b>: approve the email before and after linking an email account in Settings (any fake key).</li>
<li><b>Owner</b>: models by person fills in as you go.</li></ul>`;
document.body.prepend(bar);
document.body.append(tips);
const btn = bar.querySelector("button")!;
btn.addEventListener("click", () => { tips.hidden = !tips.hidden; btn.setAttribute("aria-expanded", String(!tips.hidden)); });
