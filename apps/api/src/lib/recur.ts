import { parts, zonedToUtc } from "./time.js";

export const REPEAT_UNITS = ["day", "week", "month", "year"] as const;
export type RepeatUnit = (typeof REPEAT_UNITS)[number];
export type Repeat = { every: number; unit: RepeatUnit };

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
