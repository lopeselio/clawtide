import { randomBytes } from 'node:crypto';
import {
  RULES_VERSION, boardSeed, headZero, nextHead, sealOf, settle, sha256Hex, stateHash, type Opening, type Setup, type Skill, type State,
} from '@clawtide/rules';
import { call, view } from './chain.ts';
import { config } from './config.ts';
import { saveRound, type RoundRecord, type SeatRec } from './store.ts';

// One round's onchain life:
//   1. create_round commits sha256(secret); the contract draws its VRF seed in the next receipt
//   2. we read that draw; the board seed is sha256("clawtide|board|{vrf}|{secret}")
//   3. every 3 s, seal each seat's chunk (one transaction batches whatever is pending)
//   4. at the end, reveal the secret, open every chunk, settle
// Chain calls never hold up play once the board exists: if one fails, the round record says why.

export interface SeatPlan { name: string; kind: 'human' | 'guest' | 'bot'; account?: string; bot?: string }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class ChainRound {
  readonly id = `r-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  /** secret until the round is over; only its hash goes onchain first */
  private readonly secret = randomBytes(16).toString('hex');
  readonly rec: RoundRecord;
  setup: Setup | null = null;
  private onchain = false;
  private pending: string[][] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly seats: SeatPlan[], readonly difficulty: Skill) {
    const rows: SeatRec[] = seats.map((s) => ({ name: s.name, kind: s.kind, account: s.account, bot: s.bot }));
    this.rec = {
      id: this.id, createdAt: Date.now(), seats: rows, difficulty, rules: RULES_VERSION, secretHash: sha256Hex(this.secret),
      chunks: [], seals: [], head: headZero(this.id), sealedOnchain: 0, openedOnchain: 0, settled: false, txs: [], lines: [],
    };
    saveRound(this.rec);
  }

  /** Commits the secret, waits for the contract's VRF draw, and returns the setup the round is played from. */
  async draw(): Promise<Setup> {
    let vrf: string | null = null;
    if (config.chainEnabled) {
      try {
        const r = await call(config.referee, 'create_round', {
          round_id: this.id, secret_hash: this.rec.secretHash,
          seats: this.seats.map((s) => ({ account: s.account ?? null, name: s.name })),
        }, 60);
        this.rec.txs.push({ what: 'create_round + draw_tide', hash: r.tx });
        for (let k = 0; k < 20 && !vrf; k++) {
          const got = await view<{ vrf: string | null } | null>('get_round', { round_id: this.id }).catch(() => null);
          vrf = got?.vrf ?? null;
          if (!vrf) await sleep(700);
        }
        this.onchain = !!vrf;
        if (!vrf) this.rec.error = 'the contract had not drawn the tide in time; this round is played offline';
      } catch (e) {
        this.rec.error = `create_round: ${(e as Error).message.slice(0, 300)}`;
      }
    }
    // offline (CHAIN=0 or the chain failed): a local draw, clearly marked as such
    vrf ??= `local-${randomBytes(16).toString('hex')}`;
    this.rec.vrf = vrf;
    const seed = boardSeed(vrf, this.secret);
    this.setup = { seed, rules: RULES_VERSION, difficulty: this.difficulty, seats: this.seats.map((s) => ({ name: s.name, ...(s.kind === 'bot' ? { bot: this.difficulty } : {}) })) };
    saveRound(this.rec);
    return this.setup;
  }

  get chain(): boolean { return this.onchain; }

  addChunk(openings: Opening[]): void {
    const k = this.rec.chunks.length;
    const seals = openings.map((o, seat) => sealOf(this.id, this.secret, seat, k, o));
    this.rec.chunks.push(openings);
    this.rec.seals.push(seals);
    this.rec.head = nextHead(this.rec.head, k, seals);
    this.pending.push(seals);
    void this.flush();
  }

  flush(): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (!this.pending.length || !this.onchain) return;
      const batch = this.pending.splice(0, this.pending.length);
      const from = this.rec.sealedOnchain;
      try {
        const r = await call(config.referee, 'seal', { round_id: this.id, from_chunk: from, chunks: batch }, 30 + batch.length * 5);
        this.rec.sealedOnchain += batch.length;
        this.rec.txs.push({ what: `seal chunk${batch.length > 1 ? `s ${from}–${from + batch.length - 1}` : ` ${from}`}`, hash: r.tx });
      } catch (e) {
        this.pending.unshift(...batch);
        this.rec.error = `seal: ${(e as Error).message.slice(0, 200)}`;
      }
      saveRound(this.rec);
    });
    return this.queue;
  }

  finish(s: State): { settled: Promise<void> } {
    const finals = s.crabs.map((c) => ({ pearls: c.pearls, clams: c.clams, stings: c.stings }));
    this.rec.secret = this.secret;
    this.rec.boardSeed = this.setup?.seed;
    this.rec.shape = s.board.shape;
    this.rec.endTick = s.tick;
    this.rec.end = s.end;
    this.rec.winner = s.winner;
    this.rec.stateHash = stateHash(s);
    this.rec.expected = settle(this.seats.map((x) => !!x.account), finals);
    saveRound(this.rec);
    const settled = (async () => {
      if (!this.onchain) return;
      await this.flush();
      for (let tries = 0; this.pending.length && tries < 3; tries++) await this.flush();
      try {
        const BATCH = 12;
        for (let from = this.rec.openedOnchain; from < this.rec.chunks.length; from = this.rec.openedOnchain) {
          const chunks = this.rec.chunks.slice(from, from + BATCH);
          const r = await call(config.referee, 'open_chunks', { round_id: this.id, secret: this.secret, from_chunk: from, chunks }, 150);
          this.rec.openedOnchain += chunks.length;
          this.rec.txs.push({ what: `open chunks ${from}–${from + chunks.length - 1}`, hash: r.tx });
          saveRound(this.rec);
        }
        const r = await call(config.referee, 'settle_round', { round_id: this.id }, 100);
        this.rec.txs.push({ what: 'settle_round', hash: r.tx });
        this.rec.settled = true;
        delete this.rec.error;
      } catch (e) {
        this.rec.error = `settle: ${(e as Error).message.slice(0, 300)}`;
      }
      saveRound(this.rec);
    })();
    return { settled };
  }
}
