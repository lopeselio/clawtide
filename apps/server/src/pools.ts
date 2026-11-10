import { randomBytes } from 'node:crypto';
import { layoutError, newRaid, poolHash, raidStep, raidView, type RaidState, type RaidView } from '@clawtide/rules';
import { call, view } from './chain.ts';
import { config } from './config.ts';
import { kvGet, kvSet, loadRaid, saveRaid, type RaidRecord } from './store.ts';

// Rockpools and raids. A layout stays on the server (the referee) and only its hash goes onchain
// until the owner replaces it; then the old layout and salt are published with `reveal_pool`, so
// every raid against it can be replayed (`pnpm verify raid <id>`). Raids run here, one hop per
// request; a signed-in raid is begun and settled onchain, a guest raid is practice only.

export interface PoolRec { layout: string; salt: string; hash: string; at: number }
interface Retired extends PoolRec { owner: string; revealed: boolean }

const pools = (): Record<string, PoolRec> => kvGet<Record<string, PoolRec>>('pools', {});
const pending = (): Record<string, PoolRec> => kvGet<Record<string, PoolRec>>('pendingPools', {});

export const currentPool = (acct: string): PoolRec | null => pools()[acct] ?? null;
export function setPool(acct: string, layout: string, salt: string): PoolRec {
  const rec = { layout, salt, hash: poolHash(layout, salt), at: Date.now() };
  kvSet('pools', { ...pools(), [acct]: rec });
  return rec;
}
export function retirePool(acct: string): void {
  const old = currentPool(acct);
  if (!old) return;
  const list = kvGet<Retired[]>('retired', []);
  if (!list.some((r) => r.hash === old.hash)) kvSet('retired', [...list, { ...old, owner: acct, revealed: false }].slice(-200));
}
export const poolOwners = (): string[] => Object.keys(pools());

/** Publishes every replaced layout onchain (anyone could; the referee does it for everyone). */
export async function revealRetired(): Promise<void> {
  if (!config.chainEnabled) return;
  const list = kvGet<Retired[]>('retired', []);
  for (const r of list.filter((x) => !x.revealed)) {
    try {
      const already = await view<string | null>('revealed_pool', { hash: r.hash }).catch(() => null);
      if (!already) await call(config.referee, 'reveal_pool', { hash: r.hash, layout: r.layout, salt: r.salt });
      r.revealed = true;
    } catch (e) {
      console.warn('reveal_pool:', (e as Error).message.slice(0, 160));
    }
  }
  kvSet('retired', list);
}

/** A player's new layout: checked, salted, and held until their wallet commits its hash. */
export function proposePool(acct: string, layout: string): PoolRec {
  const err = layoutError(layout);
  if (err) throw new Error(err);
  const rec = { layout, salt: randomBytes(16).toString('hex'), hash: '', at: Date.now() };
  rec.hash = poolHash(layout, rec.salt);
  kvSet('pendingPools', { ...pending(), [acct]: rec });
  return rec;
}

/** Once the chain shows the proposed hash, it becomes the player's pool (and the old one is retired). */
export async function syncPool(acct: string): Promise<PoolRec | null> {
  const p = pending()[acct];
  if (p && config.chainEnabled) {
    const onchain = await view<{ hash: string } | null>('get_pool', { account_id: acct }).catch(() => null);
    if (onchain?.hash === p.hash) {
      retirePool(acct);
      kvSet('pools', { ...pools(), [acct]: p });
      const rest = { ...pending() };
      delete rest[acct];
      kvSet('pendingPools', rest);
      void revealRetired();
    }
  } else if (p && !config.chainEnabled) {
    retirePool(acct);
    kvSet('pools', { ...pools(), [acct]: p });
  }
  return currentPool(acct);
}

// ---------- raids ----------

const live = new Map<string, { s: RaidState; rec: RaidRecord; settling?: Promise<void> }>();

export async function startRaid(raider: string | null, raiderName: string, owner: string, ownerName: string): Promise<{ id: string; view: RaidView }> {
  const pool = currentPool(owner);
  if (!pool) throw new Error('that crab has no rockpool yet');
  if (raider === owner) throw new Error('you can’t raid your own rockpool');
  const id = `x-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const onchain = !!raider && config.chainEnabled;
  const rec: RaidRecord = { id, createdAt: Date.now(), raider, raiderName, owner, ownerName, poolHash: pool.hash, onchain, hops: [], over: false, won: false, energy: 0, txs: [] };
  if (onchain) {
    // the contract enforces raids per day, shields and revenge; a refusal stops the raid here
    const r = await call(config.referee, 'begin_raid', { raid_id: id, raider, owner }, 30);
    rec.txs.push({ what: 'begin_raid', hash: r.tx });
  }
  const s = newRaid(pool.layout);
  rec.energy = s.energy;
  saveRaid(rec);
  live.set(id, { s, rec });
  return { id, view: raidView(s) };
}

export function raidHop(id: string, dir: number, raider: string | null): { view: RaidView; rec: RaidRecord } {
  const r = live.get(id);
  if (!r) throw new Error('no such raid (or it has ended)');
  if (r.rec.raider !== raider) throw new Error('that raid isn’t yours');
  if (r.s.over) return { view: raidView(r.s), rec: r.rec };
  if (raidStep(r.s, dir)) r.rec.hops.push(dir);
  r.rec.energy = r.s.energy;
  if (r.s.over) {
    r.rec.over = true;
    r.rec.won = r.s.won;
    saveRaid(r.rec);
    r.settling = settleRaid(r.rec);
    setTimeout(() => live.delete(id), 10 * 60_000).unref();
    return { view: raidView(r.s), rec: r.rec };
  }
  saveRaid(r.rec);
  return { view: raidView(r.s), rec: r.rec };
}

/** Gives up: the raid ends as a failure. */
export function abandonRaid(id: string, raider: string | null): RaidRecord | null {
  const r = live.get(id);
  if (!r || r.rec.raider !== raider || r.s.over) return null;
  r.s.over = true;
  r.rec.over = true;
  r.rec.won = false;
  saveRaid(r.rec);
  r.settling = settleRaid(r.rec);
  return r.rec;
}

async function settleRaid(rec: RaidRecord): Promise<void> {
  if (!rec.onchain) return;
  try {
    const r = await call(config.referee, 'settle_raid', { raid_id: rec.id, hops: rec.hops.join(''), won: rec.won, energy_left: Math.max(0, rec.energy) }, 30);
    rec.txs.push({ what: 'settle_raid', hash: r.tx });
  } catch (e) {
    rec.error = `settle_raid: ${(e as Error).message.slice(0, 200)}`;
  }
  saveRaid(rec);
}

export async function raidResult(id: string): Promise<RaidRecord | null> {
  const r = live.get(id);
  if (r?.settling) await r.settling;
  return r?.rec ?? loadRaid(id);
}
