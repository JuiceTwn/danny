// Runs on the audio thread. Takes the microphone at whatever rate the phone uses (often 48 kHz) and turns it into
// 16 kHz, 16-bit mono audio in tenth-of-a-second pieces, which is what Danny's server expects.
// Each piece also carries how loud it was, so the call screen can show that Danny is hearing you.
class Pcm16k extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000;
    this.pos = 0;
    this.out = new Int16Array(1600);
    this.n = 0;
    this.sum = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (; this.pos < ch.length; this.pos += this.step) {
      const i = Math.floor(this.pos);
      const f = this.pos - i;
      const a = ch[i];
      const b = i + 1 < ch.length ? ch[i + 1] : a;
      const v = Math.max(-1, Math.min(1, a + (b - a) * f));
      this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      this.sum += v * v;
      if (this.n === this.out.length) {
        const level = Math.sqrt(this.sum / this.n);
        this.port.postMessage({ pcm: this.out.buffer.slice(0), level });
        this.n = 0;
        this.sum = 0;
      }
    }
    this.pos -= ch.length;
    return true;
  }
}
registerProcessor("pcm16k", Pcm16k);

// Plays Danny's voice. The server sends it as small pieces of whatever size the network delivered, at 24 kHz, and the phone's speaker runs at
// 48 kHz or 44.1 kHz. Playing each piece as its own sound makes a tiny click at every join (each piece is converted to the speaker's rate on
// its own, and any piece that arrives late leaves a gap), which sounds like crackle. This keeps ONE continuous stream instead: pieces are
// written into a ring buffer, and the speaker reads it smoothly, converting the rate as it goes, so where the pieces join makes no difference.
// It waits for a little audio before it starts (and again after running dry) so a slow network gives a short pause, not a stutter, and it
// fades out and in at those points so a pause never clicks.
class PcmPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const rate = (options.processorOptions && options.processorOptions.rate) || 24000;
    this.step = rate / sampleRate; // input samples consumed per output sample
    this.cap = Math.ceil(rate * 30); // thirty seconds of room
    this.ring = new Float32Array(this.cap);
    this.wp = 0; // samples written, ever
    this.rp = 0; // read position, in samples, fractional
    this.playing = false;
    this.startAfter = Math.round(rate * 0.12); // wait for this much before starting or restarting
    this.last = 0;
    this.fade = 1; // 0 to 1: how much of the signal to let through
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.clear) {
        this.wp = 0;
        this.rp = 0;
        this.playing = false;
        return;
      }
      const i16 = new Int16Array(d.pcm, 0, Math.floor(d.pcm.byteLength / 2));
      for (let i = 0; i < i16.length; i++) this.ring[this.wp++ % this.cap] = i16[i] / 32768;
      // A listener who is far behind (a long stall) gets the latest audio, not a backlog.
      if (this.wp - this.rp > this.cap - 1) this.rp = this.wp - (this.cap - 1);
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    for (let i = 0; i < out.length; i++) {
      const avail = this.wp - this.rp;
      if (!this.playing && avail >= this.startAfter) this.playing = true;
      if (this.playing && avail < 2) this.playing = false; // ran dry
      const target = this.playing ? 1 : 0;
      this.fade += (target - this.fade) * 0.02; // ~1 ms either way
      if (this.playing) {
        const k = Math.floor(this.rp);
        const f = this.rp - k;
        const a = this.ring[k % this.cap];
        const b = this.ring[(k + 1) % this.cap];
        this.last = a + (b - a) * f;
        this.rp += this.step;
      } else {
        this.last *= 0.98;
      }
      out[i] = this.last * this.fade;
    }
    return true;
  }
}
registerProcessor("pcm-player", PcmPlayer);
