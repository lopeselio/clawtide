import { MAX_H, MAX_W, PEARL_PCT, URCHIN_PCT } from './constants.ts';
import { int, nextU32, rngFrom, type Rng } from './rng.ts';

// Sandbars. A board is a W×H grid of water and sand; under the sand lie urchins, loose pearls and
// clams. Every shape is drawn with integer geometry only (no trig), so Node and every browser
// build exactly the same sandbar from the same seed.

export const WATER = 0;
export const SAND = 1;

export const EMPTY = 0;
export const URCHIN = 1;
export const PEARL = 2;
export const CLAM = 3;

export const SHAPES = ['bar', 'atoll', 'twin', 'horseshoe', 'archipelago', 'snake', 'crescent'] as const;
export type Shape = (typeof SHAPES)[number];
export const SHAPE_NAMES: Record<Shape, string> = {
  bar: 'Long Bar', atoll: 'Ring Atoll', twin: 'Twin Bars', horseshoe: 'Horseshoe Reef', archipelago: 'Scattered Shoals', snake: 'Eel Spit', crescent: 'Crescent Moon',
};

/** 1 = north (y-1), then clockwise; 0 = stay */
export const DIRS: readonly (readonly [number, number])[] = [[0, 0], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];

export interface Board {
  shape: Shape;
  w: number;
  h: number;
  /** WATER or SAND per tile */
  land: number[];
  /** EMPTY, URCHIN, PEARL or CLAM per tile */
  content: number[];
  /** urchins among the 8 neighbours */
  num: number[];
  /** where each seat lands (shore tiles, far apart, urchin-free around) */
  spawns: number[];
  clams: number;
}

export const neighbours = (w: number, h: number, i: number): number[] => {
  const x = i % w, y = (i - x) / w;
  const out: number[] = [];
  for (let k = 1; k <= 8; k++) {
    const nx = x + DIRS[k][0], ny = y + DIRS[k][1];
    if (nx >= 0 && ny >= 0 && nx < w && ny < h) out.push(ny * w + nx);
  }
  return out;
};

/** Chebyshev distance between two tiles (hops for a crab on open sand). */
export const hops = (w: number, a: number, b: number): number => Math.max(Math.abs((a % w) - (b % w)), Math.abs(Math.floor(a / w) - Math.floor(b / w)));

/** The tile one hop from `i` in direction `d`, or -1 if that leaves the grid. */
export function stepTo(w: number, h: number, i: number, d: number): number {
  const x = (i % w) + DIRS[d][0], y = Math.floor(i / w) + DIRS[d][1];
  return x >= 0 && y >= 0 && x < w && y < h ? y * w + x : -1;
}
/** The direction from `a` to an adjacent `b` (0 if not adjacent). */
export function dirTo(w: number, a: number, b: number): number {
  const dx = (b % w) - (a % w), dy = Math.floor(b / w) - Math.floor(a / w);
  for (let k = 1; k <= 8; k++) if (DIRS[k][0] === dx && DIRS[k][1] === dy) return k;
  return 0;
}

// ---------- shapes ----------

type Grid = number[];
const inEllipse = (x: number, y: number, cx: number, cy: number, rx: number, ry: number): boolean =>
  (x - cx) * (x - cx) * ry * ry + (y - cy) * (y - cy) * rx * rx <= rx * rx * ry * ry;

function fill(w: number, h: number, f: (x: number, y: number) => boolean): Grid {
  const g: Grid = new Array(w * h).fill(WATER);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) if (f(x, y)) g[y * w + x] = SAND;
  return g;
}

/** A sandy causeway of width 2 from (ax,ay) to (bx,by): along x first, then y. */
function causeway(g: Grid, w: number, h: number, ax: number, ay: number, bx: number, by: number): void {
  const put = (x: number, y: number): void => { if (x > 0 && y > 0 && x < w - 1 && y < h - 1) g[y * w + x] = SAND; };
  const sx = ax <= bx ? 1 : -1;
  for (let x = ax; x !== bx + sx; x += sx) { put(x, ay); put(x, ay + 1); }
  const sy = ay <= by ? 1 : -1;
  for (let y = ay; y !== by + sy; y += sy) { put(bx, y); put(bx + 1, y); }
}

/** Ragged edges: each shore tile may be nibbled away or a water tile next to sand may silt up. */
function ragged(g: Grid, w: number, h: number, r: Rng, pct: number): Grid {
  const out = g.slice();
  for (let i = 0; i < g.length; i++) {
    const x = i % w, y = (i - x) / w;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) continue;
    const n = neighbours(w, h, i).filter((j) => g[j] === SAND).length;
    if (g[i] === SAND && n <= 5 && nextU32(r) % 100 < pct) out[i] = WATER;
    else if (g[i] === WATER && n >= 4 && nextU32(r) % 100 < pct) out[i] = SAND;
  }
  return out;
}

function draw(shape: Shape, w: number, h: number, r: Rng): Grid {
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const rx = (w - 3) / 2, ry = (h - 3) / 2;
  switch (shape) {
    case 'bar':
      return fill(w, h, (x, y) => inEllipse(x, y, cx, cy, rx, ry));
    case 'atoll': {
      const ix = Math.max(2, rx - 3), iy = Math.max(1.5, ry - 3);
      return fill(w, h, (x, y) => inEllipse(x, y, cx, cy, rx, ry) && !inEllipse(x, y, cx, cy, ix, iy));
    }
    case 'crescent': {
      const off = Math.floor(rx * 0.6);
      return fill(w, h, (x, y) => inEllipse(x, y, cx, cy, rx, ry) && !inEllipse(x, y, cx + off, cy - 1, rx - 1, ry - 1));
    }
    case 'horseshoe': {
      const ix = Math.max(2, rx - 3), iy = Math.max(1.5, ry - 3);
      const gap = int(r, 0, 1);
      return fill(w, h, (x, y) => inEllipse(x, y, cx, cy, rx, ry) && !inEllipse(x, y, cx, cy, ix, iy) && !(gap ? y > cy && Math.abs(x - cx) < ix * 0.7 : y < cy && Math.abs(x - cx) < ix * 0.7));
    }
    case 'twin': {
      const a = Math.floor(w * 0.28), b = Math.ceil(w * 0.72) - 1, rr = Math.floor(w * 0.22);
      const ya = int(r, Math.floor(cy) - 2, Math.floor(cy)), yb = int(r, Math.floor(cy), Math.floor(cy) + 2);
      const g = fill(w, h, (x, y) => inEllipse(x, y, a, ya, rr, ry - 1) || inEllipse(x, y, b, yb, rr, ry - 1));
      causeway(g, w, h, a, ya, b, Math.floor((ya + yb) / 2));
      return g;
    }
    case 'archipelago': {
      // four or five small shoals joined by narrow spits, each to the one before it
      const n = int(r, 4, 5);
      const centres: [number, number][] = [];
      for (let k = 0; k < n; k++) {
        const col = Math.floor(((k + 0.5) * (w - 4)) / n) + 2;
        centres.push([col, int(r, 3, h - 4)]);
      }
      const g = fill(w, h, (x, y) => centres.some(([px, py]) => inEllipse(x, y, px, py, 2.6, 2.3)));
      for (let k = 1; k < n; k++) causeway(g, w, h, centres[k - 1][0], centres[k - 1][1], centres[k][0], centres[k][1]);
      return g;
    }
    case 'snake': {
      // a band three tiles thick that wanders left to right
      const g: Grid = new Array(w * h).fill(WATER);
      let y = Math.floor(cy), last = y;
      for (let x = 1; x < w - 1; x++) {
        if (x % 2 === 0) y = Math.max(2, Math.min(h - 3, y + int(r, -1, 1) * 2));
        for (let yy = Math.min(y, last) - 2; yy <= Math.max(y, last) + 2; yy++) if (yy > 0 && yy < h - 1) g[yy * w + x] = SAND;
        last = y;
      }
      return g;
    }
  }
}

/** Keeps only the largest connected stretch of sand (8-connected, as crabs hop). */
function largest(g: Grid, w: number, h: number): Grid {
  const comp = new Array(g.length).fill(-1);
  let best = -1, bestSize = 0, id = 0;
  for (let s = 0; s < g.length; s++) {
    if (g[s] !== SAND || comp[s] >= 0) continue;
    const q = [s];
    comp[s] = id;
    let size = 0;
    while (q.length) {
      const i = q.pop()!;
      size++;
      for (const j of neighbours(w, h, i)) if (g[j] === SAND && comp[j] < 0) { comp[j] = id; q.push(j); }
    }
    if (size > bestSize) { bestSize = size; best = id; }
    id++;
  }
  return g.map((v, i) => (v === SAND && comp[i] === best ? SAND : WATER));
}

const isShore = (land: Grid, w: number, h: number, i: number): boolean => {
  const x = i % w, y = (i - x) / w;
  return land[i] === SAND && (x === 0 || y === 0 || x === w - 1 || y === h - 1 || neighbours(w, h, i).some((j) => land[j] === WATER));
};

/** Board numbers for a given content layout. */
export function numbers(w: number, h: number, content: number[]): number[] {
  return content.map((_, i) => neighbours(w, h, i).filter((j) => content[j] === URCHIN).length);
}

/** Builds the sandbar for a board seed and a number of seats. Same seed, same sandbar, everywhere. */
export function makeBoard(seed: string, seats: number, shapeHint?: Shape): Board {
  const r = rngFrom(`clawtide|board|${seed}`);
  const shape: Shape = shapeHint ?? SHAPES[nextU32(r) % SHAPES.length];
  const w = shape === 'snake' ? MAX_W : int(r, MAX_W - 4, MAX_W);
  const h = shape === 'snake' ? int(r, 12, 14) : int(r, MAX_H - 3, MAX_H);
  const plain = draw(shape, w, h, r);
  // thick shapes get ragged shores; thin ones (rings, the eel) would fall apart
  let land = largest(shape === 'bar' || shape === 'twin' || shape === 'crescent' ? ragged(plain, w, h, r, 14) : plain, w, h);
  if (land.filter((v) => v === SAND).length < 90) land = largest(plain, w, h);

  // seats land on shore tiles as far from each other as the sandbar allows
  const shore = land.map((_, i) => i).filter((i) => isShore(land, w, h, i) && neighbours(w, h, i).filter((j) => land[j] === SAND).length >= 3);
  const spawns: number[] = [shore[nextU32(r) % shore.length]];
  while (spawns.length < seats) {
    let pick = -1, far = -1;
    for (const i of shore) {
      const d = Math.min(...spawns.map((s) => hops(w, s, i)));
      if (d > far) { far = d; pick = i; }
    }
    spawns.push(pick);
  }
  const safe = new Set<number>();
  for (const s of spawns) { safe.add(s); for (const j of neighbours(w, h, s)) safe.add(j); }

  const content = new Array(w * h).fill(EMPTY);
  const sand = land.map((_, i) => i).filter((i) => land[i] === SAND);
  const draw1 = (pool: number[]): number => { const k = nextU32(r) % pool.length; const v = pool[k]; pool[k] = pool[pool.length - 1]; pool.pop(); return v; };

  const open = sand.filter((i) => !safe.has(i));
  const urchins = Math.floor((sand.length * URCHIN_PCT) / 100);
  for (let k = 0; k < urchins && open.length; k++) content[draw1(open)] = URCHIN;
  // clams sit away from the landing spots
  let clamPool = open.filter((i) => spawns.every((s) => hops(w, s, i) >= 5));
  if (clamPool.length < 8) clamPool = open.filter((i) => spawns.every((s) => hops(w, s, i) >= 3));
  const clams = Math.max(4, Math.min(8, Math.floor(sand.length / 30)));
  let placed = 0;
  for (; placed < clams && clamPool.length; placed++) {
    const i = draw1(clamPool);
    content[i] = CLAM;
    const at = open.indexOf(i);
    if (at >= 0) { open[at] = open[open.length - 1]; open.pop(); }
  }
  const pearlPool = sand.filter((i) => content[i] === EMPTY && !spawns.includes(i));
  const pearls = Math.floor((pearlPool.length * PEARL_PCT) / 100);
  for (let k = 0; k < pearls && pearlPool.length; k++) content[draw1(pearlPool)] = PEARL;

  return { shape, w, h, land, content, num: numbers(w, h, content), spawns, clams: placed };
}
