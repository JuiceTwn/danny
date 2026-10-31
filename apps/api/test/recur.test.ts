import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tasks } from "../src/db/schema.js";
import { addRepeat, describeRepeat, nextOccurrence } from "../src/lib/recur.js";
import { createRegistry } from "../src/tools/builtin.js";
import { seedOwner, setupApp, type Client, type Ctx } from "./helpers.js";

const TO = "America/Toronto";
const d = (s: string) => new Date(s);

describe("addRepeat", () => {
  it("steps days and weeks on the user's clock, across a daylight saving change", () => {
    // 9:00 local on Sat 31 Oct 2026 (EDT, UTC-4). Clocks go back on Sun 1 Nov, so 9:00 is then UTC-5.
    expect(addRepeat(d("2026-10-31T13:00:00Z"), { every: 1, unit: "day" }, TO).toISOString()).toBe("2026-11-01T14:00:00.000Z");
    expect(addRepeat(d("2026-10-31T13:00:00Z"), { every: 2, unit: "week" }, TO).toISOString()).toBe("2026-11-14T14:00:00.000Z");
  });
  it("lands a month-end date on the last day of a shorter month", () => {
    expect(addRepeat(d("2026-01-31T15:00:00Z"), { every: 1, unit: "month" }, TO).toISOString()).toBe("2026-02-28T15:00:00.000Z");
    expect(addRepeat(d("2026-11-30T15:00:00Z"), { every: 3, unit: "month" }, TO).toISOString()).toBe("2027-02-28T15:00:00.000Z");
  });
  it("rolls over the year, and keeps Feb 29 on Feb 28 in other years", () => {
    expect(addRepeat(d("2026-12-15T15:00:00Z"), { every: 1, unit: "month" }, TO).toISOString()).toBe("2027-01-15T15:00:00.000Z");
    expect(addRepeat(d("2028-02-29T15:00:00Z"), { every: 1, unit: "year" }, TO).toISOString()).toBe("2029-02-28T15:00:00.000Z");
  });
  it("skips occurrences that already went by", () => {
    const now = d("2026-11-20T00:00:00Z");
    expect(nextOccurrence(d("2026-10-06T13:00:00Z"), { every: 1, unit: "week" }, TO, now).toISOString()).toBe("2026-11-24T14:00:00.000Z");
  });
  it("says it in words", () => {
    expect(describeRepeat({ every: 1, unit: "week" })).toBe("every week");
    expect(describeRepeat({ every: 2, unit: "month" })).toBe("every 2 months");
    expect(describeRepeat(null)).toBeNull();
  });
});

let ctx: Ctx;
let owner: Client;
beforeAll(async () => {
  ctx = await setupApp({ complete: async () => ({ content: [], stopReason: "end_turn", usage: { input: 0, output: 0 } }) as never }, createRegistry());
  owner = (await seedOwner(ctx)).c;
});
afterAll(() => ctx.close());

const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const rowOf = async (id: string) => (await ctx.owner.db.select().from(tasks).where(eq(tasks.id, id)))[0]!;

describe("repeating tasks", () => {
  it("rejects a repeat with nothing to repeat from", async () => {
    const r = await owner.post("/v1/tasks", { title: "Bins", repeat: { every: 1, unit: "week" } });
    expect(r.status).toBe(400);
  });

  it("stays open when done and moves to the next occurrence", async () => {
    const due = iso(1);
    const r = await owner.post("/v1/tasks", { title: "Bins out", dueAt: due, repeat: { every: 1, unit: "week" } });
    expect(r.status).toBe(201);
    expect(r.body.item.repeat).toEqual({ every: 1, unit: "week" });
    const id = r.body.item.id as string;

    const done = await owner.post(`/v1/tasks/${id}/done`);
    expect(done.status).toBe(200);
    const row = await rowOf(id);
    expect(row.status).toBe("open");
    expect(row.completedAt).toBeNull();
    expect(row.dueAt!.getTime()).toBeGreaterThan(new Date(due).getTime() + 6 * 86_400_000);
    expect(row.remindAt!.getTime()).toBe(row.dueAt!.getTime());
    expect(done.body.next).toBe(row.dueAt!.toISOString());
  });

  it("keeps a reminder lead, and restarts the nudges", async () => {
    // Birthday in 10 days, remind 3 days before, every year.
    const due = new Date(Date.now() + 10 * 86_400_000);
    const remind = new Date(due.getTime() - 3 * 86_400_000);
    const r = await owner.post("/v1/tasks", { title: "Mum's birthday", dueAt: due.toISOString(), remindAt: remind.toISOString(), repeat: { every: 1, unit: "year" } });
    const id = r.body.item.id as string;
    await ctx.owner.db.update(tasks).set({ nudgeCount: 3, remindAt: null }).where(eq(tasks.id, id)); // as if every nudge was ignored
    await owner.post(`/v1/tasks/${id}/done`);
    const row = await rowOf(id);
    expect(row.nudgeCount).toBe(0);
    expect(row.dueAt!.getUTCFullYear()).toBe(due.getUTCFullYear() + 1);
    expect(row.dueAt!.getTime() - row.remindAt!.getTime()).toBe(3 * 86_400_000);
  });

  it("with only a reminder time, repeats from it and does not drift when nudged", async () => {
    const at = new Date(Date.now() + 3_600_000);
    const r = await owner.post("/v1/tasks", { title: "Vitamins", remindAt: at.toISOString(), repeat: { every: 1, unit: "day" } });
    const id = r.body.item.id as string;
    expect((await rowOf(id)).dueAt!.getTime()).toBe(at.getTime());
    await ctx.owner.db.update(tasks).set({ remindAt: new Date(at.getTime() + 10 * 60_000), nudgeCount: 1 }).where(eq(tasks.id, id)); // nudged +10 min
    await owner.post(`/v1/tasks/${id}/done`);
    const row = await rowOf(id);
    expect(row.remindAt!.getTime() - at.getTime()).toBe(86_400_000);
  });

  it("finished weeks late, it skips the days that already went by", async () => {
    const r = await owner.post("/v1/tasks", { title: "Water plants", dueAt: iso(1), repeat: { every: 1, unit: "day" } });
    const id = r.body.item.id as string;
    await ctx.owner.db.update(tasks).set({ dueAt: new Date(Date.now() - 20 * 86_400_000), remindAt: null }).where(eq(tasks.id, id));
    await owner.post(`/v1/tasks/${id}/done`);
    const row = await rowOf(id);
    expect(row.dueAt!.getTime()).toBeGreaterThan(Date.now());
    expect(row.dueAt!.getTime()).toBeLessThanOrEqual(Date.now() + 86_400_000);
  });

  it("a one-off still finishes for good", async () => {
    const r = await owner.post("/v1/tasks", { title: "Call the vet", dueAt: iso(1) });
    const id = r.body.item.id as string;
    await owner.post(`/v1/tasks/${id}/done`);
    expect((await rowOf(id)).status).toBe("done");
    expect((await owner.post(`/v1/tasks/${id}/done`)).status).toBe(404);
  });
});
