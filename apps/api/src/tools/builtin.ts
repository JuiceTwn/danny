import { z } from "zod";
import { approvals, auditLog } from "../db/schema.js";
import { addMemory, forgetMemory, KINDS, lineOf, MAX_MEMORIES, recall } from "../lib/memory.js";
import { defineTool, ToolRegistry } from "./registry.js";
import { gmailTools } from "./gmail.js";
import { calendarTools } from "./calendar.js";
import { cardTools } from "./cards.js";
import { githubTools } from "./github.js";
import { weatherTools } from "./weather.js";
import { styleTools } from "./style.js";
import { interestTools } from "./interests.js";
import { goalTools } from "./goals.js";
import { taskTools } from "./tasks.js";

const kinds = z.enum(KINDS);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date like 2027-03-31");

export const remember = defineTool({
  name: "remember",
  description:
    "Save one durable fact about the user's life or work that you will want next week: a preference, a person, a rate, how they like to work. " +
    "Write it as a short fragment, under 12 words, with no 'User' or 'The user' ('Prefers texts to calls', not 'The user said they prefer to be texted'). " +
    "Set `subject` for a person or place ('Marlene'). If it will stop being true, set `expires_on` ('Moving to Toronto in March' ends 2027-03-31). " +
    "Do NOT save what has its own home: things to do (add_task), things they are working toward (add_goal), topics they follow (add_interest), how they like to be helped (learn_preference). " +
    "If it corrects or updates a note you already hold, pass that note's id as `replaces` instead of adding a second one. Never save passwords or card numbers.",
  kind: "internal",
  input: z.object({
    fact: z.string().trim().min(1).max(300),
    kind: kinds.optional(),
    subject: z.string().trim().max(80).optional(),
    expires_on: day.optional(),
    pin: z.boolean().optional().describe("Always keep this in view. Only for the few things that matter in nearly every conversation."),
    replaces: z.uuid().optional(),
  }),
  async run(ctx, i) {
    const r = await addMemory(ctx, { fact: i.fact, kind: i.kind, subject: i.subject, expiresOn: i.expires_on, pinned: i.pin }, { replaces: i.replaces });
    if (r.status === "full") return `Memory is full (${MAX_MEMORIES} notes). Ask the user what to forget, or forget something outdated yourself.`;
    if (r.status === "missing") return "No note with that id to replace. Use recall to find it.";
    if (r.status === "duplicate") return "Already remembered.";
    if (r.status === "replaced") return "Updated.";
    return r.similar.length
      ? `Remembered. Similar notes you already hold:\n${r.similar.map((m) => `${m.id} | ${lineOf(m)}`).join("\n")}\nIf one of them is now out of date, call remember again with replaces=<its id> or forget_memory it.`
      : "Remembered.";
  },
});

export const recallTool = defineTool({
  name: "recall",
  description:
    "Look up what you remember about the user. Only some notes are shown to you each turn; this finds the rest. Pass a few words (a name, a place, a topic). Leave `query` empty for the pinned and newest notes. Returns ids you can use to update or forget a note.",
  kind: "read",
  input: z.object({ query: z.string().trim().max(120).optional() }),
  run: async (ctx, { query }) => {
    const found = await recall(ctx, query ?? "");
    return found.length ? found.map((m) => `${m.id} | ${m.kind} | ${lineOf(m)}`).join("\n") : "Nothing matching.";
  },
});

export const forgetMemoryTool = defineTool({
  name: "forget_memory",
  description: "Delete a note for good, because it is wrong, out of date, or they asked you to forget it. Take the id from recall.",
  kind: "internal",
  input: z.object({ id: z.uuid() }),
  run: async (ctx, { id }) => ((await forgetMemory(ctx, id, "chat")) ? "Forgotten." : "No note with that id."),
});

export const requestApproval = defineTool({
  name: "request_approval",
  description:
    "Ask the user to approve something before it happens: a message to send, a post to publish, anything that leaves this chat. Include the full draft. " +
    "This only records the request. Nothing is sent. Tell the user it is waiting on their tap.",
  kind: "internal",
  input: z.object({
    kind: z.string().trim().min(1).max(40).describe("email, post, note, ..."),
    title: z.string().trim().min(1).max(200),
    draft: z.string().trim().min(1).max(8000),
  }),
  async run(ctx, { kind, title, draft }) {
    const id = await ctx.tenant(async (tx) => {
      const [a] = await tx.insert(approvals).values({ workspaceId: ctx.workspaceId, userId: ctx.userId, kind, titleEnc: ctx.vault.seal(ctx.workspaceId, title), payloadEnc: ctx.vault.sealJson(ctx.workspaceId, { draft }) }).returning({ id: approvals.id });
      await tx.insert(auditLog).values({ workspaceId: ctx.workspaceId, userId: ctx.userId, action: "approval.request", detail: { id: a!.id, kind, via: "chat" } });
      return a!.id;
    });
    return `Approval requested (${id}). Waiting on the user. Nothing has been sent.`;
  },
});

export function createRegistry() {
  const r = new ToolRegistry().register(remember).register(requestApproval).register(recallTool).register(forgetMemoryTool);
  for (const t of [...taskTools, ...goalTools, ...interestTools, ...styleTools, ...weatherTools, ...githubTools, ...cardTools, ...gmailTools, ...calendarTools]) r.register(t);
  return r;
}
