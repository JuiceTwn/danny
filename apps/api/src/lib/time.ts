// Timezone math with no library. Everything is stored in UTC; these only translate to and from a person's clock.

export function isValidTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parts(date: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(date)) if (p.type !== "literal") o[p.type] = Number(p.value);
  return { y: o.year!, mo: o.month!, d: o.day!, h: o.hour!, mi: o.minute!, s: o.second! };
}

function offsetMs(date: Date, tz: string) {
  const p = parts(date, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

export function localHour(date: Date, tz: string) {
  return parts(date, tz).h;
}

/** The UTC instant for a wall-clock time in a zone. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  return new Date(guess - offsetMs(new Date(guess), tz));
}

/** "2026-10-30T15:04:00-04:00", the shape the task tools take, for telling the model what time it is. */
export function localIso(date: Date, tz: string) {
  const p = parts(date, tz);
  const off = Math.round(offsetMs(date, tz) / 60000);
  const sign = off < 0 ? "-" : "+";
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(off % 60)}`;
}

export const QUIET_START = 22; // 22:00 local
export const QUIET_END = 7; //   07:00 local

export function inQuietHours(date: Date, tz: string) {
  const h = localHour(date, tz);
  return h >= QUIET_START || h < QUIET_END;
}

/** The next 07:00 local after `date`. */
export function nextQuietEnd(date: Date, tz: string) {
  const p = parts(date, tz);
  let at = zonedToUtc(p.y, p.mo, p.d, QUIET_END, 0, tz);
  if (at <= date) {
    const next = new Date(Date.UTC(p.y, p.mo - 1, p.d + 1));
    at = zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), QUIET_END, 0, tz);
  }
  return at;
}
