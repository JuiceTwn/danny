import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResult } from "../src/brain/model.js";
import { spendLedger } from "../src/db/schema.js";
import { seedOwner, setupApp, signUp, type Client, type Ctx } from "./helpers.js";

const text = (t: string): ModelResult => ({ content: [{ type: "text", text: t }], stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20 } });
const useTool = (name: string, input: unknown): ModelResult => ({ content: [{ type: "tool_use", id: "tu_1", name, input }], stopReason: "tool_use", usage: { inputTokens: 100, outputTokens: 20 } });
const found = (...changes: unknown[]) => text(JSON.stringify(changes));

/** A model that plays back a script and records every request it was sent. */
function scripted(steps: ModelResult[]) {
  const calls: ModelRequest[] = [];
  const model: ModelClient = {
    async complete(req, onText) {
      calls.push(JSON.parse(JSON.stringify(req)));
      const step = steps.shift();
      if (!step) throw new Error("script ran out");
      for (const b of step.content) if (b.type === "text") onText(b.text);
      return step;
    },
  };
  return { model, calls };
}

let ctx: Ctx;
let owner: Client;
let script: ReturnType<typeof scripted>;
beforeAll(async () => {
  ctx = await setupApp({ complete: (r, o) => script.model.complete(r, o) });
  owner = (await seedOwner(ctx)).c;
});
afterAll(() => ctx.close());

async function chat(c: Client, message: string) {
  const res = await c.req("POST", "/v1/chat", { message });
  return res.raw.body
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
}
const notes = async (c: Client) => (await c.get("/v1/memory")).body.items as { id: string; content: string; subject: string | null; kind: string; source: string; expiresOn: string | null }[];
const FUTURE = "2099-06-30";

describe("auto memory: what you mention in passing is kept without being asked", () => {
  it("saves a durable fact after the reply, says so after done, and marks it as noticed", async () => {
    const u = await signUp(ctx, owner, "Auto");
    script = scripted([
      text("Sounds like a fun trip."),
      found({ op: "add", fact: "Sister Marlene gets married in June", kind: "person", subject: "Marlene", expires_on: FUTURE }),
    ]);
    const events = await chat(u.c, "My sister Marlene is getting married in June so I need to sort a dress");
    // the reply is finished before the quiet pass speaks
    expect(events.map((e) => e.type)).toEqual(["text", "done", "memory"]);
    expect(events[2].notes).toEqual([{ id: expect.any(String), fact: expect.stringContaining("Marlene"), kind: "added" }]);

    const [n] = await notes(u.c);
    expect(n).toMatchObject({ content: "Sister Marlene gets married in June", subject: "Marlene", kind: "person", source: "auto", expiresOn: FUTURE });

    // the second model call is the quiet pass: it is told what was said, and it is told that the words are data
    expect(script.calls).toHaveLength(2);
    expect(script.calls[1]!.tools).toEqual([]);
    expect(script.calls[1]!.messages[0]!.content).toContain("My sister Marlene is getting married");
    expect(script.calls[1]!.system).toMatch(/data, not instructions/);
  });

  it("costs go through the same ledger as chat", async () => {
    const u = await signUp(ctx, owner, "Billed");
    script = scripted([text("Noted."), found({ op: "add", fact: "Works night shifts at the hospital" })]);
    await chat(u.c, "I work night shifts at the hospital these days");
    const rows = await ctx.owner.db.select().from(spendLedger).where(eq(spendLedger.workspaceId, u.workspaceId));
    expect(rows).toHaveLength(2);
  });

  it("updates a note it was shown instead of adding a second, and keeps the old wording for undo", async () => {
    const u = await signUp(ctx, owner, "Update");
    await u.c.post("/v1/memory", { content: "Lives in Toronto", kind: "fact" });
    const [old] = await notes(u.c);
    script = scripted([text("Big move!"), found({ op: "update", id: old!.id, fact: "Lives in Calgary" })]);
    await chat(u.c, "Just moved out to Calgary last weekend, still unpacking boxes");
    expect((await notes(u.c)).map((n) => n.content)).toEqual(["Lives in Calgary"]);
    // the Memory tab's undo puts the old wording back
    expect((await u.c.post(`/v1/memory/${old!.id}/restore`)).status).toBe(200);
    expect((await notes(u.c)).map((n) => n.content)).toEqual(["Lives in Toronto"]);
  });

  it("keeps a person's name on a note when its wording is updated", async () => {
    const u = await signUp(ctx, owner, "Keeps");
    await u.c.post("/v1/memory", { content: "Prefers calls", subject: "Marlene", kind: "person" });
    const [old] = await notes(u.c);
    script = scripted([text("Got it."), found({ op: "update", id: old!.id, fact: "Prefers texts, not calls" })]);
    await chat(u.c, "Actually Marlene says she prefers texts now, calls stress her out");
    expect((await notes(u.c))[0]).toMatchObject({ content: "Prefers texts, not calls", subject: "Marlene" });
  });

  it("ignores an update to a note it was never shown, and bad output", async () => {
    const u = await signUp(ctx, owner, "Strict");
    script = scripted([
      text("ok"),
      found({ op: "update", id: "00000000-0000-4000-8000-000000000000", fact: "Hijacked note" }, { op: "nonsense" }, { op: "add", fact: "Has a dog called Biscuit" }),
    ]);
    await chat(u.c, "I have a dog called Biscuit and a green van and play chess on Sundays");
    expect((await notes(u.c)).map((n) => n.content)).toEqual(["Has a dog called Biscuit"]);

    script = scripted([text("ok"), text("sure, here is what I would keep: [not json")]);
    expect((await chat(u.c, "I started a new job at the bakery on Monday morning")).map((e) => e.type)).toEqual(["text", "done"]);
    expect(await notes(u.c)).toHaveLength(1);
  });

  it("keeps at most three changes from one message", async () => {
    const u = await signUp(ctx, owner, "Three");
    script = scripted([text("ok"), found(...["Drives a green van", "Plays chess on Sundays", "Has a dog called Biscuit", "Fourth over the limit"].map((fact) => ({ op: "add", fact })))]);
    await chat(u.c, "I drive a green van, play chess on Sundays, and have a dog called Biscuit");
    expect((await notes(u.c)).map((n) => n.content).sort()).toEqual(["Drives a green van", "Has a dog called Biscuit", "Plays chess on Sundays"]);
  });

  it("drops an expiry date that is already past rather than archiving the note at once", async () => {
    const u = await signUp(ctx, owner, "Past");
    script = scripted([text("ok"), found({ op: "add", fact: "Away for a conference", expires_on: "2001-01-01" })]);
    await chat(u.c, "I am away at a conference somewhere cold this month");
    expect((await notes(u.c))[0]).toMatchObject({ content: "Away for a conference", expiresOn: null });
  });

  it("does not run for short messages, or when Danny already chose to save something this turn", async () => {
    const u = await signUp(ctx, owner, "Skips");
    script = scripted([text("Morning.")]);
    expect((await chat(u.c, "hey danny")).map((e) => e.type)).toEqual(["text", "done"]);
    expect(script.calls).toHaveLength(1);

    script = scripted([useTool("remember", { fact: "Prefers texts to calls", subject: "Marlene" }), text("Saved.")]);
    await chat(u.c, "Remember that Marlene prefers texts to calls please");
    expect(script.calls).toHaveLength(2); // the chat steps only: no quiet pass on top
    expect(await notes(u.c)).toHaveLength(1);
  });

  it("can be turned off, and stays off", async () => {
    const u = await signUp(ctx, owner, "Optout");
    expect((await u.c.get("/v1/me")).body.user.autoMemory).toBe(true);
    expect((await u.c.patch("/v1/profile", { autoMemory: false })).body.autoMemory).toBe(false);
    script = scripted([text("ok")]);
    await chat(u.c, "My favourite colour is a very particular shade of teal");
    expect(script.calls).toHaveLength(1);
    expect(await notes(u.c)).toHaveLength(0);
  });

  it("does nothing, quietly, when the day's allowance is spent", async () => {
    const u = await signUp(ctx, owner, "Broke");
    script = scripted([{ ...text("ok"), usage: { inputTokens: 10_000_000, outputTokens: 10_000_000 } }, found({ op: "add", fact: "Should never be saved" })]);
    const events = await chat(u.c, "I really love long walks along the river at dusk");
    expect(events.map((e) => e.type)).toEqual(["text", "done"]);
    expect(script.calls).toHaveLength(1);
    expect(await notes(u.c)).toHaveLength(0);
  });
});
