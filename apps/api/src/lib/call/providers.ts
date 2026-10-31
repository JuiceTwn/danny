/** The two things a call needs from outside: live listening and spoken replies. Tests plug in fakes. */
export type SttEvents = {
  /** Words so far, may still change. */
  onPartial(text: string): void;
  /** A finished stretch of speech. */
  onCommitted(text: string): void;
  onError(message: string): void;
  onClose(): void;
};
export type SttSession = {
  /** 16 kHz, 16-bit, mono, little-endian audio. */
  send(pcm: Buffer): void;
  close(): void;
};
export type RealtimeStt = { open(events: SttEvents): Promise<SttSession> };
export type Speech = {
  /** Sample rate of the audio `speak` returns (16-bit mono PCM). */
  readonly sampleRate: number;
  speak(text: string, signal: AbortSignal): AsyncIterable<Buffer>;
};
export type CallProviders = { stt: RealtimeStt; speech: Speech };
