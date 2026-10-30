/** How Danny talks. The user picks one in Settings. Every message he writes uses it, including briefings. */
export const VOICES = {
  foreman: "short sentences, direct, a little dry, like a shop foreman. No hype words, no emoji.",
  warm: "friendly and encouraging, like a good friend who is also organised. Plain words, short, kind. A light touch of humour is fine. No hype, no emoji.",
  brief: "as few words as possible. Fragments are fine. No greetings, no filler, no emoji.",
} as const;
export type Voice = keyof typeof VOICES;
export const isVoice = (v: string): v is Voice => v in VOICES;
export const voiceOf = (v: string | null | undefined) => VOICES[v && isVoice(v) ? v : "foreman"];
