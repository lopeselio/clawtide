// Every sound is synthesised in WebAudio: nothing to download.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = (() => { try { return localStorage.getItem('clawtide:muted') === '1'; } catch { return false; } })();

export const isMuted = (): boolean => muted;
export function setMuted(m: boolean): void {
  muted = m;
  try { localStorage.setItem('clawtide:muted', m ? '1' : '0'); } catch { /* fine */ }
  if (master && ctx) master.gain.setTargetAtTime(m ? 0 : 0.8, ctx.currentTime, 0.05);
}

function ac(): AudioContext | null {
  try {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.8;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch { return null; }
}

function noise(c: AudioContext, dur: number): AudioBufferSourceNode {
  const buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * dur)), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const s = c.createBufferSource();
  s.buffer = buf;
  return s;
}

function env(c: AudioContext, peak: number, attack: number, decay: number): GainNode {
  const g = c.createGain();
  const t = c.currentTime;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(master!);
  return g;
}

function tone(freq: number, type: OscillatorType, peak: number, decay: number, slideTo?: number, delay = 0): void {
  const c = ac();
  if (!c || muted) return;
  const o = c.createOscillator();
  o.type = type;
  const t = c.currentTime + delay;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + decay);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  o.connect(g);
  g.connect(master!);
  o.start(t);
  o.stop(t + decay + 0.05);
}

function whoosh(peak: number, from: number, to: number, dur: number): void {
  const c = ac();
  if (!c || muted) return;
  const n = noise(c, dur);
  const f = c.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 1.4;
  f.frequency.setValueAtTime(from, c.currentTime);
  f.frequency.exponentialRampToValueAtTime(to, c.currentTime + dur);
  n.connect(f);
  f.connect(env(c, peak, 0.02, dur));
  n.start();
}

export type Sfx = 'hop' | 'dig' | 'pearl' | 'clam' | 'pry' | 'sting' | 'pinch' | 'pinched' | 'tide' | 'beep' | 'go' | 'win' | 'lose' | 'click' | 'mark' | 'clack' | 'bump';

export function sfx(kind: Sfx, n = 0): void {
  const c = ac();
  if (!c || muted) return;
  switch (kind) {
    case 'hop': tone(420 + (n % 3) * 40, 'triangle', 0.06, 0.07, 620); break;
    case 'dig': whoosh(0.18, 900, 300, 0.12); tone(160, 'square', 0.05, 0.06); break;
    case 'pearl': tone(1320, 'sine', 0.14, 0.18); tone(1760, 'sine', 0.1, 0.25, undefined, 0.07); break;
    case 'clam': [784, 988, 1175, 1568].forEach((f, k) => tone(f, 'triangle', 0.16, 0.35, undefined, k * 0.07)); break;
    case 'pry': tone(220 + n * 12, 'square', 0.04, 0.05); break;
    case 'sting': tone(520, 'sawtooth', 0.2, 0.5, 90); whoosh(0.3, 2400, 400, 0.5); break;
    case 'pinch': tone(1500, 'square', 0.08, 0.06); tone(1900, 'triangle', 0.1, 0.12, undefined, 0.05); break;
    case 'pinched': tone(300, 'square', 0.12, 0.2, 180); break;
    case 'tide': whoosh(0.45, 200, 1400, 1.6); tone(110, 'sine', 0.25, 1.6, 70); break;
    case 'beep': tone(620, 'square', 0.1, 0.12); break;
    case 'go': tone(940, 'square', 0.14, 0.3); break;
    case 'win': [523, 659, 784, 1046, 1318].forEach((f, k) => tone(f, 'triangle', 0.18, 0.5, undefined, k * 0.11)); break;
    case 'lose': [392, 330, 262].forEach((f, k) => tone(f, 'triangle', 0.16, 0.6, undefined, k * 0.16)); break;
    case 'click': tone(1200, 'square', 0.05, 0.04); break;
    case 'mark': tone(880, 'triangle', 0.08, 0.08); tone(660, 'triangle', 0.06, 0.08, undefined, 0.05); break;
    case 'clack': for (let k = 0; k < 4; k++) tone(2200 - k * 120, 'square', 0.07, 0.03, undefined, k * 0.07); break;
    case 'bump': tone(140, 'sine', 0.12, 0.08); break;
  }
}

/** Surf on the shore: filtered noise that swells and recedes. */
export function startSurf(): void {
  const c = ac();
  if (!c || surf) return;
  const g = c.createGain();
  g.gain.value = 0;
  g.connect(master!);
  const n = noise(c, 4); n.loop = true;
  const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 520;
  const lfo = c.createOscillator(); lfo.frequency.value = 0.12;
  const lg = c.createGain(); lg.gain.value = 0.035;
  const base = c.createGain(); base.gain.value = 0.05;
  lfo.connect(lg); lg.connect(base.gain);
  n.connect(f); f.connect(base); base.connect(g);
  [n, lfo].forEach((s) => s.start());
  g.gain.setTargetAtTime(1, c.currentTime, 1.5);
  surf = { stop: () => { g.gain.setTargetAtTime(0, c.currentTime, 0.6); setTimeout(() => { [n, lfo].forEach((s) => { try { s.stop(); } catch { /* done */ } }); }, 2500); surf = null; } };
}
let surf: { stop: () => void } | null = null;
export const stopSurf = (): void => surf?.stop();
export const unlockAudio = (): void => { ac(); };
