import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  CHUNK, MAX_SEATS, MAX_TICKS, Recorder, SHAPE_NAMES, TAKEOVER, TICK_HZ, createState, eventsFor, nextStep, step, viewFor, type Input, type SimEvent, type Skill, type State,
} from '@clawtide/rules';
import { AGENTS, accountOf, taunt, type AgentDef } from './agents.ts';
import { view } from './chain.ts';
import { config, explorerTx, hasKey } from './config.ts';
import { ChainRound, type SeatPlan } from './round.ts';

// Rooms. The server runs each sandbar at 10 ticks a second and sends every seat its view (what's
// been uncovered, never what's buried). Players send a hop direction or a goal tile; the server
// walks them there one hop per tick over uncovered sand. Every 30 ticks the chunk is sealed onchain.

type Phase = 'lobby' | 'drawing' | 'countdown' | 'playing' | 'results';

interface Member {
  ws: WebSocket | null;
  name: string;
  account: string | null;
  ready: boolean;
  bot: AgentDef | null;
  /** a one-shot hop, or a tile to walk to */
  want: number;
  goal: number;
  sent: number;
  left: boolean;
}

const rooms = new Map<string, Room>();
const COUNTDOWN_MS = 3000;
export const asDifficulty = (d: unknown): Skill => (d === 'easy' || d === 'hard' ? d : 'normal');
const send = (ws: WebSocket | null, msg: unknown): void => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
/** The order unnamed AI crabs join in: a gentle mix. */
const FILL_ORDER = ['kelpie', 'coral', 'barnacle', 'skitter', 'pincer'];

let crownCache: { at: number; account: string | null } = { at: 0, account: null };
async function crownHolder(): Promise<string | null> {
  if (!config.chainEnabled) return null;
  if (Date.now() - crownCache.at < 30_000) return crownCache.account;
  const c = await view<{ account: string } | null>('get_crown', {}).catch(() => null);
  crownCache = { at: Date.now(), account: c?.account ?? null };
  return crownCache.account;
}

function newCode(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    const c = Array.from(randomBytes(4), (b) => A[b % A.length]).join('');
    if (!rooms.has(c)) return c;
  }
}

export class Room {
  readonly code = newCode();
  phase: Phase = 'lobby';
  members: Member[] = [];
  difficulty: Skill = 'normal';
  /** quick-play rooms (you and AI crabs): the next sandbar rises as soon as you're ready */
  quick = false;
  sandbars = 0;
  private state: State | null = null;
  private round: ChainRound | null = null;
  private recorder: Recorder | null = null;
  private timer: NodeJS.Timeout | null = null;
  private evBuf: SimEvent[] = [];
  private cleanup: NodeJS.Timeout | null = null;

  constructor() { rooms.set(this.code, this); }

  static get(c: string): Room | undefined { return rooms.get(c.toUpperCase().trim()); }
  static count(): number { return rooms.size; }

  get hostIdx(): number { return this.members.findIndex((m) => !m.bot && m.ws); }
  seatOf(ws: WebSocket): number { return this.members.findIndex((m) => m.ws === ws); }

  join(ws: WebSocket, name: string, account: string | null): void {
    if (this.phase !== 'lobby' && this.phase !== 'results') throw new Error('that sandbar is already being dug; wait for the tide');
    if (this.members.length >= MAX_SEATS) {
      // a human can take an AI crab's seat
      const b = this.members.findIndex((m) => m.bot);
      if (b < 0) throw new Error('the room is full');
      this.members.splice(b, 1);
    }
    if (account && this.members.some((m) => m.account === account)) throw new Error('you are already in this room');
    this.members.push({ ws, name: name || 'Crab', account, ready: false, bot: null, want: 0, goal: -1, sent: 0, left: false });
    if (this.phase === 'results') this.toLobby();
    this.broadcastRoom();
  }

  addBot(by: WebSocket | null, label?: string): void {
    if (this.phase !== 'lobby' || (by && this.seatOf(by) !== this.hostIdx) || this.members.length >= MAX_SEATS) return;
    const used = new Set(this.members.map((m) => m.bot?.label));
    const a = AGENTS.find((x) => x.label === label && !used.has(x.label))
      ?? FILL_ORDER.map((l) => AGENTS.find((x) => x.label === l)).find((x) => x && !used.has(x.label));
    if (!a) return;
    this.members.push({ ws: null, name: a.name, account: null, ready: true, bot: a, want: 0, goal: -1, sent: 0, left: false });
    this.broadcastRoom();
  }

  setDifficulty(by: WebSocket | null, d: unknown): void {
    if (this.phase !== 'lobby' || (by && this.seatOf(by) !== this.hostIdx)) return;
    this.difficulty = asDifficulty(d);
    this.broadcastRoom();
  }

  kick(by: WebSocket, seat: number): void {
    if (this.phase !== 'lobby' || this.seatOf(by) !== this.hostIdx || seat === this.hostIdx) return;
    const m = this.members[seat];
    if (!m) return;
    send(m.ws, { t: 'kicked' });
    this.members.splice(seat, 1);
    this.broadcastRoom();
  }

  setReady(ws: WebSocket, ready: boolean): void {
    const i = this.seatOf(ws);
    if (i < 0) return;
    if (this.phase === 'results') this.toLobby();
    if (this.phase !== 'lobby') return;
    this.members[i].ready = ready;
    this.broadcastRoom();
    // one human alone may dig against AI crabs; a sandbar needs at least two crabs
    if (this.members.length >= 2 && this.members.every((m) => m.ready)) void this.start();
  }

  private toLobby(): void {
    if (this.cleanup) clearTimeout(this.cleanup);
    this.phase = 'lobby';
    this.members = this.members.filter((m) => m.bot || m.ws);
    for (const m of this.members) { m.ready = !!m.bot; m.want = 0; m.goal = -1; m.left = false; }
    this.state = null; this.round = null;
  }

  again(ws: WebSocket): void {
    if (this.phase !== 'results' || this.seatOf(ws) < 0) return;
    this.toLobby();
    this.broadcastRoom();
  }

  leave(ws: WebSocket): void {
    const i = this.seatOf(ws);
    if (i < 0) return;
    const m = this.members[i];
    if (this.phase === 'lobby' || this.phase === 'results') this.members.splice(i, 1);
    else { m.ws = null; m.left = true; }
    if (!this.members.some((x) => x.ws)) {
      if (this.phase !== 'playing' && this.phase !== 'countdown' && this.phase !== 'drawing') { this.stop(); rooms.delete(this.code); }
      return;
    }
    this.broadcastRoom();
  }

  /** A one-shot hop (1-8) from the keyboard or the d-pad. */
  hop(ws: WebSocket, dir: unknown): void {
    const i = this.seatOf(ws);
    if (i < 0 || this.phase !== 'playing' || typeof dir !== 'number' || !(dir >= 1 && dir <= 8)) return;
    const m = this.members[i];
    if (++m.sent > 8) return;
    m.want = Math.floor(dir);
    m.goal = -1;
  }

  /** Walk to a tile (tap or click): one hop per tick over uncovered sand, the last one may dig. */
  go(ws: WebSocket, tile: unknown): void {
    const i = this.seatOf(ws);
    if (i < 0 || this.phase !== 'playing' || !this.state || typeof tile !== 'number') return;
    const m = this.members[i];
    if (++m.sent > 8) return;
    m.goal = tile >= 0 && tile < this.state.board.land.length ? Math.floor(tile) : -1;
    m.want = 0;
  }

  emote(ws: WebSocket): void {
    const i = this.seatOf(ws);
    if (i < 0 || this.phase !== 'playing') return;
    const m = this.members[i];
    if (++m.sent > 8) return;
    this.members.forEach((x) => send(x.ws, { t: 'emote', seat: i }));
  }

  private broadcastRoom(): void {
    const seats = this.members.map((m) => ({ name: m.name, kind: m.bot ? 'bot' : 'human', ready: m.ready, signedIn: !!m.account, here: !!m.ws || !!m.bot }));
    this.members.forEach((m, i) => send(m.ws, {
      t: 'room', code: this.code, phase: this.phase, seats, you: i, host: i === this.hostIdx, difficulty: this.difficulty, quick: this.quick, sandbars: this.sandbars,
      bots: AGENTS.map((a) => ({ label: a.label, name: a.name })),
    }));
  }

  private async start(): Promise<void> {
    if (this.phase !== 'lobby') return;
    this.phase = 'drawing';
    this.broadcastRoom();
    const plans: SeatPlan[] = this.members.map((m) => (m.bot
      ? { name: m.name, kind: 'bot', bot: m.bot.label, account: config.chainEnabled && hasKey(accountOf(m.bot)) ? accountOf(m.bot) : undefined }
      : { name: m.name, kind: m.account ? 'human' : 'guest', account: m.account ?? undefined }));
    const round = new ChainRound(plans, this.difficulty);
    this.round = round;
    const crown = await crownHolder();
    this.members.forEach((m) => send(m.ws, { t: 'drawing', roundId: round.id, secretHash: round.rec.secretHash, chain: config.chainEnabled }));
    const setup = await round.draw();
    if (this.round !== round) return;
    this.state = createState(setup);
    this.recorder = new Recorder(this.members.length);
    this.phase = 'countdown';
    this.sandbars++;
    const b = this.state.board;
    const startsAt = Date.now() + COUNTDOWN_MS;
    const seats = plans.map((p) => ({ name: p.name, kind: p.kind, account: p.account ?? null, crowned: !!crown && p.account === crown }));
    this.members.forEach((m, i) => send(m.ws, {
      t: 'start', you: i, roundId: round.id, startsAt, seats, difficulty: this.difficulty, secretHash: round.rec.secretHash, vrf: round.rec.vrf, onchain: round.chain,
      w: b.w, h: b.h, land: b.land, shape: b.shape, shapeName: SHAPE_NAMES[b.shape], clams: b.clams, maxTicks: MAX_TICKS, tickHz: TICK_HZ,
      txs: round.rec.txs.map((x) => ({ ...x, url: explorerTx(x.hash) })), v: viewFor(this.state!, i),
    }));
    this.broadcastRoom();
    const bots = this.members.filter((m) => m.bot).map((m) => m.bot!);
    if (bots.length) {
      const pickB = bots[round.rec.secretHash.charCodeAt(0) % bots.length];
      void taunt(pickB, this.members.filter((m) => m.bot !== pickB).map((m) => m.name), round.rec.secretHash.charCodeAt(1)).then((line) => {
        round.rec.lines.push(line);
        this.members.forEach((m) => send(m.ws, { t: 'line', who: line.who, text: line.text, signed: !!line.signature }));
      });
    }
    setTimeout(() => this.play(), Math.max(0, startsAt - Date.now()));
  }

  private play(): void {
    if (!this.state || !this.round) return;
    this.phase = 'playing';
    this.broadcastRoom();
    let next = Date.now();
    const tick = (): void => {
      const s = this.state!;
      const inputs: (Input | undefined)[] = this.members.map((m, i) => {
        m.sent = 0;
        const c = s.crabs[i];
        if (c.bot) return undefined;
        if (m.left) { m.left = false; return TAKEOVER; }
        if (c.stun > 0 || c.cool > 0) return undefined;
        if (m.want) { const w = m.want; m.want = 0; return w; }
        if (m.goal >= 0) {
          if (m.goal === c.at) { m.goal = -1; return undefined; }
          const d = nextStep(viewFor(s, i), c.at, m.goal);
          if (!d) { m.goal = -1; return undefined; }
          return d;
        }
        return undefined;
      });
      const t = s.tick;
      const { events, applied } = step(s, inputs);
      this.recorder!.add(t, applied);
      // a sting ends the walk; so does reaching a buried goal
      for (const e of events) if (e.k === 'sting') this.members[e.c].goal = -1;
      this.evBuf.push(...events);
      if (s.tick % CHUNK === 0 || s.over) this.round!.addChunk(this.recorder!.close(s));
      this.snapshot();
      if (s.over) { this.stop(); this.finish(); return; }
      next += 1000 / TICK_HZ;
      this.timer = setTimeout(tick, Math.max(0, next - Date.now()));
    };
    tick();
  }

  private snapshot(): void {
    const s = this.state!;
    const ev = this.evBuf;
    this.evBuf = [];
    const txs = this.round ? this.round.rec.sealedOnchain : 0;
    this.members.forEach((m, i) => { if (m.ws) send(m.ws, { t: 'snap', v: viewFor(s, i), ev: eventsFor(s, i, ev), sealed: txs }); });
  }

  private finish(): void {
    if (!this.state || !this.round) return;
    this.phase = 'results';
    const s = this.state;
    const round = this.round;
    const { settled } = round.finish(s);
    const msg = (): unknown => ({
      t: 'results', roundId: round.id, winner: s.winner, end: s.end, endTick: s.tick, difficulty: this.difficulty, shapeName: SHAPE_NAMES[s.board.shape],
      seats: s.crabs.map((c, i) => ({ name: c.name, pearls: c.pearls, clams: c.clams, stings: c.stings, pinches: c.pinches, kind: round.rec.seats[i].kind, account: round.rec.seats[i].account ?? null })),
      expected: round.rec.expected, chain: round.chain, settled: round.rec.settled, error: round.rec.error ?? null,
      board: { content: s.board.content, num: s.board.num },
      txs: round.rec.txs.map((x) => ({ ...x, url: explorerTx(x.hash) })),
    });
    this.broadcastRoom();
    this.members.forEach((m) => send(m.ws, msg()));
    void settled.then(() => { if (this.round === round) this.members.forEach((m) => send(m.ws, msg())); });
    this.cleanup = setTimeout(() => { if (this.phase === 'results') rooms.delete(this.code); }, 15 * 60_000);
    if (!this.members.some((m) => m.ws)) rooms.delete(this.code);
  }

  private stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }
}
