// Scores and schedules for the teams a person follows. The leagues' own public feeds (NHL and MLB, no key): only a team code and a date range
// leave the server, never anything about the person. Facts come straight from the feed, so none of this needs a model or a web search.
import { localDayBounds } from "./time.js";

export type League = "nhl" | "mlb";
export type Team = { league: League; code: string; name: string; place: string };

const nhl = (code: string, place: string, name: string): Team => ({ league: "nhl", code, name, place });
const mlb = (id: number, place: string, name: string): Team => ({ league: "mlb", code: String(id), name, place });

export const TEAMS: Team[] = [
  nhl("ANA", "Anaheim", "Ducks"), nhl("BOS", "Boston", "Bruins"), nhl("BUF", "Buffalo", "Sabres"), nhl("CGY", "Calgary", "Flames"),
  nhl("CAR", "Carolina", "Hurricanes"), nhl("CHI", "Chicago", "Blackhawks"), nhl("COL", "Colorado", "Avalanche"), nhl("CBJ", "Columbus", "Blue Jackets"),
  nhl("DAL", "Dallas", "Stars"), nhl("DET", "Detroit", "Red Wings"), nhl("EDM", "Edmonton", "Oilers"), nhl("FLA", "Florida", "Panthers"),
  nhl("LAK", "Los Angeles", "Kings"), nhl("MIN", "Minnesota", "Wild"), nhl("MTL", "Montreal", "Canadiens"), nhl("NSH", "Nashville", "Predators"),
  nhl("NJD", "New Jersey", "Devils"), nhl("NYI", "New York", "Islanders"), nhl("NYR", "New York", "Rangers"), nhl("OTT", "Ottawa", "Senators"),
  nhl("PHI", "Philadelphia", "Flyers"), nhl("PIT", "Pittsburgh", "Penguins"), nhl("SJS", "San Jose", "Sharks"), nhl("SEA", "Seattle", "Kraken"),
  nhl("STL", "St. Louis", "Blues"), nhl("TBL", "Tampa Bay", "Lightning"), nhl("TOR", "Toronto", "Maple Leafs"), nhl("UTA", "Utah", "Mammoth"),
  nhl("VAN", "Vancouver", "Canucks"), nhl("VGK", "Vegas", "Golden Knights"), nhl("WSH", "Washington", "Capitals"), nhl("WPG", "Winnipeg", "Jets"),
  mlb(108, "Los Angeles", "Angels"), mlb(109, "Arizona", "Diamondbacks"), mlb(110, "Baltimore", "Orioles"), mlb(111, "Boston", "Red Sox"),
  mlb(112, "Chicago", "Cubs"), mlb(113, "Cincinnati", "Reds"), mlb(114, "Cleveland", "Guardians"), mlb(115, "Colorado", "Rockies"),
  mlb(116, "Detroit", "Tigers"), mlb(117, "Houston", "Astros"), mlb(118, "Kansas City", "Royals"), mlb(119, "Los Angeles", "Dodgers"),
  mlb(120, "Washington", "Nationals"), mlb(121, "New York", "Mets"), mlb(133, "Athletics", "Athletics"), mlb(134, "Pittsburgh", "Pirates"),
  mlb(135, "San Diego", "Padres"), mlb(136, "Seattle", "Mariners"), mlb(137, "San Francisco", "Giants"), mlb(138, "St. Louis", "Cardinals"),
  mlb(139, "Tampa Bay", "Rays"), mlb(140, "Texas", "Rangers"), mlb(141, "Toronto", "Blue Jays"), mlb(142, "Minnesota", "Twins"),
  mlb(143, "Philadelphia", "Phillies"), mlb(144, "Atlanta", "Braves"), mlb(145, "Chicago", "White Sox"), mlb(146, "Miami", "Marlins"),
  mlb(147, "New York", "Yankees"), mlb(158, "Milwaukee", "Brewers"),
];

export const LEAGUE_NAMES: Record<League, string> = { nhl: "NHL", mlb: "MLB" };
export const fullName = (t: Team) => (t.place === t.name ? t.name : `${t.place} ${t.name}`);

const ALIASES: Record<string, string> = {
  leafs: "maple leafs", habs: "canadiens", sens: "senators", pens: "penguins", isles: "islanders", bolts: "lightning", caps: "capitals",
  jackets: "blue jackets", wings: "red wings", knights: "golden knights", jays: "blue jays", dbacks: "diamondbacks", "d-backs": "diamondbacks",
  "o's": "orioles", "bo sox": "red sox", yanks: "yankees", gigantes: "giants", cards: "cardinals", stros: "astros",
};
const norm = (s: string) => s.toLowerCase().replace(/[.’']/g, "").replace(/\s+/g, " ").trim();

/** Teams a person might mean by a name. One result means it is clear; two or more means ask which; none means it is not in these leagues. */
export function findTeams(query: string, league?: League): Team[] {
  let q = norm(query);
  q = ALIASES[q] ?? q;
  if (q.length < 2) return [];
  const pool = TEAMS.filter((t) => !league || t.league === league);
  const exact = pool.filter((t) => norm(fullName(t)) === q || norm(t.name) === q || (t.code.toLowerCase() === q && t.league === "nhl"));
  if (exact.length) return exact;
  // "toronto maple leafs", "the leafs", "leafs hockey": the full name contains it, or it contains the nickname.
  const words = q.replace(/^the /, "").replace(/\b(hockey|baseball|nhl|mlb|team)\b/g, "").replace(/\s+/g, " ").trim();
  if (words.length < 2) return [];
  return pool.filter((t) => norm(fullName(t)).includes(words) || words.includes(norm(t.name)));
}

export const teamByCode = (league: League, code: string) => TEAMS.find((t) => t.league === league && t.code === code) ?? null;

// ---- Games ----

export type Side = { code: string; name: string; score: number | null };
export type Game = {
  id: string;
  league: League;
  start: Date;
  state: "upcoming" | "live" | "final";
  home: Side;
  away: Side;
  /** How a finished game ended when it went past regulation, e.g. "OT", "SO", "11 innings". */
  extra: string | null;
  /** "preseason", "spring training" or "playoffs"; null for a regular-season game. */
  kind: string | null;
};

const cache = new Map<string, { at: number; data: unknown }>();
const CACHE_MS = 60_000;

async function getJson(url: string, fetchFn?: typeof fetch): Promise<any | null> {
  // The shared cache is only for the real network. Anything injected (tests) is asked every time.
  if (!fetchFn) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  }
  try {
    const res = await (fetchFn ?? fetch)(url, { signal: AbortSignal.timeout(8_000), redirect: "follow" });
    if (!res.ok) return null;
    const data = await res.json();
    if (!fetchFn) {
      if (cache.size > 200) cache.clear();
      cache.set(url, { at: Date.now(), data });
    }
    return data;
  } catch {
    return null;
  }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function nhlGames(data: any): Game[] {
  const out: Game[] = [];
  for (const g of data?.games ?? []) {
    if (g.gameScheduleState && g.gameScheduleState !== "OK") continue; // postponed or cancelled
    const start = new Date(g.startTimeUTC);
    if (Number.isNaN(start.getTime())) continue;
    const st = String(g.gameState);
    const state = st === "FINAL" || st === "OFF" ? "final" : st === "LIVE" || st === "CRIT" ? "live" : "upcoming";
    const side = (t: any): Side => ({ code: String(t?.abbrev ?? ""), name: String(t?.commonName?.default ?? t?.abbrev ?? "?"), score: num(t?.score) });
    const last = g.gameOutcome?.lastPeriodType;
    out.push({
      id: String(g.id),
      league: "nhl",
      start,
      state,
      home: side(g.homeTeam),
      away: side(g.awayTeam),
      extra: state === "final" && (last === "OT" || last === "SO") ? last : null,
      kind: g.gameType === 1 ? "preseason" : g.gameType === 3 ? "playoffs" : null,
    });
  }
  return out;
}

function mlbGames(data: any): Game[] {
  const out: Game[] = [];
  for (const day of data?.dates ?? []) {
    for (const g of day.games ?? []) {
      const detail = String(g.status?.detailedState ?? "");
      if (/postponed|cancel/i.test(detail)) continue;
      const start = new Date(g.gameDate);
      if (Number.isNaN(start.getTime())) continue;
      const abstract = String(g.status?.abstractGameState ?? "");
      const state = abstract === "Final" ? "final" : abstract === "Live" ? "live" : "upcoming";
      const side = (t: any): Side => ({ code: String(t?.team?.id ?? ""), name: String(t?.team?.teamName ?? t?.team?.name ?? "?"), score: num(t?.score) });
      const innings = num(g.linescore?.currentInning);
      const planned = num(g.linescore?.scheduledInnings) ?? 9;
      out.push({
        id: String(g.gamePk),
        league: "mlb",
        start,
        state,
        home: side(g.teams?.home),
        away: side(g.teams?.away),
        extra: state === "final" && innings && innings > planned ? `${innings} innings` : null,
        kind: g.gameType === "S" || g.gameType === "E" ? "spring training" : ["F", "D", "L", "W"].includes(g.gameType) ? "playoffs" : null,
      });
    }
  }
  return out;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** A team's games from about two days ago to a week ahead, oldest first. null means the feed could not be reached, which is not the same as no games. */
export async function gamesFor(team: Team, now: Date, fetchFn?: typeof fetch): Promise<Game[] | null> {
  const from = now.getTime() - 2 * 86_400_000;
  const to = now.getTime() + 8 * 86_400_000;
  let all: Game[];
  if (team.league === "nhl") {
    const data = await getJson(`https://api-web.nhle.com/v1/club-schedule-season/${encodeURIComponent(team.code)}/now`, fetchFn);
    if (!data) return null;
    all = nhlGames(data);
  } else {
    const q = new URLSearchParams({ sportId: "1", teamId: team.code, startDate: ymd(new Date(from)), endDate: ymd(new Date(to)), hydrate: "linescore" });
    const data = await getJson(`https://statsapi.mlb.com/api/v1/schedule?${q}`, fetchFn);
    if (!data) return null;
    all = mlbGames(data);
  }
  return all.filter((g) => g.start.getTime() >= from && g.start.getTime() <= to).sort((a, b) => a.start.getTime() - b.start.getTime());
}

// ---- Words ----

const mine = (team: Team, g: Game) => (g.home.code === team.code ? g.home : g.away);
const theirs = (team: Team, g: Game) => (g.home.code === team.code ? g.away : g.home);

const clock = (d: Date, tz: string) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(d);
const dayWord = (d: Date, now: Date, tz: string) => {
  const t = localDayBounds(now, tz);
  if (d >= t.start && d < t.end) return "today";
  const tomorrow = localDayBounds(new Date(t.end.getTime() + 3_600_000), tz);
  if (d >= t.end && d < tomorrow.end) return "tomorrow";
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: tz }).format(d);
};
const tag = (g: Game) => (g.kind ? ` (${g.kind})` : "");

export type Result = "won" | "lost" | "tied";
export const resultOf = (team: Team, g: Game): Result | null => {
  const a = mine(team, g).score;
  const b = theirs(team, g).score;
  if (g.state !== "final" || a === null || b === null) return null;
  return a > b ? "won" : a < b ? "lost" : "tied";
};

const afterExtra = (g: Game) => (g.extra === "OT" ? " in overtime" : g.extra === "SO" ? " in a shootout" : g.extra ? ` in ${g.extra}` : "");

/** "Maple Leafs beat Canadiens 4–1 in overtime". Their own score first. */
export function finalLine(team: Team, g: Game): string | null {
  const r = resultOf(team, g);
  if (!r) return null;
  const a = mine(team, g);
  const b = theirs(team, g);
  const verb = r === "won" ? "beat" : r === "lost" ? "lost to" : "tied";
  return `${a.name} ${verb} ${b.name} ${a.score}–${b.score}${afterExtra(g)}${tag(g)}`;
}

/** "Maple Leafs vs Canadiens, today 7:00 PM" (home) or "Blue Jays at Yankees, tomorrow 1:05 PM" (away). */
export function upcomingLine(team: Team, g: Game, now: Date, tz: string): string {
  const home = g.home.code === team.code;
  return `${mine(team, g).name} ${home ? "vs" : "at"} ${theirs(team, g).name}, ${dayWord(g.start, now, tz)} ${clock(g.start, tz)}${tag(g)}`;
}

/** Facts for the morning briefing: last night's result, today's game or what is next. Empty when there is nothing to say. */
export function briefingFacts(team: Team, games: Game[], now: Date, tz: string): string[] {
  const day = localDayBounds(now, tz);
  const yesterday = day.start.getTime() - 86_400_000;
  const lines: string[] = [];
  for (const g of games.filter((x) => x.state === "final" && x.start.getTime() >= yesterday && x.start <= now).slice(-2)) {
    const l = finalLine(team, g);
    if (l) lines.push(`${l} (${g.start < day.start ? "yesterday" : "earlier today"})`);
  }
  const live = games.find((x) => x.state === "live");
  if (live) lines.push(`${upcomingLine(team, live, now, tz)} (in progress)`);
  const today = games.filter((x) => x.state === "upcoming" && x.start >= day.start && x.start < day.end);
  for (const g of today) lines.push(upcomingLine(team, g, now, tz));
  if (!today.length && !live) {
    const next = games.find((x) => x.state === "upcoming" && x.start >= day.end);
    if (next && next.start.getTime() - now.getTime() <= 7 * 86_400_000) lines.push(`Next: ${upcomingLine(team, next, now, tz)}`);
  }
  return lines.map((l) => `- ${l}`);
}

// ---- Alerts ----

/** A game is announced this long before it starts. */
export const SOON_MIN = 60;
/** A finished game is only announced if it started after this long before the person began following the team, so following one never floods the chat. */
const FOLLOW_GRACE_MS = 4 * 3_600_000;

export type Alert = { kind: "soon" | "final"; game: Game; text: string; title: string; body: string };

/** What, if anything, a team's schedule says should go out right now. Pure: the caller records which ones were already sent. */
export function dueAlerts(team: Team, games: Game[], now: Date, tz: string, followedAt: Date): Alert[] {
  const out: Alert[] = [];
  for (const g of games) {
    const mins = Math.round((g.start.getTime() - now.getTime()) / 60_000);
    if (g.state === "upcoming" && mins > 0 && mins <= SOON_MIN) {
      const m = mine(team, g);
      const o = theirs(team, g);
      const where = g.home.code === team.code ? "vs" : "at";
      out.push({
        kind: "soon",
        game: g,
        title: `${m.name} ${where} ${o.name}`,
        body: `Starts ${clock(g.start, tz)} · in ${mins} min${tag(g)}`,
        text: `${m.name} ${where} ${o.name} starts at ${clock(g.start, tz)}, in ${mins} minutes${tag(g)}.`,
      });
    }
    if (g.state === "final" && g.start.getTime() >= followedAt.getTime() - FOLLOW_GRACE_MS && g.start.getTime() >= now.getTime() - 24 * 3_600_000) {
      const r = resultOf(team, g);
      const line = finalLine(team, g);
      if (!r || !line) continue;
      const m = mine(team, g);
      const o = theirs(team, g);
      out.push({
        kind: "final",
        game: g,
        title: `Final: ${m.name} ${m.score}, ${o.name} ${o.score}`,
        body: `${r === "won" ? "Win" : r === "lost" ? "Loss" : "Tie"}${afterExtra(g)}${tag(g)}`,
        text: `${line}.`,
      });
    }
  }
  return out;
}
