import { afterEach, describe, expect, it } from "vitest";
import { classifyModelError, reportFailure, setErrorSink } from "../src/lib/model-error.js";

const api = (status: number, type: string, message: string) => Object.assign(new Error(`${status} ${message}`), { status, error: { error: { type, message } } });

describe("why a model call failed", () => {
  afterEach(() => setErrorSink(null));

  it("tells apart a bad key, a bad model name, rate limits, overload and bad requests", () => {
    expect(classifyModelError(api(401, "authentication_error", "invalid x-api-key")).kind).toBe("auth");
    expect(classifyModelError(api(403, "permission_error", "no")).kind).toBe("auth");
    expect(classifyModelError(api(404, "not_found_error", "model: claude-nope")).kind).toBe("model");
    expect(classifyModelError(api(429, "rate_limit_error", "slow down")).kind).toBe("rate");
    expect(classifyModelError(api(529, "overloaded_error", "Overloaded")).kind).toBe("overloaded");
    expect(classifyModelError(api(500, "api_error", "oops")).kind).toBe("overloaded");
    expect(classifyModelError(api(400, "invalid_request_error", "tools.3.input_schema: bad")).kind).toBe("bad_request");
  });

  it("recognises a network problem, a timeout, and anything else", () => {
    expect(classifyModelError(new Error("fetch failed")).kind).toBe("network");
    expect(classifyModelError(Object.assign(new Error("Connection error."), { name: "APIConnectionError" })).kind).toBe("network");
    expect(classifyModelError(Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" })).kind).toBe("timeout");
    expect(classifyModelError(new Error("boom")).kind).toBe("unknown");
    expect(classifyModelError("a string").kind).toBe("unknown");
    expect(classifyModelError(null).kind).toBe("unknown");
  });

  it("gives a hint a person can act on, and never uses the words the briefing treats as 'do not retry'", () => {
    for (const kind of ["auth", "model", "rate", "overloaded", "bad_request", "network", "timeout", "unknown"] as const) {
      const hint = classifyModelError(api(kind === "auth" ? 401 : kind === "model" ? 404 : kind === "rate" ? 429 : kind === "overloaded" ? 529 : 400, "x", "y")).hint;
      expect(hint.length).toBeGreaterThan(10);
      expect(hint).not.toMatch(/stopped|cap/i); // the briefing retries unless a reason says stopped or cap
    }
  });

  it("keeps anything that looks like a key out of what it says", () => {
    const f = classifyModelError(api(401, "authentication_error", "invalid x-api-key sk-ant-api03-AbCdEf123456789_xyz"));
    expect(f.detail).not.toContain("AbCdEf123456789");
    expect(f.detail).toContain("sk-…");
  });

  it("logs the cause through the app's logger, or to stderr when there is none", () => {
    const seen: { o: Record<string, unknown>; m: string }[] = [];
    setErrorSink((o, m) => seen.push({ o, m }));
    const f = reportFailure("chat model call", api(429, "rate_limit_error", "slow down"), { model: "m1" });
    expect(f.kind).toBe("rate");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.o).toMatchObject({ where: "chat model call", kind: "rate", status: 429, model: "m1" });
    expect(seen[0]!.m).toContain("chat model call failed: rate (429)");
  });
});
