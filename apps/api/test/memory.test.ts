import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResult } from "../src/brain/model.js";
import { memory, users } from "../src/db/schema.js";
import { withTenant } from "../src/db/client.js";
import { runDueMemoryTidy, type BackgroundDeps } from "../src/lib/background.js";
import { addMemory, forPrompt, jaccard, recall, words } from "../src/lib/memory.js";
import type { PushSender } from "../src/lib/push.js";
import { createRegistry } from "../src/tools/builtin.js";
import { seedOwner, setupApp, signUp, type Client, type Ctx } from "./helpers.js";

const push: PushSender = { publicKey: null, send: async () => "failed" };
let ctx: Ctx;
let owner: Client;
let chat: ModelResult[] = [];
let plainReply: ((req: ModelRequest) => ModelResult) | null = null;
const calls: ModelRequest[] = [];
const model: ModelClient = {
  async complete(req, onText) {
    calls.push(JSON.parse(JSON.stringify(req)));
    if (req.tools.length === 0 && plainReply) return plainReply(req);
    const res = chat.shift()!;
    for (const b of res.content) if (b.type === "text") onText(b.text);
    return res;
  },
};
beforeAll(async () => {
  ctx = await setupApp(model, createRegistry(), {}, push);
  owner = (await seedOwner(ctx)).c;
});
afterAll(() => ctx.close());

const say = (t: string): ModelResult => ({ content: [{ type: "text", text: t }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } });
const use = (name: string, input: unknown): ModelResult => ({ content: [{ type: "tool_use", id: "t1", name, input }], stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } });
const deps = (): BackgroundDeps => ({ db: ctx.runtime.db, vault: ctx.vault, push, config: ctx.config, model });
type U = Awaited<ReturnType<typeof signUp>>;
const actor = (u: U) => ({ workspaceId: u.workspaceId, userId: u.userId, vault: ctx.vault, tenant: <T,>(fn: any) => withTenant(ctx.runtime.db, u.workspaceId, fn) as Promise<T> });
const sysOf = () => calls.at(-1)!.system;
const items = async (u: U) => (await u.c.get("/v1/memory")).body;
const chatText = async (c: Client) => (await c.get("/v1/chat/history")).body.messages.map((m: any) => m.text as string);

describe("matching", () => {
  it("compares notes by meaningful words", () => {
    expect(words("Marlene prefers texts, not calls")).toEqual(["marlene", "prefers", "texts", "calls"]);
    expect(jaccard(words("Prefers texts to calls"), words("Prefers texts not calls"))).toBeGreaterThan(0.5);
    expect(jaccard(words("Prefers texts"), words("Rent is due on the first"))).toBe(0);
  });
});

describe("saving", () => {
  it("keeps the same thing said twice once, and points at similar notes so the old one can be replaced", async () => {
    const u = await signUp(ctx, owner, "Dup");
    const a = actor(u);
    const first = await addMemory(a, { fact: "Moving to downtown Toronto in March", kind: "plan", expiresOn: "2027-03-31" });
    expect(first.status).toBe("added");
    expect((await addMemory(a, { fact: "moving to downtown toronto in march" })).status).toBe("duplicate");
    expect(await items(u)).toMatchObject({ items: [{ kind: "plan", expiresOn: "2027-03-31" }] });

    const moved = await addMemory(a, { fact: "Now moving to downtown Toronto in April, sales job", kind: "plan" });
    expect(moved.status).toBe("added");
    expect(moved.status === "added" && moved.similar.map((m) => m.id)).toContain((first as any).item.id);
    const fixed = await addMemory(a, { fact: "Moving to downtown Toronto in April", kind: "plan", expiresOn: "2027-04-30" }, { replaces: (first as any).item.id });
    expect(fixed.status).toBe("replaced");
    expect((await items(u)).items.map((m: any) => m.content)).toContain("Moving to downtown Toronto in April");
    expect((await items(u)).items.map((m: any) => m.content)).not.toContain("Moving to downtown Toronto in March");
    expect((await addMemory(a, { fact: "x", }, { replaces: "00000000-0000-4000-8000-000000000000" })).status).toBe("missing");
  });

  it("tells Danny, from chat, when it already knew or found something similar", async () => {
    const u = await signUp(ctx, owner, "Chat");
    chat = [use("remember", { fact: "Marlene prefers texts", subject: "Marlene", kind: "person" }), say("ok")];
    await u.c.req("POST", "/v1/chat", { message: "marlene likes texts" });
    chat = [use("remember", { fact: "Marlene prefers text messages over calls", subject: "Marlene" }), say("ok")];
    await u.c.req("POST", "/v1/chat", { message: "she hates calls" });
    expect(JSON.stringify(calls.at(-1)!.messages.at(-1))).toContain("Similar notes you already hold");
    expect(JSON.stringify(calls.at(-1)!.messages.at(-1))).toContain("replaces=");
    const m = (await items(u)).items;
    expect(m.find((x: any) => x.subject === "Marlene" && x.kind === "person")).toBeTruthy();
  });

  it("stops at 300 notes with a clear message", async () => {
    const u = await signUp(ctx, owner, "Full");
    await ctx.owner.db.insert(memory).values(Array.from({ length: 300 }, (_, i) => ({ workspaceId: u.workspaceId, userId: u.userId, contentEnc: ctx.vault.seal(u.workspaceId, `Note number ${i} about topic${i}`) })));
    expect((await addMemory(actor(u), { fact: "One more distinct thing entirely" })).status).toBe("full");
    expect((await u.c.post("/v1/memory", { content: "Another unrelated thing" })).status).toBe(400);
  });
});

describe("what goes in the prompt", () => {
  async function many(u: U) {
    const a = actor(u);
    await addMemory(a, { fact: "Prefers texts to calls", kind: "preference", pinned: true });
    await addMemory(a, { fact: "Allergic to penicillin", pinned: true });
    await addMemory(a, { fact: "Marlene prefers email on Mondays", subject: "Marlene", kind: "person" });
    await addMemory(a, { fact: "Rent is due on the first of the month" });
    await addMemory(a, { fact: "Dentist is Dr. Okafor on King Street", subject: "Dentist" });
    await addMemory(a, { fact: "Car is a 2014 Civic" });
    await addMemory(a, { fact: "Sister Priya lives in Calgary", subject: "Priya", kind: "person" });
    await addMemory(a, { fact: "Guitar is a Fender Telecaster" });
    await addMemory(a, { fact: "Favourite coffee order is a flat white" });
    await addMemory(a, { fact: "Gym membership renews in June" });
    await addMemory(a, { fact: "Old landlord was Mr. Brandt" });
    await addMemory(a, { fact: "Wedding in Halifax", kind: "plan", expiresOn: "2020-01-01" });
  }

  it("is the pinned core plus what matches the message, not everything, and says how many there are", async () => {
    const u = await signUp(ctx, owner, "Pick");
    await many(u);
    chat = [say("ok")];
    await u.c.req("POST", "/v1/chat", { message: "what does Marlene like?" });
    const s = sysOf();
    expect(s).toContain("Prefers texts to calls"); // pinned
    expect(s).toContain("Allergic to penicillin"); // pinned
    expect(s).toContain("Marlene: Marlene prefers email on Mondays"); // matches the message
    expect(s).not.toContain("Fender Telecaster"); // unrelated
    expect(s).not.toContain("Wedding in Halifax"); // expired
    expect(s).toMatch(/Showing \d+ of 11; use recall/);
  });

  it("puts everything in when there are only a few notes", async () => {
    const u = await signUp(ctx, owner, "Few");
    const a = actor(u);
    await addMemory(a, { fact: "Likes a flat white" });
    await addMemory(a, { fact: "Car is a Civic" });
    chat = [say("ok")];
    await u.c.req("POST", "/v1/chat", { message: "hello there" });
    expect(sysOf()).toContain("flat white");
    expect(sysOf()).toContain("Civic");
    expect(sysOf()).not.toContain("Showing");
  });

  it("recall finds the rest, ranked, with ids, and skips expired notes", async () => {
    const u = await signUp(ctx, owner, "Rec");
    await many(u);
    const found = await recall(actor(u), "guitar telecaster");
    expect(found[0]!.fact).toContain("Telecaster");
    expect((await recall(actor(u), "wedding halifax")).length).toBe(0);
    chat = [use("recall", { query: "dentist" }), say("ok")];
    await u.c.req("POST", "/v1/chat", { message: "who is my dentist" });
    expect(JSON.stringify(calls.at(-1)!.messages.at(-1))).toMatch(/[0-9a-f-]{36} \| fact \| Dentist: Dentist is Dr\. Okafor/);
  });

  it("forgetting from chat deletes for real", async () => {
    const u = await signUp(ctx, owner, "Fg");
    const r = await addMemory(actor(u), { fact: "Secret plan about a surprise party" });
    const id = (r as any).item.id;
    chat = [use("forget_memory", { id }), say("Forgotten.")];
    await u.c.req("POST", "/v1/chat", { message: "forget the party thing" });
    expect(await ctx.owner.db.select().from(memory).where(eq(memory.id, id))).toHaveLength(0);
  });
});

describe("memory tab", () => {
  it("edit, pin, set an expiry, and nobody else can touch it", async () => {
    const u = await signUp(ctx, owner, "Edit");
    const other = await signUp(ctx, owner, "Else");
    const id = (await u.c.post("/v1/memory", { content: "Rent due on the 1st", kind: "fact" })).body.item.id;
    const p = await u.c.patch(`/v1/memory/${id}`, { content: "Rent due on the 3rd", pinned: true, kind: "plan", subject: "Rent", expiresOn: "2030-01-01" });
    expect(p.body.item).toMatchObject({ content: "Rent due on the 3rd", pinned: true, kind: "plan", subject: "Rent", expiresOn: "2030-01-01" });
    expect((await other.c.patch(`/v1/memory/${id}`, { pinned: false })).status).toBe(404);
    expect((await u.c.patch(`/v1/memory/${id}`, { kind: "nonsense" })).status).toBe(400);
    expect((await u.c.patch(`/v1/memory/${id}`, { expiresOn: "soon" })).status).toBe(400);
    const [raw] = await ctx.owner.db.select().from(memory).where(eq(memory.id, id));
    expect(raw!.contentEnc.toString("utf8")).not.toContain("Rent");
    expect(raw!.subjectEnc!.toString("utf8")).not.toContain("Rent");
  });
});

describe("weekly tidy", () => {
  async function seed(u: U, n: number) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = await addMemory(actor(u), { fact: `Distinct fact number ${i} about thing${i} and stuff${i}` });
      ids.push((r as any).item.id);
    }
    await ctx.owner.db.update(users).set({ createdAt: new Date("2026-01-01T00:00:00Z"), lastTidiedAt: null }).where(eq(users.id, u.userId));
    return ids;
  }

  it("merges duplicates and shortens wordy notes, archives instead of deleting, tells the user, and can be undone", async () => {
    const u = await signUp(ctx, owner, "Tidy");
    const ids = await seed(u, 16);
    const wordy = "Distinct fact number 7 about thing7 and stuff7 which is a really very long and rambling way of saying it";
    await ctx.owner.db.update(memory).set({ contentEnc: ctx.vault.seal(u.workspaceId, wordy) }).where(eq(memory.id, ids[7]!));
    let prompt = "";
    plainReply = (req) => {
      prompt = String((req.messages[0] as any).content);
      return say(JSON.stringify({
        merge: [{ keep: ids[0], drop: [ids[1], ids[2]], fact: "Facts 0, 1 and 2 about things" }, { keep: ids[3], drop: ["not-a-real-id"], fact: "bad" }],
        shorten: [{ id: ids[7], fact: "Fact 7 about thing7 and stuff7" }, { id: ids[8], fact: "Distinct fact number 8 about thing8 and stuff8" /* not shorter: ignored */ }],
      }));
    };
    expect(await runDueMemoryTidy(deps(), new Date())).toBeGreaterThanOrEqual(1);
    expect(prompt).toContain(ids[0]!);

    const live = (await items(u)).items.map((m: any) => m.content);
    expect(live).toContain("Facts 0, 1 and 2 about things");
    expect(live).toContain("Fact 7 about thing7 and stuff7");
    expect(live).toHaveLength(14); // 16 - 2 merged away
    expect(live.some((c: string) => c.includes("number 3 "))).toBe(true); // the bad merge changed nothing
    expect(live.some((c: string) => c.includes("number 8 "))).toBe(true);
    expect((await chatText(u.c)).at(-1)).toContain("I tidied your memory: 2 duplicates merged, 1 wordy note shortened");

    const tidied = (await items(u)).tidied;
    expect(tidied.filter((t: any) => t.archived).map((t: any) => t.id).sort()).toEqual([ids[1], ids[2]].sort());
    expect(await ctx.owner.db.select().from(memory).where(eq(memory.id, ids[1]!))).toHaveLength(1); // archived, not deleted

    // undo: an archived note comes back, a shortened one gets its old words back
    expect((await u.c.post(`/v1/memory/${ids[1]}/restore`)).status).toBe(200);
    expect((await u.c.post(`/v1/memory/${ids[7]}/restore`)).body.item.content).toBe(wordy);
    expect((await items(u)).items.map((m: any) => m.id)).toContain(ids[1]);
    expect((await u.c.post(`/v1/memory/${ids[5]}/restore`)).status).toBe(404); // never tidied

    // once a week
    const n = calls.length;
    await runDueMemoryTidy(deps(), new Date(Date.now() + 3600_000));
    expect(calls.length).toBe(n);
    plainReply = null;
  });

  it("does not call the model for a short list, and deletes old archives and archives long-expired notes without one", async () => {
    const u = await signUp(ctx, owner, "Tidy2");
    const ids = await seed(u, 4);
    await ctx.owner.db.update(memory).set({ archivedAt: new Date("2026-01-01T00:00:00Z"), archivedReason: "merged" }).where(eq(memory.id, ids[0]!));
    await ctx.owner.db.update(memory).set({ expiresAt: new Date("2026-01-01T00:00:00Z") }).where(eq(memory.id, ids[1]!));
    const n = calls.length;
    await runDueMemoryTidy(deps(), new Date());
    expect(calls.length).toBe(n); // fewer than 15 notes: no model call
    expect(await ctx.owner.db.select().from(memory).where(eq(memory.id, ids[0]!))).toHaveLength(0);
    const [expired] = await ctx.owner.db.select().from(memory).where(eq(memory.id, ids[1]!));
    expect(expired!.archivedReason).toBe("expired");
  });

  it("never touches another person's notes, even if the model names their ids", async () => {
    const mine = await signUp(ctx, owner, "Mine");
    const theirs = await signUp(ctx, owner, "Theirs");
    const mineIds = await seed(mine, 15);
    const theirIds = await seed(theirs, 2);
    plainReply = () => say(JSON.stringify({ merge: [{ keep: mineIds[0], drop: [theirIds[0]], fact: "stolen" }], shorten: [] }));
    await runDueMemoryTidy(deps(), new Date());
    expect((await items(theirs)).items).toHaveLength(2);
    expect((await items(mine)).items.map((m: any) => m.content)).not.toContain("stolen");
    plainReply = null;
  });
});
