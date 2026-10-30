import { z } from "zod";
import { approvals, auditLog, memory } from "../db/schema.js";
import { defineTool, ToolRegistry } from "./registry.js";

export const remember = defineTool({
  name: "remember",
  description: "Save one durable fact the user told you, such as a preference, a rate, or how they like to work. One short sentence. Do not save passwords or card numbers.",
  kind: "internal",
  input: z.object({ fact: z.string().trim().min(1).max(500) }),
  async run(ctx, { fact }) {
    await ctx.tenant(async (tx) => {
      const [row] = await tx.insert(memory).values({ workspaceId: ctx.workspaceId, userId: ctx.userId, contentEnc: ctx.vault.seal(ctx.workspaceId, fact) }).returning({ id: memory.id });
      await tx.insert(auditLog).values({ workspaceId: ctx.workspaceId, userId: ctx.userId, action: "memory.add", detail: { id: row!.id, via: "chat" } });
    });
    return "Remembered.";
  },
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
  return new ToolRegistry().register(remember).register(requestApproval);
}
