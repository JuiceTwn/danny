import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelClient, ModelResult, SearchRequest, SearchResult } from "../src/brain/model.js";
import { withTenant } from "../src/db/client.js";
import { goalMilestones, goals, tasks, users } from "../src/db/schema.js";
import { runDueBriefings, runStalledGoalCheckins, type BackgroundDeps } from "../src/lib/background.js";
import { planFacts, progressOf, type GoalView } from "../src/lib/goals.js";
import type { PushPayload, PushSender, PushSub } from "../src/lib/push.js";
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

type U = Awaited<ReturnType<typeof signUp>>;
const deps = (): BackgroundDeps => ({ db: ctx.runtime.db, vault: ctx.vault, push, config: ctx.config, model });
const reg = createRegistry();
const toolCtx = (u: U): ToolCtx => ({ card: () => {}, workspaceId: u.workspaceId, userId: u.userId, db: ctx.runtime.db, vault: ctx.vault, google: null, tenant: (fn) => withTenant(ctx.runtime.db, u.workspaceId, fn) });
const run = (u: U, tool: string, input: unknown) => reg.get(tool)!.run!(toolCtx(u), reg.get(tool)!.input.parse(input));
const goalsOf = async (u: U) => (await u.c.get("/v1/goals")).body.items as GoalView[];
const idFrom = (s: string) => s.match(/\(([0-9a-f-]{36})\)/)![1]!;

const wedding = (u: U) =>
  run(u, "add_goal", {
    title: "Plan the wedding",
    target_date: "2027-09-18",
    milestones: [{ title: "Venue booked", due_on: "2027-01-31" }, { title: "Invitations sent" }, { title: "Catering chosen" }],
  });

describe("a plan for a goal", () => {
  it("keeps a target date and ordered milestones, and shows them back", async () => {
    const u = await signUp(ctx, owner, "Pl1");
    const said = await wedding(u);
    expect(said).toContain("3 milestones");
    expect(said).toContain("Target 2027-09-18");
    const [g] = await goalsOf(u);
    expect(g).toMatchObject({ title: "Plan the wedding", targetDate: "2027-09-18", openTasks: 0 });
    expect(g!.milestones.map((m) => [m.title, m.dueOn, m.status])).toEqual([["Venue booked", "2027-01-31", "open"], ["Invitations sent", null, "open"], ["Catering chosen", null, "open"]]);
    const listed = await run(u, "list_goals", {});
    expect(listed).toContain("0 of 3 milestones done");
    expect(listed).toContain("next milestone: Venue booked");
    expect(listed).toContain("[ ] Invitations sent");
    expect(listed).toContain("no open tasks linked to it");
    // Milestone titles are encrypted like everything else.
    const [raw] = await ctx.owner.db.select().from(goalMilestones).where(eq(goalMilestones.userId, u.userId));
    expect(raw!.titleEnc.toString("utf8")).not.toContain("Venue");
  });

  it("refuses an impossible date and more than 12 steps, and adds to the end of the plan", async () => {
    const u = await signUp(ctx, owner, "Pl2");
    expect(await run(u, "add_goal", { title: "Bad date", target_date: "2027-02-31" })).toContain("real date");
    expect(() => reg.get("add_goal")!.input.parse({ title: "x", target_date: "next June" })).toThrow();
    const id = idFrom(await run(u, "add_goal", { title: "Learn Spanish", milestones: [{ title: "Basics" }] }));
    expect(await run(u, "add_milestones", { goal_id: id, milestones: [{ title: "Conversations" }, { title: "A trip" }] })).toContain("now has 3 milestones");
    expect((await goalsOf(u))[0]!.milestones.map((m) => m.title)).toEqual(["Basics", "Conversations", "A trip"]);
    const many = Array.from({ length: 10 }, (_, i) => ({ title: `Step ${i}` }));
    expect(await run(u, "add_milestones", { goal_id: id, milestones: many })).toContain("12 milestones at most");
    expect((await goalsOf(u))[0]!.milestones).toHaveLength(3);
    expect(await run(u, "add_milestones", { goal_id: "00000000-0000-4000-8000-000000000000", milestones: [{ title: "x" }] })).toBe("No goal with that id.");
  });

  it("moves or removes the target date from chat", async () => {
    const u = await signUp(ctx, owner, "Pl3");
    const id = idFrom(await wedding(u));
    await run(u, "update_goal", { id, target_date: "2027-10-02" });
    expect((await goalsOf(u))[0]!.targetDate).toBe("2027-10-02");
    await run(u, "update_goal", { id, target_date: null });
    expect((await goalsOf(u))[0]!.targetDate).toBeNull();
  });

  it("ticking a milestone is progress: the goal stops looking quiet and the count moves", async () => {
    const u = await signUp(ctx, owner, "Pl4");
    await wedding(u);
    const [g] = await goalsOf(u);
    await ctx.owner.db.update(goals).set({ touchedAt: new Date("2026-01-01T00:00:00Z"), stallNudgedAt: new Date("2026-02-01T00:00:00Z") }).where(eq(goals.id, g!.id));
    const said = await run(u, "update_milestone", { id: g!.milestones[0]!.id, status: "done" });
    expect(said).toContain("1 of 3 milestones done");
    const [row] = await ctx.owner.db.select().from(goals).where(eq(goals.id, g!.id));
    expect(row!.touchedAt.getFullYear()).toBeGreaterThanOrEqual(2026);
    expect(row!.touchedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(row!.stallNudgedAt).toBeNull();
    const after = (await goalsOf(u))[0]!;
    expect(after.milestones[0]).toMatchObject({ status: "done" });
    expect(await run(u, "update_milestone", { id: g!.milestones[0]!.id, status: "open" })).toContain("0 of 3");
    for (const m of g!.milestones.slice(0, 2)) await run(u, "update_milestone", { id: m.id, status: "done" });
    expect(await run(u, "update_milestone", { id: g!.milestones[2]!.id, status: "done" })).toContain("last one: offer to mark the goal done");
    expect(await run(u, "update_milestone", { id: g!.milestones[2]!.id, remove: true })).toBe("Removed.");
  });

  it("can be ticked from the app, and only by its owner", async () => {
    const a = await signUp(ctx, owner, "Pl5");
    const b = await signUp(ctx, owner, "Pl6");
    await wedding(a);
    const m = (await goalsOf(a))[0]!.milestones[1]!;
    expect((await b.c.patch(`/v1/goals/milestones/${m.id}`, { status: "done" })).status).toBe(404);
    const r = await a.c.patch(`/v1/goals/milestones/${m.id}`, { status: "done" });
    expect(r.status).toBe(200);
    expect(r.body.item.milestones.filter((x: any) => x.status === "done")).toHaveLength(1);
    expect((await a.c.patch(`/v1/goals/milestones/${m.id}`, { status: "later" })).status).toBe(400);
  });
});

describe("tasks that serve a goal", () => {
  it("can be made for a goal and a milestone, and say so in the list", async () => {
    const u = await signUp(ctx, owner, "Tk1");
    await wedding(u);
    const g = (await goalsOf(u))[0]!;
    await run(u, "add_task", { title: "Call the Lakeview barn", goal_id: g.id, milestone_id: g.milestones[0]!.id });
    await run(u, "add_task", { title: "Buy milk" });
    const listed = await run(u, "list_tasks", {});
    expect(listed).toContain("Call the Lakeview barn | for goal: Plan the wedding");
    expect(listed.split("\n").find((l: string) => l.includes("Buy milk"))).not.toContain("for goal");
    expect((await goalsOf(u))[0]!.openTasks).toBe(1);
    expect((await run(u, "list_goals", {}))).toContain("1 open task linked");
    const items = (await u.c.get("/v1/tasks")).body.items;
    expect(items.find((t: any) => t.title === "Call the Lakeview barn")).toMatchObject({ goalId: g.id, goalTitle: "Plan the wedding", milestoneId: g.milestones[0]!.id });
  });

  it("can't be tied to someone else's goal, a done goal, or a milestone of another goal", async () => {
    const u = await signUp(ctx, owner, "Tk2");
    const other = await signUp(ctx, owner, "Tk3");
    await wedding(other);
    const theirs = (await goalsOf(other))[0]!;
    expect(await run(u, "add_task", { title: "Sneaky", goal_id: theirs.id })).toBe("No goal with that id.");
    await wedding(u);
    const mine = (await goalsOf(u))[0]!;
    await run(u, "add_goal", { title: "Run a 10k", milestones: [{ title: "5k" }] });
    const second = (await goalsOf(u)).find((g) => g.title === "Run a 10k")!;
    expect(await run(u, "add_task", { title: "Mixed up", goal_id: mine.id, milestone_id: second.milestones[0]!.id })).toBe("That milestone isn't part of that goal.");
    expect(await run(u, "add_task", { title: "Orphan step", milestone_id: mine.milestones[0]!.id })).toBe("A milestone belongs to a goal: give the goal as well.");
    await run(u, "update_goal", { id: second.id, status: "done" });
    expect(await run(u, "add_task", { title: "Too late", goal_id: second.id })).toBe("That goal is already done.");
    expect((await u.c.get("/v1/tasks")).body.items.map((t: any) => t.title)).toEqual([]);
  });

  it("an existing task can be linked and unlinked", async () => {
    const u = await signUp(ctx, owner, "Tk4");
    await wedding(u);
    const g = (await goalsOf(u))[0]!;
    const t = idFrom(await run(u, "add_task", { title: "Ask Mum about the guest list" }));
    expect(await run(u, "link_task", { task_id: t, goal_id: g.id, milestone_id: g.milestones[1]!.id })).toContain("counts as progress");
    expect((await goalsOf(u))[0]!.openTasks).toBe(1);
    expect(await run(u, "link_task", { task_id: t })).toBe("Unlinked from its goal.");
    expect((await goalsOf(u))[0]!.openTasks).toBe(0);
    expect(await run(u, "link_task", { task_id: "00000000-0000-4000-8000-000000000000", goal_id: g.id })).toBe("No open task with that id.");
  });

  it("finishing one counts as progress, and the last one for a milestone prompts a question rather than ticking it", async () => {
    const u = await signUp(ctx, owner, "Tk5");
    await wedding(u);
    const g = (await goalsOf(u))[0]!;
    const m = g.milestones[0]!;
    const a = idFrom(await run(u, "add_task", { title: "Shortlist venues", goal_id: g.id, milestone_id: m.id }));
    const b = idFrom(await run(u, "add_task", { title: "Visit the top two", goal_id: g.id, milestone_id: m.id }));
    await ctx.owner.db.update(goals).set({ touchedAt: new Date("2026-01-01T00:00:00Z") }).where(eq(goals.id, g.id));

    const first = await run(u, "complete_task", { id: a });
    expect(first).toContain('a step toward the goal "Plan the wedding"');
    expect(first).not.toContain("last open task");
    const [row] = await ctx.owner.db.select().from(goals).where(eq(goals.id, g.id));
    expect(row!.touchedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);

    const last = await run(u, "complete_task", { id: b });
    expect(last).toContain('last open task for the milestone "Venue booked"');
    expect((await goalsOf(u))[0]!.milestones[0]!.status).toBe("open"); // Danny asks; the person decides
  });

  it("a plain task is unaffected", async () => {
    const u = await signUp(ctx, owner, "Tk6");
    const t = idFrom(await run(u, "add_task", { title: "Buy milk" }));
    expect(await run(u, "complete_task", { id: t })).toBe("Marked done.");
  });

  it("removing a milestone leaves its tasks on the goal", async () => {
    const u = await signUp(ctx, owner, "Tk7");
    await wedding(u);
    const g = (await goalsOf(u))[0]!;
    const t = idFrom(await run(u, "add_task", { title: "Taste menus", goal_id: g.id, milestone_id: g.milestones[2]!.id }));
    await run(u, "update_milestone", { id: g.milestones[2]!.id, remove: true });
    const [row] = await ctx.owner.db.select().from(tasks).where(eq(tasks.id, t));
    expect(row).toMatchObject({ goalId: g.id, milestoneId: null });
  });
});

describe("reading a plan", () => {
  const base: GoalView = { id: "g", title: "T", notes: null, targetDate: null, milestones: [], openTasks: 0, watchQuery: null, checkEveryHours: null, status: "open", lastCheckedAt: null, lastFinding: null };
  const ms = (xs: [string, string | null, "open" | "done"][]) => xs.map(([title, dueOn, status], i) => ({ id: `m${i}`, title, position: i, dueOn, status }));

  it("says what is true: days left, overdue, passed, done, nothing linked", () => {
    const g: GoalView = { ...base, targetDate: "2027-03-10", milestones: ms([["Venue", "2027-02-20", "open"], ["Invites", null, "open"], ["Cake", null, "done"]]) };
    const f = planFacts(g, "2027-03-01");
    expect(f).toContain("target date 2027-03-10 (in 9 days)");
    expect(f).toContain("1 of 3 milestones done");
    expect(f).toContain("next milestone: Venue (due 2027-02-20, 9 days ago)");
    expect(f).toContain("OVERDUE: Venue (was due 2027-02-20)");
    expect(f).toContain("no open tasks linked to it");
    expect(planFacts({ ...g, openTasks: 2 }, "2027-03-01")).toContain("2 open tasks linked");
    expect(planFacts(g, "2027-03-11").join(" ")).toContain("PASSED");
    expect(planFacts({ ...g, milestones: ms([["A", null, "done"]]) }, "2027-03-01")).toContain("every milestone is done");
    expect(planFacts(base, "2027-03-01")).toEqual([]);
    expect(progressOf(g, "2027-03-01")).toMatchObject({ done: 1, total: 3, next: { title: "Venue" } });
  });
});

describe("the briefing and the check-in", () => {
  it("the morning brief gets the plan facts, so Danny can say a date is close or a step is late", async () => {
    const u = await signUp(ctx, owner, "Br1");
    await u.c.patch("/v1/profile", { briefingEnabled: true, briefingTime: "07:30" });
    await ctx.owner.db.update(users).set({ timezone: "America/Toronto" }).where(eq(users.id, u.userId));
    await ctx.owner.db.update(users).set({ briefingEnabled: false }).where(eq(users.briefingEnabled, true));
    await ctx.owner.db.update(users).set({ briefingEnabled: true }).where(eq(users.id, u.userId));
    await run(u, "add_goal", { title: "Launch the shop", target_date: "2027-03-10", milestones: [{ title: "Photos done", due_on: "2027-02-20" }, { title: "Site live" }] });
    searches.length = 0;
    await runDueBriefings(deps(), new Date("2027-03-01T13:00:00Z"));
    const p = searches.at(-1)!.prompt;
    expect(p).toContain("Launch the shop");
    expect(p).toContain("target date 2027-03-10 (in 9 days)");
    expect(p).toContain("OVERDUE: Photos done");
    expect(p).toContain("no open tasks linked to it");
    expect(p).toContain("name the next milestone");
  });

  it("the two-week check-in names the next step", async () => {
    const u = await signUp(ctx, owner, "Ck1");
    await ctx.owner.db.update(users).set({ timezone: "America/Toronto" }).where(eq(users.id, u.userId));
    await run(u, "add_goal", { title: "Launch the shop", milestones: [{ title: "Photos done" }, { title: "Site live" }] });
    const [g] = await goalsOf(u);
    await ctx.owner.db.update(goals).set({ touchedAt: new Date("2026-01-01T00:00:00Z") }).where(eq(goals.id, g!.id));
    push.sent = [];
    await runStalledGoalCheckins(deps(), new Date("2026-12-01T17:00:00Z")); // noon in Toronto
    const hist = (await u.c.get("/v1/chat/history")).body.messages.map((m: any) => m.text as string);
    expect(hist.at(-1)).toContain('"Launch the shop" hasn\'t moved in two weeks.');
    expect(hist.at(-1)).toContain('The next step is "Photos done".');
  });
});
