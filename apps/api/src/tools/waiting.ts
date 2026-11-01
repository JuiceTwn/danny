import { z } from "zod";
import { GmailError } from "../lib/google.js";
import { listWaiting, startWaiting, stopWaiting, WaitingError } from "../lib/waiting.js";
import { defineTool } from "./registry.js";

const guard = async (f: () => Promise<string>) => {
  try {
    return await f();
  } catch (e) {
    if (e instanceof GmailError || e instanceof WaitingError) return e.message;
    throw e;
  }
};

export const watchReply = defineTool({
  name: "watch_reply",
  description:
    "Keep an eye on an email conversation and tell the user only if nobody has replied by a time. Use it when they say things like 'remind me if Sam hasn't answered by Friday' or 'let me know if they don't get back to me'. " +
    "Take the message id from search_email (any message in the conversation, ideally the one they sent). `by` is when to check, ISO 8601 with the user's UTC offset; pick 9am on the day they named, or 3 days from now if they gave none. " +
    "If there is a reply, Danny stays quiet. If not, he tells them and offers to draft a follow-up. Asking again for the same conversation moves the date.",
  kind: "internal",
  input: z.object({ message_id: z.string().regex(/^[0-9a-f]{6,32}$/i, "a Gmail message id from search_email"), by: z.iso.datetime({ offset: true }) }),
  run: (ctx, i) =>
    guard(async () => {
      const w = await startWaiting(ctx, ctx, i.message_id, new Date(i.by));
      return `${w.moved ? "Moved the check for" : "Watching"} "${w.subject}" (waiting on ${w.who}). Will check on ${i.by} and only speak up if there is no reply. Confirm in one short line.`;
    }),
});

export const listWaitingOn = defineTool({
  name: "list_waiting",
  description: "List the email conversations the user is waiting on a reply for, soonest check first. Use it to get an id before stop_waiting, or when they ask who they are waiting on.",
  kind: "read",
  input: z.object({}),
  run: async (ctx) => {
    const rows = await listWaiting(ctx);
    return rows.length ? rows.map((r) => `${r.id} | "${r.subject}" | waiting on ${r.who} | ${r.status === "nudged" ? "no reply yet, already told them" : `checks ${r.checkAt}`}`).join("\n") : "Not waiting on anyone.";
  },
});

export const dropWaiting = defineTool({
  name: "stop_waiting",
  description: "Stop watching for a reply. Take the id from list_waiting. Use it when they say to drop it or it no longer matters.",
  kind: "internal",
  input: z.object({ id: z.uuid() }),
  run: async (ctx, { id }) => ((await stopWaiting(ctx, id)) ? "Stopped." : "No such item."),
});

export const waitingTools = [watchReply, listWaitingOn, dropWaiting];
