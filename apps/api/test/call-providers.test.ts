import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WS } from "ws";
import { ElevenLabsRealtimeStt, ElevenLabsSpeech } from "../src/lib/call/elevenlabs.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => unknown, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return;
    await sleep(10);
  }
  throw new Error("timed out waiting");
};
const streamOf = (chunks: number[][]) =>
  new Response(new ReadableStream({ start(c) { for (const k of chunks) c.enqueue(new Uint8Array(k)); c.close(); } }), { status: 200 });
const collect = async (it: AsyncIterable<Buffer>) => {
  const out: Buffer[] = [];
  for await (const b of it) out.push(b);
  return out;
};

describe("ElevenLabsSpeech", () => {
  it("asks for streaming 24 kHz audio with the key, voice and model", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return streamOf([[1, 0, 2, 0]]);
    }) as unknown as typeof fetch;
    const t = new ElevenLabsSpeech("key-1", "voice/with space", "eleven_flash_v2_5", f);
    expect(t.sampleRate).toBe(24000);
    const ctl = new AbortController();
    await collect(t.speak("Hello there.", ctl.signal));
    expect(seen!.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice%2Fwith%20space/stream?output_format=pcm_24000");
    expect(seen!.init.method).toBe("POST");
    expect((seen!.init.headers as Record<string, string>)["xi-api-key"]).toBe("key-1");
    expect(JSON.parse(seen!.init.body as string)).toEqual({ text: "Hello there.", model_id: "eleven_flash_v2_5" });
    expect(seen!.init.signal).toBe(ctl.signal);
  });

  it("never splits a 16-bit sample across chunks", async () => {
    // network chunks of 3, 3 and 2 bytes: 8 bytes in all, but the first chunk ends mid-sample
    const f = (async () => streamOf([[1, 2, 3], [4, 5, 6], [7, 8]])) as unknown as typeof fetch;
    const out = await collect(new ElevenLabsSpeech("k", "v", "m", f).speak("x", new AbortController().signal));
    expect(out.every((b) => b.length % 2 === 0)).toBe(true);
    expect(Buffer.concat(out)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  });

  it("throws on a failed request instead of playing nothing silently", async () => {
    const f = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    await expect(collect(new ElevenLabsSpeech("k", "v", "m", f).speak("x", new AbortController().signal))).rejects.toThrow(/speech failed \(401\)/);
  });
});

describe("ElevenLabsRealtimeStt", () => {
  let wss: WebSocketServer;
  let base = "";
  let got: { url: string; key: string | undefined; messages: any[] } | null = null;
  let server: WS | null = null;
  beforeAll(async () => {
    const http = createServer();
    wss = new WebSocketServer({ server: http });
    wss.on("connection", (ws, req) => {
      server = ws;
      got = { url: req.url!, key: req.headers["xi-api-key"] as string | undefined, messages: [] };
      ws.on("message", (d) => got!.messages.push(JSON.parse(String(d))));
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    base = `ws://127.0.0.1:${(http.address() as { port: number }).port}`;
  });
  afterAll(() => wss.close());

  it("connects the way the docs say, sends audio as base64 chunks, and reports what it hears", async () => {
    const events: string[] = [];
    const stt = await new ElevenLabsRealtimeStt("key-2", base).open({
      onPartial: (t) => events.push(`partial:${t}`),
      onCommitted: (t) => events.push(`committed:${t}`),
      onError: (m) => events.push(`error:${m}`),
      onClose: () => events.push("close"),
    });
    await until(() => got);
    const u = new URL(got!.url, "http://x");
    expect(u.pathname).toBe("/v1/speech-to-text/realtime");
    expect(u.searchParams.get("model_id")).toBe("scribe_v2_realtime");
    expect(u.searchParams.get("audio_format")).toBe("pcm_16000");
    expect(u.searchParams.get("commit_strategy")).toBe("vad");
    expect(got!.key).toBe("key-2");

    const pcm = Buffer.from([1, 2, 3, 4]);
    stt.send(pcm);
    await until(() => got!.messages.length === 1);
    expect(got!.messages[0]).toEqual({ message_type: "input_audio_chunk", audio_base_64: pcm.toString("base64"), commit: false, sample_rate: 16000 });

    server!.send(JSON.stringify({ message_type: "session_started", session_id: "s" }));
    server!.send(JSON.stringify({ message_type: "partial_transcript", text: "hello wor" }));
    server!.send(JSON.stringify({ message_type: "committed_transcript", text: "hello world" }));
    server!.send(JSON.stringify({ message_type: "insufficient_audio_activity", error: "quiet" })); // not fatal
    server!.send("not json");
    await until(() => events.length >= 2);
    await sleep(30);
    expect(events).toEqual(["partial:hello wor", "committed:hello world"]);

    server!.send(JSON.stringify({ message_type: "quota_exceeded", error: "out of credit" }));
    await until(() => events.includes("error:quota_exceeded"));
    stt.close();
    await until(() => events.includes("close"));
  });

  it("fails clearly when it can't connect", async () => {
    await expect(new ElevenLabsRealtimeStt("k", "ws://127.0.0.1:1").open({ onPartial() {}, onCommitted() {}, onError() {}, onClose() {} })).rejects.toThrow(/could not reach/);
  });
});
