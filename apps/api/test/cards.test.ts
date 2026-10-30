import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResult } from "../src/brain/model.js";
import { messages } from "../src/db/schema.js";
import { withTenant } from "../src/db/client.js";
import { arrange, CardSchema, validCards, type Card } from "../src/lib/cards.js";
import { createRegistry } from "../src/tools/builtin.js";
import { seedOwner, setupApp, signUp, type Client, type Ctx } from "./helpers.js";

let ctx: Ctx;
let owner: Client;
let chat: ModelResult[] = [];
const calls: ModelRequest[] = [];
const model: ModelClient = {
  async complete(req, onText) {
    calls.push(JSON.parse(JSON.stringify(req)));
    const res = chat.shift()!;
    for (const b of res.content) if (b.type === "text") onText(b.text);
    return res;
  },
};
beforeAll(async () => {
  ctx = await setupApp(model, createRegistry());
  owner = (await seedOwner(ctx)).c;
});
afterAll(() => ctx.close());

const say = (t: string): ModelResult => ({ content: [{ type: "text", text: t }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } });
const use = (name: string, input: unknown, id = "t1"): ModelResult => ({ content: [{ type: "tool_use", id, name, input }], stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } });
const events = (raw: string) => raw.split("\n\n").filter((c) => c.startsWith("data: ")).map((c) => JSON.parse(c.slice(6)));
const history = async (c: Client) => (await c.get("/v1/chat/history")).body.messages as { role: string; text: string; cards: Card[] }[];

describe("the card menu", () => {
  it("accepts the cards we draw and refuses everything else", () => {
    const ok = [
      { kind: "task", id: "5b9a3c1e-2d4f-4c6a-8b7e-1f2a3b4c5d6e", title: "Call mum" },
      { kind: "weather", place: "Leeds", summary: "light rain", high: "11°C", low: "5°C", rain: 70 },
      { kind: "list", style: "check", items: [{ text: "one" }, { text: "two", href: "https://example.com/x" }] },
      { kind: "table", columns: ["Day", "Plan"], rows: [["Mon", "Gym"]] },
      { kind: "place", name: "Cafe", address: "1 High St" },
      { kind: "replies", options: ["Yes", "No"] },
    ];
    for (const c of ok) expect(CardSchema.safeParse(c).success, JSON.stringify(c)).toBe(true);
    const bad = [
      { kind: "script", html: "<script>alert(1)</script>" },
      { kind: "list", items: [{ text: "x", href: "javascript:alert(1)" }] },
      { kind: "list", items: [] },
      { kind: "replies", options: [] },
      { kind: "replies", options: ["a", "b", "c", "d", "e"] },
      { kind: "task", id: "not-a-uuid", title: "x" },
      { kind: "table", columns: [], rows: [["a"]] },
    ];
    for (const c of bad) expect(CardSchema.safeParse(c).success, JSON.stringify(c)).toBe(false);
    expect(validCards([...ok, ...bad]).length).toBe(ok.length);
    expect(validCards("nope")).toEqual([]);
  });

  it("puts one set of quick replies last, whatever order they arrived in", () => {
    const r1: Card = { kind: "replies", options: ["A"] };
    const r2: Card = { kind: "replies", options: ["B"] };
    const l: Card = { kind: "list", style: "bullets", items: [{ text: "x" }] };
    expect(arrange([r1, l, r2])).toEqual([l, r2]);
  });
});

describe("cards in a chat turn", () => {
  it("a task card streams live, is saved with the reply that ends the turn, and comes back on reload, encrypted at rest", async () => {
    const u = await signUp(ctx, owner, "Cd1");
    chat = [use("add_task", { title: "Call the dentist about the SECRETWORD crown" }), say("On the list.")];
    const r = await u.c.req("POST", "/v1/chat", { message: "remind me to call the dentist" });
    const ev = events(r.raw.body);
    const card = ev.find((e) => e.type === "card");
    expect(card.card).toMatchObject({ kind: "task", title: "Call the dentist about the SECRETWORD crown" });
    expect(ev.findIndex((e) => e.type === "card")).toBeLessThan(ev.findIndex((e) => e.type === "done"));

    const h = await history(u.c);
    const last = h.at(-1)!;
    expect(last).toMatchObject({ role: "assistant", text: "On the list." });
    expect(last.cards).toMatchObject([{ kind: "task", id: card.card.id }]);
    expect(h[0]!.cards).toEqual([]); // the user's own message has none
    const rows = await ctx.owner.db.select().from(messages).where(eq(messages.workspaceId, u.workspaceId));
    expect(rows.some((m) => m.uiEnc && m.uiEnc.toString("utf8").includes("SECRETWORD"))).toBe(false);
    // the tool result told Danny not to repeat what the card shows
    expect(JSON.stringify(calls.filter((c) => c.tools.length).at(-1)!.messages.at(-1))).toContain("shows the task as a card"); // the last chat call, not the quiet memory pass after it
  });

  it("quick replies are validated, limited to one set, and shown last", async () => {
    const u = await signUp(ctx, owner, "Cd2");
    chat = [
      { content: [{ type: "tool_use", id: "a", name: "suggest_replies", input: { options: ["Old", "Set"] } }, { type: "tool_use", id: "b", name: "show_card", input: { card: "list", style: "steps", items: [{ text: "First" }, { text: "Second" }, { text: "Third" }] } }, { type: "tool_use", id: "c", name: "suggest_replies", input: { options: ["Yes, watch it", "Not now"] } }], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
      say("Want me to watch it?"),
    ];
    await u.c.req("POST", "/v1/chat", { message: "plan it" });
    const last = (await history(u.c)).at(-1)!;
    expect(last.cards.map((c) => c.kind)).toEqual(["list", "replies"]);
    expect(last.cards[1]).toMatchObject({ options: ["Yes, watch it", "Not now"] });
  });

  it("a card Danny gets wrong is refused with a reason, and nothing broken is shown", async () => {
    const u = await signUp(ctx, owner, "Cd3");
    chat = [use("show_card", { card: "table", title: "x" }), say("In text then.")];
    const r = await u.c.req("POST", "/v1/chat", { message: "show a table" });
    expect(events(r.raw.body).some((e) => e.type === "card")).toBe(false);
    expect(JSON.stringify(calls.at(-1)!.messages.at(-1))).toContain("not valid");
    expect((await history(u.c)).at(-1)!.cards).toEqual([]);
    chat = [use("show_card", { card: "list", items: [{ text: "ok", href: "javascript:alert(1)" }, { text: "fine", href: "https://example.com" }, { text: "plain" }] }), say("Here.")];
    await u.c.req("POST", "/v1/chat", { message: "list" });
    const card = (await history(u.c)).at(-1)!.cards[0] as Extract<Card, { kind: "list" }>;
    expect(card.items.map((i) => i.href)).toEqual([undefined, "https://example.com", undefined]); // the unsafe link is gone, the rest stay
  });

  it("older messages without cards load as before", async () => {
    const u = await signUp(ctx, owner, "Cd4");
    chat = [say("Just words.")];
    await u.c.req("POST", "/v1/chat", { message: "hi" });
    expect((await history(u.c)).map((m) => m.cards)).toEqual([[], []]);
  });
});

describe("cards from the other tools", () => {
  const reg = createRegistry();
  const run = async (name: string, u: { workspaceId: string; userId: string }, input: unknown, extra: Record<string, unknown> = {}) => {
    const shown: Card[] = [];
    const t = reg.get(name)!;
    const out = await t.run!({ workspaceId: u.workspaceId, userId: u.userId, db: ctx.runtime.db, vault: ctx.vault, google: null, tenant: (fn: any) => withTenant(ctx.runtime.db, u.workspaceId, fn), card: (c: Card) => shown.push(c), ...extra } as any, t.input.parse(input));
    return { out, shown };
  };

  it("whats_next shows the one task", async () => {
    const u = await signUp(ctx, owner, "Cd5");
    await u.c.post("/v1/tasks", { title: "Pay the invoice" });
    const { shown } = await run("whats_next", u, {});
    expect(shown).toMatchObject([{ kind: "task", title: "Pay the invoice" }]);
  });

  it("get_weather shows a weather card", async () => {
    const u = await signUp(ctx, owner, "Cd6");
    await u.c.req("PUT", "/v1/style/location", { text: "Austin, TX" });
    const fx = (async (url: string) =>
      String(url).includes("geocoding")
        ? new Response(JSON.stringify({ results: [{ name: "Austin", latitude: 30, longitude: -97 }] }), { status: 200 })
        : new Response(JSON.stringify({ daily: { weather_code: [3], temperature_2m_max: [20], temperature_2m_min: [10], precipitation_probability_max: [40] } }), { status: 200 })) as unknown as typeof fetch;
    const { shown, out } = await run("get_weather", u, {}, { fetchFn: fx });
    expect(shown).toMatchObject([{ kind: "weather", place: "Austin", summary: "overcast", high: "20°C", low: "10°C", rain: 40 }]);
    expect(out).toContain("Austin: overcast");
  });
});
