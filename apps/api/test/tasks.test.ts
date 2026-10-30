import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelClient, ModelResult } from "../src/brain/model.js";
import { auditLog, messages, pushSubscriptions, tasks, users } from "../src/db/schema.js";
import type { PushPayload, PushSender, PushSub } from "../src/lib/push.js";
import { nextNudgeAt, nudgeText, runDueReminders } from "../src/lib/reminders.js";
import { inQuietHours, localIso, nextQuietEnd } from "../src/lib/time.js";
import { createRegistry } from "../src/tools/builtin.js";
import { seedOwner, setupApp, signUp, type Client, type Ctx } from "./helpers.js";

class FakePush implements PushSender {
  publicKey: string | null = "test-public-key";
  sent: { sub: PushSub; payload: PushPayload }[] = [];
  result: "ok" | "gone" | "failed" = "ok";
  async send(sub: PushSub, payload: PushPayload) {
    this.sent.push({ sub, payload });
    return this.result;
  }
}

const push = new FakePush();
let ctx: Ctx;
let owner: Client;
let script: ModelResult[] = [];
beforeAll(async () => {
  const model: ModelClient = {
    async complete(_req, onText) {
      const res = script.shift()!;
      for (const b of res.content) if (b.type === "text") onText(b.text);
      return res;
    },
  };
  ctx = await setupApp(model, createRegistry(), {}, push);
  owner = (await seedOwner(ctx)).c;
});
afterAll(() => ctx.close());

const runner = () => ({ db: ctx.runtime.db, vault: ctx.vault, push });
const minutes = (n: number, from = Date.now()) => new Date(from + n * 60_000);
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123";
const subscribe = (c: Client, endpoint = ENDPOINT) => c.post("/v1/push/subscribe", { endpoint, keys: { p256dh: "p", auth: "a" } });

/** Make a task due right now, as the scheduler sees it. */
async function dueTask(c: Client, title: string) {
  const r = await c.post("/v1/tasks", { title, remindAt: minutes(5).toISOString() });
  expect(r.status).toBe(201);
  return r.body.item.id as string;
}
const rowOf = async (id: string) => (await ctx.owner.db.select().from(tasks).where(eq(tasks.id, id)))[0]!;

describe("time helpers", () => {
  it("formats the current time with the zone's real offset", () => {
    expect(localIso(new Date("2026-10-30T19:04:00Z"), "America/Toronto")).toBe("2026-10-30T15:04:00-04:00");
    expect(localIso(new Date("2026-12-30T19:04:00Z"), "America/Toronto")).toBe("2026-12-30T14:04:00-05:00");
  });
  it("knows quiet hours and when they end, in the user's zone", () => {
    expect(inQuietHours(new Date("2026-10-31T03:30:00Z"), "America/Toronto")).toBe(true); // 23:30 local
    expect(inQuietHours(new Date("2026-10-31T16:00:00Z"), "America/Toronto")).toBe(false); // noon local
    expect(nextQuietEnd(new Date("2026-10-31T03:30:00Z"), "America/Toronto").toISOString()).toBe("2026-10-31T11:00:00.000Z"); // 07:00 EDT
    expect(nextQuietEnd(new Date("2026-10-31T09:00:00Z"), "America/Toronto").toISOString()).toBe("2026-10-31T11:00:00.000Z"); // early morning, same day
  });
  it("escalates three times, then stops", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    expect(nextNudgeAt(1, now)?.toISOString()).toBe("2026-01-01T12:10:00.000Z");
    expect(nextNudgeAt(2, now)?.toISOString()).toBe("2026-01-01T12:30:00.000Z");
    expect(nextNudgeAt(3, now)?.toISOString()).toBe("2026-01-01T14:00:00.000Z");
    expect(nextNudgeAt(4, now)).toBeNull();
    expect(nudgeText("call the dentist", 0)).toBe("Reminder: call the dentist");
    expect(nudgeText("call the dentist", 3)).toContain("It stays on your list");
  });
});

describe("tasks API", () => {
  it("adds, lists, completes and deletes, with the title encrypted at rest", async () => {
    const r = await owner.post("/v1/tasks", { title: "Send Marlene the invoice" });
    expect(r.status).toBe(201);
    expect(r.body.item.remindAt).toBeNull();
    const [raw] = await ctx.owner.db.select().from(tasks).where(eq(tasks.id, r.body.item.id));
    expect(raw!.titleEnc.toString("utf8")).not.toContain("Marlene");

    expect((await owner.get("/v1/tasks")).body.items.map((t: any) => t.title)).toContain("Send Marlene the invoice");
    expect((await owner.post(`/v1/tasks/${r.body.item.id}/done`)).status).toBe(200);
    expect((await owner.post(`/v1/tasks/${r.body.item.id}/done`)).status).toBe(404); // already done
    expect((await owner.get("/v1/tasks?status=done")).body.items.map((t: any) => t.id)).toContain(r.body.item.id);
    expect((await owner.del(`/v1/tasks/${r.body.item.id}`)).status).toBe(200);
  });

  it("a deadline with no reminder reminds at the deadline; a past reminder is refused", async () => {
    const due = minutes(60).toISOString();
    const r = await owner.post("/v1/tasks", { title: "File HST", dueAt: due });
    expect(r.body.item.remindAt).toBe(due);
    const bad = await owner.post("/v1/tasks", { title: "Too late", remindAt: minutes(-30).toISOString() });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/passed/);
  });

  it("snoozing moves the reminder and restarts the escalation", async () => {
    const id = await dueTask(owner, "Take the bins out");
    await ctx.owner.db.update(tasks).set({ nudgeCount: 2 }).where(eq(tasks.id, id));
    const r = await owner.post(`/v1/tasks/${id}/snooze`, { minutes: 60 });
    expect(r.status).toBe(200);
    const row = await rowOf(id);
    expect(row.nudgeCount).toBe(0);
    expect(row.remindAt!.getTime()).toBeGreaterThan(Date.now() + 55 * 60_000);
  });

  it("one user cannot see, finish, snooze or delete another's task", async () => {
    const a = await signUp(ctx, owner, "Ada");
    const b = await signUp(ctx, owner, "Bo");
    const id = await dueTask(a.c, "Ada's private thing");
    expect((await b.c.get("/v1/tasks")).body.items).toEqual([]);
    expect((await b.c.post(`/v1/tasks/${id}/done`)).status).toBe(404);
    expect((await b.c.post(`/v1/tasks/${id}/snooze`, { minutes: 5 })).status).toBe(404);
    expect((await b.c.del(`/v1/tasks/${id}`)).status).toBe(404);
    expect((await rowOf(id)).status).toBe("open");
  });
});

describe("reminders", () => {
  it("fires at the time, posts to the chat, pushes, and schedules the next nudge", async () => {
    const u = await signUp(ctx, owner, "Cy");
    expect((await subscribe(u.c)).status).toBe(201);
    const id = await dueTask(u.c, "Call the dentist");
    const at = minutes(6);

    expect(await runDueReminders(runner(), minutes(1))).toBe(0); // not yet
    push.sent = [];
    expect(await runDueReminders(runner(), at)).toBeGreaterThanOrEqual(1);

    expect(push.sent.filter((s) => s.payload.taskId === id)).toHaveLength(1);
    expect(push.sent.find((s) => s.payload.taskId === id)!.payload).toMatchObject({ title: "Call the dentist", body: "Reminder" });
    const row = await rowOf(id);
    expect(row.nudgeCount).toBe(1);
    expect(row.remindAt!.toISOString()).toBe(minutes(10, at.getTime()).toISOString());

    const chat = await u.c.get("/v1/chat/history");
    expect(chat.body.messages.at(-1)).toMatchObject({ role: "assistant", text: "Reminder: Call the dentist" });
    const log = await ctx.owner.db.select().from(auditLog).where(eq(auditLog.action, "reminder.fire"));
    expect(log.some((l) => (l.detail as any).id === id)).toBe(true);
  });

  it("does not fire the same reminder twice, and stops after the last nudge", async () => {
    const u = await signUp(ctx, owner, "Di");
    const id = await dueTask(u.c, "Pay the hydro bill");
    let t = minutes(6);
    await runDueReminders(runner(), t);
    await runDueReminders(runner(), t); // same instant: already claimed
    expect((await rowOf(id)).nudgeCount).toBe(1);

    for (const wait of [11, 31, 121]) {
      t = minutes(wait, t.getTime());
      await runDueReminders(runner(), t);
    }
    const row = await rowOf(id);
    expect(row.nudgeCount).toBe(4);
    expect(row.remindAt).toBeNull();
    expect(row.status).toBe("open"); // still on the list
    const texts = (await u.c.get("/v1/chat/history")).body.messages.map((m: any) => m.text);
    expect(texts).toEqual(["Reminder: Pay the hydro bill", "Still open: Pay the hydro bill", expect.stringContaining("Still on the board"), expect.stringContaining("Last nudge")]);
  });

  it("finishing a task stops its nudges", async () => {
    const u = await signUp(ctx, owner, "Ed");
    const id = await dueTask(u.c, "Book the car in");
    await runDueReminders(runner(), minutes(6));
    await u.c.post(`/v1/tasks/${id}/done`);
    const before = (await u.c.get("/v1/chat/history")).body.messages.length;
    await runDueReminders(runner(), minutes(20));
    expect((await u.c.get("/v1/chat/history")).body.messages.length).toBe(before);
  });

  it("repeat nudges wait out quiet hours; the first one goes exactly when asked", async () => {
    const u = await signUp(ctx, owner, "Flo");
    await u.c.patch("/v1/profile", { timezone: "America/Toronto" });
    const id = await dueTask(u.c, "Take the pills");
    const night = new Date("2099-01-01T04:30:00Z"); // 23:30 in Toronto
    await ctx.owner.db.update(tasks).set({ remindAt: night }).where(eq(tasks.id, id));
    await runDueReminders(runner(), night);
    expect((await rowOf(id)).nudgeCount).toBe(1); // first nudge ignores quiet hours

    const later = minutes(10, night.getTime());
    await runDueReminders(runner(), later);
    const row = await rowOf(id);
    expect(row.nudgeCount).toBe(1); // held back
    expect(row.remindAt!.toISOString()).toBe("2099-01-01T12:00:00.000Z"); // 07:00 EST
  });

  it("drops a push subscription the browser says is gone", async () => {
    const u = await signUp(ctx, owner, "Gus");
    const endpoint = "https://updates.push.services.mozilla.com/wpush/v2/gone";
    await subscribe(u.c, endpoint);
    await dueTask(u.c, "Water the plants");
    push.result = "gone";
    await runDueReminders(runner(), minutes(6));
    push.result = "ok";
    expect(await ctx.owner.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint))).toHaveLength(0);
  });

  it("leaves a stopped workspace alone", async () => {
    const u = await signUp(ctx, owner, "Hal");
    const id = await dueTask(u.c, "Stopped task");
    expect((await u.c.patch("/v1/settings", { killSwitch: true })).status).toBe(200);
    await runDueReminders(runner(), minutes(6));
    expect((await rowOf(id)).nudgeCount).toBe(0);
  });
});

describe("row-level security", () => {
  it("the app role sees no tasks or push subscriptions unless a workspace is set, and only its own once set", async () => {
    const a = await signUp(ctx, owner, "Kim");
    const b = await signUp(ctx, owner, "Lou");
    await dueTask(a.c, "Kim's task");
    await subscribe(a.c, "https://fcm.googleapis.com/fcm/send/kim");
    expect(await ctx.runtime.db.select().from(tasks)).toHaveLength(0);
    expect(await ctx.runtime.db.select().from(pushSubscriptions)).toHaveLength(0);
    const { withTenant } = await import("../src/db/client.js");
    expect(await withTenant(ctx.runtime.db, b.workspaceId, (tx) => tx.select().from(tasks))).toHaveLength(0);
    expect(await withTenant(ctx.runtime.db, a.workspaceId, (tx) => tx.select().from(tasks))).toHaveLength(1);
  });
});

describe("push subscriptions", () => {
  it("only accepts real push services, so the server can't be pointed at an internal address", async () => {
    for (const endpoint of ["http://fcm.googleapis.com/x", "https://169.254.169.254/latest", "https://localhost/x", "https://evil.example.com/fcm.googleapis.com", "https://fcm.googleapis.com.evil.com/x", "https://fcm.googleapis.com:8443/x"]) {
      const r = await subscribe(owner, endpoint);
      expect(r.status, endpoint).toBe(400);
    }
    expect((await subscribe(owner, "https://web.push.apple.com/abc")).status).toBe(201);
    expect((await subscribe(owner, "https://wns2-par02p.notify.windows.com/w/?token=x")).status).toBe(201);
  });

  it("encrypts the keys, and unsubscribe removes them", async () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/enc-test";
    await subscribe(owner, endpoint);
    const [row] = await ctx.owner.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
    expect(row!.subEnc.toString("utf8")).not.toContain("p256dh");
    await owner.post("/v1/push/unsubscribe", { endpoint });
    expect(await ctx.owner.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint))).toHaveLength(0);
  });

  it("reports the public key, and refuses subscriptions when push is not configured", async () => {
    expect((await owner.get("/v1/push/key")).body.publicKey).toBe("test-public-key");
    const off = new FakePush();
    off.publicKey = null;
    const c2 = await setupApp(undefined, undefined, {}, off);
    const o2 = (await seedOwner(c2)).c;
    expect((await o2.get("/v1/push/key")).body.publicKey).toBeNull();
    expect((await subscribe(o2)).status).toBe(503);
    await c2.close();
  });
});

describe("profile", () => {
  it("saves a valid timezone and rejects nonsense", async () => {
    expect((await owner.patch("/v1/profile", { timezone: "America/Vancouver" })).body.timezone).toBe("America/Vancouver");
    expect((await owner.get("/v1/me")).body.user.timezone).toBe("America/Vancouver");
    expect((await owner.patch("/v1/profile", { timezone: "Mars/Olympus" })).status).toBe(400);
    await ctx.owner.db.update(users).set({ timezone: "America/Toronto" }).where(eq(users.email, (await owner.get("/v1/me")).body.user.email));
  });
});

describe("chat tools", () => {
  it("add_task from chat creates the task, and the model is told the time and zone", async () => {
    const u = await signUp(ctx, owner, "Ivy");
    const seen: string[] = [];
    const model: ModelClient = {
      async complete(req, onText) {
        seen.push(req.system);
        const res = script.shift()!;
        for (const b of res.content) if (b.type === "text") onText(b.text);
        return res;
      },
    };
    const c2 = await setupApp(model, createRegistry(), {}, push);
    // Same database, so sign in as Ivy on the second app instance.
    const cli = (await import("./helpers.js")).client(c2);
    expect((await cli.post("/v1/auth/login", { email: u.email, password: "correct horse battery" })).status).toBe(200);
    const remindAt = minutes(90).toISOString();
    script = [
      { content: [{ type: "tool_use", id: "t1", name: "add_task", input: { title: "Call mum", remind_at: remindAt } }], stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } },
      { content: [{ type: "text", text: "Added." }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } },
    ];
    const res = await cli.req("POST", "/v1/chat", { message: "remind me to call mum in 90 minutes" });
    expect(res.raw.body).toContain("Added.");
    expect(seen[0]).toMatch(/Right now it is \d{4}-\d\d-\d\dT[\d:]+[-+]\d\d:\d\d \(America\/Toronto\)/);
    const list = await cli.get("/v1/tasks");
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ title: "Call mum", remindAt });
    await c2.close();
  });

  it("whats_next gives one task, overdue first", async () => {
    const reg = createRegistry();
    const u = await signUp(ctx, owner, "Jo");
    await u.c.post("/v1/tasks", { title: "later", dueAt: minutes(600).toISOString() });
    await u.c.post("/v1/tasks", { title: "no deadline" });
    await u.c.post("/v1/tasks", { title: "soonest", dueAt: minutes(30).toISOString() });
    const { withTenant } = await import("../src/db/client.js");
    const tctx = { workspaceId: u.workspaceId, userId: u.userId, db: ctx.runtime.db, vault: ctx.vault, tenant: (fn: any) => withTenant(ctx.runtime.db, u.workspaceId, fn) };
    const out = await reg.get("whats_next")!.run!(tctx as never, {});
    expect(out).toContain("soonest");
    expect(out).toContain("2 other open task(s)");
    expect(out).not.toContain("no deadline");
  });
});

describe("readiness", () => {
  it("/readyz is 200 when the database answers and the scheduler is fresh, and /healthz stays a cheap liveness check", async () => {
    const r = await ctx.app.inject({ method: "GET", url: "/readyz", remoteAddress: "10.7.7.7" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, db: true, scheduler: true });
    expect((await ctx.app.inject({ method: "GET", url: "/healthz", remoteAddress: "10.7.7.7" })).statusCode).toBe(200);
  });

  it("goes 503 when the scheduler has stopped ticking, so a silent reminder outage gets noticed and restarted", async () => {
    const { Health } = await import("../src/lib/health.js");
    const health = new Health(true, 50);
    const c2 = await setupApp(undefined, undefined, {}, undefined, null, health);
    const ready = () => c2.app.inject({ method: "GET", url: "/readyz", remoteAddress: "10.7.7.9" });
    expect((await ready()).statusCode).toBe(200); // fresh at boot
    await new Promise((r) => setTimeout(r, 80));
    const stale = await ready();
    expect(stale.statusCode).toBe(503);
    expect(stale.json()).toEqual({ ok: false, db: true, scheduler: false });
    health.tick(); // the scheduler comes back
    expect((await ready()).statusCode).toBe(200);
    expect(new Health(false, 1).schedulerOk(Date.now() + 10_000)).toBe(true); // scheduler off (tests, read-only process): never stale
    await c2.close();
  });

  it("goes 503 with db:false when the database is unreachable", async () => {
    const c2 = await setupApp();
    await c2.runtime.client.end();
    const r = await c2.app.inject({ method: "GET", url: "/readyz", remoteAddress: "10.7.7.8" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ ok: false, db: false });
    await c2.app.close();
    await c2.owner.client.end();
  });
});
