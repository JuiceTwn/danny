import { eq } from "drizzle-orm";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ModelClient, ModelRequest, ModelResult } from "../src/brain/model.js";
import { approvals, memory, spendLedger } from "../src/db/schema.js";
import { createRegistry } from "../src/tools/builtin.js";
import { defineTool } from "../src/tools/registry.js";
import { ORIGIN, seedOwner, setupApp, signUp, type Client, type Ctx } from "./helpers.js";

const text = (t: string, inT = 100, outT = 20): ModelResult => ({ content: [{ type: "text", text: t }], stopReason: "end_turn", usage: { inputTokens: inT, outputTokens: outT } });
const useTool = (name: string, input: unknown, id = "tu_1"): ModelResult => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
  usage: { inputTokens: 100, outputTokens: 20 },
});

/** A model that plays back a script and records every request it was sent. */
function scripted(steps: (ModelResult | ((req: ModelRequest) => Promise<ModelResult>))[]) {
  const calls: ModelRequest[] = [];
  const model: ModelClient = {
    async complete(req, onText) {
      calls.push(JSON.parse(JSON.stringify(req)));
      const step = steps.shift();
      if (!step) throw new Error("script ran out");
      const res = typeof step === "function" ? await step(req) : step;
      for (const b of res.content) if (b.type === "text") onText(b.text);
      return res;
    },
  };
  return { model, calls, steps };
}

const sendEmail = vi.fn(async () => "SENT");
const emailTool = defineTool({
  name: "send_email",
  description: "Send an email",
  kind: "external_write",
  input: z.object({ to: z.string(), body: z.string() }),
  approvalTitle: (i) => `Email to ${i.to}`,
  run: sendEmail as never, // would be a bug if ever called from chat
});

let ctx: Ctx;
let owner: Client;
let script: ReturnType<typeof scripted>;
let proxyModel: ModelClient;
beforeAll(async () => {
  proxyModel = { complete: (r, o) => script.model.complete(r, o) };
  const tools = createRegistry().register(emailTool);
  ctx = await setupApp(proxyModel, tools);
  owner = (await seedOwner(ctx)).c;
});
afterAll(() => ctx.close());

async function chat(c: Client, message: string) {
  const res = await c.req("POST", "/v1/chat", { message });
  const events = res.raw.body
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
  return { status: res.status, events, raw: res.raw };
}

describe("chat", () => {
  it("streams a reply, remembers the turn, and records what it cost", async () => {
    const u = await signUp(ctx, owner, "Chatty");
    script = scripted([text("Morning. What's first?", 1000, 200)]);
    const r = await chat(u.c, "hey danny");
    expect(r.raw.headers["content-type"]).toBe("text/event-stream");
    expect(r.events).toEqual([{ type: "text", text: "Morning. What's first?" }, { type: "done" }]);
    const hist = (await u.c.get("/v1/chat/history")).body.messages;
    expect(hist.map((m: any) => [m.role, m.text])).toEqual([["user", "hey danny"], ["assistant", "Morning. What's first?"]]);
    // 1000 in x $1/Mtok + 200 out x $5/Mtok = $0.002
    expect((await u.c.get("/v1/settings")).body.spentTodayUsd).toBeCloseTo(0.002, 6);
  });

  it("remembers facts through the tool, and uses them next time", async () => {
    const u = await signUp(ctx, owner, "Mem");
    script = scripted([useTool("remember", { fact: "Marlene prefers texts" }), text("Got it.")]);
    const r = await chat(u.c, "Marlene prefers texts, not calls");
    expect(r.events).toContainEqual({ type: "tool", name: "remember", status: "ran" });
    const rows = await ctx.owner.db.select().from(memory).where(eq(memory.userId, u.userId));
    expect(rows.map((m) => ctx.vault.open(u.workspaceId, m.contentEnc))).toEqual(["Marlene prefers texts"]);

    script = scripted([text("Texting her.")]);
    await chat(u.c, "how should I reach Marlene?");
    expect(script.calls[0]!.system).toContain("- Marlene prefers texts");
  });

  it("request_approval records a pending card and says nothing was sent", async () => {
    const u = await signUp(ctx, owner, "Appr");
    script = scripted([useTool("request_approval", { kind: "email", title: "Reply to Marlene", draft: "Hi Marlene" }), text("Waiting on your tap.")]);
    const r = await chat(u.c, "draft a reply to Marlene");
    expect(r.events.find((e) => e.type === "approval")).toMatchObject({ title: "Reply to Marlene" });
    const [a] = await ctx.owner.db.select().from(approvals).where(eq(approvals.userId, u.userId));
    expect(a).toMatchObject({ status: "pending", executedAt: null, kind: "email" });
    // the model was told plainly that nothing went out
    const toolResult = script.calls[1]!.messages.at(-1)!.content as any[];
    expect(toolResult[0].content).toMatch(/nothing has been sent/i);
  });

  it("an outside-world tool is never run from chat, it becomes an approval", async () => {
    const u = await signUp(ctx, owner, "Guard");
    sendEmail.mockClear();
    script = scripted([useTool("send_email", { to: "marlene@x.ca", body: "Hi" }), text("Queued.")]);
    const r = await chat(u.c, "email Marlene");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(r.events).toContainEqual({ type: "tool", name: "send_email", status: "queued" });
    const [a] = await ctx.owner.db.select().from(approvals).where(eq(approvals.userId, u.userId));
    expect(a).toMatchObject({ kind: "send_email", title: "Email to marlene@x.ca", status: "pending", executedAt: null });
  });

  it("bad tool calls come back to the model as errors, not crashes", async () => {
    const u = await signUp(ctx, owner, "Bad");
    script = scripted([useTool("does_not_exist", {}, "a"), useTool("remember", { fact: "" }, "b"), text("Sorry.")]);
    const r = await chat(u.c, "go");
    expect(r.events.filter((e) => e.type === "tool").map((e) => e.status)).toEqual(["error", "error"]);
    expect(r.events.at(-1)).toEqual({ type: "done" });
  });

  it("history is never left holding a tool call without its result", async () => {
    const u = await signUp(ctx, owner, "Pair");
    script = scripted([useTool("remember", { fact: "x" }), text("ok")]);
    await chat(u.c, "one");
    script = scripted([text("two")]);
    await chat(u.c, "two");
    const sent = script.calls[0]!.messages;
    const kinds = sent.map((m) => (typeof m.content === "string" ? "text" : (m.content as any[]).map((b) => b.type).join("+")));
    expect(kinds).toEqual(["text", "tool_use", "tool_result", "text", "text"]);
  });

  it("stops at the kill switch without calling the model", async () => {
    const u = await signUp(ctx, owner, "Kill");
    await u.c.patch("/v1/settings", { killSwitch: true });
    script = scripted([text("should not run")]);
    const r = await chat(u.c, "hello?");
    expect(r.events).toEqual([{ type: "error", code: "kill_switch", message: expect.stringMatching(/stopped/i) }]);
    expect(script.calls).toHaveLength(0);
    await u.c.patch("/v1/settings", { killSwitch: false });
    script = scripted([text("back")]);
    expect((await chat(u.c, "hello?")).events.at(-1)).toEqual({ type: "done" });
  });

  it("stops when the daily cap is hit, including between tool steps", async () => {
    const u = await signUp(ctx, owner, "Cap");
    await u.c.patch("/v1/settings", { dailyCapUsd: 0.001 });
    // first call costs $0.002, which passes the cap, so the follow-up step must not run
    script = scripted([{ ...useTool("remember", { fact: "x" }), usage: { inputTokens: 2000, outputTokens: 0 } }, text("never")]);
    const r = await chat(u.c, "go");
    expect(r.events.at(-1)).toMatchObject({ type: "error", code: "cap_reached" });
    expect(script.calls).toHaveLength(1);
    // and the next message is refused up front
    script = scripted([text("never")]);
    expect((await chat(u.c, "again")).events[0]).toMatchObject({ code: "cap_reached" });
    expect(script.calls).toHaveLength(0);
  });

  it("a failed model call is reported and charges nothing", async () => {
    const u = await signUp(ctx, owner, "Fail");
    script = scripted([async () => { throw new Error("upstream 529"); }]);
    const r = await chat(u.c, "hi");
    expect(r.events).toEqual([{ type: "error", code: "model_failed", message: expect.any(String) }]);
    expect(await ctx.owner.db.select().from(spendLedger).where(eq(spendLedger.userId, u.userId))).toHaveLength(0);
  });

  it("refuses a second message while one is still running", async () => {
    const u = await signUp(ctx, owner, "Busy");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    script = scripted([async () => { await gate; return text("late"); }]);
    const first = chat(u.c, "slow one");
    await new Promise((r) => setTimeout(r, 150));
    const second = await u.c.req("POST", "/v1/chat", { message: "impatient" });
    expect(second.status).toBe(429);
    release();
    expect((await first).events.at(-1)).toEqual({ type: "done" });
  });

  it("each user has their own conversation and never sees another's", async () => {
    const a = await signUp(ctx, owner, "ChatA");
    const b = await signUp(ctx, owner, "ChatB");
    script = scripted([text("A reply")]);
    await chat(a.c, "A secret question");
    expect((await b.c.get("/v1/chat/history")).body.messages).toEqual([]);
    script = scripted([text("B reply")]);
    await chat(b.c, "hi");
    expect(JSON.stringify(script.calls[0]!.messages)).not.toContain("A secret");
  });

  it("needs a session and the same-origin header, and validates input", async () => {
    const { client } = await import("./helpers.js");
    expect((await client(ctx).req("POST", "/v1/chat", { message: "hi" })).status).toBe(401);
    const u = await signUp(ctx, owner, "Val");
    expect((await u.c.req("POST", "/v1/chat", { message: "hi" }, { origin: "http://evil.test" })).status).toBe(403);
    expect((await u.c.req("POST", "/v1/chat", { message: "" })).status).toBe(400);
    expect(ORIGIN).toBeTruthy();
  });

  it("lists tools with their kind so the app can show what Danny can do", async () => {
    const u = await signUp(ctx, owner, "Tools");
    const tools = (await u.c.get("/v1/tools")).body.tools;
    expect(tools.map((t: any) => [t.name, t.kind])).toEqual([["remember", "internal"], ["request_approval", "internal"], ["send_email", "external_write"]]);
  });
});
