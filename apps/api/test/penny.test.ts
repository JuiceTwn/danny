import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelClient, ModelResult } from "../src/brain/model.js";
import { withTenant } from "../src/db/client.js";
import { spendLedger } from "../src/db/schema.js";
import { Bill, CENT_MICROS, ceilToCent, recordSpend } from "../src/lib/spend.js";
import { createRegistry } from "../src/tools/builtin.js";
import { seedOwner, setupApp, signUp, type Client, type Ctx } from "./helpers.js";

describe("usage rounds up to the penny", () => {
  it("never rounds down, and zero stays zero", () => {
    expect(ceilToCent(0)).toBe(0);
    expect(ceilToCent(1)).toBe(CENT_MICROS); // a hundredth of a cent is billed as a cent
    expect(ceilToCent(800)).toBe(CENT_MICROS); // what a chat turn really costs
    expect(ceilToCent(9_999)).toBe(CENT_MICROS);
    expect(ceilToCent(10_000)).toBe(10_000); // exactly a cent is a cent, not two
    expect(ceilToCent(10_001)).toBe(20_000);
    expect(ceilToCent(123_000)).toBe(130_000);
  });

  it("a request made of several costs rounds up once, as a whole", () => {
    const bill = new Bill();
    const billed = [800, 800, 11_200, 0].map((c) => bill.add(c)); // two model calls, a search, a free step
    expect(billed).toEqual([10_000, 0, 10_000, 0]); // the first call opens the 1st cent, the second fits inside it, the search crosses into the 2nd
    expect(billed.reduce((a, b) => a + b, 0)).toBe(ceilToCent(800 + 800 + 11_200)); // 2 cents in all
    expect(bill.exact).toBe(12_800);
  });

  it("separate requests each round up on their own", () => {
    expect(ceilToCent(800) + ceilToCent(800)).toBe(20_000);
  });
});

let ctx: Ctx;
let owner: Client;
let script: ModelResult[] = [];
beforeAll(async () => {
  const model: ModelClient = {
    async complete(_req, onText) {
      const res = script.shift()!;
      for (const b of res.content) if (b.type === "text") onText(b.text);
      return res;
    },
  };
  ctx = await setupApp(model, createRegistry());
  owner = (await seedOwner(ctx)).c;
});
afterAll(() => ctx.close());

const rows = async (workspaceId: string) => ctx.owner.db.select().from(spendLedger).where(eq(spendLedger.workspaceId, workspaceId));
const reply = (text: string, inputTokens: number, outputTokens: number): ModelResult => ({ content: [{ type: "text", text }], stopReason: "end_turn", usage: { inputTokens, outputTokens } });
const useTool = (name: string, input: Record<string, unknown>, inputTokens: number, outputTokens: number): ModelResult => ({
  content: [{ type: "tool_use", id: `t_${name}`, name, input }],
  stopReason: "tool_use",
  usage: { inputTokens, outputTokens },
});

describe("what the ledger records", () => {
  it("a chat turn with a tool step costs one cent, however many model calls it takes", async () => {
    const u = await signUp(ctx, owner, "Penny");
    script = [useTool("add_task", { title: "Call the vet" }, 2000, 100), reply("Added.", 2200, 50)];
    const r = await u.c.post("/v1/chat", { message: "remind me to call the vet" });
    expect(r.status).toBe(200);
    const l = await rows(u.workspaceId);
    expect(l.length).toBeGreaterThanOrEqual(2); // one row per model call
    expect(l.reduce((n, x) => n + x.costMicros, 0)).toBe(10_000); // billed once, as a whole: 1 cent
    expect(l.reduce((n, x) => n + x.exactMicros, 0)).toBeLessThan(CENT_MICROS); // the real cost is a fraction of that
  });

  it("a request that costs 2 cents is billed 2, not 1 and not 3", async () => {
    const u = await signUp(ctx, owner, "Pricey");
    script = [reply("A long one.", 150_000, 10_000)]; // $0.015 in + $0.005 out = exactly $0.02 on Haiku 5.5
    await u.c.post("/v1/chat", { message: "write me something long please" });
    const l = await rows(u.workspaceId);
    const exact = l.reduce((n, x) => n + x.exactMicros, 0);
    const billed = l.reduce((n, x) => n + x.costMicros, 0);
    expect(exact).toBe(20_000); // 150,000 x $0.10/Mtok + 10,000 x $0.50/Mtok
    expect(billed).toBe(20_000);
    expect(billed % CENT_MICROS).toBe(0);
  });

  it("every ledger row is a whole number of cents or zero, and never less than the real cost in total", async () => {
    const u = await signUp(ctx, owner, "Whole");
    for (const n of [100, 5_000, 40_000]) {
      script = [reply("ok", n, 50)];
      await u.c.post("/v1/chat", { message: `message of size ${n}` });
    }
    const l = await rows(u.workspaceId);
    for (const x of l) expect(x.costMicros % CENT_MICROS).toBe(0);
    expect(l.reduce((n, x) => n + x.costMicros, 0)).toBeGreaterThanOrEqual(l.reduce((n, x) => n + x.exactMicros, 0));
  });

  it("recordSpend on its own rounds up and keeps the real cost", async () => {
    const u = await signUp(ctx, owner, "Direct");
    await withTenant(ctx.runtime.db, u.workspaceId, (tx) => recordSpend(tx, { workspaceId: u.workspaceId, userId: u.userId, model: "m", inputTokens: 1, outputTokens: 1, costMicros: 37 }));
    const [row] = await rows(u.workspaceId);
    expect(row).toMatchObject({ costMicros: 10_000, exactMicros: 37 });
  });
});
