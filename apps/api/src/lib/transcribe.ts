/** Speech to text. The server never keeps the audio: it goes to the provider and the words come back. */
export type Transcriber = { transcribe(audio: Buffer, mime: string): Promise<string> };

/** Any provider failure. The message is ours, never the provider's, so nothing odd reaches the user. */
export class TranscribeError extends Error {}

const EXT: Record<string, string> = { webm: "webm", mp4: "mp4", m4a: "m4a", aac: "aac", ogg: "ogg", wav: "wav", mpeg: "mp3", mp3: "mp3" };
const extFor = (mime: string) => EXT[/^audio\/([a-z0-9]+)/i.exec(mime)?.[1]?.toLowerCase() ?? ""] ?? "webm";

export class ElevenLabsTranscriber implements Transcriber {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async transcribe(audio: Buffer, mime: string) {
    const form = new FormData();
    form.set("model_id", this.model);
    form.set("tag_audio_events", "false");
    form.set("diarize", "false");
    form.set("file", new Blob([new Uint8Array(audio)], { type: mime }), `speech.${extFor(mime)}`);
    let res: Response;
    try {
      res = await this.fetchFn("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": this.apiKey },
        body: form,
        signal: AbortSignal.timeout(25_000),
      });
    } catch {
      throw new TranscribeError("transcription request failed");
    }
    if (!res.ok) throw new TranscribeError(`transcription failed (${res.status})`);
    const body = (await res.json().catch(() => null)) as { text?: unknown } | null;
    return typeof body?.text === "string" ? body.text.trim().slice(0, 8000) : "";
  }
}
