import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * The phone-side player for Danny's voice (apps/web/public/call-worklet.js), run here with stand-ins for the browser's audio globals.
 * The thing that matters: where the network pieces join must make NO difference to what comes out, because a difference there is the crackle.
 */
type Port = { onmessage: ((e: { data: unknown }) => void) | null };
type Player = { port: Port; process(i: unknown[], o: Float32Array[][]): boolean };

function loadPlayer(speakerRate: number, voiceRate: number): Player {
  const classes: Record<string, new (o?: unknown) => Player> = {};
  runInNewContext(readFileSync(new URL("../../web/public/call-worklet.js", import.meta.url), "utf8"), {
    AudioWorkletProcessor: class {
      port: Port = { onmessage: null, postMessage() {} } as Port;
    },
    registerProcessor: (n: string, c: new (o?: unknown) => Player) => (classes[n] = c),
    sampleRate: speakerRate,
    Int16Array,
    Float32Array,
    Math,
  });
  return new classes["pcm-player"]!({ processorOptions: { rate: voiceRate } });
}

/** A steady tone, as 16-bit samples at the voice's rate. */
const tone = (n: number, rate: number, hz = 220, amp = 0.5) => Int16Array.from({ length: n }, (_, i) => Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * amp * 32767));
const send = (p: Player, s: Int16Array) => p.port.onmessage!({ data: { pcm: s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength) } });
const render = (p: Player, blocks: number) => {
  const all: number[] = [];
  for (let b = 0; b < blocks; b++) {
    const out = new Float32Array(128);
    p.process([], [[out]]);
    all.push(...out);
  }
  return all;
};
const maxJump = (x: number[]) => x.slice(1).reduce((m, v, i) => Math.max(m, Math.abs(v - x[i]!)), 0);

describe("Danny's voice player", () => {
  const voice = 24000;
  for (const speaker of [48000, 44100]) {
    it(`gives exactly the same sound however the network cut it up, at a ${speaker} Hz speaker`, () => {
      const all = tone(24000, voice);
      const whole = loadPlayer(speaker, voice);
      send(whole, all);
      const a = render(whole, 300);

      const cut = loadPlayer(speaker, voice);
      // awkward, uneven pieces, some tiny, some odd lengths
      const sizes = [7, 313, 1, 999, 2048, 5, 480, 1201, 33, 3000];
      let at = 0;
      for (let i = 0; at < all.length; i++) {
        const n = Math.min(sizes[i % sizes.length]!, all.length - at);
        send(cut, all.subarray(at, at + n));
        at += n;
      }
      const b = render(cut, 300);
      expect(b).toEqual(a);
    });
  }

  it("a steady tone comes out smooth: no jumps at all beyond the tone itself", () => {
    const p = loadPlayer(48000, voice);
    const all = tone(24000, voice, 220, 0.5);
    for (let i = 0; i < all.length; i += 123) send(p, all.subarray(i, i + 123));
    const out = render(p, 200).slice(5000, 20000); // well inside the tone
    // A 220 Hz tone at amplitude 0.5 moves at most 2*pi*220/48000*0.5 per sample (about 0.0144). A click would be many times that.
    expect(maxJump(out)).toBeLessThan(0.02);
  });

  it("waits for a little audio before starting, so a slow start is a short pause, not a stutter", () => {
    const p = loadPlayer(48000, voice);
    send(p, tone(500, voice)); // far less than a tenth of a second
    expect(Math.max(...render(p, 20).map(Math.abs))).toBe(0);
    send(p, tone(5000, voice));
    expect(Math.max(...render(p, 40).map(Math.abs))).toBeGreaterThan(0.1);
  });

  it("running dry fades out instead of clicking, and picks up again smoothly once there is audio", () => {
    const p = loadPlayer(48000, voice);
    send(p, tone(6000, voice, 220, 0.8));
    const first = render(p, 200); // plays through 0.25 s of audio, then runs dry
    expect(maxJump(first)).toBeLessThan(0.05); // no click at the point it ran out
    expect(Math.abs(first.at(-1)!)).toBeLessThan(0.01); // settled to silence
    send(p, tone(6000, voice, 220, 0.8));
    const second = render(p, 200);
    expect(maxJump(second)).toBeLessThan(0.05);
    expect(Math.max(...second.map(Math.abs))).toBeGreaterThan(0.3);
  });

  it("clear (talking over him) stops the sound within a moment and drops what was queued", () => {
    const p = loadPlayer(48000, voice);
    send(p, tone(24000, voice, 220, 0.8));
    render(p, 40);
    p.port.onmessage!({ data: { clear: true } });
    const after = render(p, 40);
    expect(maxJump(after)).toBeLessThan(0.05);
    expect(Math.max(...after.slice(1500).map(Math.abs))).toBeLessThan(0.001);
  });

  it("an odd trailing byte never breaks the stream", () => {
    const p = loadPlayer(48000, voice);
    const bytes = new Uint8Array(tone(5001, voice).buffer);
    p.port.onmessage!({ data: { pcm: bytes.buffer.slice(0, bytes.length - 1 + 1) } });
    expect(() => render(p, 20)).not.toThrow();
  });
});
