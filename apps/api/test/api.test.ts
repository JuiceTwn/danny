import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../src/db/client.js";
import { approvals, auditLog, memory, workspaces } from "../src/db/schema.js";
import { checkBudget, recordSpend } from "../src/lib/spend.js";
import { PASSWORD, client, seedOwner, setupApp, signUp, uniqueEmail, ORIGIN, type Client, type Ctx } from "./helpers.js";

let ctx: Ctx;
let owner: Client;
beforeAll(async () => {
  ctx = await setupApp();
  owner = (await seedOwner(ctx)).c;
});
afterAll(() => ctx.close());

describe("access", () => {
  it("health check is public", async () => {
    expect((await client(ctx).get("/healthz")).body).toEqual({ ok: true });
  });

  it("everything else needs a session", async () => {
    const c = client(ctx);
    for (const url of ["/v1/me", "/v1/memory", "/v1/approvals", "/v1/settings", "/v1/admin/usage"]) {
      expect((await c.get(url)).status, url).toBe(401);
    }
  });

  it("refuses state-changing requests from other origins or with no origin", async () => {
    const c = client(ctx);
    expect((await c.req("POST", "/v1/auth/login", {}, { origin: "http://evil.test" })).status).toBe(403);
    const res = await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: {} });
    expect(res.statusCode).toBe(403);
  });

  it("login gives the same answer for a wrong password and an unknown email", async () => {
    const { email } = await seedOwner(ctx);
    const a = await client(ctx).post("/v1/auth/login", { email, password: "wrong wrong wrong" });
    const b = await client(ctx).post("/v1/auth/login", { email: uniqueEmail("nobody"), password: "wrong wrong wrong" });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
  });

  it("sets an HttpOnly, SameSite=Lax cookie and logout ends the session", async () => {
    const { c, email } = await seedOwner(ctx);
    const again = client(ctx);
    const res = await again.post("/v1/auth/login", { email, password: PASSWORD });
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect((await again.get("/v1/me")).status).toBe(200);
    await again.post("/v1/auth/logout");
    expect((await client(ctx, again.cookie).get("/v1/me")).status).toBe(401);
    expect((await c.get("/v1/me")).status).toBe(200); // other sessions untouched
  });
});

describe("invite-only signup", () => {
  it("rejects a made-up invite token", async () => {
    const res = await client(ctx).post("/v1/auth/accept-invite", { token: "x".repeat(40), password: PASSWORD });
    expect(res.status).toBe(400);
  });

  it("an invite works once and makes a personal workspace", async () => {
    const email = uniqueEmail("once");
    const inv = await owner.post("/v1/admin/invites", { email });
    const token = new URL(inv.body.inviteUrl).searchParams.get("token");
    const first = client(ctx);
    expect((await first.post("/v1/auth/accept-invite", { token, password: PASSWORD, name: "Once" })).status).toBe(201);
    const me = await first.get("/v1/me");
    expect(me.body.user.email).toBe(email);
    expect(me.body.role).toBe("admin");
    expect(me.body.isOwner).toBe(false);
    expect((await client(ctx).post("/v1/auth/accept-invite", { token, password: PASSWORD })).status).toBe(400);
  });

  it("refuses short passwords", async () => {
    const inv = await owner.post("/v1/admin/invites", { email: uniqueEmail("short") });
    const token = new URL(inv.body.inviteUrl).searchParams.get("token");
    expect((await client(ctx).post("/v1/auth/accept-invite", { token, password: "short" })).status).toBe(400);
  });

  it("the public form takes requests from the marketing site and the owner approves them", async () => {
    const email = uniqueEmail("ask");
    const res = await ctx.app.inject({ method: "POST", url: "/v1/invite-requests", headers: { origin: "http://www.test" }, payload: { email } });
    expect(res.statusCode).toBe(202);
    expect(res.headers["access-control-allow-origin"]).toBe("http://www.test");
    const dupe = await ctx.app.inject({ method: "POST", url: "/v1/invite-requests", payload: { email } });
    expect(dupe.statusCode).toBe(202);
    const list = await owner.get("/v1/admin/invite-requests");
    const mine = list.body.items.find((r: any) => r.email === email);
    expect(mine.status).toBe("pending");
    const approved = await owner.post(`/v1/admin/invite-requests/${mine.id}/approve`);
    expect(approved.body.inviteUrl).toContain("/accept?token=");
  });

  it("the owner sees the total and can download the whole list as a CSV; nobody else can", async () => {
    const email = uniqueEmail("csv");
    await ctx.app.inject({ method: "POST", url: "/v1/invite-requests", payload: { email } });
    const list = await owner.get("/v1/admin/invite-requests");
    expect(list.body.total).toBeGreaterThanOrEqual(1);
    const csv = await owner.get("/v1/admin/invite-requests.csv");
    expect(csv.status).toBe(200);
    expect(String(csv.headers["content-type"])).toContain("text/csv");
    expect(String(csv.headers["content-disposition"])).toContain("attachment");
    const lines = csv.raw.body.split("\r\n");
    expect(lines[0]).toBe("email,signed_up_at,status");
    expect(lines.some((l: string) => l.startsWith(`"${email}",`))).toBe(true);
    const user = await signUp(ctx, owner, "NotOwner");
    expect((await user.c.get("/v1/admin/invite-requests.csv")).status).toBe(403);
    expect((await client(ctx).get("/v1/admin/invite-requests.csv")).status).toBe(401);
  });

  it("only the owner can invite", async () => {
    const user = await signUp(ctx, owner, "Plain");
    expect((await user.c.post("/v1/admin/invites", { email: uniqueEmail("x") })).status).toBe(403);
    expect((await user.c.get("/v1/admin/usage")).status).toBe(403);
  });
});

describe("memory", () => {
  it("remembers, lists and really forgets", async () => {
    const u = await signUp(ctx, owner, "Mem");
    const add = await u.c.post("/v1/memory", { content: "Marlene prefers texts" });
    expect(add.status).toBe(201);
    expect((await u.c.get("/v1/memory")).body.items).toHaveLength(1);
    expect((await u.c.del(`/v1/memory/${add.body.item.id}`)).status).toBe(200);
    expect((await u.c.get("/v1/memory")).body.items).toHaveLength(0);
    const left = await ctx.owner.db.select().from(memory).where(eq(memory.id, add.body.item.id));
    expect(left).toHaveLength(0); // gone from the table, not just hidden
  });

  it("validates input", async () => {
    const u = await signUp(ctx, owner, "Val");
    expect((await u.c.post("/v1/memory", { content: "" })).status).toBe(400);
    expect((await u.c.del("/v1/memory/not-a-uuid")).status).toBe(400);
  });
});

describe("approvals are recorded, never executed", () => {
  it("decides once and says nothing was sent", async () => {
    const u = await signUp(ctx, owner, "Appr");
    const made = await u.c.post("/v1/approvals", { kind: "email", title: "Reply to Marlene", payload: { body: "Hi" } });
    expect(made.body.item.status).toBe("pending");
    const done = await u.c.post(`/v1/approvals/${made.body.item.id}/decision`, { decision: "approve" });
    expect(done.body.item.status).toBe("approved");
    expect(done.body.item.executed).toBe(false);
    expect(done.body.note).toMatch(/nothing has been sent/i);
    expect((await u.c.post(`/v1/approvals/${made.body.item.id}/decision`, { decision: "drop" })).status).toBe(409);
    const [row] = await ctx.owner.db.select().from(approvals).where(eq(approvals.id, made.body.item.id));
    expect(row!.executedAt).toBeNull();
  });
});

describe("tenant isolation", () => {
  it("user A cannot read, change or delete user B's data through the API", async () => {
    const a = await signUp(ctx, owner, "Alice");
    const b = await signUp(ctx, owner, "Bob");
    const mem = await a.c.post("/v1/memory", { content: "Alice's secret" });
    const appr = await a.c.post("/v1/approvals", { kind: "email", title: "Alice's draft" });

    expect((await b.c.get("/v1/memory")).body.items).toHaveLength(0);
    expect((await b.c.get("/v1/approvals")).body.items).toHaveLength(0);
    expect((await b.c.del(`/v1/memory/${mem.body.item.id}`)).status).toBe(404);
    expect((await b.c.post(`/v1/approvals/${appr.body.item.id}/decision`, { decision: "approve" })).status).toBe(409);

    // Alice's data is untouched.
    expect((await a.c.get("/v1/memory")).body.items).toHaveLength(1);
    expect((await a.c.get("/v1/approvals?status=pending")).body.items).toHaveLength(1);
  });

  it("the database refuses cross-tenant access even when a query has no filter", async () => {
    const a = await signUp(ctx, owner, "RlsA");
    const b = await signUp(ctx, owner, "RlsB");
    await a.c.post("/v1/memory", { content: "A only" });
    await b.c.post("/v1/memory", { content: "B only" });

    // Unfiltered select as B sees only B.
    const asB = await withTenant(ctx.runtime.db, b.workspaceId, (tx) => tx.select().from(memory));
    expect(asB.map((r) => ctx.vault.open(b.workspaceId, r.contentEnc))).toEqual(["B only"]);
    // No workspace context at all: nothing.
    expect(await ctx.runtime.db.select().from(memory)).toHaveLength(0);
    // Writing a row into someone else's workspace is rejected by the policy.
    await expect(
      withTenant(ctx.runtime.db, b.workspaceId, (tx) => tx.insert(memory).values({ workspaceId: a.workspaceId, userId: b.userId, contentEnc: ctx.vault.seal(a.workspaceId, "planted") })),
    ).rejects.toThrow();
    // Updating A's rows from B's context touches nothing.
    const hit = await withTenant(ctx.runtime.db, b.workspaceId, (tx) => tx.update(memory).set({ contentEnc: ctx.vault.seal(b.workspaceId, "hacked") }).returning());
    expect(hit.map((r) => ctx.vault.open(b.workspaceId, r.contentEnc))).toEqual(["hacked"]); // B's own row only
    const aStill = await withTenant(ctx.runtime.db, a.workspaceId, (tx) => tx.select().from(memory));
    expect(aStill.map((r) => ctx.vault.open(a.workspaceId, r.contentEnc))).toEqual(["A only"]);
  });

  it("the audit log can be added to but never edited or deleted by the app", async () => {
    const u = await signUp(ctx, owner, "Audit");
    await u.c.post("/v1/memory", { content: "x" });
    const rows = await withTenant(ctx.runtime.db, u.workspaceId, (tx) => tx.select().from(auditLog));
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["account.created", "memory.add"]));
    // drizzle wraps the driver error, so look at the real cause from Postgres
    const reason = async (p: Promise<unknown>) => {
      try { await p; } catch (e) { return String((e as Error & { cause?: Error }).cause?.message ?? e); }
      return "did not fail";
    };
    expect(await reason(withTenant(ctx.runtime.db, u.workspaceId, (tx) => tx.update(auditLog).set({ action: "edited" })))).toMatch(/permission denied/i);
    expect(await reason(withTenant(ctx.runtime.db, u.workspaceId, (tx) => tx.delete(auditLog)))).toMatch(/permission denied/i);
  });

  it("the runtime role cannot change the schema or turn security off", async () => {
    await expect(ctx.runtime.client.unsafe("alter table memory disable row level security")).rejects.toThrow();
    await expect(ctx.runtime.client.unsafe("drop table memory")).rejects.toThrow();
  });
});

describe("spend cap and kill switch", () => {
  it("new users get the free dollar a day, can stop Danny, and cannot change the limit", async () => {
    const u = await signUp(ctx, owner, "Cap");
    const s = (await u.c.get("/v1/settings")).body;
    expect(s).toMatchObject({ usedPercent: 0, killSwitch: false, canSetCap: false, model: expect.any(String), resetsAt: expect.any(String) });
    // a usage meter, not dollars
    expect(s).not.toHaveProperty("dailyCapUsd");
    expect(s).not.toHaveProperty("spentTodayUsd");
    const [ws] = await ctx.owner.db.select().from(workspaces).where(eq(workspaces.id, u.workspaceId));
    expect(ws!.dailyCapMicros).toBe(1_000_000);

    const denied = await u.c.patch("/v1/settings", { dailyCapUsd: 50 });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("owner_only");
    // a mixed request is refused whole, so the stop switch is not flipped either
    expect((await u.c.patch("/v1/settings", { dailyCapUsd: 50, killSwitch: true })).status).toBe(403);
    expect((await u.c.get("/v1/settings")).body.killSwitch).toBe(false);
    const [after] = await ctx.owner.db.select().from(workspaces).where(eq(workspaces.id, u.workspaceId));
    expect(after!.dailyCapMicros).toBe(1_000_000);

    expect((await u.c.patch("/v1/settings", { killSwitch: true })).status).toBe(200);
    expect((await u.c.patch("/v1/settings", { killSwitch: false })).status).toBe(200);
  });

  it("the usage meter fills as the day's allowance is spent, and the cap is enforced in one place", async () => {
    const u = await signUp(ctx, owner, "Meter");
    const budget = () => withTenant(ctx.runtime.db, u.workspaceId, (tx) => checkBudget(tx, u.workspaceId));
    expect((await budget()).ok).toBe(true);
    await withTenant(ctx.runtime.db, u.workspaceId, (tx) =>
      recordSpend(tx, { workspaceId: u.workspaceId, userId: u.userId, model: "m", inputTokens: 1000, outputTokens: 1000, costMicros: 250_000 }),
    );
    expect((await u.c.get("/v1/settings")).body.usedPercent).toBe(25);
    await withTenant(ctx.runtime.db, u.workspaceId, (tx) =>
      recordSpend(tx, { workspaceId: u.workspaceId, userId: u.userId, model: "m", inputTokens: 1000, outputTokens: 1000, costMicros: 800_000 }),
    );
    expect(await budget()).toMatchObject({ ok: false, reason: "cap_reached" });
    expect((await u.c.get("/v1/settings")).body.usedPercent).toBe(100);
    await u.c.patch("/v1/settings", { killSwitch: true });
    expect(await budget()).toMatchObject({ ok: false, reason: "kill_switch" });
    await u.c.patch("/v1/settings", { killSwitch: false });
  });

  it("only the owner sees dollars and sets a cap, and only for their own workspace", async () => {
    const s = (await owner.get("/v1/settings")).body;
    expect(s).toMatchObject({ canSetCap: true, dailyCapUsd: expect.any(Number), spentTodayUsd: expect.any(Number) });
    const original = s.dailyCapUsd;
    expect((await owner.patch("/v1/settings", { dailyCapUsd: 0.5 })).body.dailyCapUsd).toBe(0.5);
    expect((await owner.patch("/v1/settings", { dailyCapUsd: 9999 })).status).toBe(400);
    await owner.patch("/v1/settings", { dailyCapUsd: original });
    // the owner changing theirs does not touch anyone else's
    const u = await signUp(ctx, owner, "Other");
    const [ws] = await ctx.owner.db.select().from(workspaces).where(eq(workspaces.id, u.workspaceId));
    expect(ws!.dailyCapMicros).toBe(1_000_000);
  });

  it("one workspace's spend never counts against another's cap", async () => {
    const a = await signUp(ctx, owner, "SpendA");
    const b = await signUp(ctx, owner, "SpendB");
    await withTenant(ctx.runtime.db, a.workspaceId, (tx) =>
      recordSpend(tx, { workspaceId: a.workspaceId, userId: a.userId, model: "m", inputTokens: 1, outputTokens: 1, costMicros: 5_000_000 }),
    );
    expect((await withTenant(ctx.runtime.db, b.workspaceId, (tx) => checkBudget(tx, b.workspaceId))).ok).toBe(true);
  });

  it("the owner sees spend per user", async () => {
    const u = await signUp(ctx, owner, "Billed");
    await withTenant(ctx.runtime.db, u.workspaceId, (tx) =>
      recordSpend(tx, { workspaceId: u.workspaceId, userId: u.userId, model: "m", inputTokens: 1, outputTokens: 1, costMicros: 123_000 }),
    );
    const usage = (await owner.get("/v1/admin/usage")).body.users;
    expect(usage.find((x: any) => x.email === u.email)).toMatchObject({ todayUsd: 0.123, last30DaysUsd: 0.123 });
  });
});
