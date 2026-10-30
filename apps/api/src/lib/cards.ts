import { z } from "zod";

/**
 * The cards Danny can show under a message. This list is the whole menu: the app draws exactly these and nothing else, and every card is
 * checked here before it is sent or saved, so a tool, or a model, can't put anything else in front of the user.
 */
const text = (n: number) => z.string().max(n);
const https = z.url().max(500).refine((u) => /^https?:\/\//i.test(u), "web links only");

export const CardSchema = z.discriminatedUnion("kind", [
  // A task the user can finish or snooze right there.
  z.object({ kind: z.literal("task"), id: z.uuid(), title: text(200), remindAt: z.iso.datetime({ offset: true }).nullable().default(null), dueAt: z.iso.datetime({ offset: true }).nullable().default(null) }),
  // A day of calendar.
  z.object({
    kind: z.literal("events"),
    day: text(60),
    items: z.array(z.object({ when: text(40), title: text(140), where: text(100).optional(), others: z.number().int().min(0).max(99).optional() })).max(14),
  }),
  z.object({ kind: z.literal("weather"), place: text(80), summary: text(60), high: text(12), low: text(12), rain: z.number().int().min(0).max(100).nullable().default(null) }),
  // A list: plain bullets, a checklist, or numbered steps. Each item may link.
  z.object({
    kind: z.literal("list"),
    title: text(80).optional(),
    style: z.enum(["bullets", "check", "steps"]).default("bullets"),
    items: z.array(z.object({ text: text(200), sub: text(140).optional(), href: https.optional() })).min(1).max(12),
  }),
  z.object({ kind: z.literal("table"), title: text(80).optional(), columns: z.array(text(30)).min(1).max(5), rows: z.array(z.array(text(80)).max(5)).min(1).max(10) }),
  // A place, with buttons that open a map app.
  z.object({ kind: z.literal("place"), name: text(100), address: text(200).optional(), note: text(140).optional() }),
  // A few quick answers, shown as buttons under the last message. Tapping one sends it.
  z.object({ kind: z.literal("replies"), options: z.array(text(40).min(1)).min(1).max(4) }),
]);

export type Card = z.infer<typeof CardSchema>;

/** Keep what is valid and drop the rest. Never throws: a bad card is just not shown. */
export function validCards(raw: unknown): Card[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c) => {
    const r = CardSchema.safeParse(c);
    return r.success ? [r.data] : [];
  });
}

/** One quick-replies card at most, and last, since it sits under the message like a row of buttons. */
export function arrange(cards: Card[]): Card[] {
  const replies = cards.filter((c) => c.kind === "replies").at(-1);
  return [...cards.filter((c) => c.kind !== "replies"), ...(replies ? [replies] : [])];
}
