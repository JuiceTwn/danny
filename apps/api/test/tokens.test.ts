import { describe, expect, it } from "vitest";
import { clip, windowStart } from "../src/brain/run.js";
import { costMicros } from "../src/lib/spend.js";

const price = { inputPerMtokUsd: 1, outputPerMtokUsd: 5 };

describe("token savings", () => {
  it("the history window only moves in steps, so the cached prefix holds still between moves", () => {
    expect(windowStart(5)).toBe(0);
    expect(windowStart(39)).toBe(0);
    expect(windowStart(40)).toBe(20);
    expect(windowStart(59)).toBe(20);
    expect(windowStart(60)).toBe(40);
    // never more than 39 messages and never fewer than 20 once the chat is long
    for (let n = 20; n < 500; n++) expect(n - windowStart(n)).toBeGreaterThanOrEqual(20), expect(n - windowStart(n)).toBeLessThan(40);
  });

  it("clip keeps short text and marks what it cut", () => {
    expect(clip("short", 10)).toBe("short");
    expect(clip("x".repeat(15), 10)).toBe(`${"x".repeat(10)}\n[cut: 5 more characters]`);
  });

  it("cached reads cost a tenth and writes 1.25x", () => {
    expect(costMicros({ inputTokens: 1000, outputTokens: 0 }, price)).toBe(1000);
    expect(costMicros({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1000 }, price)).toBe(100);
    expect(costMicros({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1000 }, price)).toBe(1250);
  });
});
