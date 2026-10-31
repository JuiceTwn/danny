import type { Deps } from "../../app.js";
import { runTurn } from "../../brain/run.js";
import { withTenant } from "../../db/client.js";
import { unmark } from "../format.js";
import { Bill, checkBudget, recordSpend } from "../spend.js";
import type { CallProviders, SttSession } from "./providers.js";

/**
 * One live call. The phone sends 16 kHz audio; this listens, hands finished sentences to the same brain as typed chat,
 * and speaks the answer back sentence by sentence. Talking over Danny stops him.
 *
 * Phone to server:  binary = audio.  JSON: {type:"interrupt"} | {type:"end"}
 * Server to phone:  binary = Danny's voice (16-bit mono PCM).
 *   JSON: ready | state | you (live captions) | danny (reply text) | approval | stop (drop queued audio) | error | ended
 */
export type CallSocket = { send(data: string | Buffer): void; close(code?: number, reason?: string): void };
export type CallState = "listening" | "thinking" | "speaking";

export type CallOptions = {
  billEveryMs?: number;
  idleMs?: number;
  maxMs?: number;
  /** Minimum words said over Danny before it counts as interrupting him. A cough or a bit of echo should not. */
  bargeWords?: number;
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter(Boolean);

/** Cuts finished sentences off the front of a growing reply. Short bits ("Okay.") wait and join the next sentence. */
export function takeSentences(buf: string, final = false) {
  const out: string[] = [];
  const re = /[.!?…]+["')\]]*\s+|\n+/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buf))) {
    const end = m.index + m[0].length;
    const piece = buf.slice(start, end).trim();
    if (piece.length >= 12) {
      out.push(piece);
      start = end;
    }
  }
  let rest = buf.slice(start);
  if (final) {
    if (rest.trim()) out.push(rest.trim());
    rest = "";
  } else if (rest.length > 220) {
    // A very long stretch with no full stop: start talking at the last comma or space.
    const cut = Math.max(rest.lastIndexOf(", "), rest.lastIndexOf(" "));
    if (cut > 40) {
      out.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1);
    }
  }
  return { sentences: out, rest };
}

export class CallSession {
  private stt: SttSession | null = null;
  private closed = false;
  private state: CallState | null = null; // nothing sent yet, so the first setState always tells the phone
  private abort = new AbortController();
  private turns: Promise<void> = Promise.resolve();
  private turnActive = false;
  private pump: Promise<void> = Promise.resolve();
  private speakingUntil = 0;
  private recent: string[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  private stateTimer: ReturnType<typeof setTimeout> | undefined;
  private startedAt = Date.now();
  private billedAt = Date.now();
  private heardAt = Date.now();
  private readonly o: Required<CallOptions>;
  private readonly bytesPerSec: number;

  constructor(
    private readonly deps: Deps,
    private readonly who: { workspaceId: string; userId: string },
    private readonly socket: CallSocket,
    private readonly providers: CallProviders,
    opts: CallOptions = {},
  ) {
    this.o = { billEveryMs: 5000, idleMs: 120_000, maxMs: deps.config.call.maxMinutes * 60_000, bargeWords: 3, ...opts };
    this.bytesPerSec = providers.speech.sampleRate * 2;
  }

  async start() {
    this.stt = await this.providers.stt.open({
      onPartial: (t) => this.onPartial(t),
      onCommitted: (t) => this.onCommitted(t),
      onError: () => this.end("listening_failed", "I lost the connection to my ears. Try calling again."),
      onClose: () => this.closed || this.end("listening_failed", "I lost the connection to my ears. Try calling again."),
    });
    this.startedAt = this.billedAt = this.heardAt = Date.now();
    this.send({ type: "ready", sampleRate: this.providers.speech.sampleRate });
    this.setState("listening");
    this.timers.push(setInterval(() => void this.tick(), this.o.billEveryMs));
  }

  /** A frame from the phone. */
  onFrame(data: Buffer, isBinary: boolean) {
    if (this.closed) return;
    if (isBinary) return void this.stt?.send(data);
    let m: { type?: string };
    try {
      m = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    if (m.type === "interrupt") this.interrupt();
    else if (m.type === "end") this.end("hung_up");
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    clearTimeout(this.stateTimer);
    this.timers.forEach(clearInterval);
    this.stt?.close();
    void this.bill(); // the last few seconds
  }

  // ---- what was heard

  private speaking() {
    return Date.now() < this.speakingUntil + 300;
  }
  /** Danny's own voice coming back through the phone's microphone. */
  private looksLikeEcho(text: string) {
    if (Date.now() > this.speakingUntil + 1500) return false;
    const heard = norm(text);
    if (heard.length < 2) return false;
    const said = new Set(norm(this.recent.join(" ")));
    return heard.filter((w) => said.has(w)).length / heard.length >= 0.7;
  }

  private onPartial(text: string) {
    if (this.closed) return;
    this.send({ type: "you", text, final: false });
    if ((this.turnActive || this.speaking()) && norm(text).length >= this.o.bargeWords && !this.looksLikeEcho(text)) this.interrupt();
  }

  private onCommitted(raw: string) {
    const text = raw.trim();
    if (this.closed || !text) return;
    const words = norm(text).length;
    const over = this.turnActive || this.speaking();
    if (over && (this.looksLikeEcho(text) || words < 2)) return; // echo or a stray noise, not the person
    this.heardAt = Date.now();
    if (over) this.interrupt();
    this.send({ type: "you", text, final: true });
    // One turn at a time: a new one waits for the one before it to finish stopping.
    this.turns = this.turns.then(() => this.turn(text)).catch(() => {});
  }

  /** Stop talking, drop what was queued, and go back to listening. */
  private interrupt() {
    this.abort.abort();
    this.speakingUntil = 0;
    this.pump = Promise.resolve();
    this.send({ type: "stop" });
    this.setState("listening");
  }

  // ---- Danny's turn

  private async turn(text: string) {
    if (this.closed) return;
    const release = this.deps.turnLock!.tryAcquire(this.who.workspaceId);
    if (!release) return this.send({ type: "error", code: "busy", message: "One moment, Danny is still on your last message." });
    const ac = (this.abort = new AbortController());
    const isStopped = () => ac.signal.aborted || this.closed;
    this.turnActive = true;
    this.setState("thinking");
    let buf = "";
    const speak = (final: boolean) => {
      const { sentences, rest } = takeSentences(buf, final);
      buf = rest;
      for (const s of sentences) this.say(s, ac.signal);
    };
    try {
      await runTurn(
        this.deps,
        this.who,
        text,
        (e) => {
          if (isStopped()) return;
          if (e.type === "text") {
            buf += e.text;
            this.send({ type: "danny", text: e.text });
            speak(false);
          } else if (e.type === "approval") this.send({ type: "approval", title: e.title });
          else if (e.type === "error") {
            if (e.code === "cap_reached" || e.code === "kill_switch") this.end(e.code, e.message);
            else this.send({ type: "error", code: e.code, message: e.message });
          }
        },
        isStopped,
        release,
        { spoken: true },
      );
      if (!isStopped()) speak(true);
      await this.pump;
    } catch {
      if (!isStopped()) this.send({ type: "error", code: "model_failed", message: "Something broke on my side. Try again." });
    } finally {
      release();
      this.turnActive = false;
      this.settle();
    }
  }

  // ---- Danny's voice

  /** Starts making a sentence's audio now, and plays it in order after the sentences before it. */
  private say(raw: string, signal: AbortSignal) {
    const text = unmark(raw).trim();
    if (!text || signal.aborted) return;
    this.recent.push(text);
    if (this.recent.length > 4) this.recent.shift();
    void this.chargeSpeech(text.length);
    const chunks: Buffer[] = [];
    let done = false;
    let failed = false;
    let wake = null as (() => void) | null; // set by the player below when it is waiting for more audio
    void (async () => {
      try {
        for await (const c of this.providers.speech.speak(text, signal)) {
          chunks.push(c);
          wake?.();
        }
      } catch {
        failed = !signal.aborted;
      }
      done = true;
      wake?.();
    })();
    this.pump = this.pump.then(async () => {
      for (;;) {
        while (chunks.length) {
          if (signal.aborted || this.closed) return;
          this.sendAudio(chunks.shift()!);
        }
        if (done) break;
        await new Promise<void>((r) => (wake = r));
      }
      if (failed && !signal.aborted) this.send({ type: "error", code: "speech_failed", message: "I lost my voice for a second." });
    });
  }

  private sendAudio(buf: Buffer) {
    if (this.state !== "speaking") this.setState("speaking");
    this.socket.send(buf);
    const now = Date.now();
    this.speakingUntil = Math.max(now, this.speakingUntil) + (buf.length / this.bytesPerSec) * 1000;
    this.settle();
  }

  /** Back to listening once what was sent has finished playing on the phone. */
  private settle() {
    clearTimeout(this.stateTimer);
    if (this.closed) return;
    const wait = this.speakingUntil - Date.now();
    if (wait > 0) this.stateTimer = setTimeout(() => this.settle(), wait + 50);
    else if (!this.turnActive) this.setState("listening");
  }

  private setState(s: CallState) {
    if (this.state === s) return;
    this.state = s;
    this.send({ type: "state", state: s });
  }

  // ---- time, money and limits

  private async tick() {
    if (this.closed) return;
    const now = Date.now();
    if (now - this.startedAt >= this.o.maxMs) return this.end("time_limit", `That's the longest a call can go (${Math.round(this.o.maxMs / 60000)} minutes). Call again any time.`);
    if (now - this.heardAt >= this.o.idleMs && !this.turnActive && !this.speaking()) return this.end("idle", "I haven't heard anything for a while, so I hung up.");
    await this.bill();
    if (this.closed) return;
    const b = await withTenant(this.deps.db, this.who.workspaceId, (tx) => checkBudget(tx, this.who.workspaceId)).catch(() => null);
    if (b && !b.ok) this.end(b.reason, b.reason === "kill_switch" ? "Danny is stopped. Turn him back on in settings." : "You've used all of today's allowance. It resets at midnight UTC.");
  }

  /** Listening is billed for as long as the line is open. */
  private async bill() {
    const now = Date.now();
    const seconds = (now - this.billedAt) / 1000;
    this.billedAt = now;
    if (seconds <= 0) return;
    const costMicros = Math.ceil((seconds / 3600) * this.deps.config.call.sttLivePerHourUsd * 1_000_000);
    await this.record("stt-live:scribe_v2_realtime", costMicros);
  }

  private async chargeSpeech(chars: number) {
    const { ttsModel, ttsPer1kCharsUsd } = this.deps.config.call;
    await this.record(`tts:${ttsModel}`, Math.ceil((chars / 1000) * ttsPer1kCharsUsd * 1_000_000));
  }

  /** Listening and speaking across the whole call round up together, as one request. */
  private callBill = new Bill();

  private async record(model: string, costMicros: number) {
    const { workspaceId, userId } = this.who;
    try {
      await withTenant(this.deps.db, workspaceId, (tx) => recordSpend(tx, { workspaceId, userId, model, inputTokens: 0, outputTokens: 0, costMicros }, this.callBill));
    } catch {
      /* a ledger hiccup must not drop the call; the next tick bills again */
    }
  }

  end(reason: string, message?: string) {
    if (this.closed) return;
    this.send({ type: "ended", reason, message });
    this.close();
    this.socket.close(1000, reason.slice(0, 100));
  }

  private send(m: Record<string, unknown>) {
    try {
      this.socket.send(JSON.stringify(m));
    } catch {
      /* the phone went away */
    }
  }
}
