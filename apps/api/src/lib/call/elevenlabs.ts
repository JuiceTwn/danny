import WebSocket from "ws";
import type { RealtimeStt, SttEvents, SttSession, Speech } from "./providers.js";

// Messages after which the session is over. Others (warnings, "not enough audio yet") are not fatal.
const FATAL = new Set(["error", "auth_error", "quota_exceeded", "unaccepted_terms", "session_time_limit_exceeded", "resource_exhausted", "queue_overflow", "transcriber_error", "rate_limited"]);

/** Live speech to text. The key stays on the server; the phone only talks to Danny. */
export class ElevenLabsRealtimeStt implements RealtimeStt {
  constructor(
    private readonly apiKey: string,
    private readonly base = "wss://api.elevenlabs.io",
    // How long a pause counts as "finished talking". A little patient, so a breath doesn't cut someone off.
    private readonly silenceSecs = 0.9,
  ) {}

  async open(ev: SttEvents): Promise<SttSession> {
    const q = new URLSearchParams({ model_id: "scribe_v2_realtime", audio_format: "pcm_16000", commit_strategy: "vad", vad_silence_threshold_secs: String(this.silenceSecs) });
    const sock = new WebSocket(`${this.base}/v1/speech-to-text/realtime?${q}`, { headers: { "xi-api-key": this.apiKey }, handshakeTimeout: 10_000 });
    await new Promise<void>((resolve, reject) => {
      sock.once("open", () => resolve());
      sock.once("error", () => reject(new Error("could not reach live transcription")));
    });
    sock.on("message", (data) => {
      let m: { message_type?: string; text?: string };
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (m.message_type === "partial_transcript" && typeof m.text === "string") ev.onPartial(m.text);
      else if (m.message_type === "committed_transcript" && typeof m.text === "string") ev.onCommitted(m.text);
      else if (m.message_type && FATAL.has(m.message_type)) ev.onError(m.message_type);
    });
    sock.on("error", () => ev.onError("connection"));
    sock.on("close", () => ev.onClose());
    return {
      send(pcm) {
        if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: pcm.toString("base64"), commit: false, sample_rate: 16000 }));
      },
      close() {
        if (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING) sock.close();
      },
    };
  }
}

/** Danny's voice. Audio streams back as it is made, so he can start talking before a sentence is finished rendering. */
export class ElevenLabsSpeech implements Speech {
  readonly sampleRate = 24000;
  constructor(
    private readonly apiKey: string,
    private readonly voiceId: string,
    private readonly model: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async *speak(text: string, signal: AbortSignal): AsyncIterable<Buffer> {
    const res = await this.fetchFn(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.voiceId)}/stream?output_format=pcm_24000`, {
      method: "POST",
      headers: { "xi-api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: this.model }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`speech failed (${res.status})`);
    // Each sample is two bytes. A network chunk can end in the middle of one, so carry the odd byte into the next chunk.
    let carry: Buffer | null = null;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      let buf = Buffer.from(chunk);
      if (carry) {
        buf = Buffer.concat([carry, buf]);
        carry = null;
      }
      if (buf.length % 2) {
        carry = buf.subarray(buf.length - 1);
        buf = buf.subarray(0, buf.length - 1);
      }
      if (buf.length) yield buf;
    }
  }
}
