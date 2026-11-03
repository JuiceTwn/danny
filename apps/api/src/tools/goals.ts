import { z } from "zod";
import { addMilestones, createGoal, GoalError, listGoals, logProgress, MAX_CHECK_HOURS, MAX_MILESTONES, MIN_CHECK_HOURS, planFacts, removeMilestone, todayFor, updateGoal, updateMilestone, type GoalView } from "../lib/goals.js";
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

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const step = z.object({ title: z.string().trim().min(1).max(200), due_on: date.optional() });

const line = (g: GoalView, today: string) =>
  [
    `${g.id} | ${g.title} | ${g.status}`,
    g.notes && `  notes: ${g.notes}`,
    ...planFacts(g, today).map((f) => `  ${f}`),
    ...g.milestones.map((m) => `  - ${m.id} | ${m.status === "done" ? "[x]" : "[ ]"} ${m.title}${m.dueOn ? ` (due ${m.dueOn})` : ""}`),
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
    "To have Danny check the web on a schedule, set `check_every_hours` (24 is daily) and `watch_query` (a good search phrase). Only watch things where new information would change what they do. Each check costs a few cents. " +
    `If there is a deadline ("by June", "before the wedding"), set \`target_date\` (YYYY-MM-DD, worked out from today's date in the system prompt). For anything with several stages, also pass \`milestones\`: 3 to 6 short steps in order, each an outcome ("Venue booked"), not a task. Up to ${MAX_MILESTONES}. Put a \`due_on\` on one only when there is a real reason for that date.`,
  kind: "internal",
  input: z.object({
    title: z.string().trim().min(1).max(200),
    notes: z.string().trim().max(1500).optional(),
    watch_query: z.string().trim().max(300).optional(),
    check_every_hours: hours.optional(),
    target_date: date.optional(),
    milestones: z.array(step).max(MAX_MILESTONES).optional(),
  }),
  run: (ctx, i) =>
    guard(async () => {
      const g = await createGoal(ctx, { title: i.title, notes: i.notes, watchQuery: i.watch_query, checkEveryHours: i.check_every_hours, targetDate: i.target_date, milestones: i.milestones?.map((m) => ({ title: m.title, dueOn: m.due_on })) });
      return `Goal saved (${g.id}).${g.milestones.length ? ` ${g.milestones.length} milestones.` : ""}${g.targetDate ? ` Target ${g.targetDate}.` : ""}${g.checkEveryHours ? ` Will check the web every ${g.checkEveryHours}h and only speak up when there is something new.` : " Not being watched."}`;
    }),
});

export const listGoalsTool = defineTool({
  name: "list_goals",
  description:
    "List the user's goals with their notes, target date, milestones (with ids and ticks), how many tasks are linked, and what was last found. Use it before updating one or linking a task to one, and when they ask how a goal is going: give the honest picture in a few lines, including a passed or close target date, an overdue milestone, or a goal with no tasks moving it.",
  kind: "read",
  input: z.object({}),
  run: async (ctx) => {
    const [all, today] = await Promise.all([listGoals(ctx), todayFor(ctx)]);
    return all.length ? all.map((g) => line(g, today)).join("\n") : "No goals yet.";
  },
});

export const updateGoalTool = defineTool({
  name: "update_goal",
  description:
    "Change a goal. Take the id from list_goals. Set `status` to done when they have reached it, or paused to stop work on it for now. " +
    "Set `check_every_hours` to start or change watching, or null to stop watching. Update `notes` when they tell you more about what they want. `target_date` (YYYY-MM-DD) sets or moves the deadline; null removes it.",
  kind: "internal",
  input: z.object({
    id: z.uuid(),
    title: z.string().trim().min(1).max(200).optional(),
    notes: z.string().trim().max(1500).nullable().optional(),
    watch_query: z.string().trim().max(300).nullable().optional(),
    check_every_hours: hours.nullable().optional(),
    status: z.enum(["open", "paused", "done"]).optional(),
    target_date: date.nullable().optional(),
  }),
  run: (ctx, i) =>
    guard(async () => {
      const g = await updateGoal(ctx, i.id, { title: i.title, notes: i.notes, watchQuery: i.watch_query, checkEveryHours: i.check_every_hours, status: i.status, targetDate: i.target_date });
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

export const addMilestonesTool = defineTool({
  name: "add_milestones",
  description:
    `Add steps to a goal's plan, in order, up to ${MAX_MILESTONES} in all. Use it to break a goal down when they ask how to get there, or when you save one with several stages. 3 to 6 milestones is usually right: each is a short outcome ("Venue booked"), not a to-do. ` +
    "Then offer, in one line, to turn the first milestone into a few tasks. Do not add tasks for every milestone at once. Take the goal id from list_goals.",
  kind: "internal",
  input: z.object({ goal_id: z.uuid(), milestones: z.array(step).min(1).max(MAX_MILESTONES) }),
  run: (ctx, i) =>
    guard(async () => {
      const g = await addMilestones(ctx, i.goal_id, i.milestones.map((m) => ({ title: m.title, dueOn: m.due_on })));
      return g ? `Added. "${g.title}" now has ${g.milestones.length} milestones.` : "No goal with that id.";
    }),
});

export const updateMilestoneTool = defineTool({
  name: "update_milestone",
  description:
    "Tick off, reopen, rename or re-date one milestone, or remove it (set `remove` true). Take the id from list_goals. Mark one done when they say it is done, or when they say yes to your question about it. " +
    "Say it plainly and mention how many are left. When the last one is done, offer to mark the whole goal done.",
  kind: "internal",
  input: z.object({ id: z.uuid(), status: z.enum(["open", "done"]).optional(), title: z.string().trim().min(1).max(200).optional(), due_on: date.nullable().optional(), remove: z.boolean().optional() }),
  run: (ctx, i) =>
    guard(async () => {
      if (i.remove) return (await removeMilestone(ctx, i.id)) ? "Removed." : "No milestone with that id.";
      const r = await updateMilestone(ctx, i.id, { status: i.status, title: i.title, dueOn: i.due_on });
      if (!r) return "No milestone with that id.";
      const open = r.goal.milestones.filter((m) => m.status === "open").length;
      return `Updated. "${r.goal.title}": ${r.goal.milestones.length - open} of ${r.goal.milestones.length} milestones done${open === 0 && r.goal.milestones.length ? ". That was the last one: offer to mark the goal done" : ""}.`;
    }),
});

export const goalTools = [addGoal, listGoalsTool, updateGoalTool, goalProgress, addMilestonesTool, updateMilestoneTool, searchWeb];
