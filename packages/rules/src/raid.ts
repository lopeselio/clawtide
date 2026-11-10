import { DIRS, neighbours, stepTo } from './board.ts';
import { POOL, POOL_ENTRY, POOL_ROCKS, POOL_URCHINS, RAID_ENERGY, RAID_STEP, RAID_STING } from './constants.ts';
import { sha256Hex } from './hash.ts';
import { int, nextU32, rngFrom } from './rng.ts';

// Rockpools. Every crab keeps a 9×9 rockpool: a pearl cache, rocks anyone can see, and urchins
// buried in the sand. Rivals raid it asynchronously: they wade in at the bottom with an energy
// gauge (1 per hop, 12 per urchin, which also flings them back to the entry). Numbers show only on
// tiles the raider has stepped on: no flood-fill, every hop is a decision. Reach the cache to
// steal a share of the owner's pearls.
//
// A layout is 81 characters: '.' sand, 'u' urchin, 'r' rock, 'c' the cache. Its hash (with the
// owner's salt) is committed onchain; raids are replayed from the layout and the logged hops.

export const POOL_TILES = POOL * POOL;
export const poolHash = (layout: string, salt: string): string => sha256Hex(`clawtide|pool|${layout}|${salt}`);

const ok = (l: string, i: number): boolean => i >= 0 && l[i] !== 'r';

/** Tiles reachable from the entry without stepping on an urchin or a rock. */
function cleanReach(l: string): Set<number> {
  const seen = new Set([POOL_ENTRY]);
  const q = [POOL_ENTRY];
  while (q.length) {
    const i = q.pop()!;
    for (const j of neighbours(POOL, POOL, i)) if (!seen.has(j) && l[j] !== 'r' && l[j] !== 'u') { seen.add(j); q.push(j); }
  }
  return seen;
}

/** Why a layout isn't allowed, or null if it is. */
export function layoutError(l: string): string | null {
  if (typeof l !== 'string' || l.length !== POOL_TILES || !/^[.urc]+$/.test(l)) return 'a rockpool is 81 tiles of . u r c';
  const count = (ch: string): number => l.split('').filter((x) => x === ch).length;
  if (count('c') !== 1) return 'place exactly one pearl cache';
  if (count('u') > POOL_URCHINS) return `at most ${POOL_URCHINS} urchins`;
  if (count('r') > POOL_ROCKS) return `at most ${POOL_ROCKS} rocks`;
  if (l[POOL_ENTRY] !== '.') return 'leave the entry (bottom middle) as open sand';
  const c = l.indexOf('c');
  if (Math.floor(c / POOL) > POOL - 4) return 'the cache must sit at least three rows up from the entry';
  if (!cleanReach(l).has(c)) return 'there must be at least one urchin-free path from the entry to the cache';
  return null;
}

/** The rockpool an AI crab keeps (deterministic per crab and version). */
export function botPool(label: string, version = 1): string {
  const r = rngFrom(`clawtide|botpool|${label}|${version}`);
  for (let tries = 0; ; tries++) {
    const t = new Array(POOL_TILES).fill('.');
    t[int(r, 0, 2) * POOL + int(r, 0, POOL - 1)] = 'c';
    for (let k = 0; k < POOL_ROCKS; k++) { const i = nextU32(r) % POOL_TILES; if (t[i] === '.' && i !== POOL_ENTRY) t[i] = 'r'; }
    const urchins = POOL_URCHINS - (tries > 20 ? 4 : 0);
    for (let k = 0; k < urchins; k++) { const i = nextU32(r) % POOL_TILES; if (t[i] === '.' && i !== POOL_ENTRY) t[i] = 'u'; }
    const l = t.join('');
    if (!layoutError(l)) return l;
  }
}

export interface RaidState {
  layout: string;
  at: number;
  energy: number;
  /** tiles the raider has stood on (they show their numbers) */
  stepped: number[];
  /** urchins the raider has trodden on */
  stung: number[];
  hops: number;
  stings: number;
  over: boolean;
  won: boolean;
}

export function newRaid(layout: string): RaidState {
  const stepped = new Array(POOL_TILES).fill(0);
  stepped[POOL_ENTRY] = 1;
  return { layout, at: POOL_ENTRY, energy: RAID_ENERGY, stepped, stung: new Array(POOL_TILES).fill(0), hops: 0, stings: 0, over: false, won: false };
}

/** One hop (1-8). Returns false if it couldn't be made (a rock, an uncovered urchin, the edge). */
export function raidStep(s: RaidState, dir: number): boolean {
  if (s.over || !(dir >= 1 && dir <= 8)) return false;
  const to = stepTo(POOL, POOL, s.at, dir);
  if (!ok(s.layout, to) || s.stung[to]) return false;
  s.hops++;
  s.energy -= RAID_STEP;
  if (s.layout[to] === 'u') {
    s.stung[to] = 1;
    s.stings++;
    s.energy -= RAID_STING;
    s.at = POOL_ENTRY;
  } else {
    s.at = to;
    s.stepped[to] = 1;
    if (s.layout[to] === 'c') { s.won = true; s.over = true; }
  }
  if (s.energy <= 0 && !s.won) { s.energy = Math.max(0, s.energy); s.over = true; }
  return true;
}

export const RT_HIDDEN = -1, RT_ROCK = -4, RT_CACHE = -5, RT_URCHIN = -3;
export interface RaidView { at: number; energy: number; tiles: number[]; hops: number; stings: number; over: boolean; won: boolean }

/** What the raider sees: rocks and the cache, urchins they hit, numbers where they've stood. */
export function raidView(s: RaidState): RaidView {
  const l = s.layout;
  const tiles = l.split('').map((ch, i) => {
    if (ch === 'r') return RT_ROCK;
    if (ch === 'c') return RT_CACHE;
    if (s.stung[i]) return RT_URCHIN;
    if (s.stepped[i] || s.over) return neighbours(POOL, POOL, i).filter((j) => l[j] === 'u').length;
    return RT_HIDDEN;
  });
  // once the raid is over the whole pool is shown
  if (s.over) l.split('').forEach((ch, i) => { if (ch === 'u') tiles[i] = RT_URCHIN; });
  return { at: s.at, energy: s.energy, tiles, hops: s.hops, stings: s.stings, over: s.over, won: s.won };
}

export const encodeRaid = (dirs: number[]): string => dirs.join('');
/** Replays a raid's logged hops (one digit each) against a revealed layout. */
export function replayRaid(layout: string, hops: string): RaidState {
  const s = newRaid(layout);
  for (const ch of hops) if (!raidStep(s, Number(ch))) throw new Error(`hop ${ch} at ${s.at} is not possible`);
  return s;
}
export { DIRS };
