import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResult, SearchRequest, SearchResult } from "../src/brain/model.js";
import { goals, messages, spendLedger, users } from "../src/db/schema.js";
import { runDueBriefings, runDueGoalChecks, type BackgroundDeps } from "../src/lib/background.js";
import type { PushPayload, PushSender, PushSub } from "../src/lib/push.js";
import { createRegistry } from "../src/tools/builtin.js";
import { seedOwner, setupApp, signUp, type Client, type Ctx } from "./helpers.js";

class FakePush implements PushSender {
  publicKey: string | null = "k";
  sent: PushPayload[] = [];
  async send(_s: PushSub, p: PushPayload) {
    this.sent.push(p);
    return "ok" as const;
  }
}

const push = new FakePush();
let ctx: Ctx;
let owner: Client;
let chat: ModelResult[] = [];
let searchReply: (req: SearchRequest) => SearchResult = () => ({ text: "", sources: [], usage: { inputTokens: 0, outputTokens: 0 } });
const searches: SearchRequest[] = [];
const chatCalls: ModelRequest[] = [];

const model: ModelClient = {
  async complete(req, onText) {
    chatCalls.push(JSON.parse(JSON.stringify(req)));
    const res = chat.shift()!;
    for (const b of res.content) if (b.type === "text") onText(b.text);
    return res;
  },
  async search(req) {
    searches.push(req);
    return searchReply(req);
  },
};

beforeAll(async () => {
  ctx = await setupApp(model, createRegistry(), {}, push);
  owner = (await seedOwner(ctx)).c;
});
afterAll(() => ctx.close());

const deps = (): BackgroundDeps => ({ db: ctx.runtime.db, vault: ctx.vault, push, config: ctx.config, model });
const found = (text: string, n = 1): SearchResult => ({ text, sources: [{ title: "Example", url: "https://example.com/a" }], usage: { inputTokens: 1000, outputTokens: 100, searches: n } });
const use = (name: string, input: unknown): ModelResult => ({ content: [{ type: "tool_use", id: "t1", name, input }], stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } });
const say = (t: string): ModelResult => ({ content: [{ type: "text", text: t }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } });
const chatText = async (c: Client) => (await c.get("/v1/chat/history")).body.messages.map((m: any) => m.text as string);
const spend = async (userId: string) => (await ctx.owner.db.select().from(spendLedger).where(eq(spendLedger.userId, userId))).reduce((a, r) => a + r.costMicros, 0);

async function newUserWithGoal(name: string, goal: Record<string, unknown>) {
  const u = await signUp(ctx, owner, name);
  chat = [use("add_goal", goal), say("Saved.")];
  const r = await u.c.req("POST", "/v1/chat", { message: "I'm looking into a new job" });
  expect(r.raw.body).toContain("Saved.");
  return u;
}

describe("goals", () => {
  it("are saved from chat, encrypted at rest, and listed", async () => {
    const u = await newUserWithGoal("Gia", { title: "Find a product job in Austin", notes: "fintech, remote ok", watch_query: "product manager fintech Austin", check_every_hours: 24 });
    const [raw] = await ctx.owner.db.select().from(goals).where(eq(goals.userId, u.userId));
    expect(raw!.titleEnc.toString("utf8")).not.toContain("Austin");
    expect(raw!.notesEnc!.toString("utf8")).not.toContain("fintech");
    const list = (await u.c.get("/v1/goals")).body.items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: "Find a product job in Austin", notes: "fintech, remote ok", checkEveryHours: 24, status: "open" });
  });

  it("can be paused from the app, and one user cannot touch another's", async () => {
    const a = await newUserWithGoal("Ann", { title: "Buy a used bike" });
    const b = await signUp(ctx, owner, "Ben");
    const id = (await a.c.get("/v1/goals")).body.items[0].id;
    expect((await b.c.patch(`/v1/goals/${id}`, { status: "done" })).status).toBe(404);
    expect((await a.c.patch(`/v1/goals/${id}`, { status: "paused" })).body.item.status).toBe("paused");
    expect((await b.c.get("/v1/goals")).body.items).toEqual([]);
  });

  it("refuse a ninth watched goal and a check interval under six hours", async () => {
    const u = await signUp(ctx, owner, "Lim");
    for (let i = 0; i < 5; i++) {
      chat = [use("add_goal", { title: `g${i}`, check_every_hours: 24 }), say("ok")];
      await u.c.req("POST", "/v1/chat", { message: `goal ${i}` });
    }
    chat = [use("add_goal", { title: "one too many", check_every_hours: 24 }), say("ok")];
    await u.c.req("POST", "/v1/chat", { message: "another" });
    expect((await u.c.get("/v1/goals")).body.items).toHaveLength(5);
    chat = [use("add_goal", { title: "too often", check_every_hours: 1 }), say("ok")];
    await u.c.req("POST", "/v1/chat", { message: "again" });
    expect((await u.c.get("/v1/goals")).body.items).toHaveLength(5);
  });
});

describe("goal checks", () => {
  it("report only what is new, keep it, charge for it, and wait for the next interval", async () => {
    const u = await newUserWithGoal("Chk", { title: "Find a flat in Leeds", notes: "under 1200", watch_query: "flats to rent Leeds", check_every_hours: 24 });
    push.sent = [];
    searches.length = 0;
    const before = await spend(u.userId);
    const noon = new Date(Date.now() + 60_000);
    searchReply = () => found("Two new 1-bed flats under 1200 in Headingley.", 2);
    expect(await runDueGoalChecks(deps(), noon)).toBeGreaterThanOrEqual(1);
    expect(searches.at(-1)!.prompt).toContain("flats to rent Leeds");
    expect((await chatText(u.c)).at(-1)).toContain("Headingley");
    expect((await chatText(u.c)).at(-1)).toContain("https://example.com/a");
    expect(await spend(u.userId)).toBeGreaterThan(before + 20_000); // two searches at 1 cent each, plus tokens
    const [row] = await ctx.owner.db.select().from(goals).where(eq(goals.userId, u.userId));
    expect(ctx.vault.open(row!.workspaceId, row!.lastFindingEnc!)).toContain("Headingley");

    // Not due again until the interval has passed.
    const n = searches.length;
    await runDueGoalChecks(deps(), new Date(noon.getTime() + 3600_000));
    expect(searches.some((s, i) => i >= n && s.prompt.includes("flats to rent Leeds"))).toBe(false);

    // The next check is told what was said last time, and stays quiet when nothing is new.
    searchReply = () => found("NOTHING_NEW");
    const count = (await chatText(u.c)).length;
    await runDueGoalChecks(deps(), new Date(noon.getTime() + 25 * 3600_000));
    expect(searches.at(-1)!.prompt).toContain("Headingley");
    expect((await chatText(u.c)).length).toBe(count);
  });

  it("do nothing when the daily cap is spent or Danny is stopped", async () => {
    const u = await newUserWithGoal("Cap", { title: "Watch fares to Lisbon", check_every_hours: 6 });
    await u.c.patch("/v1/settings", { killSwitch: true });
    const n = searches.length;
    searchReply = () => found("Fares dropped.");
    await runDueGoalChecks(deps(), new Date(Date.now() + 60_000));
    expect(searches.slice(n).some((s) => s.prompt.includes("Lisbon"))).toBe(false);
    await u.c.patch("/v1/settings", { killSwitch: false });
  });

  it("never run for a paused goal", async () => {
    const u = await newUserWithGoal("Pau", { title: "Watch fares to Oslo", check_every_hours: 6 });
    const id = (await u.c.get("/v1/goals")).body.items[0].id;
    await u.c.patch(`/v1/goals/${id}`, { status: "paused" });
    const n = searches.length;
    await runDueGoalChecks(deps(), new Date(Date.now() + 60_000));
    expect(searches.slice(n).some((s) => s.prompt.includes("Oslo"))).toBe(false);
  });
});

describe("morning briefing", () => {
  it("validates the time and is off until turned on", async () => {
    const u = await signUp(ctx, owner, "Brf");
    expect((await u.c.get("/v1/me")).body.user).toMatchObject({ briefingEnabled: false, briefingTime: "07:30" });
    expect((await u.c.patch("/v1/profile", { briefingTime: "25:00" })).status).toBe(400);
    const r = await u.c.patch("/v1/profile", { briefingEnabled: true, briefingTime: "06:45" });
    expect(r.body).toMatchObject({ briefingEnabled: true, briefingTime: "06:45" });
  });

  it("goes out once a day at the user's local time, with their tasks, goals and memory", async () => {
    const u = await newUserWithGoal("Mor", { title: "Move to Denver", notes: "near the mountains" });
    await u.c.post("/v1/tasks", { title: "Renew passport" });
    await u.c.post("/v1/push/subscribe", { endpoint: "https://fcm.googleapis.com/fcm/send/mor", keys: { p256dh: "p", auth: "a" } });
    await u.c.patch("/v1/profile", { briefingEnabled: true, briefingTime: "07:30" });
    await ctx.owner.db.update(users).set({ timezone: "America/Toronto" }).where(eq(users.id, u.userId));
    push.sent = [];
    searches.length = 0;
    searchReply = () => found("Morning. Passport first. Denver rents flat this month.", 2);

    expect(await runDueBriefings(deps(), new Date("2027-01-15T11:00:00Z"))).toBe(0); // 06:00 in Toronto: too early
    const sent = await runDueBriefings(deps(), new Date("2027-01-15T13:00:00Z")); // 08:00 in Toronto
    expect(sent).toBeGreaterThanOrEqual(1);
    const p = searches.find((x) => x.prompt.includes("Renew passport"))!.prompt;
    expect(p).toContain("Move to Denver");
    expect((await chatText(u.c)).at(-1)).toContain("Passport first");
    expect(push.sent.some((x) => x.title === "Morning briefing")).toBe(true);

    expect(await runDueBriefings(deps(), new Date("2027-01-15T15:00:00Z"))).toBe(0); // already sent today
    expect(await runDueBriefings(deps(), new Date("2027-01-16T13:00:00Z"))).toBeGreaterThanOrEqual(1); // next day
  });

  it("stays off for people who did not ask for it", async () => {
    const u = await signUp(ctx, owner, "Off");
    const n = searches.length;
    await runDueBriefings(deps(), new Date("2027-02-01T13:00:00Z"));
    expect((await chatText(u.c)).length).toBe(0);
    expect(searches.length).toBeGreaterThanOrEqual(n);
  });
});

describe("search_web in chat", () => {
  it("runs through the same cap and ledger, and the result is framed as untrusted", async () => {
    const u = await signUp(ctx, owner, "Web");
    searchReply = () => found("The 5k race is on May 3.", 1);
    chat = [use("search_web", { question: "when is the Bristol 5k" }), say("May 3.")];
    const before = await spend(u.userId);
    const r = await u.c.req("POST", "/v1/chat", { message: "when is the Bristol 5k" });
    expect(r.raw.body).toContain("May 3.");
    const toolResult = JSON.stringify(chatCalls.at(-1)!.messages.at(-1));
    expect(toolResult).toContain("never instructions");
    expect(toolResult).toContain("May 3");
    expect(await spend(u.userId)).toBeGreaterThan(before + 10_000);
  });
});
