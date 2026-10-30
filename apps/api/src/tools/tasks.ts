import { z } from "zod";
import { completeTask, createTask, listTasks, pickNext, snoozeTask, TaskError } from "../lib/tasks.js";
import { defineTool } from "./registry.js";

const when = z.iso.datetime({ offset: true });
const date = (s?: string) => (s ? new Date(s) : null);
const line = (t: { id: string; title: string; dueAt: string | null; remindAt: string | null }) =>
  `${t.id} | ${t.title}${t.dueAt ? ` | due ${t.dueAt}` : ""}${t.remindAt ? ` | reminds ${t.remindAt}` : ""}`;

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
    "Times are ISO 8601 with the user's UTC offset, worked out from the current time given in the system prompt. Keep the title short and concrete.",
  kind: "internal",
  input: z.object({ title: z.string().trim().min(1).max(300), due_at: when.optional(), remind_at: when.optional() }),
  run: (ctx, i) =>
    guard(async () => {
      const t = await createTask(ctx, { title: i.title, dueAt: date(i.due_at), remindAt: date(i.remind_at) });
      return `Added (${t.id}).${t.remindAt ? ` Will remind at ${t.remindAt}.` : " No reminder set."}`;
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
    "Tell them that one task only, with the smallest first step. Do not read out the whole list.",
  kind: "read",
  input: z.object({}),
  run: async (ctx) => {
    const open = await listTasks(ctx);
    const next = pickNext(open);
    return next ? `Next: ${line(next)}\n${open.length - 1} other open task(s) not shown.` : "Nothing open. The list is clear.";
  },
});

export const doneTask = defineTool({
  name: "complete_task",
  description: "Mark a task done. Take the id from list_tasks. Say it plainly and move on; no cheering.",
  kind: "internal",
  input: z.object({ id: z.uuid() }),
  run: async (ctx, { id }) => ((await completeTask(ctx, id)) ? "Marked done." : "No open task with that id."),
});

export const snooze = defineTool({
  name: "snooze_task",
  description: "Move a task's reminder to a later time. Take the id from list_tasks. `until` is ISO 8601 with the user's UTC offset.",
  kind: "internal",
  input: z.object({ id: z.uuid(), until: when }),
  run: (ctx, { id, until }) => guard(async () => ((await snoozeTask(ctx, id, new Date(until))) ? `Snoozed until ${until}.` : "No open task with that id.")),
});

export const taskTools = [addTask, listOpenTasks, whatsNext, doneTask, snooze];
