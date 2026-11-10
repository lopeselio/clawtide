import type { SimEvent, View } from '@clawtide/rules';

// Server API (same origin). The wallet session is Better Auth's HttpOnly cookie.

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const res = await fetch(`/api${path}`, body === undefined ? { headers, credentials: 'same-origin' } : { method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export type Difficulty = 'easy' | 'normal' | 'hard';
export interface Tx { what: string; hash: string; url: string }
export interface ServerConfig { network: string; contract: string; referee: string; chain: boolean; relayer: string | null; nearAi: boolean; bots: { label: string; name: string; account: string }[] }
export interface Record_ { rounds: number; wins: number; pearls_banked: number; clams: number; stings: number; raids_won: number; raids_failed: number; raided: number; defended: number }
export interface ChainPool { hash: string; shield_until: string; last_raider: string | null; raids_today: number; raid_day: number }
export interface Me { accountId: string; name: string | null; balance: number; record: Record_ | null; pool: ChainPool | null; layout: string | null; layoutLive: boolean }
export interface BoardRow { account: string; name: string; pearls: number; season_pearls: number; wins: number }
export interface Crown { account: string; name: string; pearls: number }
export interface Season { season: number; started_ns: string; ends_ns: string; supply: string; rounds_settled: number; raids: number }
export interface Board { rows: BoardRow[]; crown: Crown | null; season: Season | null }
export interface RoundRow { id: string; createdAt: number; names: string[]; winner: number | null; settled: boolean; shape?: string; mints: number[] }
export interface PoolRow { account: string; name: string; bot: boolean; pearls: number; shieldMs: number; crown: boolean; revenge: boolean }
export interface RaidRow { id: string; raider: string; owner: string; won: boolean; onchain: boolean; hops: number; txs: Tx[] }
export interface AgentAct { at: number; who: string; what: string; url?: string }

export interface RoomSeat { name: string; kind: 'bot' | 'human'; ready: boolean; signedIn: boolean; here: boolean }
export interface RoomMsg { t: 'room'; code: string; phase: string; seats: RoomSeat[]; you: number; host: boolean; difficulty: Difficulty; quick: boolean; sandbars: number; bots: { label: string; name: string }[] }
export interface StartSeat { name: string; kind: string; account: string | null; crowned: boolean }
export interface StartMsg {
  t: 'start'; you: number; roundId: string; startsAt: number; seats: StartSeat[]; difficulty: Difficulty; secretHash: string; vrf: string; onchain: boolean;
  w: number; h: number; land: number[]; shape: string; shapeName: string; clams: number; maxTicks: number; tickHz: number; txs: Tx[]; v: View;
}
export interface SnapMsg { t: 'snap'; v: View; ev: SimEvent[]; sealed: number }
export interface ResultSeat { name: string; pearls: number; clams: number; stings: number; pinches: number; kind: string; account: string | null }
export interface ResultsMsg {
  t: 'results'; roundId: string; winner: number | null; end: string; endTick: number; difficulty: Difficulty; shapeName: string; seats: ResultSeat[];
  expected: { winner: number | null; mints: number[] } | null; chain: boolean; settled: boolean; error: string | null; board: { content: number[]; num: number[] }; txs: Tx[];
}
export interface LineMsg { t: 'line'; who: string; text: string; signed: boolean }
export type ServerMsg = RoomMsg | StartMsg | SnapMsg | ResultsMsg | LineMsg | { t: 'drawing'; roundId: string; secretHash: string; chain: boolean } | { t: 'emote'; seat: number } | { t: 'error'; msg: string } | { t: 'kicked' } | { t: 'hello'; account: string | null };

export const explorerAccount = (a: string): string => `https://testnet.nearblocks.io/address/${a}`;
export const short = (a: string): string => (a.length > 22 ? `${a.slice(0, 10)}…${a.slice(-8)}` : a);
