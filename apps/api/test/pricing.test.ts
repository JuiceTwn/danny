import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { listPrice, resolvePrice } from "../src/lib/pricing.js";

const base = { NODE_ENV: "test", DATABASE_URL: "postgres://x", DATA_KEYS: "1:" + Buffer.alloc(32, 7).toString("base64") } as NodeJS.ProcessEnv;

describe("prices follow the model", () => {
  it("uses Anthropic's list price for the model when nothing is set", () => {
    expect(resolvePrice("claude-haiku-5-5", {})).toMatchObject({ input: 0.1, output: 0.5, source: "list", differsFromList: false });
    expect(resolvePrice("claude-sonnet-5-5", {})).toMatchObject({ input: 2, output: 10, source: "list" });
    expect(resolvePrice("claude-opus-5-5", {})).toMatchObject({ input: 4, output: 20, source: "list" });
  });
  it("changing MODEL changes the price, with no other setting", () => {
    expect(loadConfig({ ...base, MODEL: "claude-sonnet-5-5" }).price).toMatchObject({ inputPerMtokUsd: 2, outputPerMtokUsd: 10 });
    expect(loadConfig({ ...base }).price).toMatchObject({ inputPerMtokUsd: 0.1, outputPerMtokUsd: 0.5 }); // the default model
  });
  it("a dated model id is the same model", () => {
    expect(listPrice("claude-haiku-5-5-20261001")).toEqual({ input: 0.1, output: 0.5 });
    expect(listPrice("claude-haiku-4-5")).toEqual({ input: 1, output: 5 }); // not mistaken for haiku-5-5
  });
  it("a value set in .env wins, and is reported as set by hand", () => {
    const r = loadConfig({ ...base, PRICE_INPUT_PER_MTOK_USD: "1", PRICE_OUTPUT_PER_MTOK_USD: "5" });
    expect(r.price).toMatchObject({ inputPerMtokUsd: 1, outputPerMtokUsd: 5 });
    expect(r.priceInfo).toMatchObject({ source: "env", differsFromList: true }); // the old values on the new model: flagged
  });
  it("an env value equal to the list price is not flagged", () => {
    expect(loadConfig({ ...base, PRICE_INPUT_PER_MTOK_USD: "0.1", PRICE_OUTPUT_PER_MTOK_USD: "0.5" }).priceInfo).toMatchObject({ source: "env", differsFromList: false });
  });
  it("a blank line in .env means not set, not free", () => {
    const r = loadConfig({ ...base, PRICE_INPUT_PER_MTOK_USD: "", PRICE_OUTPUT_PER_MTOK_USD: "" });
    expect(r.price).toMatchObject({ inputPerMtokUsd: 0.1, outputPerMtokUsd: 0.5 });
    expect(r.priceInfo.source).toBe("list");
  });
  it("an unknown model is priced as the dearest, never given away", () => {
    const r = loadConfig({ ...base, MODEL: "claude-brand-new-9" });
    expect(r.price).toMatchObject({ inputPerMtokUsd: 10, outputPerMtokUsd: 50 });
    expect(r.priceInfo.source).toBe("unknown-model");
  });
});
