import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelClient } from "../src/brain/model.js";
import { auditLog, spendLedger, tasks } from "../src/db/schema.js";
import { runTaskCheckins, type BackgroundDeps } from "../src/lib/background.js";
import { runDueReminders } from "../src/lib/reminders.js";
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
const model: ModelClient = {
  async complete() {
    throw new Error("a check-in must never call the model");
  },
};
beforeAll(async () => {
  ctx = await setupApp(model, createRegistry(), {}, push);
  owner = (await seedOwner(ctx)).c;
});
afterAll(() => ctx.close());

const deps = (): BackgroundDeps => ({ db: ctx.runtime.db, vault: ctx.vault, push, config: ctx.config, model });
const DAY = 86_400_000;
// 12:00 in Toronto (UTC-5 in winter), so not quiet hours; and 04:00 UTC the same day is 23:00 in Toronto, which is.
const noon = (daysAhead: number) => {
  const d = new Date(Date.now() + daysAhead * DAY);
  d.setUTCHours(17, 0, 0, 0);
  return d;
};
const history = async (c: Client) => (await c.get("/v1/chat/history")).body.messages as { text: string; cards: any[] }[];
const asked = async (c: Client) => (await history(c)).filter((m) => m.text.includes("No pressure") || m.text.includes("pushed back"));

async function person(name: string, adhd = true) {
  const u = await signUp(ctx, owner, name);
  if (adhd) await u.c.patch("/v1/profile", { adhdMode: true });
  return u;
}
async function task(u: { c: Client }, title: string, over: Partial<typeof tasks.$inferInsert> = {}) {
  const id = (await u.c.post("/v1/tasks", { title, firstStep: "Open the file" })).body.item.id as string;
  await ctx.owner.db.update(tasks).set({ remindAt: null, ...over }).where(eq(tasks.id, id));
  return id;
}

describe("task check-ins (Starting help)", () => {
  it("asks once about a task whose reminders gave up a day ago, with its first step, the task card and tap-replies, and no model call", async () => {
    const u = await person("Ck1");
    await task(u, "Sort out the tax return", { nudgeCount: 4, lastNudgeAt: new Date(Date.now() - 2 * DAY) });
    expect(await runTaskCheckins(deps(), noon(0))).toBe(1);
    const [m] = await asked(u.c);
    expect(m!.text).toContain("Sort out the tax return");
    expect(m!.text).toContain("The first step is: Open the file");
    expect(m!.cards.map((c) => c.kind)).toEqual(["task", "replies"]);
    expect(m!.cards[1].options).toContain("Make it smaller");
    const audit = await ctx.owner.db.select().from(auditLog).where(eq(auditLog.userId, u.userId));
    expect(audit.some((a) => a.action === "task.checkin")).toBe(true);
  });

  it("waits a day after the last nudge, and does not ask about a task whose reminders are still going", async () => {
    const u = await person("Ck2");
    await task(u, "Fresh nudges", { nudgeCount: 4, lastNudgeAt: new Date(Date.now() - 3_600_000) }); // gave up an hour ago
    await task(u, "Still nudging", { nudgeCount: 2, remindAt: new Date(Date.now() + 3_600_000), lastNudgeAt: new Date(Date.now() - 2 * DAY) });
    await task(u, "Never nudged");
    expect(await runTaskCheckins(deps(), new Date())).toBe(0);
    expect(await asked(u.c)).toHaveLength(0);
  });

  it("a task put off three times gets a different, kind question", async () => {
    const u = await person("Ck3");
    await task(u, "Ring the bank", { snoozeCount: 3, remindAt: new Date(Date.now() + DAY) });
    expect(await runTaskCheckins(deps(), noon(0))).toBe(1);
    const [m] = await asked(u.c);
    expect(m!.text).toContain("pushed back 3 times");
    expect(m!.text).toContain("do part of it for you");
    expect(m!.text).not.toMatch(/weeks|days ago|should have/i);
    expect(m!.cards[1].options).toContain("Help me do it");
  });

  it("is limited to one a day per person, and the same task is left alone for three days", async () => {
    // Other people's tasks in this database are eligible too, so count this person's own messages, not the return value.
    const u = await person("Ck4");
    await task(u, "First", { snoozeCount: 5 });
    await task(u, "Second", { snoozeCount: 4 });
    await runTaskCheckins(deps(), noon(0));
    await runTaskCheckins(deps(), new Date(noon(0).getTime() + 60_000)); // same day, other task
    expect((await asked(u.c)).map((m) => m.text.includes("First"))).toEqual([true]);
    await runTaskCheckins(deps(), noon(1)); // next day: the other task goes, not the one just asked about
    expect((await asked(u.c)).map((m) => (m.text.includes("First") ? "First" : "Second"))).toEqual(["First", "Second"]);
    await runTaskCheckins(deps(), noon(2)); // both still within their three days
    expect(await asked(u.c)).toHaveLength(2);
    await runTaskCheckins(deps(), noon(4)); // First may be asked again
    expect(await asked(u.c)).toHaveLength(3);
  });

  it("never in quiet hours (it waits), and nothing is claimed so it comes round at a human hour", async () => {
    const u = await person("Ck5");
    await task(u, "Night owl", { snoozeCount: 3 });
    const night = noon(0);
    night.setUTCHours(4, 0, 0, 0); // 23:00 Toronto
    expect(await runTaskCheckins(deps(), night)).toBe(0);
    expect(await asked(u.c)).toHaveLength(0);
    expect(await runTaskCheckins(deps(), noon(0))).toBe(1);
  });

  it("is off for people who did not turn Starting help on, and for a stopped workspace", async () => {
    const off = await person("Ck6", false);
    await task(off, "Not asked", { snoozeCount: 9 });
    const stopped = await person("Ck7");
    await task(stopped, "Also not asked", { snoozeCount: 9 });
    await stopped.c.patch("/v1/settings", { killSwitch: true }).catch(() => {});
    expect(await asked(off.c)).toHaveLength(0);
    await runTaskCheckins(deps(), noon(0));
    expect(await asked(off.c)).toHaveLength(0);
  });

  it("costs nothing: no model call, nothing in the spend ledger", async () => {
    const u = await person("Ck8");
    await task(u, "Free", { snoozeCount: 3 });
    await runTaskCheckins(deps(), noon(0));
    expect(await ctx.owner.db.select().from(spendLedger).where(eq(spendLedger.userId, u.userId))).toHaveLength(0);
  });

  it("a reminder that buzzes records when, so the day-long wait is measured from the last nudge", async () => {
    const u = await person("Ck9");
    const id = (await u.c.post("/v1/tasks", { title: "Buzz me" })).body.item.id as string;
    await ctx.owner.db.update(tasks).set({ remindAt: new Date(Date.now() - 1000) }).where(eq(tasks.id, id));
    await runDueReminders({ db: ctx.runtime.db, vault: ctx.vault, push });
    const [t] = await ctx.owner.db.select().from(tasks).where(eq(tasks.id, id));
    expect(t!.lastNudgeAt).not.toBeNull();
  });
});
