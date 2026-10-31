import { z } from "zod";
import { describeRepeat, REPEAT_UNITS } from "../lib/recur.js";
import { completeTask, createTask, listTasks, pickNext, presetTime, setFirstStep, snoozeTask, TaskError } from "../lib/tasks.js";
import { SNOOZE_PRESETS } from "../lib/time.js";
import { defineTool } from "./registry.js";

const when = z.iso.datetime({ offset: true });
const date = (s?: string) => (s ? new Date(s) : null);
const line = (t: { id: string; title: string; dueAt: string | null; remindAt: string | null; repeat: { every: number; unit: (typeof REPEAT_UNITS)[number] } | null; firstStep: string | null; snoozeCount: number }) =>
  `${t.id} | ${t.title}${t.firstStep ? ` | first step: ${t.firstStep}` : ""}${t.dueAt ? ` | due ${t.dueAt}` : ""}${t.remindAt ? ` | reminds ${t.remindAt}` : ""}${t.repeat ? ` | ${describeRepeat(t.repeat)}` : ""}${t.snoozeCount >= 2 ? ` | put off ${t.snoozeCount} times` : ""}`;
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
    "`first_step` is the smallest physical first move, under 12 words, starting with a verb (\"Find last year's return\", \"Open the email and type hello\"). Give one whenever the task is vague or big (taxes, a call you dread, sorting something out); skip it for tasks that are already one small action.",
  kind: "internal",
  input: z.object({
    title: z.string().trim().min(1).max(300),
    due_at: when.optional(),
    remind_at: when.optional(),
    repeat_every: z.number().int().min(1).max(366).optional(),
    repeat_unit: z.enum(REPEAT_UNITS).optional(),
    first_step: z.string().trim().min(1).max(200).optional(),
  }),
  run: (ctx, i) =>
    guard(async () => {
      if (!i.repeat_unit !== !i.repeat_every) return "A repeat needs both a number and a unit (for example every 2 weeks).";
      const repeat = i.repeat_unit && i.repeat_every ? { every: i.repeat_every, unit: i.repeat_unit } : null;
      const t = await createTask(ctx, { title: i.title, dueAt: date(i.due_at), remindAt: date(i.remind_at), repeat, firstStep: i.first_step });
      ctx.card?.(card(t));
      return `Added (${t.id}).${t.remindAt ? ` Will remind at ${t.remindAt}.` : " No reminder set."}${t.repeat ? ` Repeats ${describeRepeat(t.repeat)}.` : ""} The app shows the task as a card, so confirm in a few words.`;
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
    return !r ? "No open task with that id." : r.next ? `Done. It repeats, so the next one is ${r.next}.` : "Marked done.";
  },
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

export const taskTools = [addTask, listOpenTasks, whatsNext, doneTask, snooze, setStep];
