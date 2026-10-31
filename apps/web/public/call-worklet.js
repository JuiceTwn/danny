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
