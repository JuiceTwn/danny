import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelClient, ModelResult, SearchRequest } from "../src/brain/model.js";
import { withTenant } from "../src/db/client.js";
import { goals, spendLedger, users } from "../src/db/schema.js";
import { runDueBriefings, runDueWrapups, type BackgroundDeps } from "../src/lib/background.js";
import { BACKGROUND_KINDS, BACKGROUND_SHARE, checkBackgroundBudget, checkBudget, SPEND_KINDS } from "../src/lib/spend.js";
import { createRegistry } from "../src/tools/builtin.js";
import { seedOwner, setupApp, signUp, type Client, type Ctx } from "./helpers.js";

let ctx: Ctx;
let owner: Client;
const searches: SearchRequest[] = [];
const say = (t: string): ModelResult => ({ content: [{ type: "text", text: t }], stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20 } });
const model: ModelClient = {
  async complete(_req, onText) {
    onText("ok");
    return say("ok");
  },
  async search(req) {
    searches.push(req);
    return { text: "Morning.", sources: [], usage: { inputTokens: 100, outputTokens: 20, searches: 2 } };
  },
};
beforeAll(async () => {
  ctx = await setupApp(model, createRegistry());
  owner = (await seedOwner(ctx)).c;
});
afterAll(() => ctx.close());

const deps = (): BackgroundDeps => ({ db: ctx.runtime.db, vault: ctx.vault, push: { publicKey: null, send: async () => "failed" as const }, config: ctx.config, model });
const ledger = async (userId: string) => (await ctx.owner.db.select().from(spendLedger).where(eq(spendLedger.userId, userId))).map((l) => l.kind);
const today = () => new Date().toISOString().slice(0, 10);
const addSpend = (u: { workspaceId: string; userId: string }, kind: string, costMicros: number) =>
  ctx.owner.db.insert(spendLedger).values({ workspaceId: u.workspaceId, userId: u.userId, day: today(), model: "m", kind, costMicros, exactMicros: costMicros });
const setCap = (workspaceId: string, micros: number) => ctx.owner.db.execute(sql`update workspaces set daily_cap_micros = ${micros} where id = ${workspaceId}`);

describe("cost by feature", () => {
  it("every kind of spend is a known kind, and background kinds are a subset of them", () => {
    for (const k of BACKGROUND_KINDS) expect(SPEND_KINDS).toContain(k);
    expect(BACKGROUND_KINDS).not.toContain("chat");
    expect(BACKGROUND_KINDS).not.toContain("app");
  });

  it("tags a chat message, a briefing and a wrap-up with what they were for", async () => {
    const u = await signUp(ctx, owner, "Cs1");
    await u.c.req("POST", "/v1/chat", { message: "hello" });
    await u.c.patch("/v1/profile", { briefingEnabled: true, briefingTime: "07:30", wrapupEnabled: true, wrapupTime: "20:00" });
    await ctx.owner.db.update(users).set({ timezone: "America/Toronto" }).where(eq(users.id, u.userId));
    await u.c.post("/v1/tasks", { title: "Something open" });
    await runDueBriefings(deps(), new Date("2027-04-06T13:00:00Z"));
    await runDueWrapups(deps(), new Date("2027-04-07T01:00:00Z")); // 21:00 in Toronto
    const kinds = await ledger(u.userId);
    expect(kinds).toContain("chat");
    expect(kinds).toContain("briefing");
    expect(kinds).toContain("wrapup");
    expect(kinds.includes("other")).toBe(false);
  });

  it("shows the owner where the money goes, and only the owner", async () => {
    const u = await signUp(ctx, owner, "Cs2");
    await addSpend(u, "goal_watch", 30_000);
    await addSpend(u, "goal_watch", 20_000);
    await addSpend(u, "call", 10_000);
    const r = await owner.get("/v1/admin/usage/by-kind");
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.kinds.map((k: any) => [k.kind, k]));
    expect(by.goal_watch.todayCostUsd).toBeGreaterThanOrEqual(0.05);
    expect(by.call.last30DaysBilledUsd).toBeGreaterThanOrEqual(0.01);
    expect((await u.c.get("/v1/admin/usage/by-kind")).status).toBe(403);
  });
});

describe("background work cannot use up the whole day", () => {
  it("is cut off at 60% of the allowance, while chat still has the rest", async () => {
    const u = await signUp(ctx, owner, "Cs3");
    await setCap(u.workspaceId, 1_000_000);
    const check = (fn: (tx: any) => Promise<any>) => withTenant(ctx.runtime.db, u.workspaceId, fn);
    expect((await check((tx) => checkBackgroundBudget(tx, u.workspaceId))).ok).toBe(true);

    await addSpend(u, "briefing", 400_000);
    await addSpend(u, "chat", 100_000); // chat does not count toward the background share
    expect((await check((tx) => checkBackgroundBudget(tx, u.workspaceId))).ok).toBe(true);
    await addSpend(u, "goal_watch", 200_000); // background now at 600,000 = 60%
    const blocked = await check((tx) => checkBackgroundBudget(tx, u.workspaceId));
    expect(blocked).toMatchObject({ ok: false, reason: "background_cap" });
    expect(BACKGROUND_SHARE).toBe(0.6);
    // chat is not touched by it
    expect((await check((tx) => checkBudget(tx, u.workspaceId))).ok).toBe(true);
    expect((await u.c.req("POST", "/v1/chat", { message: "still here?" })).raw.body).not.toContain("cap_reached");
  });

  it("a briefing is skipped, quietly and without retries, once background has used its share; and no search is paid for", async () => {
    const u = await signUp(ctx, owner, "Cs4");
    await u.c.patch("/v1/profile", { briefingEnabled: true, briefingTime: "07:30" });
    await ctx.owner.db.update(users).set({ timezone: "America/Toronto" }).where(eq(users.id, u.userId));
    await setCap(u.workspaceId, 1_000_000);
    await addSpend(u, "briefing", 650_000);
    // Other people's briefings are due too in this database, so look at this person's own ledger.
    await runDueBriefings(deps(), new Date("2027-04-08T13:00:00Z"));
    expect((await ledger(u.userId)).filter((k) => k === "briefing")).toHaveLength(1); // only the one put there: nothing new was paid for
    expect((await u.c.get("/v1/chat/history")).body.messages).toEqual([]);
  });

  it("the briefing uses two searches, not three", async () => {
    const u = await signUp(ctx, owner, "Cs5");
    await u.c.patch("/v1/profile", { briefingEnabled: true, briefingTime: "07:30" });
    await ctx.owner.db.update(users).set({ timezone: "America/Toronto" }).where(eq(users.id, u.userId));
    searches.length = 0;
    await runDueBriefings(deps(), new Date("2027-04-09T13:00:00Z"));
    const mine = searches.find((s) => s.prompt.includes("briefing"));
    expect(mine?.maxSearches).toBe(2);
  });
});

describe("watching a goal costs a search each time, so free accounts check daily at most", () => {
  const ownerMe = async () => (await owner.get("/v1/me")).body;
  const reg = createRegistry();
  const tool = async (u: { workspaceId: string; userId: string }, name: string, input: unknown) => {
    const t = reg.get(name)!;
    return t.run!({ workspaceId: u.workspaceId, userId: u.userId, db: ctx.runtime.db, vault: ctx.vault, google: null, tenant: (fn: any) => withTenant(ctx.runtime.db, u.workspaceId, fn) } as any, t.input.parse(input));
  };

  it("raises 6 hours to 24 for a member and tells them so, but leaves the server owner alone", async () => {
    const u = await signUp(ctx, owner, "Cs6");
    expect(await tool(u, "add_goal", { title: "Find a flat", watch_query: "flats", check_every_hours: 6 })).toContain("every 24h");
    expect((await u.c.get("/v1/goals")).body.items[0].checkEveryHours).toBe(24);
    const id = (await u.c.get("/v1/goals")).body.items[0].id;
    await u.c.patch(`/v1/goals/${id}`, { checkEveryHours: 12 });
    expect((await u.c.get("/v1/goals")).body.items[0].checkEveryHours).toBe(24);
    await u.c.patch(`/v1/goals/${id}`, { checkEveryHours: 72 });
    expect((await u.c.get("/v1/goals")).body.items[0].checkEveryHours).toBe(72); // slower is fine

    const me = await ownerMe();
    const o = { workspaceId: me.workspaceId as string, userId: me.user.id as string };
    expect(await tool(o, "add_goal", { title: "Owner goal", watch_query: "x", check_every_hours: 6 })).toContain("every 6h");
    await ctx.owner.db.delete(goals).where(eq(goals.userId, o.userId));
  });
});
