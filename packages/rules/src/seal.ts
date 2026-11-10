import { sha256Hex } from './hash.ts';
import type { Input, LogEntry, State } from './sim.ts';

// Sealed logs. Every chunk (30 ticks, 3 s) each seat's hops and end-of-chunk standing are hashed
// with a salt only the referee's secret can produce; the referee posts the seals and the contract
// folds them into one chain head. At the end the secret and the chunks are opened and the contract
// re-folds them. contracts/clawtide builds exactly the same strings (shared test vector in both suites).

/** What one seat did in one chunk: its hops (`tick:dir;…`) and where it stood when the chunk closed. */
export interface Opening { inputs: string; at: number; pearls: number; clams: number; stings: number }

export const saltOf = (secret: string, seat: number, chunk: number): string => sha256Hex(`clawtide|salt|${secret}|${seat}|${chunk}`);

export const sealPreimage = (round: string, seat: number, chunk: number, salt: string, o: Opening): string =>
  `clawtide|seal|${round}|${seat}|${chunk}|${salt}|${o.inputs}|${o.at},${o.pearls},${o.clams},${o.stings}`;

export const sealOf = (round: string, secret: string, seat: number, chunk: number, o: Opening): string =>
  sha256Hex(sealPreimage(round, seat, chunk, saltOf(secret, seat, chunk), o));

export const headZero = (round: string): string => sha256Hex(`clawtide|head|${round}`);
export const nextHead = (head: string, chunk: number, seals: string[]): string => sha256Hex(`${head}|${chunk}|${seals.join(',')}`);

/** The board seed: the contract's VRF draw mixed with the referee's committed secret. */
export const boardSeed = (vrf: string, secret: string): string => sha256Hex(`clawtide|board|${vrf}|${secret}`);

export function foldHead(round: string, chunks: string[][]): string {
  let h = headZero(round);
  chunks.forEach((seals, k) => { h = nextHead(h, k, seals); });
  return h;
}

// ---------- inputs as text ----------

export const encodeEntry = (t: number, i: Input): string => `${t}:${i}`;

export function decodeInputs(text: string, seat: number): LogEntry[] {
  if (!text) return [];
  return text.split(';').map((part) => {
    const m = /^(\d+):([1-9])$/.exec(part);
    if (!m) throw new Error(`bad log entry "${part}"`);
    return { t: Number(m[1]), c: seat, i: Number(m[2]) };
  });
}

export const logFromOpenings = (chunks: Opening[][]): LogEntry[] =>
  chunks.flatMap((seats) => seats.flatMap((o, seat) => decodeInputs(o.inputs, seat))).sort((a, b) => a.t - b.t || a.c - b.c);

export const stateOpening = (s: State, seat: number, inputs: string): Opening => {
  const c = s.crabs[seat];
  return { inputs, at: c.at, pearls: c.pearls, clams: c.clams, stings: c.stings };
};

/** Collects applied inputs as the round runs and closes a chunk's openings when asked. */
export class Recorder {
  private buf: string[][];
  constructor(readonly seats: number) { this.buf = Array.from({ length: seats }, () => []); }
  add(tick: number, applied: (Input | null)[]): void {
    applied.forEach((a, i) => { if (a) this.buf[i].push(encodeEntry(tick, a)); });
  }
  close(s: State): Opening[] {
    const out = this.buf.map((entries, seat) => stateOpening(s, seat, entries.join(';')));
    this.buf = Array.from({ length: this.seats }, () => []);
    return out;
  }
}
