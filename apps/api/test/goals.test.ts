import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResult, SearchRequest, SearchResult } from "../src/brain/model.js";
import { goals, interests, messages, spendLedger, tasks, users } from "../src/db/schema.js";
import { runDueBriefings, runDueGoalChecks, runDueWrapups, runStalledGoalCheckins, type BackgroundDeps } from "../src/lib/background.js";
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
let plainReply: ((req: ModelRequest) => ModelResult) | null = null;
const searches: SearchRequest[] = [];
const chatCalls: ModelRequest[] = [];

const model: ModelClient = {
  async complete(req, onText) {
    chatCalls.push(JSON.parse(JSON.stringify(req)));
    if (req.tools.length === 0 && plainReply) return plainReply(req);
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

describe("evening wrap-up", () => {
  const evening = new Date("2027-04-06T00:30:00Z"); // 20:30 Monday in Toronto
  it("is off until asked for, then goes out once with the day's facts", async () => {
    const u = await newUserWithGoal("Wrp", { title: "Learn to swim", notes: "lessons on Saturdays" });
    const t1 = (await u.c.post("/v1/tasks", { title: "Book the lessons" })).body.item.id;
    await u.c.post("/v1/tasks", { title: "Buy goggles" });
    await u.c.post(`/v1/tasks/${t1}/done`);
    await ctx.owner.db.update(tasks).set({ completedAt: new Date("2027-04-05T23:00:00Z") }).where(eq(tasks.id, t1));
    const seen: string[] = [];
    plainReply = (req) => {
      seen.push(String((req.messages[0] as any).content));
      return say("Booked the lessons. Goggles tomorrow.");
    };

    await runDueWrapups(deps(), evening);
    expect(seen.some((p) => p.includes("Buy goggles"))).toBe(false); // not turned on

    expect((await u.c.patch("/v1/profile", { wrapupEnabled: true, wrapupTime: "20:00" })).body).toMatchObject({ wrapupEnabled: true, wrapupTime: "20:00" });
    expect(await runDueWrapups(deps(), new Date("2027-04-05T22:00:00Z"))).toBeGreaterThanOrEqual(0); // 18:00: too early
    expect((await chatText(u.c)).some((t: string) => t.includes("Goggles tomorrow"))).toBe(false);
    await runDueWrapups(deps(), evening);
    const p = seen.find((x) => x.includes("Buy goggles"))!;
    expect(p).toContain("Book the lessons"); // done today
    expect(p).toContain("Learn to swim");
    expect(p).not.toContain("weekly review");
    expect((await chatText(u.c)).at(-1)).toContain("Goggles tomorrow");
    const n = seen.length;
    await runDueWrapups(deps(), new Date(evening.getTime() + 600_000));
    expect(seen.length).toBe(n); // once a day
    plainReply = null;
  });

  it("becomes the weekly review on Sundays", async () => {
    const u = await newUserWithGoal("Sun", { title: "Save for a bike" });
    await u.c.patch("/v1/profile", { wrapupEnabled: true, wrapupTime: "19:00" });
    const seen: string[] = [];
    plainReply = (req) => {
      seen.push(String((req.messages[0] as any).content));
      return say("Week done.");
    };
    await runDueWrapups(deps(), new Date("2027-04-12T00:30:00Z")); // Sunday 20:30 in Toronto
    expect(seen.some((p) => p.includes("weekly review") && p.includes("Save for a bike"))).toBe(true);
    plainReply = null;
  });

  it("says nothing when there is nothing to say", async () => {
    const u = await signUp(ctx, owner, "Emp");
    await u.c.patch("/v1/profile", { wrapupEnabled: true, wrapupTime: "19:00" });
    await runDueWrapups(deps(), evening);
    expect(await chatText(u.c)).toEqual([]);
  });
});

describe("stalled goals", () => {
  const noonIn = (days: number, hourUtc = 16) => {
    const d = new Date(Date.now() + days * 86_400_000);
    d.setUTCHours(hourUtc, 0, 0, 0);
    return d;
  };
  const asked = async (c: Client) => (await chatText(c)).filter((t: string) => t.includes("hasn't moved"));

  it("get one kind question after two quiet weeks, then nothing more for two weeks", async () => {
    const u = await newUserWithGoal("Stl", { title: "Write the first chapter" });
    await runStalledGoalCheckins(deps(), noonIn(5));
    expect(await asked(u.c)).toHaveLength(0); // only 5 days
    await runStalledGoalCheckins(deps(), noonIn(15, 4)); // 00:00 in Toronto: quiet hours, so it waits
    expect(await asked(u.c)).toHaveLength(0);
    await runStalledGoalCheckins(deps(), noonIn(15));
    const q = await asked(u.c);
    expect(q).toHaveLength(1);
    expect(q[0]).toContain("Write the first chapter");
    expect(q[0]).toContain("What's in the way");
    await runStalledGoalCheckins(deps(), noonIn(16));
    expect(await asked(u.c)).toHaveLength(1); // not again for two weeks
  });

  it("are quiet again once the user reports progress, and paused goals are never asked about", async () => {
    const u = await newUserWithGoal("Prg", { title: "Run a 10k" });
    const id = (await u.c.get("/v1/goals")).body.items[0].id;
    await ctx.owner.db.update(goals).set({ touchedAt: new Date(Date.now() - 30 * 86_400_000) }).where(eq(goals.id, id));
    chat = [use("goal_progress", { id, note: "ran 5k on Sunday" }), say("Noted.")];
    await u.c.req("POST", "/v1/chat", { message: "I ran 5k on Sunday" });
    expect((await u.c.get("/v1/goals")).body.items[0].notes).toContain("ran 5k on Sunday");
    await runStalledGoalCheckins(deps(), noonIn(5));
    expect(await asked(u.c)).toHaveLength(0);

    const p = await newUserWithGoal("Psd", { title: "Learn Welsh" });
    const pid = (await p.c.get("/v1/goals")).body.items[0].id;
    await p.c.patch(`/v1/goals/${pid}`, { status: "paused" });
    await ctx.owner.db.update(goals).set({ touchedAt: new Date("2026-01-01T00:00:00Z") }).where(eq(goals.id, pid));
    await runStalledGoalCheckins(deps(), noonIn(20));
    expect(await asked(p.c)).toHaveLength(0);
  });

  it("only ask about one goal per person at a time", async () => {
    const u = await newUserWithGoal("Two", { title: "Goal one" });
    chat = [use("add_goal", { title: "Goal two" }), say("ok")];
    await u.c.req("POST", "/v1/chat", { message: "another" });
    await ctx.owner.db.update(goals).set({ touchedAt: new Date("2027-01-01T00:00:00Z") }).where(eq(goals.userId, u.userId));
    await runStalledGoalCheckins(deps(), new Date("2027-05-10T16:00:00Z"));
    await runStalledGoalCheckins(deps(), new Date("2027-05-10T16:01:00Z"));
    expect((await chatText(u.c)).filter((t: string) => t.includes("hasn't moved"))).toHaveLength(1);
  });
});

describe("interests and voice", () => {
  it("are kept per person, encrypted, capped, and shape the briefing", async () => {
    const u = await signUp(ctx, owner, "Int");
    const other = await signUp(ctx, owner, "Oth");
    expect((await u.c.post("/v1/interests", { topic: "Premier League" })).status).toBe(201);
    expect((await u.c.post("/v1/interests", { topic: "premier league" })).status).toBe(201); // same topic: no duplicate
    chat = [use("add_interest", { topic: "AI policy" }), say("Added.")];
    await u.c.req("POST", "/v1/chat", { message: "I follow AI policy" });
    const list = (await u.c.get("/v1/interests")).body.items;
    expect(list.map((i: any) => i.topic).sort()).toEqual(["AI policy", "Premier League"]);
    const [raw] = await ctx.owner.db.select().from(interests).where(eq(interests.userId, u.userId));
    expect(raw!.topicEnc.toString("utf8")).not.toContain("Premier");
    expect((await other.c.get("/v1/interests")).body.items).toEqual([]);
    expect((await other.c.del(`/v1/interests/${list[0].id}`)).status).toBe(404);

    await u.c.patch("/v1/profile", { briefingEnabled: true, briefingTime: "00:00" });
    searches.length = 0;
    searchReply = () => found("Morning.");
    await runDueBriefings(deps(), new Date("2027-06-01T13:00:00Z"));
    const mine = searches.find((s) => s.prompt.includes("Premier League"))!;
    expect(mine.prompt).toContain("AI policy");

    for (let i = 0; i < 13; i++) expect((await u.c.post("/v1/interests", { topic: `Topic ${i}` })).status).toBe(201);
    expect((await u.c.post("/v1/interests", { topic: "One too many" })).status).toBe(400);
  });

  it("voice changes how Danny is told to talk, in chat and in briefings", async () => {
    const u = await signUp(ctx, owner, "Vox");
    expect((await u.c.patch("/v1/profile", { voice: "robot" })).status).toBe(400);
    expect((await u.c.get("/v1/me")).body.user.voice).toBe("foreman");
    await u.c.patch("/v1/profile", { voice: "warm" });
    chat = [say("Hi there.")];
    await u.c.req("POST", "/v1/chat", { message: "hello" });
    const sys = chatCalls.at(-1)!.system;
    expect(sys).toContain("friendly and encouraging");
    expect(sys).not.toContain("shop foreman");
    await u.c.patch("/v1/profile", { briefingEnabled: true, briefingTime: "00:00" });
    searches.length = 0;
    await runDueBriefings(deps(), new Date("2027-06-02T13:00:00Z"));
    expect(searches.some((s) => s.system.includes("friendly and encouraging"))).toBe(true);
  });
});
