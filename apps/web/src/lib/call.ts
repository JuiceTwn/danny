// A live call with Danny. The phone streams the microphone to the server and plays Danny's voice as it arrives.
// Everything else (listening, thinking, interrupting, the limits) is decided on the server; this only reports it.

export type CallState = "connecting" | "listening" | "thinking" | "speaking";

export type CallEvents = {
  onState(s: CallState): void;
  /** What you are saying, as it is heard. `final` once that stretch of speech is finished. */
  onYou(text: string, final: boolean): void;
  /** Danny's reply as text, as it is written. */
  onDanny(text: string): void;
  onApproval(title: string): void;
  /** Something went wrong but the call carries on (for example, Danny lost his voice for a moment). */
  onNotice(message: string): void;
  /** How loud the microphone is, 0 to about 0.5. */
  onLevel(level: number): void;
  /** The call is over. `message` is set when the reason is worth telling the person. */
  onEnded(reason: string, message?: string): void;
};

export class CallError extends Error {}

export const canCall = () =>
  typeof AudioWorkletNode !== "undefined" && typeof WebSocket !== "undefined" && typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

export class CallClient {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private lock: { release(): Promise<void> } | null = null;
  private muted = false;
  private ready = false;
  private over = false;
  private rate = 24000;
  /** Danny's voice: one continuous stream, so the joins between network pieces can't click (see call-worklet.js). */
  private player: AudioWorkletNode | null = null;

  constructor(private readonly ev: CallEvents) {}

  /** Call this straight from a tap: phones only let a page make sound after one. */
  async start() {
    this.ctx = new AudioContext();
    await this.ctx.resume();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (err) {
      this.cleanup();
      const name = (err as DOMException).name;
      if (name === "NotAllowedError" || name === "SecurityError") throw new CallError("Danny needs the microphone. Allow it for this app in your phone or browser settings.");
      if (name === "NotFoundError") throw new CallError("No microphone found.");
      throw new CallError("Couldn't start the microphone.");
    }
    try {
      await this.ctx.audioWorklet.addModule("/call-worklet.js?v=2");
    } catch {
      this.cleanup();
      throw new CallError("This browser can't take part in a call.");
    }
    const mic = this.ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(this.ctx, "pcm16k");
    // Not connected to the speakers (you would hear yourself), but connected to something so the browser keeps it running.
    const silent = this.ctx.createGain();
    silent.gain.value = 0;
    mic.connect(node).connect(silent).connect(this.ctx.destination);
    node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
      if (this.over) return;
      this.ev.onLevel(this.muted ? 0 : e.data.level);
      if (this.ready && !this.muted && this.ws?.readyState === WebSocket.OPEN) this.ws.send(e.data.pcm);
    };
    void (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock?.request("screen").then((l) => (this.lock = l)).catch(() => {});

    this.ev.onState("connecting");
    const ws = (this.ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1/call`));
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => this.onMessage(e);
    ws.onclose = () => this.finish("dropped", this.ready ? "The call dropped." : "Couldn't connect the call. Try again.");
  }

  private onMessage(e: MessageEvent) {
    if (e.data instanceof ArrayBuffer) return this.play(e.data);
    let m: { type?: string; sampleRate?: number; state?: CallState; text?: string; final?: boolean; title?: string; reason?: string; message?: string };
    try {
      m = JSON.parse(String(e.data));
    } catch {
      return;
    }
    switch (m.type) {
      case "ready":
        this.rate = m.sampleRate ?? 24000;
        if (this.ctx && !this.player) {
          try {
            this.player = new AudioWorkletNode(this.ctx, "pcm-player", { numberOfInputs: 0, outputChannelCount: [1], processorOptions: { rate: this.rate } });
            this.player.connect(this.ctx.destination);
          } catch {
            this.ev.onNotice("Danny's voice couldn't start on this device. Close and reopen the app, then try again.");
          }
        }
        this.ready = true;
        break;
      case "state":
        if (m.state) this.ev.onState(m.state);
        break;
      case "you":
        this.ev.onYou(m.text ?? "", Boolean(m.final));
        break;
      case "danny":
        this.ev.onDanny(m.text ?? "");
        break;
      case "approval":
        this.ev.onApproval(m.title ?? "");
        break;
      case "stop":
        this.stopPlayback();
        break;
      case "error":
        if (m.message) this.ev.onNotice(m.message);
        break;
      case "ended":
        this.finish(m.reason ?? "ended", m.message);
        break;
    }
  }

  /** Hand a piece of Danny's voice to the player, which joins it to the one before it. */
  private play(buf: ArrayBuffer) {
    if (!this.player || this.over || buf.byteLength < 2) return;
    this.player.port.postMessage({ pcm: buf }, [buf]);
  }

  private stopPlayback() {
    this.player?.port.postMessage({ clear: true });
  }

  setMuted(m: boolean) {
    this.muted = m;
  }

  /** Tap to talk over Danny: stop his voice here at once, and tell the server to stop too. */
  interrupt() {
    this.stopPlayback();
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "interrupt" }));
  }

  hangUp() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "end" }));
    this.finish("hung_up");
  }

  private finish(reason: string, message?: string) {
    if (this.over) return;
    this.over = true;
    this.cleanup();
    this.ev.onEnded(reason, message);
  }

  private cleanup() {
    this.stopPlayback();
    this.ws?.close();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.lock?.release().catch(() => {});
    void this.ctx?.close().catch(() => {});
    this.player?.disconnect();
    this.player = null;
    this.ws = null;
    this.stream = null;
    this.ctx = null;
  }
}
