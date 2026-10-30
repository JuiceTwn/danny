import { and, gte, sql, eq } from "drizzle-orm";
import { z } from "zod";
import { auditLog } from "../db/schema.js";
import { readConnectionSecret } from "./connections.js";
import { defineTool, ToolUnavailable } from "./registry.js";

export const MAX_EMAILS_PER_DAY = 20;

const secretSchema = z.object({ apiKey: z.string().min(1), from: z.string().min(3) });

/**
 * Sends through Resend, from the address the owner linked in Settings (provider "resend").
 * The secret is JSON: {"apiKey": "re_...", "from": "Justin <justin@yourdomain.com>"}.
 */
export const sendEmail = defineTool({
  name: "send_email",
  description:
    "Draft an email from the user's own address. Write it ready to send: greeting, body, sign-off in their voice. " +
    "It does not send now. It becomes a card the user must approve, and only then does it go out.",
  kind: "external_write",
  input: z.object({
    to: z.email().max(200),
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(6000),
  }),
  approvalTitle: (i) => `Email to ${i.to}: ${i.subject}`,
  async execute(ctx, i) {
    const raw = await readConnectionSecret(ctx, "resend");
    if (!raw) throw new ToolUnavailable("no email account is linked yet. Add one in Settings.");
    let conn: z.infer<typeof secretSchema>;
    try {
      conn = secretSchema.parse(JSON.parse(raw));
    } catch {
      throw new ToolUnavailable("the linked email account is set up wrong. Re-add it in Settings.");
    }

    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const [{ n }] = (await ctx.tenant((tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(and(eq(auditLog.action, "email.sent"), gte(auditLog.at, since))),
    )) as [{ n: number }];
    if (n >= MAX_EMAILS_PER_DAY) throw new ToolUnavailable(`the daily limit of ${MAX_EMAILS_PER_DAY} emails is used up.`);

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${conn.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: conn.from, to: [i.to], subject: i.subject, text: i.body }),
    });
    if (!res.ok) throw new ToolUnavailable(`the email service refused it (${res.status}).`);
    await ctx.tenant((tx) =>
      tx.insert(auditLog).values({ workspaceId: ctx.workspaceId, userId: ctx.userId, action: "email.sent", detail: { to: i.to } }),
    );
    return `Sent to ${i.to}.`;
  },
});
