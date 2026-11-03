import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelClient, ModelResult, SearchRequest, SearchResult } from "../src/brain/model.js";
import { withTenant } from "../src/db/client.js";
import { auditLog, tipsSent, users } from "../src/db/schema.js";
import { runDueBriefings, type BackgroundDeps } from "../src/lib/background.js";
import type { PushPayload, PushSender, PushSub } from "../src/lib/push.js";
import { runTips, TIPS } from "../src/lib/tips.js";
import { createRegistry } from "../src/tools/builtin.js";
import type { ToolCtx } from "../src/tools/registry.js";
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
const searches: SearchRequest[] = [];
const model: ModelClient = {
  async complete(_req, onText) {
    onText("ok");
    return { content: [{ type: "text", text: "Morning." }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } } as ModelResult;
  },
  async search(req): Promise<SearchResult> {
    searches.push(req);
    return { text: "Morning. Here is your day.", sources: [], usage: { inputTokens: 1, outputTokens: 1 } };
  },
};
beforeAll(async () => {
  ctx = await setupApp(model, createRegistry(), {}, push);
  owner = (await seedOwner(ctx)).c;
});
afterAll(() => ctx.close());

const deps = (): BackgroundDeps => ({ db: ctx.runtime.db, vault: ctx.vault, push, config: ctx.config, model });
type U = Awaited<ReturnType<typeof signUp>>;
const reg = createRegistry();
const toolCtx = (u: U): ToolCtx => ({ card: () => {}, workspaceId: u.workspaceId, userId: u.userId, db: ctx.runtime.db, vault: ctx.vault, google: null, tenant: (fn) => withTenant(ctx.runtime.db, u.workspaceId, fn) });
const run = (u: U, tool: string, input: unknown) => reg.get(tool)!.run!(toolCtx(u), reg.get(tool)!.input.parse(input));
const history = async (c: Client): Promise<{ role: string; text: string; cards: any[] }[]> => (await c.get("/v1/chat/history")).body.messages;
const audit = async (userId: string) => (await ctx.owner.db.select().from(auditLog).where(eq(auditLog.userId, userId))).map((a) => `${a.action}:${JSON.stringify(a.detail)}`);

describe("a new account", () => {
  it("starts with the brief and event heads-ups already on, a welcome in the chat, and suggestions allowed", async () => {
    const u = await signUp(ctx, owner, "Newbie Jones", { fresh: true });
    expect((await u.c.get("/v1/me")).body.user).toMatchObject({ briefingEnabled: true, briefingTime: "07:30", eventPrep: true, tips: true, wrapupEnabled: false });
    const h = await history(u.c);
    expect(h).toHaveLength(1);
    expect(h[0]!.role).toBe("assistant");
    expect(h[0]!.text).toContain("Hi Newbie.");
    expect(h[0]!.text).toContain("morning brief is already on for 7:30");
    expect(h[0]!.cards).toEqual([{ kind: "replies", options: ["Set up my morning brief", "What can you do?"] }]);
  });

  it("gets no empty 'good morning': the first brief waits until there is something to say, then goes out", async () => {
    const u = await signUp(ctx, owner, "Quiet", { fresh: true });
    await ctx.owner.db.update(users).set({ briefingEnabled: false }).where(and(eq(users.briefingEnabled, true)));
    await ctx.owner.db.update(users).set({ briefingEnabled: true, timezone: "America/Toronto" }).where(eq(users.id, u.userId));
    searches.length = 0;
    await runDueBriefings(deps(), new Date("2027-06-01T12:00:00Z")); // 08:00 in Toronto, nothing told yet
    expect(searches).toHaveLength(0);
    expect(await audit(u.userId)).toContain('briefing.skip:{"reason":"empty"}');
    expect(await history(u.c)).toHaveLength(1); // just the welcome

    await run(u, "change_setting", { setting: "location", place: "Toronto" });
    await runDueBriefings(deps(), new Date("2027-06-02T12:00:00Z"));
    expect(searches.length).toBeGreaterThan(0);
    expect((await history(u.c)).at(-1)!.text).toContain("Here is your day");
  });

  it("does not change anyone who already had an account", async () => {
    const u = await signUp(ctx, owner, "Old"); // the helper's plain account, like one made before this change
    expect((await u.c.get("/v1/me")).body.user).toMatchObject({ briefingEnabled: false, eventPrep: false });
  });
});

describe("changing things by asking", () => {
  it("switches settings from chat, with a clear answer, and keeps a record", async () => {
    const u = await signUp(ctx, owner, "Ask");
    expect(await run(u, "change_setting", { setting: "briefing", on: true })).toBe("Morning brief is on.");
    expect(await run(u, "change_setting", { setting: "briefing_time", time: "06:45" })).toBe("Morning brief at 06:45.");
    expect(await run(u, "change_setting", { setting: "wrapup", on: true })).toContain("Evening wrap-up is on");
    expect(await run(u, "change_setting", { setting: "event_heads_ups", on: true })).toContain("on");
    expect(await run(u, "change_setting", { setting: "good_news", on: true })).toContain("good news");
    expect(await run(u, "change_setting", { setting: "news_items", count: 2 })).toBe("The brief carries up to 2 news stories.");
    expect(await run(u, "change_setting", { setting: "news_items", count: 0 })).toBe("No news in the brief.");
    expect((await u.c.get("/v1/me")).body.user).toMatchObject({ briefingEnabled: true, briefingTime: "06:45", wrapupEnabled: true, eventPrep: true, goodNews: true, newsItems: 0 });
    expect((await u.c.get("/v1/style")).body.location).toBeNull();
    expect(await run(u, "change_setting", { setting: "location", place: "Leeds, UK" })).toContain("Leeds, UK");
    expect((await u.c.get("/v1/style")).body.location).toBe("Leeds, UK");
    expect((await audit(u.userId)).filter((a) => a.includes('"via":"chat"')).length).toBe(7); // every change but the city, which is saved as a note about them
  });

  it("says what is missing instead of guessing, and rejects a bad time", async () => {
    const u = await signUp(ctx, owner, "Bad");
    expect(await run(u, "change_setting", { setting: "briefing" })).toContain("needs on");
    expect(() => reg.get("change_setting")!.input.parse({ setting: "briefing_time", time: "7am" })).toThrow();
    expect(() => reg.get("change_setting")!.input.parse({ setting: "news_items", count: 9 })).toThrow();
    expect((await u.c.get("/v1/me")).body.user.briefingEnabled).toBe(false);
  });

  it("only touches the person who asked", async () => {
    const a = await signUp(ctx, owner, "Aa");
    const b = await signUp(ctx, owner, "Bb");
    await run(a, "change_setting", { setting: "wrapup", on: true });
    expect((await b.c.get("/v1/me")).body.user.wrapupEnabled).toBe(false);
  });
});

describe("btw suggestions", () => {
  const DAY1 = "2027-06-10T16:00:00Z"; // 12:00 in Toronto
  const at = (days: number, hourUtc = 16) => new Date(new Date(DAY1).getTime() + days * 86_400_000 + (hourUtc - 16) * 3_600_000);
  const person = async (name: string) => {
    const u = await signUp(ctx, owner, name);
    await ctx.owner.db.update(users).set({ timezone: "America/Toronto" }).where(eq(users.id, u.userId));
    // Only this person is due, so counts below are theirs alone.
    await ctx.owner.db.update(users).set({ tips: false }).where(and(eq(users.tips, true)));
    await ctx.owner.db.update(users).set({ tips: true }).where(eq(users.id, u.userId));
    return u;
  };
  const tipsIn = async (u: U) => (await history(u.c)).filter((m) => m.text.startsWith("btw"));

  it("one at a time, in order, each once, no more than every 3 days, without a buzz", async () => {
    const u = await person("Tp1");
    push.sent = [];
    await u.c.post("/v1/push/subscribe", { endpoint: "https://fcm.googleapis.com/fcm/send/tp1", keys: { p256dh: "p", auth: "a" } });
    expect(await runTips(deps(), at(0))).toBe(1);
    let t = await tipsIn(u);
    expect(t).toHaveLength(1);
    expect(t[0]!.text).toContain("what city you're in");
    expect(t[0]!.text).toContain("stop the tips");
    expect(push.sent).toHaveLength(0);

    expect(await runTips(deps(), at(1))).toBe(0); // too soon
    expect(await runTips(deps(), at(3))).toBe(1);
    t = await tipsIn(u);
    expect(t[1]!.text).toContain("news and scores");
    expect(t[1]!.cards).toEqual([{ kind: "replies", options: ["Add a good news story", "Tech news", "Follow a team"] }]);
    expect(t[0]!.text).not.toBe(t[1]!.text);
  });

  it("skips what they already do, never repeats, and runs out", async () => {
    const u = await person("Tp2");
    await run(u, "change_setting", { setting: "location", place: "Ottawa" });
    await run(u, "add_interest", { topic: "tech" });
    await run(u, "change_setting", { setting: "wrapup", on: true });
    await u.c.post("/v1/push/subscribe", { endpoint: "https://fcm.googleapis.com/fcm/send/tp2", keys: { p256dh: "p", auth: "a" } });
    await run(u, "add_goal", { title: "Buy a bike" });
    // Location, topics, wrap-up, notifications and a goal are all done; Google is not configured on this server, so nothing is left to say.
    expect(await runTips(deps(), at(0))).toBe(0);
    expect(await tipsIn(u)).toHaveLength(0);
  });

  it("each suggestion is said once across the whole run", async () => {
    const u = await person("Tp3");
    for (let d = 0; d < 20; d += 3) await runTips(deps(), at(d));
    const keys = (await ctx.owner.db.select().from(tipsSent).where(eq(tipsSent.userId, u.userId))).map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeLessThanOrEqual(TIPS.length);
    expect(await tipsIn(u)).toHaveLength(keys.length);
  });

  it("not on day one, not at night, and not when they said stop", async () => {
    const u = await person("Tp4");
    const justNow = new Date();
    expect(await runTips(deps(), new Date(justNow.getTime()))).toBe(0); // account is minutes old
    expect(await runTips(deps(), at(0, 3))).toBe(0); // 23:00 in Toronto
    expect(await run(u, "change_setting", { setting: "tips", on: false })).toBe("No more suggestions from me.");
    expect(await runTips(deps(), at(0))).toBe(0);
    expect((await u.c.get("/v1/me")).body.user.tips).toBe(false);
    expect((await u.c.patch("/v1/profile", { tips: true })).body.tips).toBe(true);
    expect(await runTips(deps(), at(0))).toBe(1);
  });

  it("does not suggest notifications when the server cannot send them", async () => {
    const u = await person("Tp5");
    await run(u, "change_setting", { setting: "location", place: "Ottawa" });
    await run(u, "add_interest", { topic: "tech" });
    await run(u, "change_setting", { setting: "wrapup", on: true });
    const quiet: PushSender = { publicKey: null, send: async () => "failed" as const };
    expect(await runTips({ ...deps(), push: quiet }, at(0))).toBe(1); // goals is next, not push
    expect((await tipsIn(u))[0]!.text).toContain("working toward something");
  });
});
