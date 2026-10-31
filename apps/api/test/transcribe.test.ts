import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spendLedger, workspaces } from "../src/db/schema.js";
import { ElevenLabsTranscriber, TranscribeError, type Transcriber } from "../src/lib/transcribe.js";
import { ORIGIN, seedOwner, setupApp, signUp, type Client, type Ctx } from "./helpers.js";

const audio = (bytes = 5000) => Buffer.alloc(bytes, 1);
const ENV = { ELEVENLABS_API_KEY: "test-key", PRICE_STT_PER_HOUR_USD: "0.36" }; // $0.36/hour = $0.0001 a second

let heard: { bytes: number; mime: string }[] = [];
let next: () => Promise<string> = async () => "hello danny";
const fake: Transcriber = {
  async transcribe(buf, mime) {
    heard.push({ bytes: buf.length, mime });
    return next();
  },
};

let ctx: Ctx;
let owner: Client;
beforeAll(async () => {
  ctx = await setupApp(undefined, undefined, ENV, undefined, null, undefined, undefined, undefined, fake);
  owner = (await seedOwner(ctx)).c;
});
afterAll(() => ctx.close());

/** The recording goes up as the raw request body. */
async function speak(c: Client, body: Buffer, headers: Record<string, string> = {}) {
  return c.req("POST", "/v1/transcribe", body as never, { "content-type": "audio/webm;codecs=opus", ...headers });
}
const spent = async (workspaceId: string) =>
  (await ctx.owner.db.select().from(spendLedger).where(eq(spendLedger.workspaceId, workspaceId))).filter((r) => r.model.startsWith("stt:"));

describe("voice typing", () => {
  it("turns a recording into text and bills it by the second", async () => {
    const u = await signUp(ctx, owner, "Talker");
    heard = [];
    next = async () => "remind me to call Marlene";
    const res = await speak(u.c, audio(), { "x-audio-seconds": "10" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: "remind me to call Marlene" });
    expect(heard).toEqual([{ bytes: 5000, mime: "audio/webm" }]);
    const rows = await spent(u.workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.model).toBe("stt:scribe_v2");
    expect(rows[0]!.costMicros).toBe(1000); // 10 s at $0.0001 a second
  });

  it("charges for the longer of what the app says and what the size implies", async () => {
    const u = await signUp(ctx, owner, "Sneaky");
    // 240 KB is 10 s at the size cap's rate. Claiming 1 s must not make it cheaper.
    await speak(u.c, audio(240_000), { "x-audio-seconds": "1" });
    expect((await spent(u.workspaceId))[0]!.costMicros).toBe(1000);
  });

  it("only works when signed in", async () => {
    const anon = await ctx.app.inject({ method: "POST", url: "/v1/transcribe", headers: { origin: ORIGIN, "content-type": "audio/webm" }, payload: audio() });
    expect(anon.statusCode).toBe(401);
  });

  it("refuses empty recordings, other content types and oversized ones", async () => {
    const u = await signUp(ctx, owner, "Edge");
    heard = [];
    expect((await speak(u.c, audio(10))).status).toBe(400);
    expect((await u.c.req("POST", "/v1/transcribe", "words" as never, { "content-type": "text/plain" })).status).toBe(400); // text is not audio
    expect((await u.c.req("POST", "/v1/transcribe", audio() as never, { "content-type": "application/octet-stream" })).status).toBe(415); // only audio/* is accepted
    expect((await speak(u.c, audio(2_900_000))).status).toBe(413);
    expect(heard).toHaveLength(0);
    expect(await spent(u.workspaceId)).toHaveLength(0);
  });

  it("stops at the kill switch and the daily cap without calling the provider", async () => {
    const u = await signUp(ctx, owner, "Capped");
    heard = [];
    await u.c.patch("/v1/settings", { killSwitch: true });
    const stopped = await speak(u.c, audio());
    expect(stopped.status).toBe(429);
    expect(stopped.body).toMatchObject({ error: "kill_switch", message: expect.stringMatching(/stopped/i) });
    await u.c.patch("/v1/settings", { killSwitch: false });
    await ctx.owner.db.update(workspaces).set({ dailyCapMicros: 100 }).where(eq(workspaces.id, u.workspaceId));
    await ctx.owner.db.insert(spendLedger).values({ workspaceId: u.workspaceId, userId: u.userId, model: "x", costMicros: 100 });
    const capped = await speak(u.c, audio());
    expect(capped.status).toBe(429);
    expect(capped.body.error).toBe("cap_reached");
    expect(heard).toHaveLength(0);
  });

  it("a provider failure is reported in our words and charges nothing", async () => {
    const u = await signUp(ctx, owner, "Broken");
    next = async () => {
      throw new TranscribeError("provider said: secret detail");
    };
    const res = await speak(u.c, audio());
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain("secret detail");
    expect(res.body.error).toBe("transcribe_failed");
    expect(await spent(u.workspaceId)).toHaveLength(0);
    next = async () => "hello danny";
  });

  it("an empty transcript comes back empty (nothing heard) and is still billed", async () => {
    const u = await signUp(ctx, owner, "Silent");
    next = async () => "";
    const res = await speak(u.c, audio(), { "x-audio-seconds": "3" });
    expect(res.body).toEqual({ text: "" });
    expect(await spent(u.workspaceId)).toHaveLength(1);
    next = async () => "hello danny";
  });

  it("settings tell the app whether voice typing is on", async () => {
    expect((await owner.get("/v1/settings")).body.voiceTyping).toBe(true);
  });
});

describe("voice typing turned off", () => {
  it("answers 503 and settings say so", async () => {
    const off = await setupApp(undefined, undefined, {}, undefined, null, undefined, undefined, undefined, null);
    try {
      const o = (await seedOwner(off)).c;
      expect((await o.get("/v1/settings")).body.voiceTyping).toBe(false);
      const res = await o.req("POST", "/v1/transcribe", audio() as never, { "content-type": "audio/webm" });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("voice_unavailable");
    } finally {
      await off.close();
    }
  });
});

describe("ElevenLabsTranscriber", () => {
  const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("sends the file with the key and model, and returns the trimmed text", async () => {
    const f = vi.fn(async (_u: unknown, _i?: RequestInit) => ok({ text: "  hi there  " }));
    const t = new ElevenLabsTranscriber("k123", "scribe_v2", f as never);
    expect(await t.transcribe(audio(), "audio/mp4")).toBe("hi there");
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(init!.method).toBe("POST");
    expect((init!.headers as Record<string, string>)["xi-api-key"]).toBe("k123");
    const form = init!.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v2");
    expect((form.get("file") as File).name).toBe("speech.mp4");
    expect((form.get("file") as File).type).toBe("audio/mp4");
  });

  it("turns any provider problem into one fixed error", async () => {
    const bad = new ElevenLabsTranscriber("k", "m", (async () => ok({ detail: "quota exceeded for key k" }, 401)) as never);
    await expect(bad.transcribe(audio(), "audio/webm")).rejects.toThrow(TranscribeError);
    await expect(bad.transcribe(audio(), "audio/webm")).rejects.not.toThrow(/quota|key/);
    const down = new ElevenLabsTranscriber("k", "m", (async () => {
      throw new Error("ECONNRESET");
    }) as never);
    await expect(down.transcribe(audio(), "audio/webm")).rejects.toThrow(TranscribeError);
    const junk = new ElevenLabsTranscriber("k", "m", (async () => new Response("<html>", { status: 200 })) as never);
    expect(await junk.transcribe(audio(), "audio/webm")).toBe("");
  });
});
