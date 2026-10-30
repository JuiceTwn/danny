import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runAgent, wakeReason } from "../src/brain/agent.js";
import { tick } from "../src/brain/heartbeat.js";
import type { ModelClient, ModelRequest, ModelResult } from "../src/brain/model.js";
import { withTenant } from "../src/db/client.js";
import { approvals, auditLog, goalSteps, goals, spendLedger, workspaces } from "../src/db/schema.js";
import { listGoals } from "../src/lib/goals.js";
import { createRegistry } from "../src/tools/builtin.js";
import { seedOwner, setupApp, signUp, type Client, type Ctx } from "./helpers.js";

const text = (t: string, inT = 1000, outT = 200): ModelResult => ({ content: [{ type: "text", text: t }], stopReason: "end_turn", usage: { inputTokens: inT, outputTokens: outT } });
const use = (name: string, input: unknown, id = "tu_" + name): ModelResult => ({ content: [{ type: "tool_use", id, name, input }], stopReason: "tool_use", usage: { inputTokens: 1000, outputTokens: 200 } });

let script: (ModelResult | Error)[] = [];
let respond: ((req: ModelRequest) => ModelResult | Error) | null = null; // for tests where the order of calls isn't fixed
const requests: ModelRequest[] = [];
const model: ModelClient = {
  async complete(req) {
    requests.push(JSON.parse(JSON.stringify(req)));
    const step = respond ? respond(req) : script.shift();
    if (!step) throw new Error("script ran out");
    if (step instanceof Error) throw step;
    return step;
  },
};

let ctx: Ctx;
let owner: Client;
beforeAll(async () => {
  ctx = await setupApp(model, createRegistry());
  owner = (await seedOwner(ctx)).c;
});
afterAll(() => ctx.close());
afterEach(() => {
  script = [];
  respond = null;
  requests.length = 0;
  vi.unstubAllGlobals();
});

type User = Awaited<ReturnType<typeof signUp>>;
const who = (u: User) => ({ workspaceId: u.workspaceId, userId: u.userId });
const tenant = <T>(u: User, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(ctx.runtime.db, u.workspaceId, fn);

/** A signed-up user with Danny's autonomy on and one goal whose review is due. */
async function bossWithDueGoal(name = "Boss") {
  const u = await signUp(ctx, owner, name);
  expect((await u.c.patch("/v1/settings", { agentEnabled: true })).body.agentEnabled).toBe(true);
  const created = await u.c.post("/v1/goals", { title: `Land three new GBP clients (${name})`, notes: "Local plumbers in Barrie", steps: [{ text: "List 20 plumbers" }] });
  expect(created.status).toBe(201);
  await makeDue(u);
  return { u, goalId: created.body.item.id as string };
}
const makeDue = (u: User) => ctx.owner.db.update(goals).set({ nextReviewAt: new Date(Date.now() - 60_000) }).where(eq(goals.workspaceId, u.workspaceId));
const clearGap = (u: User) => ctx.owner.db.update(workspaces).set({ agentLastRunAt: null }).where(eq(workspaces.id, u.workspaceId));
const history = async (u: User) => (await u.c.get("/v1/chat/history")).body.messages as { role: string; text: string }[];
const runs = (u: User) => ctx.owner.db.select().from(auditLog).where(and(eq(auditLog.workspaceId, u.workspaceId), eq(auditLog.action, "agent.run")));

describe("goals", () => {
  it("are created, planned and updated through the API, and come back with their steps", async () => {
    const u = await signUp(ctx, owner, "Goals");
    const g = (await u.c.post("/v1/goals", { title: "Redo the Hendricks site", due: "2026-12-01", steps: [{ text: "Get logo files" }, { text: "Draft homepage", due: "2026-11-10" }] })).body.item;
    expect(g).toMatchObject({ title: "Redo the Hendricks site", status: "active", createdBy: "user" });
    expect(g.steps.map((s: any) => [s.text, s.status])).toEqual([["Get logo files", "todo"], ["Draft homepage", "todo"]]);
    // a step due before the default first look pulls the first review in; otherwise it is tomorrow
    expect(new Date(g.nextReviewAt).getTime()).toBeLessThan(Date.now() + 86_400_000 + 5000);

    expect((await u.c.post(`/v1/goals/${g.id}/steps`, { steps: [{ text: "Send proof" }] })).status).toBe(201);
    expect((await u.c.patch(`/v1/goals/${g.id}/steps/${g.steps[0].id}`, { status: "done" })).status).toBe(200);
    expect((await u.c.patch(`/v1/goals/${g.id}`, { notes: "Waiting on logo" })).status).toBe(200);
    const list = (await u.c.get("/v1/goals")).body.items;
    expect(list).toHaveLength(1);
    expect(list[0].notes).toBe("Waiting on logo");
    expect(list[0].steps.map((s: any) => s.status)).toEqual(["done", "todo", "todo"]);

    await u.c.patch(`/v1/goals/${g.id}`, { status: "done" });
    expect((await u.c.get("/v1/goals")).body.items).toHaveLength(0);
    expect((await u.c.get("/v1/goals?closed=true")).body.items).toHaveLength(1);
  });

  it("are encrypted at rest and invisible to other workspaces", async () => {
    const a = await signUp(ctx, owner, "Alice");
    const b = await signUp(ctx, owner, "Bob");
    const g = (await a.c.post("/v1/goals", { title: "Quietly buy out Hendricks Plumbing", steps: [{ text: "Ask Marlene about the books" }] })).body.item;

    const [row] = await ctx.owner.db.select().from(goals).where(eq(goals.id, g.id));
    const [step] = await ctx.owner.db.select().from(goalSteps).where(eq(goalSteps.goalId, g.id));
    expect(row!.titleEnc.toString("utf8")).not.toContain("Hendricks");
    expect(step!.textEnc.toString("utf8")).not.toContain("Marlene");

    expect((await b.c.get("/v1/goals")).body.items).toEqual([]);
    expect((await b.c.patch(`/v1/goals/${g.id}`, { status: "dropped" })).status).toBe(404);
    expect((await b.c.patch(`/v1/goals/${g.id}/steps/${g.steps[0].id}`, { status: "done" })).status).toBe(404);
    expect((await b.c.post(`/v1/goals/${g.id}/steps`, { steps: [{ text: "x" }] })).status).toBe(404);
    // even a query with no filter, run as the other workspace, sees nothing
    expect(await tenant(b, (tx) => tx.select().from(goals))).toEqual([]);
    expect((await a.c.get("/v1/goals")).body.items).toHaveLength(1);
  });

  it("stop at 12 active goals and 15 steps, with a plain message", async () => {
    const u = await signUp(ctx, owner, "Limits");
    for (let i = 0; i < 12; i++) expect((await u.c.post("/v1/goals", { title: `g${i}` })).status).toBe(201);
    const over = await u.c.post("/v1/goals", { title: "one too many" });
    expect(over.status).toBe(409);
    expect(over.body.message).toMatch(/12 active goals/);
    const first = (await u.c.get("/v1/goals")).body.items[0];
    const steps = Array.from({ length: 16 }, (_, i) => ({ text: `s${i}` }));
    expect((await u.c.post(`/v1/goals/${first.id}/steps`, { steps: steps.slice(0, 10) })).status).toBe(201);
    expect((await u.c.post(`/v1/goals/${first.id}/steps`, { steps: steps.slice(0, 6) })).status).toBe(409);
  });

  it("can be started from chat when the user says what they want", async () => {
    const u = await signUp(ctx, owner, "Chatgoal");
    script = [use("set_goal", { title: "Get Marlene's invoice paid", review_in_days: 3, steps: [{ text: "Send a reminder" }] }), text("On it.")];
    await u.c.req("POST", "/v1/chat", { message: "I need Marlene's invoice paid" });
    const [g] = (await u.c.get("/v1/goals")).body.items;
    expect(g).toMatchObject({ title: "Get Marlene's invoice paid", createdBy: "user" });
    expect(g.steps).toHaveLength(1);
    // and the goal is in front of the model on the next turn
    script = [text("Right.")];
    await u.c.req("POST", "/v1/chat", { message: "how's that going" });
    expect(requests.at(-1)!.system).toContain("Get Marlene's invoice paid");
  });
});

describe("waking up", () => {
  it("costs nothing to check, and only has a reason when a review is due or a card was decided", async () => {
    const u = await signUp(ctx, owner, "Wake");
    expect(await wakeReason(ctx.deps, u.workspaceId)).toBeNull();
    await u.c.post("/v1/goals", { title: "Something", review_in_days: 7 });
    expect(await wakeReason(ctx.deps, u.workspaceId)).toBeNull(); // first look is tomorrow
    await makeDue(u);
    expect(await wakeReason(ctx.deps, u.workspaceId)).toBe("due");
    expect(requests).toHaveLength(0); // no model call to find out

    await ctx.owner.db.update(goals).set({ nextReviewAt: new Date(Date.now() + 5 * 86_400_000) }).where(eq(goals.workspaceId, u.workspaceId));
    await ctx.owner.db.update(workspaces).set({ agentLastRunAt: new Date(Date.now() - 3_600_000) }).where(eq(workspaces.id, u.workspaceId));
    const card = (await u.c.post("/v1/approvals", { kind: "note", title: "x", payload: { draft: "y" } })).body.item;
    await u.c.post(`/v1/approvals/${card.id}/decision`, { decision: "approve" });
    expect(await wakeReason(ctx.deps, u.workspaceId)).toBe("approval_decided");
  });
});

describe("a review", () => {
  it("replans, drafts for approval, tells the boss what happened, and is billed at the planner's price", async () => {
    const { u, goalId } = await bossWithDueGoal("Review");
    script = [
      use("add_steps", { goal_id: goalId, steps: [{ text: "Call the 5 closest plumbers", due: "2026-11-05" }] }, "a"),
      use("request_approval", { kind: "email", title: "Pitch to Barrie Plumbing", draft: "Hi, I noticed your Google listing..." }, "b"),
      use("update_goal", { goal_id: goalId, notes: "Pitch drafted for Barrie Plumbing, waiting on boss", review_in_days: 3 }, "c"),
      text("Added a call list step. Drafted a pitch to Barrie Plumbing. Needs your tap."),
    ];
    const r = await runAgent(ctx.deps, who(u), "due");
    expect(r).toMatchObject({ ran: true, message: "Added a call list step. Drafted a pitch to Barrie Plumbing. Needs your tap.", steps: 4 });

    const [g] = await tenant(u, (tx) => listGoals(tx, ctx.vault, u.workspaceId));
    expect(g!.steps.map((s) => s.text)).toEqual(["List 20 plumbers", "Call the 5 closest plumbers"]);
    expect(g!.notes).toContain("waiting on boss");
    expect(g!.nextReviewAt.getTime()).toBeGreaterThan(Date.now() + 2 * 86_400_000); // he rescheduled it himself

    const cards = (await u.c.get("/v1/approvals?status=pending")).body.items;
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ title: "Pitch to Barrie Plumbing", executed: false });

    // the boss finds it in the chat, from Danny
    expect((await history(u)).at(-1)).toEqual({ role: "assistant", text: "Added a call list step. Drafted a pitch to Barrie Plumbing. Needs your tap.", at: expect.anything() });

    // the planner model and its price: 4 calls x (1000 in x $2 + 200 out x $10)/1M = $0.016
    expect(requests.every((q) => q.model === "claude-sonnet-5-5")).toBe(true);
    const spent = await ctx.owner.db.select({ m: spendLedger.model, c: spendLedger.costMicros }).from(spendLedger).where(eq(spendLedger.workspaceId, u.workspaceId));
    expect(spent.reduce((a, s) => a + s.c, 0)).toBe(16_000);
    expect(spent.every((s) => s.m === "claude-sonnet-5-5")).toBe(true);
    expect((await runs(u))[0]!.detail).toMatchObject({ trigger: "due", costMicros: 16_000, spoke: true });
  });

  it("stays quiet when there is nothing worth the boss's time, and doesn't wake again next tick", async () => {
    const { u } = await bossWithDueGoal("Quiet");
    script = [text("NOTHING")];
    const before = (await history(u)).length;
    expect(await runAgent(ctx.deps, who(u), "due")).toMatchObject({ ran: true, message: null });
    expect(await history(u)).toHaveLength(before);
    // he did not reschedule, so the goal was pushed out a day rather than left due
    expect(await wakeReason(ctx.deps, u.workspaceId)).toBeNull();
  });

  it("can draft but never send: an email goes to a card, and nothing leaves the building", async () => {
    const { u } = await bossWithDueGoal("Nosend");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await u.c.post("/v1/connections", { provider: "resend", label: "mail", secret: JSON.stringify({ apiKey: "re_test", from: "Justin <j@x.ca>" }) });
    script = [use("send_email", { to: "marlene@x.ca", subject: "Invoice 114", body: "Friendly nudge" }), text("Drafted a nudge to Marlene.")];
    await runAgent(ctx.deps, who(u), "due");
    expect(fetchSpy).not.toHaveBeenCalled();
    const [a] = await ctx.owner.db.select().from(approvals).where(eq(approvals.workspaceId, u.workspaceId));
    expect(a).toMatchObject({ kind: "send_email", status: "pending", executedAt: null });
  });

  it("will not stack more than 8 cards on the boss", async () => {
    const { u } = await bossWithDueGoal("Pile");
    for (let i = 0; i < 7; i++) await u.c.post("/v1/approvals", { kind: "note", title: `old ${i}`, payload: { draft: "x" } });
    script = [
      { content: [1, 2, 3].map((n) => ({ type: "tool_use" as const, id: `t${n}`, name: "request_approval", input: { kind: "note", title: `new ${n}`, draft: "d" } })), stopReason: "tool_use", usage: { inputTokens: 100, outputTokens: 10 } },
      text("NOTHING"),
    ];
    await runAgent(ctx.deps, who(u), "due");
    expect((await u.c.get("/v1/approvals?status=pending")).body.items).toHaveLength(8); // 7 + only 1 of 3
    const toolResults = (requests[1]!.messages.at(-1)!.content as any[]).map((b) => b.is_error === true);
    expect(toolResults).toEqual([false, true, true]);
  });

  it("respects the kill switch, the daily cap, the run limit and the minimum gap", async () => {
    const { u } = await bossWithDueGoal("Leash");

    await u.c.patch("/v1/settings", { killSwitch: true });
    expect(await runAgent(ctx.deps, who(u), "due")).toEqual({ ran: false, reason: "kill_switch" });
    await u.c.patch("/v1/settings", { killSwitch: false, dailyCapUsd: 0.01 });
    await tenant(u, (tx) => tx.insert(spendLedger).values({ workspaceId: u.workspaceId, model: "m", costMicros: 10_000 }));
    expect(await runAgent(ctx.deps, who(u), "due")).toEqual({ ran: false, reason: "cap_reached" });
    await u.c.patch("/v1/settings", { dailyCapUsd: 5, agentRunsPerDay: 2 });
    expect(requests).toHaveLength(0);

    script = [text("NOTHING"), text("NOTHING"), text("NOTHING")];
    expect((await runAgent(ctx.deps, who(u), "due")).ran).toBe(true);
    expect(await runAgent(ctx.deps, who(u), "due")).toEqual({ ran: false, reason: "recent" }); // too soon
    await clearGap(u);
    expect((await runAgent(ctx.deps, who(u), "due")).ran).toBe(true);
    await clearGap(u);
    expect(await runAgent(ctx.deps, who(u), "due")).toEqual({ ran: false, reason: "run_limit" });
    expect(requests).toHaveLength(2);
  });

  it("does nothing on its own when autonomy is off, but the boss can still ask for a review", async () => {
    const u = await signUp(ctx, owner, "Off");
    await u.c.post("/v1/goals", { title: "g" });
    await makeDue(u);
    expect(await runAgent(ctx.deps, who(u), "due")).toEqual({ ran: false, reason: "disabled" });
    script = [text("Nothing moved. Waiting on you for the logo.")];
    const manual = await u.c.post("/v1/agent/run");
    expect(manual.body).toMatchObject({ ran: true, message: "Nothing moved. Waiting on you for the logo." });
  });

  it("reports a failed model call without charging or looping", async () => {
    const { u } = await bossWithDueGoal("Fail");
    script = [new Error("overloaded")];
    expect(await runAgent(ctx.deps, who(u), "due")).toEqual({ ran: false, reason: "model_failed" });
    expect(await ctx.owner.db.select().from(spendLedger).where(eq(spendLedger.workspaceId, u.workspaceId))).toHaveLength(0);
    expect(await wakeReason(ctx.deps, u.workspaceId)).toBeNull(); // pushed out, not retried every tick
  });

  it("only sees its own workspace's goals", async () => {
    const a = await bossWithDueGoal("Ws-a");
    const b = await signUp(ctx, owner, "Ws-b");
    await b.c.post("/v1/goals", { title: "Bob's secret plan" });
    script = [text("NOTHING")];
    await runAgent(ctx.deps, who(a.u), "due");
    expect(requests[0]!.messages[0]!.content).toContain("Land three new GBP clients");
    expect(requests[0]!.messages[0]!.content).not.toContain("Bob's secret plan");
  });
});

describe("the scheduler pass", () => {
  it("wakes only workspaces that are on and have a reason, and one failure doesn't stop the rest", async () => {
    const off = await signUp(ctx, owner, "Tick-off");
    await off.c.post("/v1/goals", { title: "g" });
    await makeDue(off);
    const idle = await signUp(ctx, owner, "Tick-idle");
    await idle.c.patch("/v1/settings", { agentEnabled: true });
    const bad = await bossWithDueGoal("Tick-bad");
    const good = await bossWithDueGoal("Tick-good");

    respond = (req) => (JSON.stringify(req.messages).includes("(Tick-bad)") ? new Error("boom") : text("Moved things along."));
    const res = await tick(ctx.deps, new Date(), { error: vi.fn() });
    // the model failing for one workspace is reported as "didn't run", not thrown, and the other still ran
    expect((await runs(good.u)).length).toBe(1);
    expect((await runs(bad.u)).length).toBe(1);
    expect((await history(good.u)).at(-1)!.text).toBe("Moved things along.");
    expect((await runs(off)).length).toBe(0);
    expect((await runs(idle)).length).toBe(0);
    expect(res.failed).toBe(0);
    expect(requests.some((r) => JSON.stringify(r.messages).includes("(Tick-off)"))).toBe(false);
  });
});

describe("approving an email", () => {
  async function pendingEmail(u: User, over: Record<string, unknown> = {}) {
    const payload = { to: "marlene@x.ca", subject: "Invoice 114", body: "Hi Marlene, a nudge on invoice 114.", ...over };
    return (await u.c.post("/v1/approvals", { kind: "send_email", title: "Email to marlene@x.ca: Invoice 114", payload })).body.item.id as string;
  }
  const link = (u: User) => u.c.post("/v1/connections", { provider: "resend", label: "Justin", secret: JSON.stringify({ apiKey: "re_secret", from: "Justin <justin@x.ca>" }) });
  const ok = () => vi.fn(async () => new Response(JSON.stringify({ id: "em_1" }), { status: 200 }));

  it("sends exactly once, from the linked account, and says so", async () => {
    const u = await signUp(ctx, owner, "Send");
    await link(u);
    const f = ok();
    vi.stubGlobal("fetch", f);
    const id = await pendingEmail(u);
    const res = await u.c.post(`/v1/approvals/${id}/decision`, { decision: "approve" });
    expect(res.body.note).toBe("Sent to marlene@x.ca.");
    expect(res.body.item.executed).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer re_secret");
    expect(JSON.parse(init.body as string)).toEqual({ from: "Justin <justin@x.ca>", to: ["marlene@x.ca"], subject: "Invoice 114", text: "Hi Marlene, a nudge on invoice 114." });

    // a second tap, or a replay, cannot send it again
    expect((await u.c.post(`/v1/approvals/${id}/decision`, { decision: "approve" })).status).toBe(409);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("does not send on change-request or drop", async () => {
    const u = await signUp(ctx, owner, "Nosendyet");
    await link(u);
    const f = ok();
    vi.stubGlobal("fetch", f);
    for (const decision of ["changes", "drop"]) {
      const res = await u.c.post(`/v1/approvals/${await pendingEmail(u)}/decision`, { decision });
      expect(res.body).toMatchObject({ note: "Recorded. Nothing has been sent.", item: { executed: false } });
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("says nothing was sent when no email account is linked, or the service refuses", async () => {
    const u = await signUp(ctx, owner, "Noacct");
    const f = vi.fn(async () => new Response("no", { status: 403 }));
    vi.stubGlobal("fetch", f);
    const none = await u.c.post(`/v1/approvals/${await pendingEmail(u)}/decision`, { decision: "approve" });
    expect(none.body.note).toMatch(/Nothing was sent: no email account is linked/);
    expect(none.body.item).toMatchObject({ status: "approved", executed: false });
    expect(f).not.toHaveBeenCalled();

    await link(u);
    const refused = await u.c.post(`/v1/approvals/${await pendingEmail(u)}/decision`, { decision: "approve" });
    expect(refused.body.note).toMatch(/Nothing was sent: the email service refused it \(403\)/);
    expect(refused.body.item.executed).toBe(false);
    expect(JSON.stringify(refused.body)).not.toContain("re_secret");
  });

  it("refuses a malformed draft, and plain notes stay recorded-only", async () => {
    const u = await signUp(ctx, owner, "Bad");
    await link(u);
    const f = ok();
    vi.stubGlobal("fetch", f);
    const bad = await u.c.post(`/v1/approvals/${await pendingEmail(u, { to: "not-an-email" })}/decision`, { decision: "approve" });
    expect(bad.body.note).toMatch(/malformed/);
    const note = (await u.c.post("/v1/approvals", { kind: "note", title: "Remember to call", payload: { draft: "x" } })).body.item.id;
    expect((await u.c.post(`/v1/approvals/${note}/decision`, { decision: "approve" })).body.note).toBe("Recorded. Nothing has been sent.");
    expect(f).not.toHaveBeenCalled();
  });

  it("stops at 20 emails a day", async () => {
    const u = await signUp(ctx, owner, "Daily");
    await link(u);
    vi.stubGlobal("fetch", ok());
    await tenant(u, (tx) => tx.insert(auditLog).values(Array.from({ length: 20 }, () => ({ workspaceId: u.workspaceId, action: "email.sent" }))));
    const res = await u.c.post(`/v1/approvals/${await pendingEmail(u)}/decision`, { decision: "approve" });
    expect(res.body.note).toMatch(/daily limit of 20/);
    expect(res.body.item.executed).toBe(false);
    void sql;
  });
});
