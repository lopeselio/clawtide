import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Opening, Settlement, Setup } from '@clawtide/rules';
import { config } from './config.ts';
import type { SignedLine } from './nearai.ts';

// Records: one JSON file per round and per raid under DATA_DIR (an Azure Files share when hosted,
// so proof bundles survive restarts and redeploys), plus a small key-value file for the rest
// (rockpool layouts, which stay secret until they're replaced, and what the AI crabs did).

export interface SeatRec { name: string; kind: 'human' | 'guest' | 'bot'; account?: string; bot?: string }

export interface RoundRecord {
  id: string;
  createdAt: number;
  seats: SeatRec[];
  difficulty: string;
  rules: number;
  secretHash: string;
  /** the VRF draw the contract made after the commitment */
  vrf?: string;
  /** revealed only once the round is over (with the board seed it makes) */
  secret?: string;
  boardSeed?: string;
  shape?: string;
  chunks: Opening[][];
  seals: string[][];
  head: string;
  endTick?: number;
  end?: string;
  winner?: number | null;
  stateHash?: string;
  expected?: Settlement;
  sealedOnchain: number;
  openedOnchain: number;
  settled: boolean;
  txs: { what: string; hash: string }[];
  lines: SignedLine[];
  error?: string;
}

export interface RaidRecord {
  id: string;
  createdAt: number;
  raider: string | null;
  raiderName: string;
  owner: string;
  ownerName: string;
  poolHash: string;
  onchain: boolean;
  hops: number[];
  over: boolean;
  won: boolean;
  energy: number;
  txs: { what: string; hash: string }[];
  error?: string;
}

const roundsDir = join(config.dataDir, 'rounds');
const raidsDir = join(config.dataDir, 'raids');
mkdirSync(roundsDir, { recursive: true });
mkdirSync(raidsDir, { recursive: true });
const mem = new Map<string, RoundRecord>();
const raidMem = new Map<string, RaidRecord>();

export const validId = (id: string): boolean => /^[a-z0-9-]{1,48}$/.test(id);

function writeJson(file: string, v: unknown): void {
  writeFileSync(`${file}.tmp`, JSON.stringify(v));
  renameSync(`${file}.tmp`, file);
}

export function saveRound(r: RoundRecord): void {
  mem.set(r.id, r);
  writeJson(join(roundsDir, `${r.id}.json`), r);
}

export function loadRound(id: string): RoundRecord | null {
  if (!validId(id)) return null;
  const hit = mem.get(id);
  if (hit) return hit;
  try {
    const r = JSON.parse(readFileSync(join(roundsDir, `${id}.json`), 'utf8')) as RoundRecord;
    mem.set(id, r);
    return r;
  } catch { return null; }
}

export function recentRounds(n: number): RoundRecord[] {
  return readdirSync(roundsDir).filter((f) => f.endsWith('.json'))
    .map((f) => loadRound(f.slice(0, -5))).filter((r): r is RoundRecord => !!r && r.endTick !== undefined)
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, n);
}

export function saveRaid(r: RaidRecord): void {
  raidMem.set(r.id, r);
  writeJson(join(raidsDir, `${r.id}.json`), r);
}
export function loadRaid(id: string): RaidRecord | null {
  if (!validId(id)) return null;
  const hit = raidMem.get(id);
  if (hit) return hit;
  try {
    const r = JSON.parse(readFileSync(join(raidsDir, `${id}.json`), 'utf8')) as RaidRecord;
    raidMem.set(id, r);
    return r;
  } catch { return null; }
}
export function recentRaids(n: number): RaidRecord[] {
  return readdirSync(raidsDir).filter((f) => f.endsWith('.json'))
    .map((f) => loadRaid(f.slice(0, -5))).filter((r): r is RaidRecord => !!r && r.over)
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, n);
}

// ---------- key-value ----------

const kvFile = join(config.dataDir, 'kv.json');
let kv: Record<string, unknown> = (() => { try { return JSON.parse(readFileSync(kvFile, 'utf8')) as Record<string, unknown>; } catch { return {}; } })();
export const kvGet = <T>(k: string, d: T): T => (k in kv ? (kv[k] as T) : d);
export function kvSet(k: string, v: unknown): void {
  kv = { ...kv, [k]: v };
  writeJson(kvFile, kv);
}
