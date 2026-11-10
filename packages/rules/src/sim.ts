import { decide, newBrain, type Brain, type Skill } from './bot.ts';
import { CLAM, EMPTY, PEARL, SAND, URCHIN, makeBoard, neighbours, stepTo, type Board, type Shape } from './board.ts';
import { CLAM_PEARLS, CLAM_TICKS, HOP_TICKS, MAX_TICKS, PINCH, PINCH_COOLDOWN, RULES_VERSION, STING_LOSS, STUN_TICKS } from './constants.ts';
import { canonical, sha256Hex } from './hash.ts';

// One sandbar round. The server runs it at TICK_HZ; every crab's only input is a hop direction (0-8).
// Prying a clam happens by standing on it. A replay of the logged hops reproduces the state exactly,
// and every AI crab's hop is decided again from its own view, so a bot can't have been fed secrets.

export interface SeatSetup { name: string; bot?: Skill }
export interface Setup {
  /** the board seed: sha256(vrf seed from the contract | the referee's salt) */
  seed: string;
  rules: number;
  seats: SeatSetup[];
  difficulty?: Skill;
  /** fixed sandbars (the tutorial) skip generation */
  board?: Board;
  shape?: Shape;
}

export interface Crab {
  name: string;
  at: number;
  spawn: number;
  pearls: number;
  clams: number;
  stings: number;
  pinches: number;
  /** ticks until the next hop; ticks left dazed; ticks spent prying the clam underfoot */
  cool: number;
  stun: number;
  pry: number;
  pinchCool: number;
  /** null for a human (until a bot takes over a seat whose player left) */
  bot: Skill | null;
}

export interface State {
  rules: number;
  board: Board;
  /** 1 once anyone has uncovered the tile (shared by everyone) */
  revealed: number[];
  crabs: Crab[];
  brains: (Brain | null)[];
  clamsLeft: number;
  tick: number;
  over: boolean;
  /** 'tide': the last clam was opened; 'time': three minutes ran out */
  end: '' | 'tide' | 'time';
  winner: number | null;
}

export type SimEvent =
  | { k: 'reveal'; tiles: number[] }
  | { k: 'pearl'; c: number; at: number }
  | { k: 'clam'; c: number; at: number }
  | { k: 'sting'; c: number; at: number; lost: number }
  | { k: 'pinch'; c: number; from: number }
  | { k: 'hop'; c: number; from: number; to: number }
  | { k: 'takeover'; c: number }
  | { k: 'tide'; reason: 'tide' | 'time' };

/** A seat's input for one tick: a hop direction 1-8, 0 for none, 9 = an AI crab takes this seat over. */
export type Input = number;
export const TAKEOVER = 9;

export function createState(setup: Setup): State {
  const src = setup.board ?? makeBoard(setup.seed, setup.seats.length, setup.shape);
  const board: Board = { ...src, land: src.land.slice(), content: src.content.slice(), num: src.num.slice(), spawns: src.spawns.slice() };
  const revealed = new Array(board.land.length).fill(0);
  const s: State = {
    rules: setup.rules ?? RULES_VERSION,
    board,
    revealed,
    crabs: setup.seats.map((x, i) => ({
      name: x.name, at: board.spawns[i], spawn: board.spawns[i], pearls: 0, clams: 0, stings: 0, pinches: 0,
      cool: 0, stun: 0, pry: 0, pinchCool: 0, bot: x.bot ?? null,
    })),
    brains: setup.seats.map((x, i) => (x.bot ? newBrain(setup.seed, i) : null)),
    clamsLeft: board.clams,
    tick: 0,
    over: false,
    end: '',
    winner: null,
  };
  for (const sp of board.spawns.slice(0, setup.seats.length)) reveal(s, sp);
  return s;
}

/** Uncovers a tile; an empty tile with no urchins around it uncovers its neighbours too. */
function reveal(s: State, start: number): number[] {
  const { board, revealed } = s;
  const out: number[] = [];
  const q = [start];
  while (q.length) {
    const i = q.pop()!;
    if (revealed[i] || board.land[i] !== SAND) continue;
    // a clam stays a lump in the sand until someone digs right into it
    if (i !== start && board.content[i] === CLAM) continue;
    revealed[i] = 1;
    out.push(i);
    if (board.content[i] !== URCHIN && board.num[i] === 0) for (const j of neighbours(board.w, board.h, i)) if (!revealed[j]) q.push(j);
  }
  return out;
}

/** The seat wearing the crown: the only crab holding the most pearls (none on a tie or at zero). */
export function crownOf(crabs: { pearls: number }[]): number | null {
  let best = -1, who: number | null = null, tie = false;
  crabs.forEach((c, i) => {
    if (c.pearls > best) { best = c.pearls; who = i; tie = false; } else if (c.pearls === best) tie = true;
  });
  return best > 0 && !tie ? who : null;
}

/** Winner: most pearls, then fewest stings, then the lowest seat. The contract applies the same rule. */
export function winnerOf(finals: { pearls: number; stings: number }[]): number | null {
  let w: number | null = null;
  finals.forEach((f, i) => {
    if (w === null) { w = i; return; }
    const b = finals[w];
    if (f.pearls > b.pearls || (f.pearls === b.pearls && f.stings < b.stings)) w = i;
  });
  return w;
}

/** A tile a crab may hop onto: sand that isn't an uncovered urchin. */
export const passable = (s: State, i: number): boolean => i >= 0 && s.board.land[i] === SAND && !(s.revealed[i] && s.board.content[i] === URCHIN);

/**
 * Advances one tick. `inputs[i]` is seat i's wanted hop (ignored for AI seats, which decide here
 * from their own view). Returns the events and, per seat, the input that took effect (or null).
 */
export function step(s: State, inputs: (Input | undefined)[]): { events: SimEvent[]; applied: (Input | null)[] } {
  const events: SimEvent[] = [];
  const applied: (Input | null)[] = s.crabs.map(() => null);
  if (s.over) return { events, applied };
  const n = s.crabs.length;
  const crown = crownOf(s.crabs);
  // who moves first rotates every tick, so no seat always wins a race for the same pearl
  for (let k = 0; k < n; k++) {
    const i = (s.tick + k) % n;
    const c = s.crabs[i];
    if (c.pinchCool > 0) c.pinchCool--;
    if (inputs[i] === TAKEOVER && !c.bot) {
      c.bot = 'normal';
      s.brains[i] = newBrain(`${s.board.spawns.join(',')}|${s.tick}`, i);
      applied[i] = TAKEOVER;
      events.push({ k: 'takeover', c: i });
      continue;
    }
    if (c.stun > 0) { c.stun--; continue; }
    if (c.cool > 0) { c.cool--; continue; }
    const want = c.bot ? decide(viewFor(s, i), s.brains[i]!, c.bot) : (inputs[i] ?? 0);
    if (!(want >= 1 && want <= 8)) continue;
    const to = stepTo(s.board.w, s.board.h, c.at, want);
    if (!passable(s, to)) continue;
    applied[i] = want;
    const from = c.at;
    c.at = to;
    c.cool = HOP_TICKS - 1;
    c.pry = 0;
    events.push({ k: 'hop', c: i, from, to });
    if (!s.revealed[to]) {
      if (s.board.content[to] === URCHIN) {
        s.revealed[to] = 1;
        const lost = Math.min(c.pearls, STING_LOSS);
        c.pearls -= lost;
        c.stings++;
        c.at = c.spawn;
        c.stun = STUN_TICKS;
        events.push({ k: 'reveal', tiles: [to] }, { k: 'sting', c: i, at: to, lost });
        continue;
      }
      events.push({ k: 'reveal', tiles: reveal(s, to) });
    }
    if (s.board.content[to] === PEARL) {
      s.board.content[to] = EMPTY;
      c.pearls++;
      events.push({ k: 'pearl', c: i, at: to });
    }
    // the crown is fair game: land on its wearer to pinch a pearl
    if (crown !== null && crown !== i && s.crabs[crown].at === to && s.crabs[crown].pearls > 0 && c.pinchCool === 0) {
      const p = Math.min(PINCH, s.crabs[crown].pearls);
      s.crabs[crown].pearls -= p;
      c.pearls += p;
      c.pinches++;
      c.pinchCool = PINCH_COOLDOWN;
      events.push({ k: 'pinch', c: i, from: crown });
    }
  }
  // prying: every crab standing still on an uncovered clam works at it
  for (let k = 0; k < n; k++) {
    const i = (s.tick + k) % n;
    const c = s.crabs[i];
    if (c.stun > 0 || !s.revealed[c.at] || s.board.content[c.at] !== CLAM) continue;
    if (++c.pry >= CLAM_TICKS) {
      s.board.content[c.at] = EMPTY;
      c.pearls += CLAM_PEARLS;
      c.clams++;
      c.pry = 0;
      s.clamsLeft--;
      events.push({ k: 'clam', c: i, at: c.at });
      for (const o of s.crabs) if (o !== c && o.at === c.at) o.pry = 0;
    }
  }
  s.tick++;
  if (s.clamsLeft <= 0 || s.tick >= MAX_TICKS) {
    s.over = true;
    s.end = s.clamsLeft <= 0 ? 'tide' : 'time';
    s.winner = winnerOf(s.crabs);
    events.push({ k: 'tide', reason: s.end });
  }
  return { events, applied };
}

// ---------- what one seat may see ----------

/** Per tile: -2 water, -1 still buried, -3 an uncovered urchin, 0-8 the urchins around it. */
export const T_WATER = -2;
export const T_HIDDEN = -1;
export const T_URCHIN = -3;

export interface CrabView { name: string; at: number; pearls: number; clams: number; stings: number; stun: number; cool: number; pry: number; bot: boolean }
export interface View {
  me: number;
  w: number;
  h: number;
  tiles: number[];
  /** what sits on uncovered tiles: 0 nothing, 2 a pearl, 3 a clam */
  items: number[];
  crabs: CrabView[];
  crown: number | null;
  clamsLeft: number;
  tick: number;
}

/** Everything on the sandbar that's been uncovered, plus where every crab stands. Never what's buried. */
export function viewFor(s: State, me: number): View {
  const b = s.board;
  return {
    me,
    w: b.w,
    h: b.h,
    tiles: b.land.map((l, i) => (l !== SAND ? T_WATER : !s.revealed[i] ? T_HIDDEN : b.content[i] === URCHIN ? T_URCHIN : b.num[i])),
    items: b.content.map((c, i) => (s.revealed[i] && (c === PEARL || c === CLAM) ? c : 0)),
    crabs: s.crabs.map((c) => ({ name: c.name, at: c.at, pearls: c.pearls, clams: c.clams, stings: c.stings, stun: c.stun, cool: c.cool, pry: c.pry, bot: !!c.bot })),
    crown: crownOf(s.crabs),
    clamsLeft: s.clamsLeft,
    tick: s.tick,
  };
}

/** Only the events a seat should hear about (everything on the sandbar is public once uncovered). */
export const eventsFor = (_s: State, _me: number, ev: SimEvent[]): SimEvent[] => ev;

export const stateHash = (s: State): string => sha256Hex(canonical(s));

// ---------- replay ----------

export interface LogEntry { t: number; c: number; i: Input }

/**
 * Replays a log from the setup. Bot seats ignore the log and decide again; `onTick` sees what was
 * applied and what the log said, so a verifier can compare them.
 */
export function replay(setup: Setup, log: LogEntry[], onTick?: (s: State, applied: (Input | null)[], logged: (Input | null)[]) => void, endTick?: number): State {
  const s = createState(setup);
  let k = 0;
  while (!s.over && (endTick === undefined || s.tick < endTick)) {
    const logged: (Input | null)[] = s.crabs.map(() => null);
    while (k < log.length && log[k].t === s.tick) { logged[log[k].c] = log[k].i; k++; }
    if (k < log.length && log[k].t < s.tick) throw new Error(`log entry out of order at tick ${log[k].t}`);
    const inputs = logged.map((x) => (x === null ? undefined : x));
    const { applied } = step(s, inputs);
    onTick?.(s, applied, logged);
  }
  return s;
}
