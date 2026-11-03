import { eq, ne } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResult, SearchRequest, SearchResult } from "../src/brain/model.js";
import { withTenant } from "../src/db/client.js";
import { followedTeams, gameAlerts, users } from "../src/db/schema.js";
import { runDueBriefings, runGameAlerts, type BackgroundDeps } from "../src/lib/background.js";
import type { PushPayload, PushSender, PushSub } from "../src/lib/push.js";
import { briefingFacts, dueAlerts, findTeams, finalLine, gamesFor, teamByCode } from "../src/lib/sports.js";
import { createRegistry } from "../src/tools/builtin.js";
import type { ToolCtx } from "../src/tools/registry.js";
import { seedOwner, setupApp, signUp, type Client, type Ctx } from "./helpers.js";

class FakePush implements PushSender {
  publicKey: string | null = "k";
  sent: PushPayload[] = [];
  async send(_s: PushSub, p: PushPayload) {
    this.sent.push(p);
    return "ok" as const;
  }
}
const push = new FakePush();
let ctx: Ctx;
let owner: Client;
const searches: SearchRequest[] = [];
const plain: ModelRequest[] = [];
const model: ModelClient = {
  async complete(req, onText) {
    plain.push(JSON.parse(JSON.stringify(req)));
    const res: ModelResult = { content: [{ type: "text", text: "Morning. Leafs won." }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } };
    onText("Morning. Leafs won.");
    return res;
  },
  async search(req): Promise<SearchResult> {
    searches.push(req);
    return { text: "Morning. Leafs won.", sources: [], usage: { inputTokens: 1, outputTokens: 1 } };
  },
};

// 08:00 in Toronto (EST, UTC-5).
const NOW = new Date("2027-01-15T13:00:00Z");
const nhlGame = (id: number, startUTC: string, state: string, tor: "home" | "away", torScore: number | null, otherScore: number | null, other: [string, string], outcome = "REG", type = 2) => {
  const mk = (abbrev: string, name: string, score: number | null) => ({ abbrev, commonName: { default: name }, ...(score === null ? {} : { score }) });
  const t = mk("TOR", "Maple Leafs", torScore);
  const o = mk(other[0], other[1], otherScore);
  return { id, gameType: type, startTimeUTC: startUTC, gameState: state, gameScheduleState: "OK", homeTeam: tor === "home" ? t : o, awayTeam: tor === "home" ? o : t, ...(state === "FINAL" || state === "OFF" ? { gameOutcome: { lastPeriodType: outcome } } : {}) };
};
let schedule: any[] = [];
const resetSchedule = () => {
  schedule = [
    nhlGame(1, "2027-01-15T00:00:00Z", "FINAL", "home", 4, 1, ["MTL", "Canadiens"]), // last night 19:00
    nhlGame(2, "2027-01-16T00:00:00Z", "FUT", "home", null, null, ["BOS", "Bruins"]), // tonight 19:00
    nhlGame(3, "2027-01-18T00:00:00Z", "FUT", "away", null, null, ["NYR", "Rangers"]),
  ];
};
resetSchedule();
beforeEach(resetSchedule);
const urls: string[] = [];
const fakeFetch = (async (url: string | URL | Request) => {
  const u = String(url);
  urls.push(u);
  if (u.includes("api-web.nhle.com") && u.includes("/TOR/")) return new Response(JSON.stringify({ games: schedule }));
  if (u.includes("statsapi.mlb.com")) return new Response(JSON.stringify({ dates: [] }));
  return new Response("nope", { status: 404 });
}) as typeof fetch;

beforeAll(async () => {
  ctx = await setupApp(model, createRegistry(), {}, push);
  owner = (await seedOwner(ctx)).c;
});
afterAll(() => ctx.close());

const deps = (): BackgroundDeps => ({ db: ctx.runtime.db, vault: ctx.vault, push, config: ctx.config, model, fetchFn: fakeFetch });
const reg = createRegistry();
type U = Awaited<ReturnType<typeof signUp>>;
const toolCtx = (u: U): ToolCtx => ({ card: () => {}, workspaceId: u.workspaceId, userId: u.userId, db: ctx.runtime.db, vault: ctx.vault, google: null, tenant: (fn) => withTenant(ctx.runtime.db, u.workspaceId, fn) });
const run = (u: U, tool: string, input: unknown) => reg.get(tool)!.run!(toolCtx(u), reg.get(tool)!.input.parse(input));
const chatText = async (c: Client): Promise<string[]> => (await c.get("/v1/chat/history")).body.messages.map((m: any) => m.text as string);
const TOR = teamByCode("nhl", "TOR")!;

describe("finding a team by name", () => {
  it("understands nicknames, and says when a name could be two teams", () => {
    expect(findTeams("Leafs").map((t) => t.code)).toEqual(["TOR"]);
    expect(findTeams("the Maple Leafs")).toHaveLength(1);
    expect(findTeams("Toronto Blue Jays")[0]).toMatchObject({ league: "mlb", code: "141" });
    expect(findTeams("jays")[0]!.name).toBe("Blue Jays");
    expect(findTeams("habs")[0]!.name).toBe("Canadiens");
    expect(findTeams("Toronto").map((t) => t.name).sort()).toEqual(["Blue Jays", "Maple Leafs"]);
    expect(findTeams("Rangers").map((t) => t.league).sort()).toEqual(["mlb", "nhl"]);
    expect(findTeams("Rangers", "nhl")).toHaveLength(1);
    expect(findTeams("Quidditch")).toEqual([]);
    expect(findTeams("a")).toEqual([]);
  });
});

describe("what the feed says", () => {
  it("reads the NHL feed into games, with overtime and a postponed game left out", async () => {
    schedule = [nhlGame(9, "2027-01-14T01:00:00Z", "OFF", "away", 3, 2, ["BOS", "Bruins"], "OT"), { ...nhlGame(10, "2027-01-15T01:00:00Z", "FUT", "home", null, null, ["BOS", "Bruins"]), gameScheduleState: "PPD" }];
    const games = (await gamesFor(TOR, NOW, fakeFetch))!;
    expect(games).toHaveLength(1);
    expect(finalLine(TOR, games[0]!)).toBe("Maple Leafs beat Bruins 3–2 in overtime");
    resetSchedule();
  });

  it("says nothing is known (null) when the feed is down, which is different from no games", async () => {
    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    expect(await gamesFor(TOR, NOW, down)).toBeNull();
    expect(await gamesFor(TOR, NOW, (async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch)).toBeNull();
  });

  it("puts last night's score and tonight's game in the briefing facts, and the next game when none is today", async () => {
    const games = (await gamesFor(TOR, NOW, fakeFetch))!;
    expect(briefingFacts(TOR, games, NOW, "America/Toronto")).toEqual(["- Maple Leafs beat Canadiens 4–1 (yesterday)", "- Maple Leafs vs Bruins, today 7:00 PM"]);
    const quiet = games.filter((g) => g.id !== "2");
    expect(briefingFacts(TOR, quiet, NOW, "America/Toronto")).toEqual(["- Maple Leafs beat Canadiens 4–1 (yesterday)", "- Next: Maple Leafs at Rangers, Sunday 7:00 PM"]);
    expect(briefingFacts(TOR, [], NOW, "America/Toronto")).toEqual([]);
  });

  it("labels preseason games", async () => {
    schedule = [nhlGame(11, "2027-01-15T00:00:00Z", "FINAL", "home", 2, 3, ["MTL", "Canadiens"], "REG", 1)];
    const games = (await gamesFor(TOR, NOW, fakeFetch))!;
    expect(finalLine(TOR, games[0]!)).toBe("Maple Leafs lost to Canadiens 2–3 (preseason)");
    resetSchedule();
  });
});

describe("when an alert is due", () => {
  const long = new Date("2026-12-01T00:00:00Z");
  it("heads-up in the hour before a game, not before and not after it starts", async () => {
    const games = (await gamesFor(TOR, NOW, fakeFetch))!;
    const at = (iso: string) => dueAlerts(TOR, games, new Date(iso), "America/Toronto", long).filter((a) => a.kind === "soon");
    expect(at("2027-01-15T22:00:00Z")).toHaveLength(0); // 17:00, two hours ahead
    const [a] = at("2027-01-15T23:30:00Z"); // 18:30
    expect(a).toMatchObject({ title: "Maple Leafs vs Bruins", body: "Starts 7:00 PM · in 30 min" });
    expect(a!.text).toBe("Maple Leafs vs Bruins starts at 7:00 PM, in 30 minutes.");
    expect(at("2027-01-16T00:05:00Z")).toHaveLength(0); // already started
  });

  it("the final score, but not for old games from before following the team", async () => {
    const games = (await gamesFor(TOR, NOW, fakeFetch))!;
    const [f] = dueAlerts(TOR, games, NOW, "America/Toronto", long).filter((a) => a.kind === "final");
    expect(f).toMatchObject({ title: "Final: Maple Leafs 4, Canadiens 1", body: "Win", text: "Maple Leafs beat Canadiens 4–1." });
    expect(dueAlerts(TOR, games, NOW, "America/Toronto", NOW).filter((a) => a.kind === "final")).toHaveLength(0);
    expect(dueAlerts(TOR, games, new Date("2027-01-17T13:00:00Z"), "America/Toronto", long).filter((a) => a.kind === "final")).toHaveLength(0); // over a day old
  });
});

describe("following teams", () => {
  it("is private to each person, encrypted, capped, and can have alerts turned off", async () => {
    const u = await signUp(ctx, owner, "Fan");
    const other = await signUp(ctx, owner, "Oth");
    const r = await u.c.post("/v1/teams", { league: "nhl", code: "TOR" });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ fullName: "Toronto Maple Leafs", leagueName: "NHL", notify: true });
    await u.c.post("/v1/teams", { league: "nhl", code: "TOR" }); // again: no second row
    expect((await u.c.get("/v1/teams")).body.items).toHaveLength(1);
    expect((await other.c.get("/v1/teams")).body.items).toEqual([]);
    const [raw] = await ctx.owner.db.select().from(followedTeams).where(eq(followedTeams.userId, u.userId));
    expect(raw!.teamEnc.toString("utf8")).not.toContain("TOR");

    expect((await other.c.patch(`/v1/teams/${r.body.item.id}`, { notify: false })).status).toBe(404);
    expect((await u.c.patch(`/v1/teams/${r.body.item.id}`, { notify: false })).status).toBe(200);
    expect((await u.c.get("/v1/teams")).body.items[0].notify).toBe(false);
    expect((await u.c.post("/v1/teams", { league: "nhl", code: "ZZZ" })).status).toBe(400);

    for (const code of ["BOS", "BUF", "CGY", "CAR", "CHI", "COL", "DAL"]) await u.c.post("/v1/teams", { league: "nhl", code });
    expect((await u.c.get("/v1/teams")).body.items).toHaveLength(8);
    expect((await u.c.post("/v1/teams", { league: "nhl", code: "DET" })).status).toBe(400);
    expect((await u.c.del(`/v1/teams/${r.body.item.id}`)).status).toBe(200);
    expect((await u.c.get("/v1/teams")).body.items).toHaveLength(7);
  });

  it("works from chat: follows, asks which when it could be two, turns alerts off", async () => {
    const u = await signUp(ctx, owner, "Chat");
    expect(await run(u, "follow_team", { team: "Toronto" })).toMatch(/Maple Leafs \(NHL\) or Toronto Blue Jays \(MLB\)\. Which one\?/);
    expect((await u.c.get("/v1/teams")).body.items).toEqual([]);
    expect(await run(u, "follow_team", { team: "Blue Jays" })).toContain("Following the Toronto Blue Jays (MLB)");
    expect(await run(u, "follow_team", { team: "Quidditch" })).toContain("NHL and MLB");
    const id = (await u.c.get("/v1/teams")).body.items[0].id;
    expect(await run(u, "list_teams", {})).toContain("alerts on");
    expect(await run(u, "set_team_alerts", { id, on: false })).toContain("Game alerts off");
    expect(await run(u, "list_teams", {})).toContain("alerts off");
    expect(await run(u, "unfollow_team", { id })).toBe("Removed.");
  });
});

describe("the morning briefing", () => {
  const setup = async (name: string, prefs: Record<string, unknown> = {}) => {
    const u = await signUp(ctx, owner, name);
    await u.c.patch("/v1/profile", { briefingEnabled: true, briefingTime: "07:30", ...prefs });
    // Each test looks at one person's briefing, so nobody else's goes out alongside it.
    await ctx.owner.db.update(users).set({ briefingEnabled: false }).where(ne(users.id, u.userId));
    await ctx.owner.db.update(users).set({ timezone: "America/Toronto" }).where(eq(users.id, u.userId));
    return u;
  };

  it("carries last night's score and tonight's game from the league, and tells the model not to search for sports", async () => {
    const u = await setup("Brf");
    await u.c.post("/v1/teams", { league: "nhl", code: "TOR" });
    searches.length = 0;
    await runDueBriefings(deps(), NOW);
    const s = searches.at(-1)!;
    expect(s.prompt).toContain("- Maple Leafs beat Canadiens 4–1 (yesterday)");
    expect(s.prompt).toContain("- Maple Leafs vs Bruins, today 7:00 PM");
    expect(s.prompt).toContain("**Sports**");
    expect(s.system).toContain("Never search for sports");
    expect(s.prompt).not.toContain("**Good news**");
  });

  it("still goes out when the sports feed is down", async () => {
    const u = await setup("Dwn");
    await u.c.post("/v1/teams", { league: "nhl", code: "TOR" });
    searches.length = 0;
    await runDueBriefings({ ...deps(), fetchFn: (async () => new Response("", { status: 500 })) as unknown as typeof fetch }, new Date("2027-01-16T13:00:00Z"));
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.at(-1)!.prompt).not.toContain("**Sports**");
    expect((await chatText(u.c)).at(-1)).toContain("Morning");
  });

  it("asks for one good news story when turned on, and searches a little more", async () => {
    await setup("Gd", { goodNews: true });
    searches.length = 0;
    await runDueBriefings(deps(), new Date("2027-01-17T13:00:00Z"));
    const mine = searches.find((s) => s.prompt.includes("**Good news**"))!;
    expect(mine.maxSearches).toBe(4);
    expect(mine.prompt).toContain("exactly one real, recent, uplifting story");
  });

  it("limits the news to what they asked for, and does no web search at all when it is off", async () => {
    const light = await setup("Lt", { newsItems: 1 });
    expect((await light.c.get("/v1/me")).body.user).toMatchObject({ newsItems: 1, goodNews: false });
    searches.length = 0;
    await runDueBriefings(deps(), new Date("2027-01-18T13:00:00Z"));
    expect(searches.some((s) => s.prompt.includes("up to 1 in all"))).toBe(true);

    const off = await setup("Off", { newsItems: 0 });
    searches.length = 0;
    plain.length = 0;
    await runDueBriefings(deps(), new Date("2027-01-19T13:00:00Z"));
    expect(searches.some((s) => s.prompt.includes("Topics they follow"))).toBe(false);
    const p = plain.find((r) => JSON.stringify(r.messages).includes("They have turned the news off"));
    expect(p).toBeTruthy();
    expect((await chatText(off.c)).at(-1)).toContain("Morning");
    expect((await off.c.patch("/v1/profile", { newsItems: 9 })).status).toBe(400);
  });
});

describe("game alerts", () => {
  const follow = async (name: string) => {
    const u = await signUp(ctx, owner, name);
    await u.c.post("/v1/push/subscribe", { endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys: { p256dh: "p", auth: "a" } });
    await u.c.post("/v1/teams", { league: "nhl", code: "TOR" });
    await ctx.owner.db.update(users).set({ timezone: "America/Toronto" }).where(eq(users.id, u.userId));
    await ctx.owner.db.update(followedTeams).set({ createdAt: new Date("2026-12-01T00:00:00Z") }).where(eq(followedTeams.userId, u.userId));
    return u;
  };

  it("sends a heads-up before the game and the final after it, each once, and buzzes", async () => {
    const u = await follow("Al1");
    push.sent = [];
    await runGameAlerts(deps(), new Date("2027-01-15T23:30:00Z")); // 18:30, game at 19:00
    expect((await chatText(u.c)).filter((t) => t.includes("Maple Leafs vs Bruins starts at 7:00 PM, in 30 minutes."))).toHaveLength(1);
    expect(push.sent.filter((p) => p.title === "Maple Leafs vs Bruins")).toHaveLength(1);
    await runGameAlerts(deps(), new Date("2027-01-15T23:31:00Z"));
    expect((await chatText(u.c)).filter((t) => t.includes("starts at 7:00 PM"))).toHaveLength(1); // not twice

    schedule[1] = nhlGame(2, "2027-01-16T00:00:00Z", "FINAL", "home", 2, 3, ["BOS", "Bruins"], "OT");
    push.sent = [];
    await runGameAlerts(deps(), new Date("2027-01-16T02:30:00Z")); // 21:30, before quiet hours
    expect((await chatText(u.c)).at(-1)).toBe("Maple Leafs lost to Bruins 2–3 in overtime.");
    expect(push.sent.map((p) => p.title)).toContain("Final: Maple Leafs 2, Bruins 3");
    const rows = await ctx.owner.db.select().from(gameAlerts).where(eq(gameAlerts.userId, u.userId));
    expect(rows.map((r) => `${r.gameId}:${r.kind}`).sort()).toEqual(["1:final", "2:final", "2:soon"].sort());
    resetSchedule();
  });

  it("does not buzz in quiet hours but still leaves it in the chat", async () => {
    const u = await follow("Al2");
    schedule[1] = nhlGame(2, "2027-01-16T00:00:00Z", "FINAL", "home", 5, 0, ["BOS", "Bruins"]);
    push.sent = [];
    await runGameAlerts(deps(), new Date("2027-01-16T03:30:00Z")); // 22:30 in Toronto
    expect((await chatText(u.c)).at(-1)).toBe("Maple Leafs beat Bruins 5–0.");
    expect(push.sent.filter((p) => p.title.startsWith("Final: Maple Leafs 5"))).toHaveLength(0);
    resetSchedule();
  });

  it("stays quiet with alerts off, and does not announce games from before they followed the team", async () => {
    const u = await follow("Al3");
    const id = (await u.c.get("/v1/teams")).body.items[0].id;
    await u.c.patch(`/v1/teams/${id}`, { notify: false });
    await runGameAlerts(deps(), new Date("2027-01-15T23:30:00Z"));
    expect((await chatText(u.c)).filter((t) => t.includes("starts at"))).toEqual([]);

    const v = await follow("Al4");
    await ctx.owner.db.update(followedTeams).set({ createdAt: new Date("2027-01-15T22:00:00Z") }).where(eq(followedTeams.userId, v.userId));
    await runGameAlerts(deps(), new Date("2027-01-15T23:30:00Z"));
    const text = await chatText(v.c);
    expect(text.some((t) => t.includes("starts at 7:00 PM"))).toBe(true);
    expect(text.some((t) => t.includes("beat Canadiens"))).toBe(false); // last night's game predates following
  });

  it("asks the league once per team per pass, however many people follow it", async () => {
    await follow("Al5");
    await follow("Al6");
    urls.length = 0;
    await runGameAlerts(deps(), new Date("2027-01-15T23:30:00Z"));
    expect(urls.filter((x) => x.includes("/TOR/"))).toHaveLength(1);
  });
});
