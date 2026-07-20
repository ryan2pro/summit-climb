/**
 * Audio — light WebAudio layer (game.md §3, "visual priority — audio
 * optional layer"). All synthesized, no assets, fail-soft:
 *  - wind loop (filtered noise) whose gain/cutoff scale with altitude
 *  - grab thud, jump whoosh, checkpoint chime, summit fanfare arpeggio,
 *    exhaustion low buzz
 * The context is created lazily on the first user gesture (`resume`).
 */

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private volume: number;

  constructor(volume: number) {
    this.volume = volume;
  }

  /** Create/resume the context — call from a user gesture. */
  resume(): void {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.volume;
        this.master.connect(this.ctx.destination);
        // wind: looping noise → lowpass → gain
        const len = this.ctx.sampleRate * 2;
        const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const data = buf.getChannelData(0);
        let last = 0;
        for (let i = 0; i < len; i++) {
          // brownish noise for a soft wind bed
          last = (last + (Math.random() * 2 - 1) * 0.02) * 0.998;
          data[i] = last * 3.2;
        }
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        this.windFilter = this.ctx.createBiquadFilter();
        this.windFilter.type = 'lowpass';
        this.windFilter.frequency.value = 420;
        this.windGain = this.ctx.createGain();
        this.windGain.gain.value = 0.03;
        src.connect(this.windFilter).connect(this.windGain).connect(this.master);
        src.start();
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      /* audio unavailable — silent */
    }
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** 0 at base camp → 1 at summit: more wind up high. */
  setAltitude(frac: number): void {
    if (!this.ctx || !this.windGain || !this.windFilter) return;
    const t = Math.min(1, Math.max(0, frac));
    this.windGain.gain.setTargetAtTime(0.025 + t * 0.11, this.ctx.currentTime, 0.4);
    this.windFilter.frequency.setTargetAtTime(420 + t * 950, this.ctx.currentTime, 0.4);
  }

  private blip(freq: number, dur: number, type: OscillatorType, gain: number, slideTo?: number): void {
    if (!this.ctx || !this.master) return;
    try {
      const t0 = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t0 + dur);
      g.gain.setValueAtTime(gain, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      osc.connect(g).connect(this.master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    } catch {
      /* noop */
    }
  }

  grab(): void {
    this.blip(190, 0.12, 'triangle', 0.25, 120);
  }
  jump(): void {
    this.blip(280, 0.18, 'sine', 0.16, 520);
  }
  wallJump(): void {
    this.blip(240, 0.2, 'sine', 0.2, 560);
  }
  land(hard: boolean): void {
    this.blip(hard ? 120 : 160, 0.12, 'triangle', hard ? 0.3 : 0.15, 70);
  }
  checkpoint(): void {
    this.blip(660, 0.14, 'sine', 0.22);
    window.setTimeout(() => this.blip(880, 0.22, 'sine', 0.22), 120);
  }
  exhausted(): void {
    this.blip(110, 0.4, 'sawtooth', 0.14, 70);
  }
  summit(): void {
    const notes = [523, 659, 784, 1046];
    notes.forEach((n, i) => window.setTimeout(() => this.blip(n, 0.34, 'triangle', 0.24), i * 130));
  }

  dispose(): void {
    try {
      void this.ctx?.close();
    } catch {
      /* noop */
    }
    this.ctx = null;
    this.master = null;
    this.windGain = null;
    this.windFilter = null;
  }
}
