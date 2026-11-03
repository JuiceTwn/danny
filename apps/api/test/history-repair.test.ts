import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Block, ModelClient, ModelRequest, ModelResult, Msg } from "../src/brain/model.js";
import { repairHistory } from "../src/brain/repair.js";
import { conversations, messages } from "../src/db/schema.js";
import { createRegistry } from "../src/tools/builtin.js";
import { seedOwner, setupApp, signUp, type Client, type Ctx } from "./helpers.js";

const call = (id: string, name = "list_tasks"): Block => ({ type: "tool_use", id, name, input: {} });
const res = (id: string, content = "ok"): Block => ({ type: "tool_result", tool_use_id: id, content });
const asst = (...b: Block[]): Msg => ({ role: "assistant", content: b });
const user = (...b: Block[]): Msg => ({ role: "user", content: b });
const text = (role: "user" | "assistant", t: string): Msg => ({ role, content: t });

/** The model's rule, stated the way its API states it. */
function violations(history: Msg[]): string[] {
  const bad: string[] = [];
  history.forEach((m, i) => {
    const calls = m.role === "assistant" && Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_use") : [];
    const next = history[i + 1];
    if (calls.length) {
      const got = new Set(next && next.role === "user" && Array.isArray(next.content) ? next.content.flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : [])) : []);
      for (const c of calls) if (c.type === "tool_use" && !got.has(c.id)) bad.push(`call ${c.id} has no result right after it`);
    }
    if (m.role === "user" && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type !== "tool_result") continue;
        const prev = history[i - 1];
        const ok = prev && prev.role === "assistant" && Array.isArray(prev.content) && prev.content.some((x) => x.type === "tool_use" && x.id === b.tool_use_id);
        if (!ok) bad.push(`result ${b.tool_use_id} does not follow its call`);
      }
    }
  });
  return bad;
}

describe("repairing a saved conversation", () => {
  it("leaves a healthy one exactly as it is", () => {
    const h = [text("user", "hi"), asst(call("a"), call("b")), user(res("a"), res("b")), text("assistant", "done"), text("user", "thanks"), text("assistant", "np")];
    expect(repairHistory(h)).toEqual(h);
    expect(violations(repairHistory(h))).toEqual([]);
  });

  it("puts results straight after their call when another message landed in between", () => {
    // What a brief or a game alert writing at the same moment used to do.
    const h = [text("user", "what's on?"), asst(call("a"), call("b")), text("assistant", "Morning briefing: …"), user(res("a", "A"), res("b", "B")), text("assistant", "You have two things.")];
    expect(violations(h).length).toBeGreaterThan(0);
    const fixed = repairHistory(h);
    expect(violations(fixed)).toEqual([]);
    expect(fixed).toEqual([text("user", "what's on?"), asst(call("a"), call("b")), user(res("a", "A"), res("b", "B")), text("assistant", "Morning briefing: …"), text("assistant", "You have two things.")]);
  });

  it("writes a plain 'no result' for a call that never got one, and keeps the ones that did", () => {
    const fixed = repairHistory([text("user", "go"), asst(call("a"), call("b")), user(res("a", "A")), text("assistant", "ok")]);
    expect(violations(fixed)).toEqual([]);
    const results = (fixed[2]!.content as Block[]).map((b) => (b.type === "tool_result" ? [b.tool_use_id, b.content, b.is_error ?? false] : null));
    expect(results).toEqual([["a", "A", false], ["b", "(That step did not finish, so there is no result.)", true]]);
  });

  it("handles a call at the very end, and a result whose call is gone", () => {
    expect(violations(repairHistory([text("user", "go"), asst(call("z"))]))).toEqual([]);
    const orphan = repairHistory([user(res("gone")), text("user", "hello"), text("assistant", "hi")]);
    expect(orphan).toEqual([text("user", "hello"), text("assistant", "hi")]);
  });

  it("repairs several broken calls in one conversation", () => {
    const h = [text("user", "1"), asst(call("a")), text("assistant", "alert"), user(res("a")), text("user", "2"), asst(call("b")), asst(call("c")), user(res("c")), text("assistant", "end")];
    expect(violations(repairHistory(h))).toEqual([]);
  });
});

let ctx: Ctx;
let owner: Client;
const seen: ModelRequest[] = [];
const model: ModelClient = {
  async complete(req, onText) {
    seen.push(JSON.parse(JSON.stringify(req)));
    onText("ok");
    return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } } as ModelResult;
  },
};
beforeAll(async () => {
  ctx = await setupApp(model, createRegistry());
  owner = (await seedOwner(ctx)).c;
});
afterAll(() => ctx.close());

describe("a conversation that used to break chat for good", () => {
  it("now just works: the model is sent a valid history, and the person gets an answer", async () => {
    const u = await signUp(ctx, owner, "Poisoned");
    const first = await u.c.req("POST", "/v1/chat", { message: "hello" });
    expect(String(first.raw.body)).toContain('"type":"done"');
    const [conv] = await ctx.owner.db.select().from(conversations).where(eq(conversations.userId, u.userId));
    const put = (role: string, content: unknown) => ctx.owner.db.insert(messages).values({ workspaceId: u.workspaceId, conversationId: conv!.id, role, contentEnc: ctx.vault.sealJson(u.workspaceId, content) });
    // A call, then a message Danny wrote on his own, then the call's results: the order that used to poison the chat.
    await put("user", "what do I have on?");
    await put("assistant", [call("toolu_01AAA"), call("toolu_01BBB")]);
    await put("assistant", "Morning briefing: here is your day.");
    await put("user", [res("toolu_01AAA", "a task"), res("toolu_01BBB", "another")]);
    await put("assistant", "You have two things.");

    seen.length = 0;
    const r = await u.c.req("POST", "/v1/chat", { message: "thanks" });
    expect(String(r.raw.body)).toContain('"type":"done"');
    expect(String(r.raw.body)).not.toContain('"type":"error"');
    expect(seen).toHaveLength(1);
    expect(violations(seen[0]!.messages)).toEqual([]);
    // and it still sees everything that was said
    const flat = JSON.stringify(seen[0]!.messages);
    expect(flat).toContain("Morning briefing: here is your day.");
    expect(flat).toContain("You have two things.");
  });
});
