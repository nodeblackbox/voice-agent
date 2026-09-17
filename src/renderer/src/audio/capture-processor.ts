// AudioWorklet processor source. Kept as a string and loaded through a Blob URL so the same code
// runs identically under the Vite dev server and in the packaged build (worklet modules can't be
// bundled through the normal import graph).
export const CAPTURE_PROCESSOR_NAME = 'va-capture'

export const CAPTURE_PROCESSOR_SOURCE = `
const TARGET_RATE = 16000;
const FRAME = 512;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(FRAME);
    this.fill = 0;
    this.ratio = sampleRate / TARGET_RATE;
    this.phase = 0;
    this.prev = 0;
  }

  pushSample(s) {
    const v = s < -1 ? -1 : s > 1 ? 1 : s;
    this.buf[this.fill++] = v < 0 ? v * 0x8000 : v * 0x7fff;
    if (this.fill === FRAME) {
      const out = this.buf.buffer.slice(0);
      this.port.postMessage(out, [out]);
      this.fill = 0;
    }
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.ratio === 1) {
      for (let i = 0; i < ch.length; i++) this.pushSample(ch[i]);
      return true;
    }
    // linear resample from the context rate down to 16 kHz
    let pos = this.phase;
    const n = ch.length;
    while (pos < n) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i === 0 ? this.prev : ch[i - 1];
      const b = ch[i] !== undefined ? ch[i] : ch[n - 1];
      this.pushSample(a + (b - a) * frac);
      pos += this.ratio;
    }
    this.phase = pos - n;
    this.prev = ch[n - 1];
    return true;
  }
}

registerProcessor('${CAPTURE_PROCESSOR_NAME}', CaptureProcessor);
`
