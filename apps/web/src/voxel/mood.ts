import * as THREE from 'three';

// Each sandbar shape gets its own time of day: the sun's colour and angle, the sky's fill light,
// the sea's three depth colours and the haze at the horizon. All of them keep the sand warm and
// the numbers readable; a new sandbar blends from the last mood over a second or so.

export interface Mood {
  sun: number; sunI: number; sunDir: [number, number, number];
  sky: number; ground: number; hemiI: number;
  deep: number; mid: number; shallow: number; foam: number; haze: number;
}

const NOON: Mood = { sun: 0xfff3dc, sunI: 1.90, sunDir: [-0.45, 0.8, 0.4], sky: 0xe4f6ff, ground: 0x2c7590, hemiI: 1.75, deep: 0x0c5b86, mid: 0x1694b8, shallow: 0x4fd9cf, foam: 0xf4feff, haze: 0x9fd8ea };

export const MOODS: Record<string, Mood> = {
  // Long Bar: bright midday
  bar: NOON,
  // Ring Atoll: golden hour, a long warm light from the west
  atoll: { sun: 0xffc98a, sunI: 2.15, sunDir: [-0.75, 0.5, 0.25], sky: 0xffe6c4, ground: 0x2f5f80, hemiI: 1.55, deep: 0x154f7c, mid: 0x2a88a8, shallow: 0x63d6c3, foam: 0xfff6e6, haze: 0xb4cfc8 },
  // Twin Bars: cool clear morning
  twin: { sun: 0xfff4ea, sunI: 1.75, sunDir: [0.5, 0.75, 0.45], sky: 0xd9edff, ground: 0x2a6a92, hemiI: 1.80, deep: 0x145f92, mid: 0x2299c4, shallow: 0x6ae2e0, foam: 0xf6fdff, haze: 0xa9d6ef },
  // Horseshoe Reef: warm afternoon
  horseshoe: { sun: 0xffe2b3, sunI: 2.00, sunDir: [0.6, 0.65, 0.3], sky: 0xfff0d6, ground: 0x2d6c86, hemiI: 1.65, deep: 0x0f5a80, mid: 0x1b97b2, shallow: 0x58dcc6, foam: 0xfffaf0, haze: 0xa8d8dc },
  // Scattered Shoals: tropical, the clearest water
  archipelago: { sun: 0xfff6e0, sunI: 1.95, sunDir: [-0.35, 0.85, 0.35], sky: 0xe8fbff, ground: 0x1f7c8c, hemiI: 1.80, deep: 0x0a5f84, mid: 0x12a6bd, shallow: 0x46ecd2, foam: 0xf6ffff, haze: 0x7fd6df },
  // Eel Spit: dusk, pink sky and violet water
  snake: { sun: 0xffa98f, sunI: 1.85, sunDir: [0.8, 0.45, 0.2], sky: 0xffd0dc, ground: 0x384c7c, hemiI: 1.60, deep: 0x223d72, mid: 0x30709e, shallow: 0x67bfc8, foam: 0xfff0f4, haze: 0xbfa6c6 },
  // Crescent Moon: sunset gold over deep blue
  crescent: { sun: 0xffb877, sunI: 2.05, sunDir: [-0.8, 0.45, 0.3], sky: 0xd8d2ff, ground: 0x2b3f72, hemiI: 1.60, deep: 0x1a3d6e, mid: 0x2a6f9c, shallow: 0x5fc4c9, foam: 0xfff3e2, haze: 0xa9b0d2 },
  // the practice sandbar and the raids' rockpools
  tutorial: NOON,
  rockpool: { sun: 0xfff1dc, sunI: 1.85, sunDir: [-0.4, 0.8, 0.45], sky: 0xe0f2ff, ground: 0x2a5f78, hemiI: 1.70, deep: 0x0e4a66, mid: 0x1b7f9a, shallow: 0x48c2bd, foam: 0xf2fbff, haze: 0x7fbdd0 },
};

export const moodFor = (key?: string): Mood => MOODS[key ?? ''] ?? NOON;

/** The live, blended mood: colours and the sun direction ease towards a target each frame. */
export class MoodState {
  sun = new THREE.Color(); sky = new THREE.Color(); ground = new THREE.Color();
  deep = new THREE.Color(); mid = new THREE.Color(); shallow = new THREE.Color(); foam = new THREE.Color(); haze = new THREE.Color();
  sunDir = new THREE.Vector3();
  sunI = 0; hemiI = 0;
  private goal: Mood;
  private tmp = new THREE.Color();
  constructor(m: Mood) { this.goal = m; this.snap(); }
  set(m: Mood): void { this.goal = m; }
  snap(): void { this.step(1); }
  step(k: number): void {
    const g = this.goal;
    const ease = (c: THREE.Color, v: number): void => { c.lerp(this.tmp.set(v), k); };
    ease(this.sun, g.sun); ease(this.sky, g.sky); ease(this.ground, g.ground);
    ease(this.deep, g.deep); ease(this.mid, g.mid); ease(this.shallow, g.shallow); ease(this.foam, g.foam); ease(this.haze, g.haze);
    this.sunDir.lerp(new THREE.Vector3(...g.sunDir).normalize(), k).normalize();
    this.sunI += (g.sunI - this.sunI) * k;
    this.hemiI += (g.hemiI - this.hemiI) * k;
  }
}
