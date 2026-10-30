import { describe, expect, it } from "vitest";
import { callWithEscalation, newCallState } from "../src/brain/call.js";
import type { ModelClient, ModelRequest, ModelResult } from "../src/brain/model.js";
import { estimateTokens, fitHistory, FEATURES, HAIKU_SAFE_TOKENS, lowerTier, nextTier, route, routeChat, type Feature, type RouteInput, type Tier } from "../src/brain/router.js";
import { DEFAULT_PRICES } from "../src/config.js";
import { costMicros } from "../src/lib/spend.js";

const r = (over: Partial<RouteInput> & { message: string }) => route({ feature: "chat", promptTokens: 1000, level: "ok", ...over });
const tierOf = (message: string) => routeChat({ message }).tier;

describe("routing by feature comes first", () => {
  it.each<[Feature, Tier]>([
    ["quick_chat", "haiku"],
    ["reminder", "haiku"],
    ["lookup", "haiku"],
    ["client_post", "sonnet"],
    ["email", "sonnet"],
    ["planning", "sonnet"],
    ["multi_step", "sonnet"],
    ["long_attachment", "sonnet"],
  ])("%s goes to %s, whatever the message says", (feature, tier) => {
    expect(r({ feature, message: "hi" }).tier).toBe(tier);
    expect(r({ feature, message: "draft a long email and plan the whole month step by step" }).tier).toBe(tier);
    expect(r({ feature, message: "hi" }).reason).toBe(`feature:${feature}`);
  });

  it("covers every feature, and no feature routes to Opus on its own", () => {
    for (const f of FEATURES.filter((f) => f !== "chat")) expect(r({ feature: f, message: "x" }).tier).not.toBe("opus");
  });
});

describe("free-text chat", () => {
  it.each([
    "hey danny",
    "thanks",
    "what's on my plate today?", // lookup-shaped, but "plate" is not "plan"
    "what do you remember about me?",
    "list my goals",
    "remind me to call Marlene at 3",
    "Remind me to draft the email to Marlene tomorrow", // a reminder is Haiku even though it mentions an email
    "how much did I spend this week?",
  ])("simple: %j -> haiku", (m) => expect(tierOf(m)).toBe("haiku"));

  it.each([
    ["Draft a reply to Marlene about invoice 114", "keyword:draft"],
    ["write a Google Business Profile post for the Hendricks job", "keyword:google business"],
    ["email Marlene that the quote is ready", "keyword:email"],
    ["Plan next week for me", "keyword:plan"],
    ["my goal is three new clients by month end", "keyword:my goal"],
    ["send that to Marlene", "tools:send"],
    ["add a step to the Hendricks goal", "tools:add a step"],
    ["first call the supplier, then update the quote", "keyword:quote"],
    ["call the supplier and then tell me what they said", "multi_step"],
    ["1. call Marlene\n2. call Bob", "multi_step"],
    ["x\ny\nz", "multi_step"],
  ])("quality work: %j -> sonnet", (m, reason) => {
    const out = routeChat({ message: m });
    expect(out.tier).toBe("sonnet");
    expect(out.reason).toBe(reason);
  });

  it("names the feature the request is logged as", () => {
    expect(routeChat({ message: "draft an email to Marlene" }).feature).toBe("email");
    expect(routeChat({ message: "write a gbp post about the sale" }).feature).toBe("client_post");
    expect(routeChat({ message: "plan the week" }).feature).toBe("planning");
    expect(routeChat({ message: "remind me to call Bob" }).feature).toBe("reminder");
    expect(routeChat({ message: "what's my rate?" }).feature).toBe("lookup");
  });

  it("goes by length, and defaults up to Sonnet when unsure", () => {
    expect(tierOf("a".repeat(280))).toBe("haiku");
    expect(routeChat({ message: "a".repeat(281) })).toMatchObject({ tier: "sonnet", reason: "unsure" });
    expect(routeChat({ message: "a".repeat(601) })).toMatchObject({ tier: "sonnet", reason: "long_message" });
  });

  it("sends anything with an attachment to Sonnet, and says when it is long", () => {
    expect(routeChat({ message: "hi", attachmentCount: 1, attachmentChars: 200 })).toMatchObject({ tier: "sonnet", reason: "attachment" });
    expect(routeChat({ message: "hi", attachmentCount: 1, attachmentChars: 4000 })).toMatchObject({ tier: "sonnet", feature: "long_attachment", reason: "attachment:long" });
  });
});

describe("Opus", () => {
  it("only when asked for by name", () => {
    expect(r({ message: "use opus for this" })).toMatchObject({ tier: "opus", reason: "user_asked_opus" });
    expect(r({ message: "Opus: what should I charge a plumber?" }).tier).toBe("opus");
    expect(r({ message: "try Claude Opus on this" }).tier).toBe("opus");
    expect(r({ message: "hi", askedForOpus: true }).tier).toBe("opus");
    expect(r({ feature: "email", message: "hi", askedForOpus: true }).tier).toBe("opus");
    // mentioning the word is not asking for the model
    for (const m of ["I saw an opus at the theatre", "what is opus?", "magnum opus draft"]) expect(r({ message: m }).tier).not.toBe("opus");
    // nothing sends a request to Opus on its own, however heavy
    expect(r({ message: "draft a long email ".repeat(100), promptTokens: 50_000 }).tier).toBe("sonnet");
  });
});

describe("the Haiku prompt limit", () => {
  it("never leaves a Haiku-sized request on Haiku once the prompt is near 100K tokens", () => {
    expect(r({ message: "hi", promptTokens: HAIKU_SAFE_TOKENS }).tier).toBe("haiku");
    expect(r({ message: "hi", promptTokens: HAIKU_SAFE_TOKENS + 1 })).toMatchObject({ tier: "sonnet", reason: "prompt_over_haiku_limit" });
    expect(HAIKU_SAFE_TOKENS).toBeLessThan(100_000);
  });

  it("is billed at the higher rate above 100K, and the estimate leans high", () => {
    const p = DEFAULT_PRICES["claude-haiku-5-5"]!;
    expect(costMicros({ inputTokens: 100_000, outputTokens: 1000 }, p)).toBe(10_000 + 500);
    expect(costMicros({ inputTokens: 100_001, outputTokens: 1000 }, p)).toBe(50_001 + 2500);
    expect(costMicros({ inputTokens: 1_000_000, outputTokens: 0 }, DEFAULT_PRICES["claude-sonnet-5-5"]!)).toBe(2_000_000); // no long rate for Sonnet
    expect(estimateTokens(300)).toBe(100); // 3 chars a token: more than real English, so Haiku stays safely short
  });

  it("trims the oldest history to fit, keeping the newest and a clean start", () => {
    const big = (i: number) => ({ role: i % 2 ? "assistant" : "user", content: `m${i} ` + "x".repeat(30_000) }) as const;
    const history = Array.from({ length: 40 }, (_, i) => big(i));
    expect(estimateTokens(JSON.stringify(history).length)).toBeGreaterThan(HAIKU_SAFE_TOKENS);
    const fit = fitHistory(history as never, 5_000, HAIKU_SAFE_TOKENS, (rows) => rows.slice(rows.findIndex((m) => m.role === "user")));
    expect(estimateTokens(5_000 + JSON.stringify(fit).length)).toBeLessThanOrEqual(HAIKU_SAFE_TOKENS);
    expect(fit.at(-1)).toEqual(history.at(-1));
    expect(fit[0]!.role).toBe("user");
    expect(fit.length).toBeGreaterThan(5);
  });
});

describe("answer better", () => {
  it("goes up exactly one tier from where the last answer came from", () => {
    expect(nextTier("haiku")).toBe("sonnet");
    expect(nextTier("sonnet")).toBe("opus");
    expect(nextTier("opus")).toBeNull();
    expect(r({ message: "thanks", atLeast: "sonnet" })).toMatchObject({ tier: "sonnet", reason: "answer_better" });
    expect(r({ message: "draft an email", atLeast: "opus" })).toMatchObject({ tier: "opus", reason: "answer_better" });
  });

  it("never goes down if the rules already picked a higher tier", () => {
    expect(r({ message: "draft an email", atLeast: "sonnet" }).tier).toBe("sonnet");
    expect(r({ message: "use opus", atLeast: "sonnet" }).tier).toBe("opus");
  });
});

describe("near a cap, requests shift down instead of stopping", () => {
  it("near: one tier down. critical: Haiku. ok: unchanged", () => {
    const sonnet = { message: "draft an email to Marlene" };
    expect(r({ ...sonnet, level: "ok" })).toMatchObject({ tier: "sonnet", downshifted: false, canEscalate: true });
    expect(r({ ...sonnet, level: "near" })).toMatchObject({ tier: "haiku", wanted: "sonnet", downshifted: true, canEscalate: false });
    expect(r({ ...sonnet, level: "critical" })).toMatchObject({ tier: "haiku", wanted: "sonnet", downshifted: true });
    expect(r({ message: "use opus", level: "near" })).toMatchObject({ tier: "sonnet", wanted: "opus" });
    expect(r({ message: "use opus", level: "critical" }).tier).toBe("haiku");
    expect(lowerTier("haiku")).toBe("haiku");
    expect(r({ message: "hi", level: "near" })).toMatchObject({ tier: "haiku", downshifted: false }); // already the cheapest
  });

  it("asks the caller to trim history when the budget forces Haiku onto a long prompt", () => {
    expect(r({ message: "draft an email", level: "critical", promptTokens: 90_000 })).toMatchObject({ tier: "haiku", trimToFit: true });
    expect(r({ message: "draft an email", level: "critical", promptTokens: 1000 }).trimToFit).toBe(false);
    expect(r({ message: "hi", level: "ok", promptTokens: 90_000 }).trimToFit).toBe(false); // not forced: it just goes to Sonnet
  });
});

describe("failure and escalation", () => {
  const ok: ModelResult = { content: [{ type: "text", text: "ok" }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  const models = { haiku: "H", sonnet: "S", opus: "O" };
  const build = (tier: Tier, id: string): ModelRequest => ({ model: id, system: tier, messages: [], tools: [], maxTokens: 1 });
  /** Fails for as long as `fails` says, per model id, and records which model each call went to. */
  const fake = (failsOn: (id: string, n: number) => boolean) => {
    const calls: string[] = [];
    const client: ModelClient = {
      async complete(req) {
        calls.push(req.model);
        if (failsOn(req.model, calls.length)) throw new Error("529");
        return ok;
      },
    };
    return { client, calls };
  };

  it("retries once on the same model, and that is all the failure costs", async () => {
    const f = fake((_, n) => n === 1);
    const s = newCallState("sonnet", true);
    const res = await callWithEscalation(f.client, models, s, build, () => {});
    expect(f.calls).toEqual(["S", "S"]);
    expect(res.tier).toBe("sonnet");
    expect(s).toMatchObject({ failures: 1, escalated: false });
  });

  it("moves to Opus only after Sonnet has failed twice", async () => {
    const f = fake((id) => id === "S");
    const s = newCallState("sonnet", true);
    let retries = 0;
    const res = await callWithEscalation(f.client, models, s, build, () => {}, () => retries++);
    expect(f.calls).toEqual(["S", "S", "O"]);
    expect(res).toMatchObject({ tier: "opus", model: "O" });
    expect(s).toMatchObject({ tier: "opus", failures: 2, escalated: true });
    expect(retries).toBe(2); // the app is told to discard half-streamed text each time
  });

  it("stays on Opus for later calls in the same request", async () => {
    const f = fake((id) => id === "S");
    const s = newCallState("sonnet", true);
    await callWithEscalation(f.client, models, s, build, () => {});
    await callWithEscalation(f.client, models, s, build, () => {});
    expect(f.calls).toEqual(["S", "S", "O", "O"]);
  });

  it("gives up if Opus fails too, and never climbs from Haiku", async () => {
    const all = fake(() => true);
    await expect(callWithEscalation(all.client, models, newCallState("sonnet", true), build, () => {})).rejects.toThrow("529");
    expect(all.calls).toEqual(["S", "S", "O"]);
    const h = fake(() => true);
    await expect(callWithEscalation(h.client, models, newCallState("haiku", true), build, () => {})).rejects.toThrow();
    expect(h.calls).toEqual(["H", "H"]);
  });

  it("does not go to Opus when the user is near a cap", async () => {
    const f = fake(() => true);
    await expect(callWithEscalation(f.client, models, newCallState("sonnet", false), build, () => {})).rejects.toThrow();
    expect(f.calls).toEqual(["S", "S"]);
  });
});
