import { dirTo, neighbours } from './board.ts';
import { int, nextU32, rngFrom, type Rng } from './rng.ts';
import type { View } from './sim.ts';

// The Driftwood Crabs: AI rivals. Each decides one hop at a time from exactly the view a human in
// that seat would get (uncovered tiles, numbers, crabs) and the generator in its own brain, which
// lives inside the round state so a replay makes the same choices. No secret ever reaches it.
//
// Easy: slow, deduces only the obvious, blunders into guesses. Normal: steady, sound deduction,
// hunts a nearby crown. Hard: quick, chains deductions (subset rule), takes the least risky guess,
// and doesn't race for pearls it can't reach first.

export type Skill = 'easy' | 'normal' | 'hard';
/** `rules` picks the pacing table, so rounds settled under older rules still replay exactly. */
export interface Brain { r: Rng; wait: number; rules?: number }

export const newBrain = (seed: string, seat: number, rules = 1): Brain => ({ r: rngFrom(`clawtide|brain|${seed}|${seat}`), wait: 6 + seat * 2, ...(rules > 1 ? { rules } : {}) });

const HIDDEN = -1, URCHIN = -3;
const isNum = (t: number): boolean => t >= 0;

/** Tiles the view proves to be urchins, and buried tiles it proves safe. */
export function deduce(v: View, hard: boolean, passes = 4): { mines: Set<number>; safe: Set<number> } {
  const mines = new Set<number>(), safe = new Set<number>();
  const nb = (i: number): number[] => neighbours(v.w, v.h, i);
  const front = v.tiles.map((t, i) => i).filter((i) => isNum(v.tiles[i]) && nb(i).some((j) => v.tiles[j] === HIDDEN));
  const unknownOf = (i: number): number[] => nb(i).filter((j) => v.tiles[j] === HIDDEN && !mines.has(j) && !safe.has(j));
  const remOf = (i: number): number => v.tiles[i] - nb(i).filter((j) => v.tiles[j] === URCHIN || mines.has(j)).length;
  for (let p = 0; p < passes; p++) {
    let changed = false;
    for (const i of front) {
      const u = unknownOf(i);
      if (!u.length) continue;
      const rem = remOf(i);
      if (rem === 0) { for (const j of u) safe.add(j); changed = true; } else if (rem === u.length) { for (const j of u) mines.add(j); changed = true; }
    }
    if (hard) {
      // subset rule: if A's unknowns sit inside B's, B's extra unknowns hold the difference
      for (const a of front) {
        const ua = unknownOf(a);
        if (!ua.length) continue;
        for (const b of front) {
          if (a === b || Math.abs((a % v.w) - (b % v.w)) > 2 || Math.abs(Math.floor(a / v.w) - Math.floor(b / v.w)) > 2) continue;
          const ub = unknownOf(b);
          if (ub.length <= ua.length || !ua.every((j) => ub.includes(j))) continue;
          const extra = ub.filter((j) => !ua.includes(j));
          const d = remOf(b) - remOf(a);
          if (d === 0) { for (const j of extra) safe.add(j); changed = true; } else if (d === extra.length) { for (const j of extra) mines.add(j); changed = true; }
        }
      }
    }
    if (!changed) break;
  }
  return { mines, safe };
}

/** Risk of a buried tile, in thousandths: the worst share of remaining urchins among its numbered neighbours. */
export function risk(v: View, i: number, mines: Set<number>): number {
  let worst = 0;
  for (const n of neighbours(v.w, v.h, i)) {
    if (!isNum(v.tiles[n])) continue;
    const around = neighbours(v.w, v.h, n);
    const unknown = around.filter((j) => v.tiles[j] === HIDDEN && !mines.has(j)).length;
    const rem = v.tiles[n] - around.filter((j) => v.tiles[j] === URCHIN || mines.has(j)).length;
    if (unknown > 0) worst = Math.max(worst, Math.floor((Math.max(0, rem) * 1000) / unknown));
  }
  return worst;
}

/** Breadth-first over uncovered, passable sand from `from`. Diagonal hops count as one. */
export function reach(v: View, from: number): { dist: number[]; prev: number[] } {
  const dist = new Array(v.tiles.length).fill(-1), prev = new Array(v.tiles.length).fill(-1);
  dist[from] = 0;
  const q = [from];
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    for (const j of neighbours(v.w, v.h, i)) {
      if (dist[j] >= 0 || !isNum(v.tiles[j])) continue;
      dist[j] = dist[i] + 1;
      prev[j] = i;
      q.push(j);
    }
  }
  return { dist, prev };
}

/** The hop direction that starts the shortest uncovered path to `goal` (which may itself be buried). 0 if none. */
export function nextStep(v: View, from: number, goal: number, r = reach(v, from)): number {
  if (goal === from || goal < 0) return 0;
  let end = goal;
  if (r.dist[goal] < 0) {
    // a buried (or crab-occupied) goal: enter it from the nearest reached neighbour
    if (v.tiles[goal] !== HIDDEN) return 0;
    let best = -1;
    for (const j of neighbours(v.w, v.h, goal)) if (r.dist[j] >= 0 && (best < 0 || r.dist[j] < r.dist[best])) best = j;
    if (best < 0) return 0;
    if (best === from) return dirTo(v.w, from, goal);
    end = best;
  }
  let i = end;
  while (r.prev[i] !== from && r.prev[i] >= 0) i = r.prev[i];
  return r.prev[i] === from ? dirTo(v.w, from, i) : 0;
}

// extra ticks of thought before each hop. v1 (frozen): quick. v2: about a person's pace.
const WAITS: Record<number, Record<Skill, [number, number]>> = {
  1: { easy: [5, 12], normal: [3, 7], hard: [1, 4] },
  2: { easy: [9, 18], normal: [6, 12], hard: [3, 7] },
};
const waitOf = (b: Brain, skill: Skill): [number, number] => (WAITS[b.rules ?? 1] ?? WAITS[2])[skill];

/** One AI hop. Mutates only the brain. */
export function decide(v: View, b: Brain, skill: Skill): number {
  if (b.wait > 0) { b.wait--; return 0; }
  const me = v.crabs[v.me];
  if (v.items[me.at] === 3) return 0; // prying
  const hard = skill === 'hard';
  const { mines, safe } = deduce(v, hard, skill === 'easy' ? 1 : 4);
  const r = reach(v, me.at);
  const pick = (goal: number): number => {
    const d = nextStep(v, me.at, goal, r);
    b.wait = int(b.r, waitOf(b, skill)[0], waitOf(b, skill)[1]);
    return d;
  };

  // 1. loot already uncovered (a clam is worth a detour)
  let best = -1, bestScore = 1e9;
  for (let i = 0; i < v.items.length; i++) {
    if (!v.items[i] || r.dist[i] < 0) continue;
    if (hard && v.crabs.some((c, k) => k !== v.me && c.stun === 0 && cheb(v.w, c.at, i) + 1 < r.dist[i])) continue;
    const score = r.dist[i] * 10 - (v.items[i] === 3 ? 30 : 0);
    if (score < bestScore) { bestScore = score; best = i; }
  }
  if (best >= 0 && r.dist[best] > 0) return pick(best);

  // 2. a crowned rival close by: go and pinch a pearl
  if (skill !== 'easy' && v.crown !== null && v.crown !== v.me) {
    const at = v.crabs[v.crown].at;
    if (r.dist[at] > 0 && r.dist[at] <= 4) return pick(at);
  }

  // 3. buried tiles next to reachable sand
  const frontier: number[] = [];
  for (let i = 0; i < v.tiles.length; i++) {
    if (v.tiles[i] !== HIDDEN || mines.has(i)) continue;
    if (neighbours(v.w, v.h, i).some((j) => r.dist[j] >= 0)) frontier.push(i);
  }
  if (!frontier.length) return pick(-1);
  const enter = (i: number): number => Math.min(...neighbours(v.w, v.h, i).filter((j) => r.dist[j] >= 0).map((j) => r.dist[j])) + 1;

  // easy crabs blunder into a random guess now and then
  if (skill === 'easy' && nextU32(b.r) % 100 < 18) return pick(frontier[nextU32(b.r) % frontier.length]);

  const sure = frontier.filter((i) => safe.has(i));
  if (sure.length) return pick(nearest(sure, enter, b.r));

  // 4. a guess: the least risky tile (normal crabs judge risk roughly, in fifths)
  let low = 1e9;
  const score = frontier.map((i) => {
    const k = risk(v, i, mines);
    const s = hard ? k * 4 + enter(i) * 20 : Math.floor(k / 200) * 1000 + enter(i);
    low = Math.min(low, s);
    return s;
  });
  const calm = frontier.filter((_, k) => score[k] === low);
  return pick(nearest(calm, enter, b.r));
}

const cheb = (w: number, a: number, b: number): number => Math.max(Math.abs((a % w) - (b % w)), Math.abs(Math.floor(a / w) - Math.floor(b / w)));

function nearest(tiles: number[], cost: (i: number) => number, r: Rng): number {
  let d = 1e9;
  for (const i of tiles) d = Math.min(d, cost(i));
  const ties = tiles.filter((i) => cost(i) === d);
  return ties[nextU32(r) % ties.length];
}
