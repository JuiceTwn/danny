import { google } from "./gmail.js";
import { localIso } from "./time.js";
import type { ToolCtx } from "../tools/registry.js";

type ApiEvent = {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; self?: boolean; responseStatus?: string }[];
  organizer?: { email?: string; self?: boolean };
};

export type CalEvent = { id: string; title: string; start: string; end: string; allDay: boolean; location: string; others: number; declined: boolean };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Events between two instants, soonest first. Recurring events come back as single occurrences. */
export async function listEvents(ctx: ToolCtx, from: Date, to: Date, max = 25): Promise<CalEvent[]> {
  const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: String(max) });
  const r = await google<{ items?: ApiEvent[] }>(ctx, `/calendars/primary/events?${q}`, { api: "calendar" });
  return (r.items ?? [])
    .filter((e) => e.status !== "cancelled")
    .map((e) => ({
      id: e.id,
      // Titles can come from invites other people sent, so they are cut short and shown to the model as information only.
      title: clip((e.summary ?? "(no title)").replace(/\s+/g, " "), 120),
      start: e.start?.dateTime ?? e.start?.date ?? "",
      end: e.end?.dateTime ?? e.end?.date ?? "",
      allDay: !e.start?.dateTime,
      location: clip((e.location ?? "").replace(/\s+/g, " "), 80),
      others: (e.attendees ?? []).filter((a) => !a.self).length,
      declined: (e.attendees ?? []).some((a) => a.self && a.responseStatus === "declined"),
    }));
}

export function eventLine(e: CalEvent, tz: string) {
  const when = e.allDay ? `${e.start} all day` : `${localIso(new Date(e.start), tz).slice(0, 16).replace("T", " ")} to ${localIso(new Date(e.end), tz).slice(11, 16)}`;
  return `${when} | ${e.title}${e.location ? ` | at ${e.location}` : ""}${e.others ? ` | with ${e.others} other${e.others > 1 ? "s" : ""}` : ""}${e.declined ? " | you declined" : ""}`;
}

export type NewEvent = { title: string; start: string; end: string; location?: string; description?: string; attendees?: string[] };

/** Creates the event on the primary calendar. Guests get an invitation only if there are any. */
export async function createEvent(ctx: ToolCtx, e: NewEvent) {
  const guests = e.attendees ?? [];
  const q = new URLSearchParams({ sendUpdates: guests.length ? "all" : "none" });
  return google<{ id: string; htmlLink?: string }>(ctx, `/calendars/primary/events?${q}`, {
    method: "POST",
    api: "calendar",
    json: {
      summary: e.title,
      ...(e.location ? { location: e.location } : {}),
      ...(e.description ? { description: e.description } : {}),
      start: { dateTime: e.start },
      end: { dateTime: e.end },
      ...(guests.length ? { attendees: guests.map((email) => ({ email })) } : {}),
    },
  });
}
