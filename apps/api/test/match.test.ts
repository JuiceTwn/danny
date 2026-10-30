import { describe, expect, it } from "vitest";
import { queryOf, score, stem, terms, type Candidate } from "../src/lib/match.js";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const note = (text: string, over: Partial<Candidate> = {}): Candidate => ({ text, subject: null, kind: "fact", updatedAt: "2026-01-01T00:00:00Z", usedAt: null, expiresAt: null, ...over });
const s = (c: Candidate, message: string, context: string[] = []) => score(c, queryOf(message, context), NOW);

describe("stem", () => {
  it("brings the forms of a word together", () => {
    const same = [["text", "texts", "texting", "texted"], ["move", "moves", "moving", "moved"], ["marry", "married", "marries"], ["call", "calls", "calling", "called"], ["party", "parties"], ["run", "running"], ["live", "lives", "living", "lived"]];
    for (const g of same) expect(new Set(g.map(stem)).size, g.join()).toBe(1);
  });
  it("leaves short words and different words alone", () => {
    expect(stem("dog")).toBe("dog");
    expect(stem("bus")).toBe("bus");
    expect(stem("press")).toBe("press");
    expect(stem("rent")).not.toBe(stem("rental"));
  });
});

describe("score", () => {
  it("matches across word forms", () => {
    expect(s(note("Prefers texts to calls"), "should I text or call him")).toBeGreaterThan(0);
    expect(s(note("Lives in Calgary"), "I moved last week")).toBeGreaterThan(0); // move and live are one idea
  });
  it("matches related words, but less than the same word", () => {
    const sister = note("Sister Priya lives in Calgary");
    expect(s(sister, "plans with my brother")).toBeGreaterThan(0);
    expect(s(sister, "plans with my brother")).toBeLessThan(s(sister, "plans with my sister"));
    expect(s(note("Plays guitar"), "I need to tune my instrument")).toBeGreaterThan(0);
  });
  it("scores unrelated notes zero, whatever their age, use or date", () => {
    const hot = note("Guitar is a Fender Telecaster", { updatedAt: "2026-10-29T00:00:00Z", usedAt: "2026-10-29T00:00:00Z", kind: "plan", expiresAt: "2026-11-02T00:00:00Z" });
    expect(s(hot, "what does Marlene like?")).toBe(0);
  });
  it("uses what was said just before, at a lower weight", () => {
    const priya = note("Lives in Calgary", { subject: "Priya" });
    expect(s(priya, "what about her?")).toBe(0);
    expect(s(priya, "what about her?", ["tell me about Priya"])).toBeGreaterThan(0);
    expect(s(priya, "where does Priya live")).toBeGreaterThan(s(priya, "where does she live", ["tell me about Priya"]));
  });
  it("a name in the message beats a loose match", () => {
    const named = note("Prefers email on Mondays", { subject: "Marlene" });
    const loose = note("Email signature is Danny Co");
    expect(s(named, "email Marlene")).toBeGreaterThan(s(loose, "email Marlene"));
  });
  it("between notes that match, newer, recently used and soon-due ones come first", () => {
    const old = note("Dentist is Dr Okafor");
    expect(s(note("Dentist is Dr Okafor", { updatedAt: "2026-10-25T00:00:00Z" }), "dentist")).toBeGreaterThan(s(old, "dentist"));
    expect(s(note("Dentist is Dr Okafor", { usedAt: "2026-10-28T00:00:00Z" }), "dentist")).toBeGreaterThan(s(old, "dentist"));
    expect(s(note("Dentist visit", { kind: "plan", expiresAt: "2026-11-03T00:00:00Z" }), "dentist")).toBeGreaterThan(s(note("Dentist visit", { kind: "plan", expiresAt: "2027-06-01T00:00:00Z" }), "dentist"));
  });
});

describe("terms", () => {
  it("ignores filler words", () => {
    expect([...terms("what about the thing").stems]).toEqual(["thing"]);
  });
});
