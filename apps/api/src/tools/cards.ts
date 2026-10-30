import { z } from "zod";
import { CardSchema } from "../lib/cards.js";
import { defineTool } from "./registry.js";

const item = z.object({ text: z.string().trim().min(1).max(200), sub: z.string().trim().max(140).optional(), href: z.string().trim().max(500).optional() });

export const showCard = defineTool({
  name: "show_card",
  description:
    "Show the user a card under your reply when structure reads better than prose: a list of 3 or more things (style bullets, check or steps), a small table, or a place. " +
    "Say one short line in your reply and let the card carry the detail; do not repeat it in the text. Links must be real https addresses you got from a tool. " +
    "Do not use it for one or two items, or for plain answers.",
  kind: "internal",
  input: z.object({
    card: z.enum(["list", "table", "place"]),
    title: z.string().trim().max(80).optional(),
    style: z.enum(["bullets", "check", "steps"]).optional(),
    items: z.array(item).max(12).optional().describe("For a list."),
    columns: z.array(z.string().trim().max(30)).max(5).optional().describe("For a table."),
    rows: z.array(z.array(z.string().trim().max(80)).max(5)).max(10).optional().describe("For a table: one array per row."),
    name: z.string().trim().max(100).optional().describe("For a place."),
    address: z.string().trim().max(200).optional(),
    note: z.string().trim().max(140).optional(),
  }),
  run: async (ctx, i) => {
    const raw =
      i.card === "list" ? { kind: "list", title: i.title, style: i.style ?? "bullets", items: (i.items ?? []).map((x) => ({ ...x, href: x.href && /^https?:\/\//i.test(x.href) ? x.href : undefined })) }
      : i.card === "table" ? { kind: "table", title: i.title, columns: i.columns ?? [], rows: i.rows ?? [] }
      : { kind: "place", name: i.name ?? "", address: i.address, note: i.note };
    const ok = CardSchema.safeParse(raw);
    if (!ok.success) return "That card was not valid (it needs items for a list, columns and rows for a table, a name for a place). Say it in text instead.";
    ctx.card?.(ok.data);
    return "Shown. Do not repeat its contents in your reply.";
  },
});

export const suggestReplies = defineTool({
  name: "suggest_replies",
  description:
    "Offer 2 to 4 quick answers as buttons under your reply, when your question has a few obvious answers: 'Yes, watch it', 'Not now', 'Snooze 1 hour'. Each under 40 characters, written as the user would say it. " +
    "Call it last, after you have decided what to say. Never for open questions, and never when no question is asked.",
  kind: "internal",
  input: z.object({ options: z.array(z.string().trim().min(1).max(40)).min(1).max(4) }),
  run: async (ctx, { options }) => {
    ctx.card?.({ kind: "replies", options });
    return "Shown as buttons. Now write your reply, which should end with the question.";
  },
});

export const cardTools = [showCard, suggestReplies];
