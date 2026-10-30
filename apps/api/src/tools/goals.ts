import { z } from "zod";
import { GOAL_STATUS, GoalError, STEP_STATUS, addSteps, createGoal, listGoals, updateGoal, updateStep, type GoalView } from "../lib/goals.js";
import { defineTool } from "./registry.js";

// A string, not a transform: tool inputs have to be expressible as JSON Schema for the model.
const when = z.string().trim().refine((s) => !Number.isNaN(Date.parse(s)), "use a date like 2026-11-14");
const toDate = (s: string | null | undefined) => (s === undefined ? undefined : s === null ? null : new Date(s));
const stepIn = z.object({ text: z.string().trim().min(1).max(300), due: when.optional() });

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "none");

/** Plain-text view of goals for the model. Ids are real, so the model can act on them. */
export function renderGoals(goals: GoalView[], now = new Date()) {
  if (!goals.length) return "No goals yet.";
  return goals
    .map((g) => {
      const due = g.nextReviewAt <= now ? " REVIEW DUE" : "";
      const steps = g.steps.length
        ? g.steps.map((s) => `    - [${s.status}] ${s.text} (step ${s.id}, due ${day(s.dueAt)}${s.dueAt && s.dueAt < now && s.status !== "done" ? ", OVERDUE" : ""})`).join("\n")
        : "    (no steps yet)";
      return `* ${g.title} (goal ${g.id}, ${g.status}, due ${day(g.dueAt)}, next review ${day(g.nextReviewAt)}${due}, started by ${g.createdBy})\n${g.notes ? `  notes: ${g.notes}\n` : ""}${steps}`;
    })
    .join("\n");
}

/** Limits like "too many goals" go back to the model as plain words, not as a crash. */
async function guard(f: () => Promise<string>) {
  try {
    return await f();
  } catch (e) {
    if (e instanceof GoalError) return e.message;
    throw e;
  }
}

export const listGoalsTool = defineTool({
  name: "list_goals",
  description: "See the user's goals and your plan for each, with ids. Check this before changing a plan.",
  kind: "read",
  input: z.object({ include_closed: z.boolean().optional() }),
  async run(ctx, { include_closed }) {
    return renderGoals(await ctx.tenant((tx) => listGoals(tx, ctx.vault, ctx.workspaceId, { closed: include_closed })));
  },
});

export const setGoal = defineTool({
  name: "set_goal",
  description:
    "Start tracking a goal the user has, or one you see they need. Put in a short plan as steps, each small enough to finish in a sitting. " +
    "You will be woken to review it at review_in_days (default 1). Pick a real date to look again, not a habit.",
  kind: "internal",
  input: z.object({
    title: z.string().trim().min(1).max(200),
    notes: z.string().trim().max(2000).optional().describe("Why it matters, constraints, what done looks like."),
    due: when.optional(),
    review_in_days: z.number().min(0).max(60).optional(),
    steps: z.array(stepIn).max(15).optional(),
  }),
  async run(ctx, i) {
    return guard(async () => {
      const id = await ctx.tenant((tx) =>
        createGoal(tx, ctx.vault, ctx, {
          title: i.title,
          notes: i.notes,
          dueAt: toDate(i.due),
          reviewInDays: i.review_in_days,
          steps: i.steps?.map((s) => ({ text: s.text, dueAt: toDate(s.due) })),
          createdBy: ctx.actor ?? "user",
        }),
      );
      return `Goal saved (${id}).`;
    });
  },
});

export const updateGoalTool = defineTool({
  name: "update_goal",
  description:
    "Change a goal: mark it done or dropped, rewrite your notes, move its due date, or set when you will next review it. " +
    "Use notes to leave yourself a line about where things stand, because you will not remember this conversation on the next review.",
  kind: "internal",
  input: z.object({
    goal_id: z.uuid(),
    status: z.enum(GOAL_STATUS).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    notes: z.string().trim().max(2000).optional(),
    due: when.nullable().optional(),
    review_in_days: z.number().min(0).max(60).optional(),
  }),
  async run(ctx, i) {
    return guard(async () => {
      const ok = await ctx.tenant((tx) =>
        updateGoal(tx, ctx.vault, ctx, i.goal_id, { title: i.title, notes: i.notes, status: i.status, dueAt: toDate(i.due), reviewInDays: i.review_in_days }, ctx.actor ?? "user"),
      );
      return ok ? "Updated." : "No goal with that id.";
    });
  },
});

export const addStepsTool = defineTool({
  name: "add_steps",
  description: "Add steps to a goal's plan.",
  kind: "internal",
  input: z.object({ goal_id: z.uuid(), steps: z.array(stepIn).min(1).max(10) }),
  async run(ctx, i) {
    return guard(async () => {
      const ok = await ctx.tenant((tx) => addSteps(tx, ctx.vault, ctx, i.goal_id, i.steps.map((s) => ({ text: s.text, dueAt: toDate(s.due) }))));
      return ok ? `Added ${i.steps.length}.` : "No goal with that id.";
    });
  },
});

export const updateStepTool = defineTool({
  name: "update_step",
  description: "Mark a step todo, doing, done or blocked, or reword it or move its due date. Mark blocked when you are waiting on the user or someone else.",
  kind: "internal",
  input: z.object({ step_id: z.uuid(), status: z.enum(STEP_STATUS).optional(), text: z.string().trim().min(1).max(300).optional(), due: when.nullable().optional() }),
  async run(ctx, i) {
    const row = await ctx.tenant((tx) => updateStep(tx, ctx.vault, ctx, i.step_id, { status: i.status, text: i.text, dueAt: toDate(i.due) }));
    return row ? "Updated." : "No step with that id.";
  },
});

export const goalTools = [listGoalsTool, setGoal, updateGoalTool, addStepsTool, updateStepTool];
