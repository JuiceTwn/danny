import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../src/db/client.js";
import { tasks, users } from "../src/db/schema.js";
import { checkRepeat, describeRepeatFull, firstSlot, nextRepeat, RepeatError, type Repeat } from "../src/lib/recur.js";
import type { PushPayload, PushSender, PushSub } from "../src/lib/push.js";
import { runDueReminders } from "../src/lib/reminders.js";
import { completeTask, createTask, listTasks, type Actor } from "../src/lib/tasks.js";
import { createRegistry } from "../src/tools/builtin.js";
import type { ToolCtx } from "../src/tools/registry.js";
import { seedOwner, setupApp, signUp, type Client, type Ctx } from "./helpers.js";

const TO = "America/Toronto";
const d = (s: string) => new Date(s);
const iso = (x: Date | null) => x?.toISOString() ?? null;

describe("checking a repeat", () => {
  it("puts times and days in order and drops doubles", () => {
    expect(checkRepeat({ every: 1, unit: "day", times: ["20:00", "08:00", "14:00", "08:00"] }).times).toEqual(["08:00", "14:00", "20:00"]);
    expect(checkRepeat({ every: 1, unit: "week", days: [5, 1, 3, 1] }).days).toEqual([1, 3, 5]);
    expect(checkRepeat({ every: 1, unit: "week", times: ["09:00"], days: [1], until: "2027-03-01" })).toEqual({ every: 1, unit: "week", times: ["09:00"], days: [1], until: "2027-03-01" });
    expect(checkRepeat({ every: 2, unit: "month" })).toEqual({ every: 2, unit: "month" });
  });
  it("says what is wrong in plain words", () => {
    const bad = (r: Parameters<typeof checkRepeat>[0]) => {
      try {
        checkRepeat(r);
      } catch (e) {
        expect(e).toBeInstanceOf(RepeatError);
        return (e as Error).message;
      }
      return "fine";
    };
    expect(bad({ every: 1, unit: "month", times: ["08:00"] })).toContain("by the day or the week");
    expect(bad({ every: 1, unit: "day", times: ["8am"] })).toContain("08:00");
    expect(bad({ every: 1, unit: "day", times: Array.from({ length: 9 }, (_, i) => `0${i}:00`) })).toContain("more than 8");
    expect(bad({ every: 1, unit: "day", days: [1] })).toContain("weekly repeat");
    expect(bad({ every: 1, unit: "week", days: [8] })).toContain("Monday to Sunday");
    expect(bad({ every: 1, unit: "week", until: "2027-02-30" })).toContain("real date");
  });
});

describe("the next one", () => {
  const T: Repeat = { every: 1, unit: "day", times: ["08:00", "14:00", "20:00"] };
  it("goes through the day's times, then on to the next day", () => {
    // 08:00 Toronto in January is 13:00Z.
    expect(iso(nextRepeat(d("2027-01-15T13:00:00Z"), T, TO, d("2027-01-15T13:05:00Z")))).toBe("2027-01-15T19:00:00.000Z"); // 14:00
    expect(iso(nextRepeat(d("2027-01-15T19:00:00Z"), T, TO, d("2027-01-15T19:05:00Z")))).toBe("2027-01-16T01:00:00.000Z"); // 20:00
    expect(iso(nextRepeat(d("2027-01-16T01:00:00Z"), T, TO, d("2027-01-16T01:05:00Z")))).toBe("2027-01-16T13:00:00.000Z"); // 08:00 tomorrow
  });
  it("skips the times that already went by when finished late", () => {
    expect(iso(nextRepeat(d("2027-01-15T13:00:00Z"), T, TO, d("2027-01-15T20:30:00Z")))).toBe("2027-01-16T01:00:00.000Z"); // done at 15:30: next is 20:00
  });
  it("every 2 days keeps its rhythm", () => {
    const r: Repeat = { every: 2, unit: "day", times: ["09:00", "21:00"] };
    expect(iso(nextRepeat(d("2027-01-15T14:00:00Z"), r, TO, d("2027-01-15T14:01:00Z")))).toBe("2027-01-16T02:00:00.000Z"); // 21:00 same day
    expect(iso(nextRepeat(d("2027-01-16T02:00:00Z"), r, TO, d("2027-01-16T02:01:00Z")))).toBe("2027-01-17T14:00:00.000Z"); // 09:00 two days on
  });
  it("keeps 8am at 8am across the clocks changing", () => {
    // Clocks go forward on Sun 14 March 2027 in Toronto: 08:00 is 13:00Z before, 12:00Z after.
    expect(iso(nextRepeat(d("2027-03-13T22:00:00Z"), { every: 1, unit: "day", times: ["08:00"] }, TO, d("2027-03-13T22:01:00Z")))).toBe("2027-03-14T12:00:00.000Z");
  });
  it("weekdays: Mon, Wed, Fri, then round to Monday", () => {
    const r: Repeat = { every: 1, unit: "week", days: [1, 3, 5], times: ["07:00"] };
    const f = (from: string, now: string) => iso(nextRepeat(d(from), r, TO, d(now)));
    expect(f("2027-01-11T12:00:00Z", "2027-01-11T12:01:00Z")).toBe("2027-01-13T12:00:00.000Z"); // Mon 11 -> Wed 13
    expect(f("2027-01-13T12:00:00Z", "2027-01-13T12:01:00Z")).toBe("2027-01-15T12:00:00.000Z"); // Wed -> Fri
    expect(f("2027-01-15T12:00:00Z", "2027-01-15T12:01:00Z")).toBe("2027-01-18T12:00:00.000Z"); // Fri -> Mon 18
  });
  it("every other week on Tuesday and Thursday", () => {
    const r: Repeat = { every: 2, unit: "week", days: [2, 4] };
    // Thu 14 Jan 09:00 (14:00Z) -> skip the off week -> Tue 26 Jan.
    expect(iso(nextRepeat(d("2027-01-14T14:00:00Z"), r, TO, d("2027-01-14T14:01:00Z")))).toBe("2027-01-26T14:00:00.000Z");
    expect(iso(nextRepeat(d("2027-01-12T14:00:00Z"), r, TO, d("2027-01-12T14:01:00Z")))).toBe("2027-01-14T14:00:00.000Z"); // Tue -> Thu, same week
  });
  it("stops after its end date (on the person's own calendar)", () => {
    const r: Repeat = { every: 1, unit: "day", times: ["08:00", "20:00"], until: "2027-01-16" };
    expect(iso(nextRepeat(d("2027-01-16T01:00:00Z"), r, TO, d("2027-01-16T01:05:00Z")))).toBe("2027-01-16T13:00:00.000Z"); // 08:00 on the 16th: still in
    expect(nextRepeat(d("2027-01-17T01:00:00Z"), r, TO, d("2027-01-17T01:05:00Z"))).toBeNull(); // 20:00 on the 16th was the last; next is the 17th
    expect(iso(nextRepeat(d("2027-01-15T13:00:00Z"), { every: 1, unit: "week", until: "2027-01-31" }, TO, d("2027-01-15T14:00:00Z")))).toBe("2027-01-22T13:00:00.000Z"); // plain repeats can end too
    expect(nextRepeat(d("2027-01-29T13:00:00Z"), { every: 1, unit: "week", until: "2027-01-31" }, TO, d("2027-01-29T14:00:00Z"))).toBeNull();
  });
  it("finds the first time when there is no start", () => {
    expect(iso(firstSlot({ every: 1, unit: "day", times: ["08:00", "14:00"] }, TO, d("2027-01-15T14:30:00Z")))).toBe("2027-01-15T19:00:00.000Z"); // 09:30 now -> 14:00
    expect(iso(firstSlot({ every: 1, unit: "day", times: ["08:00", "14:00"] }, TO, d("2027-01-16T02:00:00Z")))).toBe("2027-01-16T13:00:00.000Z"); // 21:00 now -> 08:00 tomorrow
  });
  it("says it in words", () => {
    expect(describeRepeatFull({ every: 1, unit: "day", times: ["08:00", "14:30", "20:00"] })).toBe("every day at 8:00 AM, 2:30 PM and 8:00 PM");
    expect(describeRepeatFull({ every: 1, unit: "week", days: [1, 3, 5] })).toBe("every Mon, Wed and Fri");
    expect(describeRepeatFull({ every: 2, unit: "week", days: [2, 4], until: "2027-12-31" })).toBe("every 2 weeks on Tue and Thu until Dec 31, 2027");
    expect(describeRepeatFull({ every: 1, unit: "week" })).toBe("every week");
    expect(describeRepeatFull(null)).toBeNull();
  });
});

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
beforeAll(async () => {
  ctx = await setupApp(undefined, createRegistry(), {}, push);
  owner = (await seedOwner(ctx)).c;
});
afterAll(() => ctx.close());

type U = Awaited<ReturnType<typeof signUp>>;
const reg = createRegistry();
const actor = (u: U): Actor => ({ workspaceId: u.workspaceId, userId: u.userId, vault: ctx.vault, tenant: (fn) => withTenant(ctx.runtime.db, u.workspaceId, fn) });
const toolCtx = (u: U): ToolCtx => ({ card: () => {}, ...actor(u), db: ctx.runtime.db, google: null });
const run = (u: U, tool: string, input: unknown) => reg.get(tool)!.run!(toolCtx(u), reg.get(tool)!.input.parse(input));
const person = async (name: string) => {
  const u = await signUp(ctx, owner, name);
  await ctx.owner.db.update(users).set({ timezone: "America/Toronto" }).where(eq(users.id, u.userId));
  return u;
};
const row = async (id: string) => (await ctx.owner.db.select().from(tasks).where(eq(tasks.id, id)))[0]!;

describe("several reminders in a day, from chat", () => {
  it("one task with no start: the first is the next of those times, and the list says it plainly", async () => {
    const u = await person("Rt1");
    const said = await run(u, "add_task", { title: "Take pills", repeat_unit: "day", repeat_every: 1, repeat_times: ["20:00", "08:00", "14:00"] });
    expect(said).toContain("Repeats every day at 8:00 AM, 2:00 PM and 8:00 PM.");
    const [t] = await listTasks(actor(u));
    expect(t!.repeat).toEqual({ every: 1, unit: "day", times: ["08:00", "14:00", "20:00"] });
    expect(new Date(t!.remindAt!).getTime()).toBeGreaterThan(Date.now());
    expect(t!.repeatText).toBe("every day at 8:00 AM, 2:00 PM and 8:00 PM");
    expect(await run(u, "list_tasks", {})).toContain("every day at 8:00 AM, 2:00 PM and 8:00 PM");
    expect((await u.c.get("/v1/tasks")).body.items[0].repeatText).toBe("every day at 8:00 AM, 2:00 PM and 8:00 PM");
  });

  it("asks for what is missing or wrong instead of guessing", async () => {
    const u = await person("Rt2");
    expect(await run(u, "add_task", { title: "x", repeat_times: ["08:00"] })).toContain("set repeat_unit and repeat_every too");
    expect(await run(u, "add_task", { title: "x", repeat_unit: "month", repeat_every: 1, repeat_times: ["08:00"] })).toContain("by the day or the week");
    expect(await run(u, "add_task", { title: "x", repeat_unit: "day", repeat_every: 1, repeat_days: ["mon"] })).toContain("weekly repeat");
    expect(() => reg.get("add_task")!.input.parse({ title: "x", repeat_unit: "day", repeat_every: 1, repeat_times: ["8am"] })).toThrow();
    expect(await listTasks(actor(u))).toEqual([]);
  });

  it("weekdays work from chat and over the API", async () => {
    const u = await person("Rt3");
    await run(u, "add_task", { title: "Gym", repeat_unit: "week", repeat_every: 1, repeat_days: ["mon", "wed", "fri"], repeat_times: ["07:00"], repeat_until: "2099-01-01" });
    const [t] = await listTasks(actor(u));
    expect(t!.repeat).toEqual({ every: 1, unit: "week", times: ["07:00"], days: [1, 3, 5], until: "2099-01-01" });
    expect(t!.repeatText).toBe("every Mon, Wed and Fri at 7:00 AM until Jan 1, 2099");
    const api = await u.c.post("/v1/tasks", { title: "Stretch", repeat: { every: 1, unit: "day", times: ["10:00", "13:00", "16:00"] } });
    expect(api.status).toBe(201);
    expect(api.body.item.repeat.times).toEqual(["10:00", "13:00", "16:00"]);
    expect((await u.c.post("/v1/tasks", { title: "Bad", repeat: { every: 1, unit: "day", times: ["25:00"] } })).status).toBe(400);
  });
});

describe("finishing one", () => {
  it("moves to the next time in the day, then the next day, and ends at the end date", async () => {
    const u = await person("Rt4");
    const a = actor(u);
    const now = d("2027-01-15T12:00:00Z"); // 07:00 Toronto
    const t = await createTask(a, { title: "Antibiotic", repeat: { every: 1, unit: "day", times: ["08:00", "20:00"], until: "2027-01-16" } }, now);
    expect(t.remindAt).toBe("2027-01-15T13:00:00.000Z");
    let r = await completeTask(a, t.id, d("2027-01-15T13:05:00Z"));
    expect(r).toMatchObject({ next: "2027-01-16T01:00:00.000Z", ended: false });
    r = await completeTask(a, t.id, d("2027-01-16T01:05:00Z"));
    expect(r!.next).toBe("2027-01-16T13:00:00.000Z");
    r = await completeTask(a, t.id, d("2027-01-16T13:05:00Z"));
    expect(r!.next).toBe("2027-01-17T01:00:00.000Z"); // 20:00 on the 16th, the last day
    r = await completeTask(a, t.id, d("2027-01-17T01:05:00Z"));
    expect(r).toMatchObject({ next: null, ended: true });
    expect(await row(t.id)).toMatchObject({ status: "done", remindAt: null });
  });

  it("the chat says when that was the last one", async () => {
    const u = await person("Rt5");
    const t = await createTask(actor(u), { title: "Course", dueAt: new Date(Date.now() + 3_600_000), repeat: { every: 1, unit: "week", until: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) } });
    expect(await run(u, "complete_task", { id: t.id })).toContain("That was the last one: the repeat has reached its end date");
  });

  it("an end date before the first one is refused", async () => {
    const u = await person("Rt6");
    const err = await createTask(actor(u), { title: "x", dueAt: new Date(Date.now() + 5 * 86_400_000), repeat: { every: 1, unit: "day", until: "2020-01-01" } }).catch((e) => e);
    expect(String(err.message)).toContain("before the first one");
  });
});

describe("an ignored reminder never costs the next one", () => {
  it("rolls on to the next time when the next one arrives, and ends cleanly at the end date", async () => {
    const u = await person("Rt7");
    const a = actor(u);
    await u.c.post("/v1/push/subscribe", { endpoint: "https://fcm.googleapis.com/fcm/send/rt7", keys: { p256dh: "p", auth: "a" } });
    const t = await createTask(a, { title: "Vitamins", repeat: { every: 1, unit: "day", times: ["08:00", "10:00"], until: "2027-01-15" } }, d("2027-01-15T11:00:00Z")); // 06:00 Toronto
    expect(t.remindAt).toBe("2027-01-15T13:00:00.000Z");
    const go = (iso: string) => runDueReminders({ db: ctx.runtime.db, vault: ctx.vault, push }, d(iso));
    push.sent = [];

    expect(await go("2027-01-15T13:00:30Z")).toBeGreaterThanOrEqual(1); // 08:00: first nudge
    expect((await row(t.id)).nudgeCount).toBe(1); // next nudge is 08:10, before the 10:00 slot: carry on
    await go("2027-01-15T13:10:30Z");
    await go("2027-01-15T13:41:00Z"); // third nudge: the next would be 2 hours later, after 10:00, so line up 10:00 instead
    const rolled = await row(t.id);
    expect(rolled.remindAt!.toISOString()).toBe("2027-01-15T15:00:00.000Z");
    expect(rolled.dueAt!.toISOString()).toBe("2027-01-15T15:00:00.000Z");
    expect(rolled.nudgeCount).toBe(0);
    expect(rolled.status).toBe("open");

    await go("2027-01-15T15:00:30Z"); // 10:00, the last one allowed by the end date
    await go("2027-01-15T15:10:30Z");
    await go("2027-01-15T15:41:00Z");
    expect((await row(t.id)).status).toBe("open"); // still working through this last time's reminders
    await go("2027-01-15T17:42:00Z"); // nudges used up and nothing left to come: finished
    expect(await row(t.id)).toMatchObject({ status: "done", remindAt: null });
    expect(push.sent.filter((p) => p.title === "Vitamins").length).toBe(7); // 3 for the 08:00 (then rolled on to 10:00) and 4 for the last 10:00
  });

  it("a plain repeating task still waits to be finished, as before", async () => {
    const u = await person("Rt8");
    const t = await createTask(actor(u), { title: "Bins", dueAt: new Date(Date.now() + 3_600_000), repeat: { every: 1, unit: "week" } });
    await ctx.owner.db.update(tasks).set({ remindAt: new Date(Date.now() - 1000) }).where(eq(tasks.id, t.id));
    await ctx.owner.db.update(users).set({ quietStart: 0, quietEnd: 0 }).where(eq(users.id, u.userId));
    await runDueReminders({ db: ctx.runtime.db, vault: ctx.vault, push }, new Date());
    const r = await row(t.id);
    expect(r.nudgeCount).toBe(1);
    expect(r.status).toBe("open");
    expect(r.dueAt!.getTime()).toBeGreaterThan(Date.now()); // not rolled
  });
});
