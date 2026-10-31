import { eq } from "drizzle-orm";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResult } from "../src/brain/model.js";
import { spendLedger, workspaces } from "../src/db/schema.js";
import type { RealtimeStt, Speech, SttEvents } from "../src/lib/call/providers.js";
import { takeSentences } from "../src/lib/call/session.js";
import { ORIGIN, seedOwner, setupApp, signUp, type Client, type Ctx } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => unknown, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return;
    await sleep(15);
  }
  throw new Error("timed out waiting");
};

class FakeStt implements RealtimeStt {
  frames: Buffer[] = [];
  events!: SttEvents;
  closed = false;
  async open(ev: SttEvents) {
    this.events = ev;
    this.closed = false;
    return { send: (b: Buffer) => void this.frames.push(b), close: () => void (this.closed = true) };
  }
}
class FakeSpeech implements Speech {
  sampleRate = 24000;
  said: string[] = [];
  chunks = 3; // 100 ms each
  gapMs = 0;
  async *speak(text: string, signal: AbortSignal) {
    this.said.push(text);
    for (let i = 0; i < this.chunks; i++) {
      if (signal.aborted) throw new Error("aborted");
      if (this.gapMs) await sleep(this.gapMs);
      yield Buffer.alloc(4800, 1);
    }
  }
}

// What the model says each turn, and every system prompt it was sent.
let replies: string[] = [];
let systems: string[] = [];
let streamGapMs = 0;
const model: ModelClient = {
  async complete(req: ModelRequest, onText): Promise<ModelResult> {
    systems.push(req.system);
    const text = replies.shift() ?? "Okay.";
    for (const part of text.match(/.{1,25}(\s|$)/g) ?? [text]) {
      onText(part);
      if (streamGapMs) await sleep(streamGapMs);
    }
    return { content: [{ type: "text", text }], stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20 } };
  },
};

const stt = new FakeStt();
const speech = new FakeSpeech();
let ctx: Ctx;
let owner: Client;
let port = 0;
beforeAll(async () => {
  ctx = await setupApp(model, undefined, { TRUST_PROXY: "true" }, undefined, null, undefined, undefined, undefined, undefined, { stt, speech }, { billEveryMs: 120, idleMs: 60_000 });
  owner = (await seedOwner(ctx)).c;
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  port = (ctx.app.server.address() as { port: number }).port;
});
afterAll(() => ctx.close());

const NONE = null; // no Origin header at all
let n = 0;
const hdrs = (cookie: string, origin: string | null) => ({ "x-forwarded-for": `10.9.${Math.floor(++n / 250)}.${n % 250}`, ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) });
function dial(cookie: string, origin: string | null = ORIGIN) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/call`, { headers: hdrs(cookie, origin) });
  const msgs: any[] = [];
  const audio: Buffer[] = [];
  ws.on("message", (d: Buffer, isBinary: boolean) => (isBinary ? audio.push(d) : msgs.push(JSON.parse(String(d)))));
  const closed = new Promise<number>((r) => ws.on("close", (code: number) => r(code)));
  const opened = new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });
  return {
    ws, msgs, audio, closed, opened,
    has: (type: string, extra: Record<string, unknown> = {}) => msgs.some((m) => m.type === type && Object.entries(extra).every(([k, v]) => m[k] === v)),
    states: () => msgs.filter((m) => m.type === "state").map((m) => m.state),
  };
}
const refusedWith = (cookie: string, origin: string | null = ORIGIN) =>
  new Promise<number>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/call`, { headers: hdrs(cookie, origin) });
    ws.once("unexpected-response", (_req: unknown, res: { statusCode: number }) => resolve(res.statusCode));
    ws.once("open", () => {
      resolve(101);
      ws.close();
    });
    ws.once("error", () => {});
  });
const ledger = async (workspaceId: string) => (await ctx.owner.db.select().from(spendLedger).where(eq(spendLedger.workspaceId, workspaceId))).map((r) => r.model);
const reset = () => {
  replies = [];
  systems = [];
  streamGapMs = 0;
  speech.said = [];
  speech.chunks = 3;
  speech.gapMs = 0;
  stt.frames = [];
};

describe("splitting a reply into sentences to speak", () => {
  it("cuts at full stops and keeps short bits with the next sentence", () => {
    expect(takeSentences("You have two tasks today. The first is the quote. Then", false)).toEqual({ sentences: ["You have two tasks today.", "The first is the quote."], rest: "Then" });
    expect(takeSentences("Okay. I'll add it to your list now. Anything else?", false).sentences).toEqual(["Okay. I'll add it to your list now."]);
    expect(takeSentences("Okay. I'll add it to your list now. Anything else?", true).sentences).toEqual(["Okay. I'll add it to your list now.", "Anything else?"]);
  });
  it("does not cut inside a number and waits for the whole sentence", () => {
    expect(takeSentences("The quote is 3.5 percent higher than last time and I", false)).toEqual({ sentences: [], rest: "The quote is 3.5 percent higher than last time and I" });
  });
  it("starts talking during a very long stretch with no full stop", () => {
    const long = "word ".repeat(60);
    const r = takeSentences(long, false);
    expect(r.sentences.length).toBe(1);
    expect(r.rest.length).toBeLessThan(long.length);
  });
  it("flushes whatever is left at the end", () => {
    expect(takeSentences("Done", true)).toEqual({ sentences: ["Done"], rest: "" });
  });
});

describe("before a call opens", () => {
  it("needs a login and a real origin", async () => {
    expect(await refusedWith("")).toBe(401);
    expect(await refusedWith(owner.cookie, "https://evil.example")).toBe(403);
    expect(await refusedWith(owner.cookie, NONE)).toBe(403);
  });

  it("is refused when stopped or out of allowance, and when calling is off", async () => {
    const u = await signUp(ctx, owner, "Stopped");
    await u.c.patch("/v1/settings", { killSwitch: true });
    expect(await refusedWith(u.c.cookie)).toBe(429);
    await u.c.patch("/v1/settings", { killSwitch: false });
    await ctx.owner.db.update(workspaces).set({ dailyCapMicros: 10 }).where(eq(workspaces.id, u.workspaceId));
    await ctx.owner.db.insert(spendLedger).values({ workspaceId: u.workspaceId, userId: u.userId, model: "x", costMicros: 10 });
    expect(await refusedWith(u.c.cookie)).toBe(429);

    const off = await setupApp(model);
    try {
      await off.app.listen({ port: 0, host: "127.0.0.1" });
      const o = (await seedOwner(off)).c;
      expect((await o.get("/v1/settings")).body.callMode).toBe(false);
      const p = (off.app.server.address() as { port: number }).port;
      const status = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${p}/v1/call`, { headers: { cookie: o.cookie, origin: ORIGIN } });
        ws.once("unexpected-response", (_r: unknown, res: { statusCode: number }) => resolve(res.statusCode));
        ws.once("open", () => resolve(101));
        ws.once("error", () => {});
      });
      expect(status).toBe(503);
    } finally {
      await off.close();
    }
  });

  it("settings tell the app calling is on", async () => {
    expect((await owner.get("/v1/settings")).body.callMode).toBe(true);
  });
});

describe("a call", () => {
  it("listens, answers out loud in the same conversation, and bills every part", async () => {
    reset();
    const u = await signUp(ctx, owner, "Caller");
    replies = ["You have two tasks today. The first is the quote for Marlene."];
    const call = dial(u.c.cookie);
    await call.opened;
    await until(() => call.has("ready"));
    expect(call.msgs.find((m) => m.type === "ready").sampleRate).toBe(24000);
    await until(() => call.states().length >= 1);
    expect(call.states()).toEqual(["listening"]); // the phone is told straight away that it is being listened to

    // the phone's audio reaches the listener
    call.ws.send(Buffer.alloc(3200, 7));
    await until(() => stt.frames.length === 1);
    expect(stt.frames[0]!.length).toBe(3200);

    // live captions, then a finished sentence
    stt.events.onPartial("what's on");
    await until(() => call.has("you", { text: "what's on", final: false }));
    stt.events.onCommitted("What's on my list?");
    await until(() => call.has("you", { text: "What's on my list?", final: true }));

    // Danny answers: text for the screen, voice for the ears, and the right states
    await until(() => call.audio.length >= 6);
    expect(speech.said).toEqual(["You have two tasks today.", "The first is the quote for Marlene."]);
    expect(call.msgs.filter((m) => m.type === "danny").map((m) => m.text).join("")).toContain("two tasks today");
    await until(() => call.states().at(-1) === "listening");
    expect(call.states()).toEqual(["listening", "thinking", "speaking", "listening"]);
    expect(call.audio.every((b) => b.length === 4800)).toBe(true);

    // it is told this is a call, so it answers to be spoken
    expect(systems[0]).toContain("live voice call");
    expect(systems[0]).toContain("read aloud");

    // the same conversation as typed chat: it is in the history
    const h = await u.c.get("/v1/chat/history");
    expect(h.body.messages.map((m: any) => m.text)).toEqual(["What's on my list?", "You have two tasks today. The first is the quote for Marlene."]);

    // hang up: listening is closed and everything was billed to the same meter
    call.ws.send(JSON.stringify({ type: "end" }));
    expect(await call.closed).toBe(1000);
    expect(call.has("ended", { reason: "hung_up" })).toBe(true);
    expect(stt.closed).toBe(true);
    await until(async () => (await ledger(u.workspaceId)).some((m) => m.startsWith("stt-live:")) || true);
    await sleep(100);
    const models = await ledger(u.workspaceId);
    expect(models.some((m) => m.startsWith("tts:"))).toBe(true);
    expect(models.some((m) => m.startsWith("stt-live:"))).toBe(true);
    expect(models).toContain("claude-haiku-5-5");
    // one meter: with the allowance set to exactly what the call cost, the bar reads full; at double, half
    const rows = await ctx.owner.db.select().from(spendLedger).where(eq(spendLedger.workspaceId, u.workspaceId));
    const total = rows.reduce((a, r) => a + r.costMicros, 0);
    await ctx.owner.db.update(workspaces).set({ dailyCapMicros: total }).where(eq(workspaces.id, u.workspaceId));
    expect((await u.c.get("/v1/settings")).body.usedPercent).toBe(100);
    await ctx.owner.db.update(workspaces).set({ dailyCapMicros: total * 2 }).where(eq(workspaces.id, u.workspaceId));
    expect((await u.c.get("/v1/settings")).body.usedPercent).toBe(50);
  });

  it("charges speech by the character", async () => {
    reset();
    const u = await signUp(ctx, owner, "Chars");
    replies = ["Twenty characters ok."]; // 21 characters
    const call = dial(u.c.cookie);
    await call.opened;
    await until(() => call.has("ready"));
    stt.events.onCommitted("hi there");
    await until(() => call.audio.length >= 3);
    call.ws.send(JSON.stringify({ type: "end" }));
    await call.closed;
    await sleep(100);
    const rows = (await ctx.owner.db.select().from(spendLedger).where(eq(spendLedger.workspaceId, u.workspaceId))).filter((r) => r.model.startsWith("tts:"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.exactMicros).toBe(Math.ceil((21 / 1000) * 0.04 * 1_000_000)); // what it really cost
    expect(rows[0]!.costMicros).toBe(10_000); // billed: rounded up to one cent
  });

  it("stops talking when you talk over it, and answers the new thing", async () => {
    reset();
    const u = await signUp(ctx, owner, "Interrupter");
    speech.gapMs = 60; // slow enough to cut off
    speech.chunks = 20;
    replies = ["This is a long answer about the quote and the schedule.", "Sure, switching to Dave's quote."];
    const call = dial(u.c.cookie);
    await call.opened;
    await until(() => call.has("ready"));
    stt.events.onCommitted("Tell me about the quote");
    await until(() => call.audio.length >= 2);
    const before = call.audio.length;
    // a cough is not an interruption
    stt.events.onPartial("uh");
    await sleep(80);
    expect(call.has("stop")).toBe(false);
    // real words are
    speech.chunks = 3;
    stt.events.onPartial("no wait tell me about Dave");
    await until(() => call.has("stop"));
    expect(call.states().at(-1)).toBe("listening");
    await sleep(250);
    const settled = call.audio.length;
    expect(settled - before).toBeLessThan(6); // the old sentence stopped
    stt.events.onCommitted("No wait, tell me about Dave's quote");
    await until(() => speech.said.some((s) => s.includes("Dave's quote")));
    await until(() => call.audio.length > settled);
    call.ws.send(JSON.stringify({ type: "end" }));
    await call.closed;
  });

  it("the interrupt button stops him too", async () => {
    reset();
    const u = await signUp(ctx, owner, "Button");
    speech.gapMs = 50;
    speech.chunks = 30;
    replies = ["A very long reply that keeps going and going for a good while yet."];
    const call = dial(u.c.cookie);
    await call.opened;
    await until(() => call.has("ready"));
    stt.events.onCommitted("Go on then");
    await until(() => call.audio.length >= 2);
    call.ws.send(JSON.stringify({ type: "interrupt" }));
    await until(() => call.has("stop"));
    await sleep(200);
    const n = call.audio.length;
    await sleep(250);
    expect(call.audio.length).toBe(n);
    call.ws.send(JSON.stringify({ type: "end" }));
    await call.closed;
  });

  it("does not mistake his own voice coming back through the microphone for you", async () => {
    reset();
    const u = await signUp(ctx, owner, "Echo");
    speech.gapMs = 40;
    speech.chunks = 10;
    replies = ["The quote for Marlene is eighteen hundred dollars."];
    const call = dial(u.c.cookie);
    await call.opened;
    await until(() => call.has("ready"));
    stt.events.onCommitted("What was the quote");
    await until(() => call.audio.length >= 2);
    // the phone's mic hears Danny and the listener transcribes it
    stt.events.onPartial("the quote for Marlene is eighteen");
    stt.events.onCommitted("The quote for Marlene is eighteen hundred dollars.");
    await sleep(150);
    expect(call.has("stop")).toBe(false);
    expect(systems).toHaveLength(1); // no second turn
    expect(call.msgs.filter((m) => m.type === "you" && m.final).map((m) => m.text)).toEqual(["What was the quote"]);
    call.ws.send(JSON.stringify({ type: "end" }));
    await call.closed;
  });

  it("only one call at a time per account", async () => {
    reset();
    const u = await signUp(ctx, owner, "Twice");
    const first = dial(u.c.cookie);
    await first.opened;
    await until(() => first.has("ready"));
    expect(await refusedWith(u.c.cookie)).toBe(409);
    first.ws.send(JSON.stringify({ type: "end" }));
    await first.closed;
    await sleep(50);
    const again = dial(u.c.cookie); // free again after hanging up
    await again.opened;
    again.ws.close();
    await again.closed;
  });

  it("hangs up when the daily allowance runs out mid-call, or when stopped", async () => {
    reset();
    const u = await signUp(ctx, owner, "Broke");
    const call = dial(u.c.cookie);
    await call.opened;
    await until(() => call.has("ready"));
    await ctx.owner.db.update(workspaces).set({ dailyCapMicros: 1 }).where(eq(workspaces.id, u.workspaceId));
    await ctx.owner.db.insert(spendLedger).values({ workspaceId: u.workspaceId, userId: u.userId, model: "x", costMicros: 5 });
    await until(() => call.has("ended", { reason: "cap_reached" }));
    expect(call.msgs.find((m) => m.type === "ended").message).toMatch(/allowance/);
    expect(await call.closed).toBe(1000);

    const v = await signUp(ctx, owner, "Halted");
    const c2 = dial(v.c.cookie);
    await c2.opened;
    await until(() => c2.has("ready"));
    await v.c.patch("/v1/settings", { killSwitch: true });
    await until(() => c2.has("ended", { reason: "kill_switch" }));
    await c2.closed;
  });

  it("hangs up after the longest allowed call and after a long silence", async () => {
    reset();
    const short = await setupApp(model, undefined, { CALL_MAX_MINUTES: "0.01" }, undefined, null, undefined, undefined, undefined, undefined, { stt: new FakeStt(), speech: new FakeSpeech() }, { billEveryMs: 100 });
    try {
      await short.app.listen({ port: 0, host: "127.0.0.1" });
      const o = (await seedOwner(short)).c;
      const p = (short.app.server.address() as { port: number }).port;
      const ws = new WebSocket(`ws://127.0.0.1:${p}/v1/call`, { headers: { cookie: o.cookie, origin: ORIGIN } });
      const got: any[] = [];
      ws.on("message", (d: Buffer, bin: boolean) => bin || got.push(JSON.parse(String(d))));
      await until(() => got.some((m) => m.type === "ended"), 4000);
      expect(got.find((m) => m.type === "ended")).toMatchObject({ reason: "time_limit" });
    } finally {
      await short.close();
    }
    const quiet = await setupApp(model, undefined, {}, undefined, null, undefined, undefined, undefined, undefined, { stt: new FakeStt(), speech: new FakeSpeech() }, { billEveryMs: 80, idleMs: 200 });
    try {
      await quiet.app.listen({ port: 0, host: "127.0.0.1" });
      const o = (await seedOwner(quiet)).c;
      const p = (quiet.app.server.address() as { port: number }).port;
      const ws = new WebSocket(`ws://127.0.0.1:${p}/v1/call`, { headers: { cookie: o.cookie, origin: ORIGIN } });
      const got: any[] = [];
      ws.on("message", (d: Buffer, bin: boolean) => bin || got.push(JSON.parse(String(d))));
      await until(() => got.some((m) => m.type === "ended"), 4000);
      expect(got.find((m) => m.type === "ended")).toMatchObject({ reason: "idle" });
    } finally {
      await quiet.close();
    }
  });

  it("tells the phone when listening breaks, and a dropped phone cleans up", async () => {
    reset();
    const u = await signUp(ctx, owner, "Drops");
    const call = dial(u.c.cookie);
    await call.opened;
    await until(() => call.has("ready"));
    stt.events.onError("connection");
    await until(() => call.has("ended", { reason: "listening_failed" }));
    await call.closed;

    const w = await signUp(ctx, owner, "Walker");
    const c2 = dial(w.c.cookie);
    await c2.opened;
    await until(() => c2.has("ready"));
    stt.closed = false;
    c2.ws.terminate(); // the phone just vanishes
    await c2.closed;
    await until(() => stt.closed);
    const again = dial(w.c.cookie); // and the account is free to call again
    await again.opened;
    again.ws.close();
    await again.closed;
  });
});
