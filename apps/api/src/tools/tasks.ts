import { z } from "zod";
import { describeRepeatFull, isoDay, MAX_TIMES, REPEAT_UNITS, WEEKDAYS } from "../lib/recur.js";
import { completeTask, createTask, linkTask, listTasks, pickNext, presetTime, setFirstStep, snoozeTask, TaskError } from "../lib/tasks.js";
import { SNOOZE_PRESETS } from "../lib/time.js";
import { defineTool } from "./registry.js";

const when = z.iso.datetime({ offset: true });
const date = (s?: string) => (s ? new Date(s) : null);
const line = (t: { id: string; title: string; dueAt: string | null; remindAt: string | null; repeat: { every: number; unit: (typeof REPEAT_UNITS)[number]; times?: string[]; days?: number[]; until?: string } | null; firstStep: string | null; snoozeCount: number; goalTitle?: string | null }) =>
  `${t.id} | ${t.title}${t.goalTitle ? ` | for goal: ${t.goalTitle}` : ""}${t.firstStep ? ` | first step: ${t.firstStep}` : ""}${t.dueAt ? ` | due ${t.dueAt}` : ""}${t.remindAt ? ` | reminds ${t.remindAt}` : ""}${t.repeat ? ` | ${describeRepeatFull(t.repeat)}` : ""}${t.snoozeCount >= 2 ? ` | put off ${t.snoozeCount} times` : ""}`;
const card = (t: { id: string; title: string; remindAt: string | null; dueAt: string | null; firstStep: string | null }) => ({ kind: "task" as const, id: t.id, title: t.title, remindAt: t.remindAt, dueAt: t.dueAt, firstStep: t.firstStep });

// Tool errors the user can fix come back as plain text so the model can explain them.
const guard = async (f: () => Promise<string>) => {
  try {
    return await f();
  } catch (e) {
    if (e instanceof TaskError) return e.message;
    throw e;
  }
};

export const addTask = defineTool({
  name: "add_task",
  description:
    "Put something on the user's to-do list. Use this whenever they mention something they need to do or remember, even in passing. " +
    "Set `remind_at` when they want a nudge at a certain time. Set `due_at` for a deadline; a deadline with no `remind_at` reminds at the deadline. " +
    "Times are ISO 8601 with the user's UTC offset, worked out from the current time given in the system prompt. Keep the title short and concrete. " +
    "For anything that comes round again (bins every Tuesday, rent on the 1st, a birthday, a yearly renewal, a pill every morning) set `repeat_every` and `repeat_unit` ONCE instead of adding it again each time: " +
    "`due_at` is the first occurrence. For \"remind me a week before\" put `remind_at` that far before `due_at`; the gap is kept every cycle. Marking an occurrence done moves it to the next one. " +
    `For something that happens more than once a day (pills at 8am, 2pm and 8pm; stretch at 10, 1 and 4), still ONE task: repeat_unit "day", repeat_every 1, and \`repeat_times\` as 24-hour HH:MM on their own clock (up to ${MAX_TIMES}); no due_at needed, the first is the next of those times. Each time gets its own reminder, and if one is ignored the next still comes. ` +
    "For certain weekdays (gym Mon, Wed, Fri) use repeat_unit \"week\", repeat_every 1 (2 for every other week) and `repeat_days`; add `repeat_times` for a time, or give `due_at` for the first one. " +
    "`repeat_until` (YYYY-MM-DD) ends it on that date: use it for a course of antibiotics, a trial, \"for the next two weeks\". Without it, it goes on until they delete the task. " +
    "`first_step` is the smallest physical first move, under 12 words, starting with a verb (\"Find last year's return\", \"Open the email and type hello\"). Give one whenever the task is vague or big (taxes, a call you dread, sorting something out); skip it for tasks that are already one small action. " +
    "When the task is a step toward one of their goals, set `goal_id` (and `milestone_id` for the step it belongs to) from list_goals, so finishing it counts as progress on the goal.",
  kind: "internal",
  input: z.object({
    title: z.string().trim().min(1).max(300),
    due_at: when.optional(),
    remind_at: when.optional(),
    repeat_every: z.number().int().min(1).max(366).optional(),
    repeat_unit: z.enum(REPEAT_UNITS).optional(),
    repeat_times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, 24 hour")).min(1).max(MAX_TIMES).optional(),
    repeat_days: z.array(z.enum(WEEKDAYS)).min(1).max(7).optional(),
    repeat_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
    first_step: z.string().trim().min(1).max(200).optional(),
    goal_id: z.uuid().optional(),
    milestone_id: z.uuid().optional(),
  }),
  run: (ctx, i) =>
    guard(async () => {
      if (!i.repeat_unit !== !i.repeat_every) return "A repeat needs both a number and a unit (for example every 2 weeks).";
      if ((i.repeat_times || i.repeat_days || i.repeat_until) && !i.repeat_unit) return "Repeat times, weekdays and an end date need a repeat: set repeat_unit and repeat_every too.";
      const repeat = i.repeat_unit && i.repeat_every ? { every: i.repeat_every, unit: i.repeat_unit, ...(i.repeat_times ? { times: i.repeat_times } : {}), ...(i.repeat_days ? { days: i.repeat_days.map(isoDay) } : {}), ...(i.repeat_until ? { until: i.repeat_until } : {}) } : null;
      const t = await createTask(ctx, { title: i.title, dueAt: date(i.due_at), remindAt: date(i.remind_at), repeat, firstStep: i.first_step, goalId: i.goal_id, milestoneId: i.milestone_id });
      ctx.card?.(card(t));
      return `Added (${t.id}).${t.remindAt ? ` Will remind at ${t.remindAt}.` : " No reminder set."}${t.repeat ? ` Repeats ${describeRepeatFull(t.repeat)}.` : ""} The app shows the task as a card, so confirm in a few words.`;
    }),
});

export const listOpenTasks = defineTool({
  name: "list_tasks",
  description: "List the user's open tasks, deadlines first. Use it before completing or snoozing so you have the right id.",
  kind: "read",
  input: z.object({}),
  run: async (ctx) => {
    const open = await listTasks(ctx);
    return open.length ? open.map(line).join("\n") : "No open tasks.";
  },
});

export const whatsNext = defineTool({
  name: "whats_next",
  description:
    "Pick the ONE thing the user should do now. Use it when they ask what to do, feel stuck or overwhelmed. " +
    "Tell them that one task only, with the smallest first step (use the saved first step if there is one; if not, make one up and save it with set_first_step). Do not read out the whole list. " +
    "A task marked \"put off\" several times is not a moral failing: offer to shrink it, drop it, or do part of it for them.",
  kind: "read",
  input: z.object({}),
  run: async (ctx) => {
    const open = await listTasks(ctx);
    const next = pickNext(open);
    if (next) ctx.card?.(card(next));
    return next ? `Next: ${line(next)}\n${open.length - 1} other open task(s) not shown.` : "Nothing open. The list is clear.";
  },
});

export const doneTask = defineTool({
  name: "complete_task",
  description: "Mark a task done. Take the id from list_tasks. Say it plainly and move on; no cheering. A repeating task stays on the list and moves to its next date.",
  kind: "internal",
  input: z.object({ id: z.uuid() }),
  run: async (ctx, { id }) => {
    const r = await completeTask(ctx, id);
    if (!r) return "No open task with that id.";
    const base = r.next ? `Done. It repeats, so the next one is ${r.next}.` : r.ended ? "Done. That was the last one: the repeat has reached its end date, so it is finished." : "Marked done.";
    if (!r.goal) return base;
    const m = r.goal.milestone;
    return (
      `${base} It was a step toward the goal "${r.goal.title}", so that counts as progress on it.` +
      (m && m.status === "open" && m.otherOpenTasks === 0 && !r.next ? ` That was the last open task for the milestone "${m.title}". Ask them, in one short line, whether that milestone is done (then call update_milestone).` : "")
    );
  },
});

export const linkTaskTool = defineTool({
  name: "link_task",
  description:
    "Tie an existing open task to one of the user's goals (and optionally to one of its milestones), or untie it by leaving goal_id out. Take the task id from list_tasks and the goal and milestone ids from list_goals. " +
    "Do it when they say a task is part of a goal, or when you notice one is.",
  kind: "internal",
  input: z.object({ task_id: z.uuid(), goal_id: z.uuid().optional(), milestone_id: z.uuid().optional() }),
  run: (ctx, i) =>
    guard(async () => ((await linkTask(ctx, i.task_id, i.goal_id ?? null, i.milestone_id ?? null)) ? (i.goal_id ? "Linked. Finishing it now counts as progress on the goal." : "Unlinked from its goal.") : "No open task with that id.")),
});

export const snooze = defineTool({
  name: "snooze_task",
  description:
    "Move a task's reminder to a later time. Take the id from list_tasks. Give EITHER `until` (ISO 8601 with the user's UTC offset) OR `when`: " +
    "later (3 hours), tonight (7pm), tomorrow (9am), weekend (Saturday 9am), monday (9am). Prefer `when` for those, it uses their own clock and quiet hours.",
  kind: "internal",
  input: z.object({ id: z.uuid(), until: when.optional(), when: z.enum(SNOOZE_PRESETS).optional() }),
  run: (ctx, i) =>
    guard(async () => {
      if (!i.until === !i.when) return "Give either `until` or `when`.";
      const at = i.when ? await presetTime(ctx, i.when) : new Date(i.until!);
      if (!at) return `There is no "${i.when}" left today. Offer later or tomorrow instead.`;
      return (await snoozeTask(ctx, i.id, at)) ? `Snoozed until ${at.toISOString()}.` : "No open task with that id.";
    }),
});

export const setStep = defineTool({
  name: "set_first_step",
  description:
    "Save or replace a task's smallest first move (under 12 words, starts with a verb, takes a few minutes). Use it when the user says a task is too big, or when you break something down: " +
    "put only the first step on the task, not the whole plan. Take the id from list_tasks. Pass an empty step to clear it.",
  kind: "internal",
  input: z.object({ id: z.uuid(), step: z.string().trim().max(200) }),
  run: async (ctx, { id, step }) => ((await setFirstStep(ctx, id, step || null)) ? "Saved." : "No open task with that id."),
});

export const taskTools = [addTask, listOpenTasks, whatsNext, doneTask, snooze, setStep, linkTaskTool];
