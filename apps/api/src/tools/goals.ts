import { z } from "zod";
import { createGoal, GoalError, listGoals, logProgress, MAX_CHECK_HOURS, MIN_CHECK_HOURS, updateGoal, type GoalView } from "../lib/goals.js";
import { sourceList, WEB_FRAME } from "../lib/search.js";
import { defineTool } from "./registry.js";

const guard = async (f: () => Promise<string>) => {
  try {
    return await f();
  } catch (e) {
    if (e instanceof GoalError) return e.message;
    throw e;
  }
};

const hours = z.number().int().min(MIN_CHECK_HOURS).max(MAX_CHECK_HOURS);

const line = (g: GoalView) =>
  [
    `${g.id} | ${g.title} | ${g.status}`,
    g.notes && `  notes: ${g.notes}`,
    g.checkEveryHours && `  watching every ${g.checkEveryHours}h${g.watchQuery ? ` for: ${g.watchQuery}` : ""}`,
    g.lastFinding && `  last finding: ${g.lastFinding.slice(0, 300)}`,
  ]
    .filter(Boolean)
    .join("\n");

export const addGoal = defineTool({
  name: "add_goal",
  description:
    "Save something the user is working toward: a job search, a move, a purchase, a project, a habit. Use it when they say they are looking into or trying to do something that will take more than a day. " +
    "`notes` holds what good looks like (location, industry, budget, deal-breakers), in their words. " +
    "To have Danny check the web on a schedule, set `check_every_hours` (24 is daily) and `watch_query` (a good search phrase). Only watch things where new information would change what they do. Each check costs a few cents.",
  kind: "internal",
  input: z.object({
    title: z.string().trim().min(1).max(200),
    notes: z.string().trim().max(1500).optional(),
    watch_query: z.string().trim().max(300).optional(),
    check_every_hours: hours.optional(),
  }),
  run: (ctx, i) =>
    guard(async () => {
      const g = await createGoal(ctx, { title: i.title, notes: i.notes, watchQuery: i.watch_query, checkEveryHours: i.check_every_hours });
      return `Goal saved (${g.id}).${g.checkEveryHours ? ` Will check the web every ${g.checkEveryHours}h and only speak up when there is something new.` : " Not being watched."}`;
    }),
});

export const listGoalsTool = defineTool({
  name: "list_goals",
  description: "List the user's goals with their notes and what was last found. Use it before updating one, and when they ask how a goal is going.",
  kind: "read",
  input: z.object({}),
  run: async (ctx) => {
    const all = await listGoals(ctx);
    return all.length ? all.map(line).join("\n") : "No goals yet.";
  },
});

export const updateGoalTool = defineTool({
  name: "update_goal",
  description:
    "Change a goal. Take the id from list_goals. Set `status` to done when they have reached it, or paused to stop work on it for now. " +
    "Set `check_every_hours` to start or change watching, or null to stop watching. Update `notes` when they tell you more about what they want.",
  kind: "internal",
  input: z.object({
    id: z.uuid(),
    title: z.string().trim().min(1).max(200).optional(),
    notes: z.string().trim().max(1500).nullable().optional(),
    watch_query: z.string().trim().max(300).nullable().optional(),
    check_every_hours: hours.nullable().optional(),
    status: z.enum(["open", "paused", "done"]).optional(),
  }),
  run: (ctx, i) =>
    guard(async () => {
      const g = await updateGoal(ctx, i.id, { title: i.title, notes: i.notes, watchQuery: i.watch_query, checkEveryHours: i.check_every_hours, status: i.status });
      return g ? `Updated. ${g.title} is ${g.status}${g.checkEveryHours ? `, watched every ${g.checkEveryHours}h` : ", not watched"}.` : "No goal with that id.";
    }),
});

export const goalProgress = defineTool({
  name: "goal_progress",
  description:
    "Record that the user did something toward a goal, or tell you how it is going: applied to a job, viewed a flat, saved money. One short sentence in `note`. " +
    "Do this whenever they mention progress, even in passing. Goals with no progress for two weeks make Danny check in. Take the id from list_goals.",
  kind: "internal",
  input: z.object({ id: z.uuid(), note: z.string().trim().min(1).max(300) }),
  run: async (ctx, { id, note }) => ((await logProgress(ctx, id, note)) ? "Noted." : "No goal with that id."),
});

export const searchWeb = defineTool({
  name: "search_web",
  description:
    "Look something up on the live web: news, prices, listings, facts that change. Write `question` as a complete question with any place, date or constraint. " +
    "Each search costs money, so do not use it for things you already know or things in the user's memory. Summarise what you find in a few short sentences and give the source.",
  kind: "read",
  input: z.object({ question: z.string().trim().min(3).max(400) }),
  run: async (ctx, { question }) => {
    if (!ctx.search) return "Web search isn't available.";
    const r = await ctx.search(question);
    return r.ok ? `${WEB_FRAME}\n\n${r.text || "Nothing found."}${sourceList(r.sources, r.text)}` : r.reason;
  },
});

export const goalTools = [addGoal, listGoalsTool, updateGoalTool, goalProgress, searchWeb];
