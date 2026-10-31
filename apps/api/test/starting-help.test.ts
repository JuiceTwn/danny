import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResult } from "../src/brain/model.js";
import { snoozeTarget, localIso } from "../src/lib/time.js";
import { createRegistry } from "../src/tools/builtin.js";
import { seedOwner, setupApp, signUp, type Client, type Ctx } from "./helpers.js";

let ctx: Ctx;
let owner: Client;
let chat: ModelResult[] = [];
const calls: ModelRequest[] = [];
const model: ModelClient = {
  async complete(req, onText) {
    calls.push(JSON.parse(JSON.stringify(req)));
    const res = chat.shift() ?? say("ok");
    for (const b of res.content) if (b.type === "text") onText(b.text);
    return res;
  },
};
beforeAll(async () => {
  ctx = await setupApp(model, createRegistry());
  owner = (await seedOwner(ctx)).c;
});
afterAll(() => ctx.close());
const say = (t: string): ModelResult => ({ content: [{ type: "text", text: t }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } });
const use = (name: string, input: unknown): ModelResult => ({ content: [{ type: "tool_use", id: "t1", name, input }], stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } });

const TZ = "America/Toronto";
// Wednesday 2026-11-04, 10:00 local (EST, UTC-5)
const wed10 = new Date("2026-11-04T15:00:00Z");
const local = (d: Date | null) => (d ? localIso(d, TZ).slice(0, 16) : null);

describe("snooze presets use the person's own clock", () => {
  it("tonight is 7pm, tomorrow is 9am, the weekend is Saturday 9am, monday is the next Monday", () => {
    expect(local(snoozeTarget("tonight", wed10, TZ))).toBe("2026-11-04T19:00");
    expect(local(snoozeTarget("tomorrow", wed10, TZ))).toBe("2026-11-05T09:00");
    expect(local(snoozeTarget("weekend", wed10, TZ))).toBe("2026-11-07T09:00");
    expect(local(snoozeTarget("monday", wed10, TZ))).toBe("2026-11-09T09:00");
    expect(local(snoozeTarget("later", wed10, TZ))).toBe("2026-11-04T13:00");
  });

  it("there is no tonight left after 6pm, and later waits out quiet hours", () => {
    expect(snoozeTarget("tonight", new Date("2026-11-04T23:30:00Z"), TZ)).toBeNull(); // 18:30 local
    // 21:00 local + 3h = midnight, which is quiet: it waits for 07:00
    expect(local(snoozeTarget("later", new Date("2026-11-05T02:00:00Z"), TZ))).toBe("2026-11-05T07:00");
  });

  it("on the weekend, the weekend means next weekend, and on Monday morning monday means next Monday", () => {
    const sat = new Date("2026-11-07T15:00:00Z");
    expect(local(snoozeTarget("weekend", sat, TZ))).toBe("2026-11-14T09:00");
    const mon = new Date("2026-11-09T15:00:00Z");
    expect(local(snoozeTarget("monday", mon, TZ))).toBe("2026-11-16T09:00");
  });

  it("tomorrow keeps 9am across the daylight saving change", () => {
    // Saturday 2026-11-07, the clocks go back on Sunday 2026-11-08
    expect(local(snoozeTarget("tomorrow", new Date("2026-11-07T15:00:00Z"), TZ))).toBe("2026-11-08T09:00");
  });
});

describe("first steps, snoozes and the starting-help setting", () => {
  it("a task keeps its first step (encrypted), and set_first_step changes or clears it", async () => {
    const u = await signUp(ctx, owner, "Sh1");
    const t = (await u.c.post("/v1/tasks", { title: "Sort out taxes", firstStep: "Find last year's return" })).body.item;
    expect(t.firstStep).toBe("Find last year's return");
    expect((await u.c.get("/v1/tasks")).body.items[0].firstStep).toBe("Find last year's return");
    expect((await u.c.req("PUT", `/v1/tasks/${t.id}/first-step`, { step: "Open the tax site" })).status).toBe(200);
    expect((await u.c.get("/v1/tasks")).body.items[0].firstStep).toBe("Open the tax site");
    await u.c.req("PUT", `/v1/tasks/${t.id}/first-step`, { step: "" });
    expect((await u.c.get("/v1/tasks")).body.items[0].firstStep).toBeNull();
    expect((await u.c.req("PUT", `/v1/tasks/${crypto.randomUUID()}/first-step`, { step: "x" })).status).toBe(404);
  });

  it("snoozing with a preset lands on the person's clock and counts how often a task is put off", async () => {
    const u = await signUp(ctx, owner, "Sh2");
    const t = (await u.c.post("/v1/tasks", { title: "Ring the bank" })).body.item;
    const r = await u.c.post(`/v1/tasks/${t.id}/snooze`, { when: "tomorrow" });
    expect(r.status).toBe(200);
    expect(new Date(r.body.remindAt).getTime()).toBeGreaterThan(Date.now());
    await u.c.post(`/v1/tasks/${t.id}/snooze`, { minutes: 30 });
    expect((await u.c.get("/v1/tasks")).body.items[0].snoozeCount).toBe(2);
    expect((await u.c.post(`/v1/tasks/${t.id}/snooze`, { when: "someday" })).status).toBe(400);
  });

  it("a repeating task starts its put-off count again when it rolls over", async () => {
    const u = await signUp(ctx, owner, "Sh3");
    const due = new Date(Date.now() + 3_600_000).toISOString();
    const t = (await u.c.post("/v1/tasks", { title: "Bins", dueAt: due, repeat: { every: 1, unit: "week" } })).body.item;
    await u.c.post(`/v1/tasks/${t.id}/snooze`, { minutes: 20 });
    await u.c.post(`/v1/tasks/${t.id}/done`, {});
    expect((await u.c.get("/v1/tasks")).body.items[0].snoozeCount).toBe(0);
  });

  it("starting help is off until the person turns it on, and only then reaches Danny's prompt", async () => {
    const u = await signUp(ctx, owner, "Sh4");
    expect((await u.c.get("/v1/me")).body.user.adhdMode).toBe(false);
    chat = [say("Hi.")];
    await u.c.req("POST", "/v1/chat", { message: "hello there" });
    const off = calls.filter((c) => c.tools.length).at(-1)!;
    expect(String(off.system)).not.toContain("ADHD-friendly");

    expect((await u.c.patch("/v1/profile", { adhdMode: true })).body.adhdMode).toBe(true);
    expect((await u.c.get("/v1/me")).body.user.adhdMode).toBe(true);
    chat = [say("Hi.")];
    await u.c.req("POST", "/v1/chat", { message: "I can't start anything" });
    const on = calls.filter((c) => c.tools.length).at(-1)!;
    expect(String(on.system)).toContain("ADHD-friendly");
    expect(String(on.system)).toContain("Too big");

    await u.c.patch("/v1/profile", { adhdMode: false });
    expect((await u.c.get("/v1/me")).body.user.adhdMode).toBe(false);
  });

  it("Danny can save a first step and snooze with a preset from chat, and whats_next shows the step on the card", async () => {
    const u = await signUp(ctx, owner, "Sh5");
    chat = [use("add_task", { title: "Do the taxes", first_step: "Find last year's return" }), say("Added.")];
    const ev = (await u.c.req("POST", "/v1/chat", { message: "taxes" })).raw.body;
    expect(ev).toContain("Find last year's return");
    const t = (await u.c.get("/v1/tasks")).body.items[0];
    chat = [use("snooze_task", { id: t.id, when: "tomorrow" }), say("Tomorrow morning.")];
    await u.c.req("POST", "/v1/chat", { message: "not now, tomorrow" });
    const after = (await u.c.get("/v1/tasks")).body.items[0];
    expect(after.snoozeCount).toBe(1);
    expect(new Date(after.remindAt).getTime()).toBeGreaterThan(Date.now());
    chat = [use("snooze_task", { id: t.id }), say("Which?")];
    await u.c.req("POST", "/v1/chat", { message: "snooze it" });
    expect(JSON.stringify(calls.at(-1)!.messages.at(-1))).toContain("either");
  });
});
