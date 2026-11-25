// The voice changer (docs/phone_recording.md, "Voice"): an AudioWorklet that runs the same in the live chain (mic ->
// the recorded video) and offline (OfflineAudioContext in voice.js: replay, editor, render).
// Method: TD-PSOLA. A pitch tracker (YIN on a 12 kHz copy) finds the voice's period T. Grains two periods long are
// cut at marks one period apart (so every grain starts at the same point of the wave), and laid down again at T / pitch
// apart: closer = higher voice, further = lower. Reading each grain faster or slower (formant factor) moves the
// "size" of the voice (the formants) on its own, so the voice is not just sped up. Robot = a fixed spacing, whatever
// the real pitch: a flat voice. Unvoiced sounds (s, sh, breath) use short time-locked grains.
// Settings come in processorOptions.settings and later as port messages: {on, pitch (semitones), formant (semitones),
// robot, robotHz, D}. D = the delay in samples (voice.js latencyFor): output sample n is input around n - D.
// Off = the input passes straight through (no delay).
// agc (live only): a slow automatic level on the output, so the live video sounds the same on any phone mic (the mic
// is opened without the browser's auto gain). Offline the level is set in voice.js polish() instead.

const DEC = 4;               // pitch tracker works on a 4x decimated copy (12 kHz at 48 kHz)
const N = 1 << 15, M = N - 1; // ring buffers (0.68 s at 48 kHz)

class EliranVoice extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sr = sampleRate;
    this.inp = new Float32Array(N); this.out = new Float32Array(N); this.ws = new Float32Array(N);
    this.nIn = 0; this.nOut = 0; this.next = 0; this.mark = null;
    // pitch tracker
    this.lp = 0; this.acc = 0; this.accN = 0;
    this.dr = new Float32Array(2048); this.nd = 0;            // decimated ring
    this.minLag = Math.floor(sr / DEC / 500); this.maxLag = Math.ceil(sr / DEC / 75);
    this.W = Math.ceil(sr / DEC / 60);                          // window: one period of 60 Hz
    this.hop = 512; this.sinceHop = 0;
    this.hist = [];                                             // [{c (input index), T, voiced}] newest last
    this.Tu = sr / 200;                                         // spacing for unvoiced grains (5 ms)
    this.lpA = 1 - Math.exp(-2 * Math.PI * 1500 / sr);
    this.d = new Float32Array(this.maxLag + 2);
    this.ms = 0; this.gain = 1;                                 // agc state
    this.msA = 1 - Math.exp(-1 / (0.3 * sr)); this.gA = 1 - Math.exp(-1 / (1.5 * sr));
    this.set(options?.processorOptions?.settings || { on: false });
    this.port.onmessage = (e) => this.set(e.data);
  }

  set(s) {
    const was = this.s?.on;
    this.s = { on: !!s.on, P: 2 ** ((s.pitch || 0) / 12), F: 2 ** ((s.formant || 0) / 12), robot: !!s.robot,
               robotHz: s.robotHz || 120, D: Math.max(0, Math.round(s.D || 0)), agc: !!s.agc };
    if (this.s.on && !was) { this.out.fill(0); this.ws.fill(0); this.next = this.nOut; this.mark = null; }
  }

  // YIN on the newest decimated window -> {T (input samples), voiced}
  detect() {
    const { dr, W, minLag, maxLag, d } = this, end = this.nd, len = W + maxLag;
    if (end < len) return { T: this.Tu, voiced: false };
    const base = end - len;
    const at = (i) => dr[(base + i) & 2047];
    let energy = 0;
    for (let j = 0; j < len; j++) { const v = at(j); energy += v * v; }
    if (energy / len < 1e-6) return { T: this.Tu, voiced: false }; // quieter than -60 dBFS
    d[0] = 1;
    let run = 0, best = -1;
    for (let tau = 1; tau <= maxLag; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) { const x = at(j) - at(j + tau); s += x * x; }
      run += s;
      d[tau] = run > 0 ? s * tau / run : 1;
    }
    for (let tau = minLag; tau < maxLag; tau++) {
      if (d[tau] < 0.18) { while (tau + 1 < maxLag && d[tau + 1] < d[tau]) tau++; best = tau; break; }
    }
    if (best < 0) return { T: this.Tu, voiced: false };
    const a = d[best - 1], b = d[best], c = d[best + 1], den = a - 2 * b + c;
    const frac = den > 0 ? 0.5 * (a - c) / den : 0;
    return { T: (best + Math.max(-0.5, Math.min(0.5, frac))) * DEC, voiced: true };
  }

  // The period at input time u: the analysis whose window centre is nearest.
  periodAt(u) {
    const h = this.hist;
    if (!h.length) return { T: this.Tu, voiced: false };
    let best = h[h.length - 1];
    for (let i = h.length - 1; i >= 0; i--) { if (Math.abs(h[i].c - u) < Math.abs(best.c - u)) best = h[i]; if (h[i].c < u - 4000) break; }
    return best;
  }

  grain() {
    const { P, F, robot, robotHz, D } = this.s, sr = sampleRate;
    const s = this.next, u = s - D;
    const p = this.periodAt(u);
    let T, spacing, c;
    if (p.voiced) {
      T = p.T;
      if (this.mark == null || this.mark < u - 2 * T || this.mark > u) this.mark = u;
      while (this.mark + T <= u) this.mark += T;
      c = this.mark;
      spacing = robot ? sr / robotHz : T / P;
    } else {
      T = this.Tu; this.mark = null; c = u; spacing = this.Tu;
    }
    const half = Math.max(16, Math.round(Math.max(T / F, spacing)));
    const { inp, out, ws } = this, limit = this.nIn - 1;
    for (let k = -half; k < half; k++) {
      const w = 0.5 + 0.5 * Math.cos(Math.PI * k / half);
      const x = c + k * F;
      let v = 0;
      if (x >= 0 && x < limit) { const i = Math.floor(x), f = x - i; v = inp[i & M] * (1 - f) + inp[(i + 1) & M] * f; }
      const o = (s + k) & M;
      out[o] += w * v; ws[o] += w;
    }
    this.next = s + Math.max(8, spacing);
    return half;
  }

  process(inputs, outputs) {
    const x = inputs[0]?.[0], y = outputs[0][0], n = y.length;
    const { inp } = this;
    for (let i = 0; i < n; i++) {
      const v = x ? x[i] : 0;
      inp[(this.nIn + i) & M] = v;
      this.lp += this.lpA * (v - this.lp);
      this.acc += this.lp;
      if (++this.accN === DEC) { this.dr[this.nd++ & 2047] = this.acc / DEC; this.acc = 0; this.accN = 0; }
    }
    this.nIn += n;
    if (!this.s.on) {
      if (x) y.set(x); else y.fill(0);
      this.nOut += n; this.next = this.nOut;
      if (this.s.agc) this.level(y);
      return true;
    }
    this.sinceHop += n;
    if (this.sinceHop >= this.hop) {
      this.sinceHop = 0;
      const r = this.detect();
      r.c = this.nIn - (this.W + this.maxLag) * DEC / 2;
      this.hist.push(r);
      if (this.hist.length > 64) this.hist.shift();
    }
    const end = this.nOut + n;
    let guard = 0;
    while (guard++ < 64) {
      // look one grain ahead: place the grain at `next` once its first sample is due
      const p = this.periodAt(this.next - this.s.D);
      const half = Math.max(16, Math.round(Math.max((p.voiced ? p.T : this.Tu) / this.s.F, p.voiced ? (this.s.robot ? sampleRate / this.s.robotHz : p.T / this.s.P) : this.Tu)));
      if (this.next - half > end) break;
      this.grain();
    }
    const { out, ws } = this;
    for (let i = 0; i < n; i++) {
      const o = (this.nOut + i) & M, w = ws[o];
      y[i] = w > 1e-4 ? out[o] / Math.max(w, 0.75) : 0;
      out[o] = 0; ws[o] = 0;
    }
    this.nOut = end;
    if (this.s.agc) this.level(y);
    return true;
  }

  // agc: speech RMS (300 ms) -> gain toward -18 dBFS, changing over ~1.5 s, only while there is sound (above -50 dBFS)
  level(y) {
    for (let i = 0; i < y.length; i++) {
      const v = y[i];
      this.ms += this.msA * (v * v - this.ms);
      const lv = Math.sqrt(this.ms);
      if (lv > 0.003) {
        const want = Math.max(0.5, Math.min(10, 0.126 / lv));
        this.gain += this.gA * (want - this.gain);
      }
      y[i] = v * this.gain;
    }
  }
}
registerProcessor("eliran-voice", EliranVoice);
