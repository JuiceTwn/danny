import { parts, zonedToUtc } from "./time.js";

export const REPEAT_UNITS = ["day", "week", "month", "year"] as const;
export type RepeatUnit = (typeof REPEAT_UNITS)[number];
export type Repeat = {
  every: number;
  unit: RepeatUnit;
  /** Several times on each repeat day, "HH:MM" on the user's clock, in order. Only for day and week repeats. */
  times?: string[];
  /** The weekdays of a weekly repeat, Monday = 1 to Sunday = 7. */
  days?: number[];
  /** The last local date (YYYY-MM-DD) it happens on. */
  until?: string;
};

export const MAX_TIMES = 8;
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const isoDay = (name: (typeof WEEKDAYS)[number]) => WEEKDAYS.indexOf(name) + 1;

/** A message the person can fix and retry. */
export class RepeatError extends Error {}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Check a repeat and tidy it: times and days in order, none twice, nothing the unit can't do. Returns it unchanged when it has nothing extra. */
export function checkRepeat(r: Repeat): Repeat {
  const out: Repeat = { every: r.every, unit: r.unit };
  if (r.times?.length) {
    if (r.unit !== "day" && r.unit !== "week") throw new RepeatError("Several times a day only works for repeats by the day or the week.");
    if (r.times.length > MAX_TIMES) throw new RepeatError(`That's more than ${MAX_TIMES} times in a day. Pick fewer.`);
    if (!r.times.every((t) => CLOCK.test(t))) throw new RepeatError("Times need to look like 08:00 or 14:30 (24 hour).");
    out.times = [...new Set(r.times)].sort();
  }
  if (r.days?.length) {
    if (r.unit !== "week") throw new RepeatError("Choosing weekdays only works for a weekly repeat (every week, or every 2 weeks).");
    if (!r.days.every((x) => Number.isInteger(x) && x >= 1 && x <= 7)) throw new RepeatError("Weekdays are Monday to Sunday.");
    out.days = [...new Set(r.days)].sort((a, b) => a - b);
  }
  if (r.until) {
    if (!DATE.test(r.until) || new Date(`${r.until}T00:00:00Z`).toISOString().slice(0, 10) !== r.until) throw new RepeatError("The end date has to be a real date like 2027-03-01.");
    out.until = r.until;
  }
  return out;
}

const daysIn = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

/**
 * `date` plus one step of the repeat, on the user's own clock: 9am stays 9am across a daylight saving change,
 * and "the 31st, monthly" lands on the last day of a shorter month instead of spilling into the next one.
 */
export function addRepeat(date: Date, r: Repeat, tz: string) {
  const out = stepWallClock(date, r, tz);
  return new Date(out.getTime() + (((date.getTime() % 60_000) + 60_000) % 60_000)); // zonedToUtc works to the minute; keep the seconds
}

function stepWallClock(date: Date, r: Repeat, tz: string) {
  const p = parts(date, tz);
  if (r.unit === "day" || r.unit === "week") {
    const step = r.every * (r.unit === "week" ? 7 : 1);
    const d = new Date(Date.UTC(p.y, p.mo - 1, p.d + step));
    return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), p.h, p.mi, tz);
  }
  const months = r.unit === "year" ? r.every * 12 : r.every;
  const idx = p.y * 12 + (p.mo - 1) + months;
  const y = Math.floor(idx / 12);
  const mo = (idx % 12) + 1;
  return zonedToUtc(y, mo, Math.min(p.d, daysIn(y, mo)), p.h, p.mi, tz);
}

/** The first occurrence after `now`, stepping forward from `from`. A chore finished weeks late skips the days that already went by. */
export function nextOccurrence(from: Date, r: Repeat, tz: string, now: Date) {
  let at = addRepeat(from, r, tz);
  for (let i = 0; at.getTime() <= now.getTime() && i < 5000; i++) at = addRepeat(at, r, tz);
  return at;
}

export function describeRepeat(r: Repeat | null) {
  if (!r) return null;
  if (r.every === 1) return r.unit === "day" ? "every day" : `every ${r.unit}`;
  return `every ${r.every} ${r.unit}s`;
}

const pad = (n: number) => String(n).padStart(2, "0");
const DAY = 86_400_000;
const mondayOf = (utcDay: number) => utcDay - ((new Date(utcDay).getUTCDay() + 6) % 7) * DAY;

/** The first moment after `now` (and after `from`) that a repeat with times or weekdays lands on, or null if there is none. */
function nextSlot(from: Date, r: Repeat, tz: string, now: Date): Date | null {
  const p = parts(from, tz);
  const times = r.times?.length ? r.times : [`${pad(p.h)}:${pad(p.mi)}`];
  const base = Math.max(from.getTime(), now.getTime());
  const start = Date.UTC(p.y, p.mo - 1, p.d);
  const startDay = ((new Date(start).getUTCDay() + 6) % 7) + 1;
  const week0 = mondayOf(start);
  for (let i = 0; i < 4000; i++) {
    const ms = start + i * DAY;
    const d = new Date(ms);
    if (r.unit === "day") {
      if (i % r.every !== 0) continue;
    } else {
      if (Math.round((mondayOf(ms) - week0) / (7 * DAY)) % r.every !== 0) continue;
      const day = ((d.getUTCDay() + 6) % 7) + 1;
      if (r.days?.length ? !r.days.includes(day) : day !== startDay) continue;
    }
    for (const t of times) {
      const at = zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), Number(t.slice(0, 2)), Number(t.slice(3)), tz);
      if (at.getTime() > base) return at;
    }
  }
  return null;
}

/**
 * The next occurrence after `now`, or null when the repeat has ended (past its end date). With times or weekdays it lands on the next listed
 * slot: after the 8am one comes the 2pm one, after the last one of the day comes the first of the next repeat day.
 */
export function nextRepeat(from: Date, r: Repeat, tz: string, now: Date): Date | null {
  const at = r.times?.length || r.days?.length ? nextSlot(from, r, tz, now) : nextOccurrence(from, r, tz, now);
  if (!at) return null;
  if (r.until) {
    const p = parts(at, tz);
    if (`${p.y}-${pad(p.mo)}-${pad(p.d)}` > r.until) return null;
  }
  return at;
}

/** The first occurrence of a repeat that has times but was given no start. */
export const firstSlot = (r: Repeat, tz: string, now: Date) => nextSlot(now, r, tz, now);

const NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const clock12 = (t: string) => {
  const h = Number(t.slice(0, 2));
  return `${h % 12 || 12}:${t.slice(3)} ${h < 12 ? "AM" : "PM"}`;
};
const list = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const niceDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "every day at 8:00 AM, 2:00 PM and 8:00 PM", "every Mon, Wed and Fri until Dec 31, 2027". */
export function describeRepeatFull(r: Repeat | null) {
  if (!r) return null;
  const base = r.days?.length ? `every ${r.every === 1 ? "" : `${r.every} weeks on `}${list(r.days.map((d) => NAMES[d - 1]!))}`.replace("every  ", "every ") : describeRepeat(r)!;
  const at = r.times?.length ? ` at ${list(r.times.map(clock12))}` : "";
  const end = r.until ? ` until ${niceDate(r.until)}` : "";
  return `${base}${at}${end}`;
}
