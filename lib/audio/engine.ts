import { PERCUSSIVE, type VoiceKind } from "@/lib/layout/types";
import { noteToFreq } from "@/lib/music/theory";

/**
 * Web Audio engine.
 *
 * Latency contract: `noteOn` is called synchronously from the vision frame
 * callback and must schedule sound at `ctx.currentTime` with no awaits, no
 * allocation of large buffers, and no React involvement. Everything expensive
 * (noise buffers, the reverb impulse) is built once at init.
 *
 * We deliberately do NOT use a lookahead scheduler for live hits. Lookahead is
 * for sequenced playback; for a live instrument it is pure added latency.
 */

export interface NoteOnOptions {
  /** 0..1, derived from hand speed at the moment of the hit. */
  velocity: number;
  /** Scientific pitch notation. Ignored by percussive voices. */
  note?: string;
  /** Per-zone gain trim. */
  gain?: number;
  /**
   * 0..1 timbre control, taken from where in the zone the hit landed.
   * Maps to brightness on most voices.
   */
  tone?: number;
}

/** Handle returned by sustaining voices so the caller can release them. */
export interface VoiceHandle {
  release(): void;
  /** Continuous modulation while held, 0..1. */
  modulate(value: number): void;
}

const NOISE_SECONDS = 2;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private dry: GainNode | null = null;
  private wet: GainNode | null = null;
  private reverb: ConvolverNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private noise: AudioBuffer | null = null;
  private analyser: AnalyserNode | null = null;

  /** Live handles for `hold`/`pinch` zones, keyed by "zoneId:handIndex". */
  private sustained = new Map<string, VoiceHandle>();

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === "running";
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  /**
   * Total output latency in ms, as reported by the browser. This is the audio
   * half of the end-to-end budget; the camera contributes the other half.
   */
  get outputLatencyMs(): number {
    if (!this.ctx) return 0;
    // outputLatency is unimplemented on some browsers; baseLatency always exists.
    const output = (this.ctx as AudioContext).outputLatency ?? 0;
    return (this.ctx.baseLatency + output) * 1000;
  }

  /** Must be called from a user gesture (click) to satisfy autoplay policy. */
  async init(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === "suspended") await this.ctx.resume();
      return;
    }

    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.ctx = ctx;

    this.limiter = ctx.createDynamicsCompressor();
    // Fast, transparent brickwall so stacked drum hits never clip the output.
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.7;

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;

    this.dry = ctx.createGain();
    this.dry.gain.value = 1;

    this.wet = ctx.createGain();
    this.wet.gain.value = 0.25;

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.buildImpulse(ctx, 1.9, 2.6);

    // voices -> master -> { dry, wet -> reverb } -> limiter -> analyser -> out
    this.master.connect(this.dry);
    this.master.connect(this.wet);
    this.wet.connect(this.reverb);
    this.dry.connect(this.limiter);
    this.reverb.connect(this.limiter);
    this.limiter.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    this.noise = this.buildNoise(ctx);

    if (ctx.state === "suspended") await ctx.resume();
  }

  setMasterGain(value: number) {
    if (this.master) this.master.gain.value = Math.max(0, Math.min(1.5, value));
  }

  /** Reverb send amount, 0..1. */
  setSpace(value: number) {
    if (this.wet) this.wet.gain.value = Math.max(0, Math.min(1, value));
  }

  getLevel(): number {
    if (!this.analyser) return 0;
    const buf = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i];
    return sum / (buf.length * 255);
  }

  // ---------------------------------------------------------------- triggers

  /**
   * Fire a one-shot voice. Returns immediately; the sound is scheduled at the
   * context's current time so it plays as soon as the output buffer allows.
   */
  noteOn(kind: VoiceKind, opts: NoteOnOptions): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || !this.noise) return;

    const t = ctx.currentTime;
    const vel = clamp01(opts.velocity);
    const trim = opts.gain ?? 1;
    const tone = opts.tone ?? 0.5;
    const freq =
      opts.note && !PERCUSSIVE.has(kind) ? noteToFreq(opts.note) : 220;

    switch (kind) {
      case "kick":
        return this.playKick(ctx, master, t, vel * trim);
      case "snare":
        return this.playSnare(ctx, master, t, vel * trim);
      case "rim":
        return this.playRim(ctx, master, t, vel * trim);
      case "clap":
        return this.playClap(ctx, master, t, vel * trim);
      case "hat":
        return this.playHat(ctx, master, t, vel * trim, 0.045);
      case "openhat":
        return this.playHat(ctx, master, t, vel * trim, 0.32);
      case "ride":
        return this.playMetal(ctx, master, t, vel * trim, 0.9, 5200);
      case "crash":
        return this.playMetal(ctx, master, t, vel * trim, 2.2, 3200);
      case "tom":
        return this.playTom(ctx, master, t, vel * trim, 180 - tone * 90);
      case "keys":
        return this.playKeys(ctx, master, t, vel * trim, freq, tone);
      case "bell":
        return this.playBell(ctx, master, t, vel * trim, freq);
      case "pluck":
        return this.playPluck(ctx, master, t, vel * trim, freq, tone);
      case "bass":
        return this.playBass(ctx, master, t, vel * trim, freq);
      case "lead":
        return this.playLead(ctx, master, t, vel * trim, freq, tone);
      case "pad":
        // A pad struck rather than held gets a short swell.
        return this.playKeys(ctx, master, t, vel * trim * 0.7, freq, tone);
    }
  }

  /**
   * Start a sustaining voice. `key` identifies the holder (zone + hand) so the
   * same finger re-entering a zone does not stack voices.
   */
  holdOn(key: string, kind: VoiceKind, opts: NoteOnOptions): void {
    if (this.sustained.has(key)) return;
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    const freq = opts.note ? noteToFreq(opts.note) : 220;
    const vel = clamp01(opts.velocity) * (opts.gain ?? 1);
    const handle =
      kind === "pad"
        ? this.startPad(ctx, master, freq, vel)
        : this.startDrone(ctx, master, freq, vel, kind);
    this.sustained.set(key, handle);
  }

  holdModulate(key: string, value: number): void {
    this.sustained.get(key)?.modulate(clamp01(value));
  }

  holdOff(key: string): void {
    const handle = this.sustained.get(key);
    if (!handle) return;
    this.sustained.delete(key);
    handle.release();
  }

  /** Release every sustaining voice — used on layout change and on stop. */
  allNotesOff(): void {
    for (const handle of this.sustained.values()) handle.release();
    this.sustained.clear();
  }

  async dispose(): Promise<void> {
    this.allNotesOff();
    await this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }

  // ------------------------------------------------------------------ voices

  private playKick(ctx: AudioContext, out: GainNode, t: number, v: number) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    // Pitch envelope is what makes a kick read as a kick rather than a thud.
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(44, t + 0.09);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(v, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(t + 0.45);

    // Click transient: without this the kick loses definition on small speakers.
    const click = ctx.createOscillator();
    const clickGain = ctx.createGain();
    click.type = "square";
    click.frequency.value = 900;
    clickGain.gain.setValueAtTime(v * 0.12, t);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
    click.connect(clickGain).connect(out);
    click.start(t);
    click.stop(t + 0.03);
  }

  private playSnare(ctx: AudioContext, out: GainNode, t: number, v: number) {
    const noise = this.noiseSource(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1400;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(v * 0.8, t);
    nGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.19);
    noise.connect(hp).connect(nGain).connect(out);
    this.startNoise(noise, t);
    noise.stop(t + 0.2);

    // Two detuned body tones give the drum a pitch without sounding like a tom.
    for (const [f, amp] of [
      [185, 0.5],
      [278, 0.3],
    ] as const) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = f;
      g.gain.setValueAtTime(v * amp, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
      osc.connect(g).connect(out);
      osc.start(t);
      osc.stop(t + 0.12);
    }
  }

  private playRim(ctx: AudioContext, out: GainNode, t: number, v: number) {
    const osc = ctx.createOscillator();
    const bp = ctx.createBiquadFilter();
    const g = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = 1700;
    bp.type = "bandpass";
    bp.frequency.value = 2400;
    bp.Q.value = 6;
    g.gain.setValueAtTime(v * 0.6, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    osc.connect(bp).connect(g).connect(out);
    osc.start(t);
    osc.stop(t + 0.06);
  }

  private playClap(ctx: AudioContext, out: GainNode, t: number, v: number) {
    // Three offset noise bursts + a tail: the classic 909-style clap.
    const offsets = [0, 0.011, 0.022];
    for (const off of offsets) {
      const noise = this.noiseSource(ctx);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1100;
      bp.Q.value = 1.2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(v * 0.55, t + off);
      g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.035);
      noise.connect(bp).connect(g).connect(out);
      this.startNoise(noise, t + off);
      noise.stop(t + off + 0.04);
    }
    const tail = this.noiseSource(ctx);
    const tbp = ctx.createBiquadFilter();
    tbp.type = "bandpass";
    tbp.frequency.value = 1300;
    tbp.Q.value = 1;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(v * 0.35, t + 0.03);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    tail.connect(tbp).connect(tg).connect(out);
    this.startNoise(tail, t + 0.03);
    tail.stop(t + 0.23);
  }

  private playHat(
    ctx: AudioContext,
    out: GainNode,
    t: number,
    v: number,
    decay: number,
  ) {
    const noise = this.noiseSource(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 8200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(v * 0.45, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    noise.connect(hp).connect(g).connect(out);
    this.startNoise(noise, t);
    noise.stop(t + decay + 0.02);
  }

  private playMetal(
    ctx: AudioContext,
    out: GainNode,
    t: number,
    v: number,
    decay: number,
    cutoff: number,
  ) {
    const noise = this.noiseSource(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = cutoff;
    const peak = ctx.createBiquadFilter();
    peak.type = "peaking";
    peak.frequency.value = cutoff * 1.4;
    peak.gain.value = 8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(v * 0.4, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    noise.connect(hp).connect(peak).connect(g).connect(out);
    this.startNoise(noise, t);
    noise.stop(t + decay + 0.05);
  }

  private playTom(
    ctx: AudioContext,
    out: GainNode,
    t: number,
    v: number,
    base: number,
  ) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(base, t);
    osc.frequency.exponentialRampToValueAtTime(base * 0.55, t + 0.22);
    g.gain.setValueAtTime(v * 0.85, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.33);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + 0.35);
  }

  private playKeys(
    ctx: AudioContext,
    out: GainNode,
    t: number,
    v: number,
    freq: number,
    tone: number,
  ) {
    // Two-operator FM: a Rhodes-ish bell tone whose index tracks velocity, so
    // playing harder gets brighter rather than just louder.
    const carrier = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const modGain = ctx.createGain();
    const amp = ctx.createGain();

    carrier.type = "sine";
    carrier.frequency.value = freq;
    mod.type = "sine";
    mod.frequency.value = freq * 2;

    const index = freq * (0.6 + v * 1.6 + tone * 0.8);
    modGain.gain.setValueAtTime(index, t);
    modGain.gain.exponentialRampToValueAtTime(index * 0.05 + 0.001, t + 0.35);

    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(v * 0.5, t + 0.006);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);

    mod.connect(modGain).connect(carrier.frequency);
    carrier.connect(amp).connect(out);
    mod.start(t);
    carrier.start(t);
    mod.stop(t + 1.7);
    carrier.stop(t + 1.7);
  }

  private playBell(
    ctx: AudioContext,
    out: GainNode,
    t: number,
    v: number,
    freq: number,
  ) {
    // Inharmonic partials -> metallic. Ratios are the classic tubular-bell set.
    const ratios = [1, 2.76, 5.4, 8.93];
    for (let i = 0; i < ratios.length; i++) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq * ratios[i];
      const amp = (v * 0.32) / (i + 1);
      const decay = 2.4 / (i * 0.6 + 1);
      g.gain.setValueAtTime(amp, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      osc.connect(g).connect(out);
      osc.start(t);
      osc.stop(t + decay + 0.05);
    }
  }

  private playPluck(
    ctx: AudioContext,
    out: GainNode,
    t: number,
    v: number,
    freq: number,
    tone: number,
  ) {
    // Karplus-Strong: a noise burst circulating through a delay line tuned to
    // the note period, damped by a lowpass. Cheap and genuinely string-like.
    const period = 1 / Math.max(20, freq);
    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = period;

    const feedback = ctx.createGain();
    feedback.gain.value = 0.86 + tone * 0.1; // longer sustain when struck high

    const damper = ctx.createBiquadFilter();
    damper.type = "lowpass";
    damper.frequency.value = 1800 + tone * 5200 + v * 2000;

    const burst = this.noiseSource(ctx);
    const burstGain = ctx.createGain();
    burstGain.gain.setValueAtTime(v * 0.7, t);
    burstGain.gain.exponentialRampToValueAtTime(0.0001, t + period * 3);

    const outGain = ctx.createGain();
    outGain.gain.setValueAtTime(0.9, t);
    outGain.gain.setValueAtTime(0.9, t + 1.6);
    outGain.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);

    burst.connect(burstGain).connect(delay);
    delay.connect(damper).connect(feedback).connect(delay);
    delay.connect(outGain).connect(out);

    this.startNoise(burst, t);
    burst.stop(t + period * 4);
    // Break the feedback loop so the nodes become collectable.
    feedback.gain.setValueAtTime(feedback.gain.value, t + 1.8);
    feedback.gain.linearRampToValueAtTime(0, t + 2.2);
  }

  private playBass(
    ctx: AudioContext,
    out: GainNode,
    t: number,
    v: number,
    freq: number,
  ) {
    const osc = ctx.createOscillator();
    const sub = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const amp = ctx.createGain();

    osc.type = "sawtooth";
    osc.frequency.value = freq;
    sub.type = "sine";
    sub.frequency.value = freq / 2;

    filter.type = "lowpass";
    filter.Q.value = 6;
    // Filter envelope: the "pluck" of a synth bass.
    filter.frequency.setValueAtTime(180 + v * 2600, t);
    filter.frequency.exponentialRampToValueAtTime(160, t + 0.35);

    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(v * 0.45, t + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);

    osc.connect(filter);
    sub.connect(filter);
    filter.connect(amp).connect(out);
    osc.start(t);
    sub.start(t);
    osc.stop(t + 0.75);
    sub.stop(t + 0.75);
  }

  private playLead(
    ctx: AudioContext,
    out: GainNode,
    t: number,
    v: number,
    freq: number,
    tone: number,
  ) {
    const a = ctx.createOscillator();
    const b = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const amp = ctx.createGain();

    a.type = "sawtooth";
    b.type = "sawtooth";
    a.frequency.value = freq;
    b.frequency.value = freq;
    b.detune.value = 9; // slight detune = width

    filter.type = "lowpass";
    filter.Q.value = 3;
    filter.frequency.setValueAtTime(600 + tone * 4000 + v * 2500, t);
    filter.frequency.exponentialRampToValueAtTime(500, t + 0.9);

    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(v * 0.3, t + 0.01);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);

    a.connect(filter);
    b.connect(filter);
    filter.connect(amp).connect(out);
    a.start(t);
    b.start(t);
    a.stop(t + 1.15);
    b.stop(t + 1.15);
  }

  // -------------------------------------------------------- sustaining voices

  private startPad(
    ctx: AudioContext,
    out: GainNode,
    freq: number,
    v: number,
  ): VoiceHandle {
    const t = ctx.currentTime;
    const oscs: OscillatorNode[] = [];
    const filter = ctx.createBiquadFilter();
    const amp = ctx.createGain();

    filter.type = "lowpass";
    filter.Q.value = 1.5;
    filter.frequency.value = 900;

    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(v * 0.22, t + 0.35);

    for (const detune of [-7, 0, 7]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = freq;
      osc.detune.value = detune;
      osc.connect(filter);
      osc.start(t);
      oscs.push(osc);
    }
    filter.connect(amp).connect(out);

    return {
      modulate(value) {
        // Hand height opens the filter — the pad "breathes" as you lift.
        const target = 400 + value * 5200;
        filter.frequency.setTargetAtTime(target, ctx.currentTime, 0.06);
      },
      release() {
        const now = ctx.currentTime;
        amp.gain.cancelScheduledValues(now);
        amp.gain.setValueAtTime(amp.gain.value, now);
        amp.gain.linearRampToValueAtTime(0, now + 0.45);
        for (const osc of oscs) osc.stop(now + 0.5);
      },
    };
  }

  private startDrone(
    ctx: AudioContext,
    out: GainNode,
    freq: number,
    v: number,
    kind: VoiceKind,
  ): VoiceHandle {
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const amp = ctx.createGain();

    osc.type = kind === "bass" ? "sawtooth" : "triangle";
    osc.frequency.value = freq;
    filter.type = "lowpass";
    filter.frequency.value = 2200;
    filter.Q.value = 2;

    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(v * 0.3, t + 0.03);

    osc.connect(filter).connect(amp).connect(out);
    osc.start(t);

    return {
      modulate(value) {
        filter.frequency.setTargetAtTime(
          500 + value * 5000,
          ctx.currentTime,
          0.05,
        );
      },
      release() {
        const now = ctx.currentTime;
        amp.gain.cancelScheduledValues(now);
        amp.gain.setValueAtTime(amp.gain.value, now);
        amp.gain.linearRampToValueAtTime(0, now + 0.12);
        osc.stop(now + 0.15);
      },
    };
  }

  // ------------------------------------------------------------------ assets

  private noiseSource(ctx: AudioContext): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    return src;
  }

  /**
   * Start a noise source at a random offset into the buffer. Without this,
   * every hat hit replays the identical sample window and the kit sounds
   * machine-gunned rather than played.
   */
  private startNoise(src: AudioBufferSourceNode, when: number): void {
    src.start(when, Math.random() * (NOISE_SECONDS - 0.5));
  }

  private buildNoise(ctx: AudioContext): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * NOISE_SECONDS);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Procedural impulse response — avoids shipping an audio asset. */
  private buildImpulse(
    ctx: AudioContext,
    seconds: number,
    decay: number,
  ): AudioBuffer {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // Short pre-delay of silence gives the reverb a sense of room size.
        const preDelay = i < rate * 0.012 ? 0 : 1;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * preDelay;
      }
    }
    return buf;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
