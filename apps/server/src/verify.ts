// Independent check of a finished round or raid. Needs no keys and trusts nothing the game server says.
//
//   pnpm verify <roundId>       [--host https://…] [--rpc https://…] [--contract clawtide.testnet]
//   pnpm verify raid <raidId>   (reads only the chain: the raid's hops and the revealed rockpool)
//
// A round: checks that the secret matches the hash committed before the contract's VRF draw, that
// the board seed is sha256(vrf | secret) as the contract recorded it, rebuilds every seal from the
// opened log, folds them into the chain head the contract holds, replays the whole round with
// packages/rules (re-making every AI crab's decision from that crab's own view) and recomputes the
// settlement.
import {
  CHUNK, RULES_VERSION, boardSeed, foldHead, logFromOpenings, replay, replayRaid, sealOf, settle, sha256Hex, stateHash,
  type Input, type Opening, type Setup, type Skill,
} from '@clawtide/rules';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const pos = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const HOST = opt('host', process.env.VERIFY_HOST ?? 'http://localhost:8851');
// public testnet RPCs (docs.near.org/api/rpc/providers). Each is retried on a rate limit (429) or a
// network error with a growing pause, then the next one is tried; rpc.testnet.near.org is deprecated.
const RPCS = args.includes('--rpc') ? [opt('rpc', '')] : ['https://testnet-rpc.intea.rs', 'https://near-testnet.drpc.org', 'https://rpc.testnet.fastnear.com'];
const CONTRACT = opt('contract', process.env.CONTRACT_ID ?? 'clawtide.testnet');
if (!pos.length) { console.error('usage: pnpm verify <roundId> | pnpm verify raid <raidId>  [--host URL] [--rpc URL] [--contract ID]'); process.exit(2); }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function fail(msg: string): never { console.error(`✗ ${msg}`); process.exit(2); }

class RetryableError extends Error {}
async function viewCall<T>(method: string, a: object): Promise<T> {
  const errors: string[] = [];
  for (const rpc of RPCS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await viewAt<T>(rpc, method, a); } catch (e) {
        const msg = (e as Error).message;
        if (!(e instanceof RetryableError)) { errors.push(`${new URL(rpc).host}: ${msg}`); break; }
        if (attempt === 2) errors.push(`${new URL(rpc).host}: ${msg}`);
        else await sleep(800 * (attempt + 1));
      }
    }
  }
  return fail(`could not read ${method} from any NEAR testnet RPC (try again in a minute, or pass --rpc <url>):\n  ${errors.join('\n  ')}`);
}
async function viewAt<T>(rpc: string, method: string, a: object): Promise<T> {
  let res: Response;
  try {
    res = await fetch(rpc, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: CONTRACT, method_name: method, args_base64: Buffer.from(JSON.stringify(a)).toString('base64') } }),
    });
  } catch (e) { throw new RetryableError(`network error (${(e as Error).message})`); }
  if (res.status === 429 || res.status >= 500) throw new RetryableError(`HTTP ${res.status}${res.status === 429 ? ' (rate-limited)' : ''}`);
  const j = (await res.json().catch(() => ({}))) as { result?: { result: number[] }; error?: unknown };
  if (!j.result) {
    const err = JSON.stringify(j.error ?? `HTTP ${res.status}`).slice(0, 200);
    // some providers report a rate limit inside a 200 body
    if (/429|rate|too many/i.test(err)) throw new RetryableError(err);
    throw new Error(err);
  }
  return JSON.parse(Buffer.from(j.result.result).toString('utf8')) as T;
}

let failed = 0;
const check = (ok: boolean, what: string, detail = ''): void => {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${what}${detail ? `  ${detail}` : ''}`);
};
const done = (): never => {
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
};

// ---------- a raid: chain only ----------
if (pos[0] === 'raid') {
  const id = pos[1];
  const raid = await viewCall<{ raider: string; owner: string; pool_hash: string; done: boolean; won: boolean; hops: string; energy_left: number; taken: number; bounty: number; revenge: boolean } | null>('get_raid', { raid_id: id });
  check(!!raid, `the contract has raid ${id}`);
  if (!raid) done();
  console.log(`  ${raid!.raider} raided ${raid!.owner}${raid!.revenge ? ' (revenge)' : ''}: ${raid!.hops.length} hops, ${raid!.won ? `reached the cache, took ${raid!.taken} PEARL` : `turned back (owner earned ${raid!.bounty})`}`);
  check(raid!.done, 'the raid is settled');
  const layout = await viewCall<string | null>('revealed_pool', { hash: raid!.pool_hash });
  if (!layout) {
    console.log(`… the rockpool ${raid!.pool_hash.slice(0, 16)}… is still in use, so its layout is secret. It is published onchain (reveal_pool) when its owner replaces it; run this again then.`);
    done();
  }
  check(true, 'the rockpool layout was revealed onchain and rebuilds its committed hash (the contract checked it)');
  const s = replayRaid(layout!, raid!.hops);
  check(s.won === raid!.won, `replaying the hops on that layout ${s.won ? 'reaches the cache' : 'does not reach the cache'}, as settled`);
  check(Math.max(0, s.energy) === raid!.energy_left, `energy left ${Math.max(0, s.energy)} (${s.stings} sting${s.stings === 1 ? '' : 's'})`);
  done();
}

// ---------- a round ----------
const id = pos[0];
interface Bundle {
  id: string; over: boolean; seats: { name: string; kind: string; account?: string; bot?: string }[]; difficulty: Skill; rules: number;
  secretHash: string; vrf?: string; secret?: string; boardSeed?: string; seals: string[][]; head: string; chunks: Opening[][]; endTick?: number;
  winner?: number | null; stateHash?: string; lines: { who: string; signature?: string; signingAddress?: string }[];
}
interface ChainRound {
  secret_hash: string; seats: { account: string | null; name: string }[]; vrf: string | null; vrf_block: string | null; chunks: number; head: string; opened: number;
  open_head: string; secret: string | null; board_seed: string | null; finals: { pearls: number; clams: number; stings: number }[]; settled: boolean; winner: number | null; minted: number[];
}

async function bundle(): Promise<Bundle & { error?: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${HOST}/api/round/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15_000) });
      if ((res.status === 429 || res.status >= 500) && attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
      return (await res.json()) as Bundle & { error?: string };
    } catch (e) {
      if (attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
      return fail(`could not reach ${HOST} (${(e as Error).message}); is the server running? Use --host https://clawtide.lopeselio.online for the hosted game.`);
    }
  }
}
const b = await bundle();
if (b.error) fail(`${HOST}: ${b.error}${HOST.includes('localhost') ? ' (this is the local server; add --host https://clawtide.lopeselio.online for a hosted round)' : ''}`);
if (!b.over || !b.secret) fail('that round is not over yet');
const c = await viewCall<ChainRound | null>('get_round', { round_id: id });
console.log(`round ${id} on ${CONTRACT}: ${b.seats.map((s) => s.name).join(', ')} (AI crabs on ${b.difficulty})\n`);
check(!!c, 'the contract has this round');
if (!c) done();

check(sha256Hex(b.secret) === c!.secret_hash && c!.secret_hash === b.secretHash, 'the revealed secret matches the hash committed at create_round', c!.secret_hash.slice(0, 16));
check(!!c!.vrf && c!.vrf === b.vrf, `the contract drew its VRF seed in a later receipt (block ${c!.vrf_block ?? '?'})`, (c!.vrf ?? '').slice(0, 16));
const seed = boardSeed(c!.vrf ?? '', b.secret);
check(seed === c!.board_seed && seed === b.boardSeed, 'board seed = sha256(vrf | secret), as the contract recorded it', seed.slice(0, 16));
const rebuilt = b.chunks.map((seats, k) => seats.map((o, seat) => sealOf(id, b.secret!, seat, k, o)));
check(JSON.stringify(rebuilt) === JSON.stringify(b.seals), `every opening rebuilds its seal (${b.chunks.length} chunks × ${b.seats.length} seats)`);
const head = foldHead(id, rebuilt);
check(head === c!.head && c!.chunks === b.chunks.length, "the seals fold into the contract's chain head", head.slice(0, 16));
check(c!.opened === c!.chunks && c!.open_head === c!.head, 'the contract opened every chunk and re-folded the same head');

// replay from the chain's board seed; AI crabs decide again from their own views
const setup: Setup = { seed: c!.board_seed ?? seed, rules: b.rules ?? RULES_VERSION, difficulty: b.difficulty, seats: b.seats.map((s) => ({ name: s.name, ...(s.kind === 'bot' ? { bot: b.difficulty } : {}) })) };
let k = 0, stateBad = 0, botBad = 0, humanBad = 0;
const log = logFromOpenings(b.chunks);
const s = replay(setup, log, (st, applied, logged) => {
  applied.forEach((a: Input | null, i) => { if (a !== logged[i]) { if (st.crabs[i].bot && logged[i] !== 9) botBad++; else humanBad++; } });
  if (st.tick % CHUNK === 0 || st.over) {
    (b.chunks[k] ?? []).forEach((o, seat) => {
      const x = st.crabs[seat];
      if (o.at !== x.at || o.pearls !== x.pearls || o.clams !== x.clams || o.stings !== x.stings) stateBad++;
    });
    k++;
  }
}, b.endTick);
check(botBad === 0, 'every AI hop is what that crab decides from its own view', `${log.filter((e) => s.crabs[e.c].bot).length} AI hops`);
check(humanBad === 0, 'every logged human hop replays as logged');
check(stateBad === 0 && k === b.chunks.length, `the replay passes through every sealed chunk state (${k} chunks)`);
check(s.tick === b.endTick && stateHash(s) === b.stateHash, `the replay ends where the server's round ended (tick ${s.tick}, ${s.end === 'tide' ? 'the last clam opened' : 'time ran out'})`, stateHash(s).slice(0, 16));
const finals = s.crabs.map((x) => ({ pearls: x.pearls, clams: x.clams, stings: x.stings }));
check(JSON.stringify(finals) === JSON.stringify(c!.finals), 'the final standings match what the contract opened');
const exp = settle(c!.seats.map((x) => !!x.account), finals);
check(c!.settled, 'the contract settled it');
check(exp.winner === c!.winner, `winner: ${exp.winner === null ? 'nobody' : b.seats[exp.winner].name}`);
check(JSON.stringify(exp.mints) === JSON.stringify(c!.minted), `PEARL minted per seat: [${c!.minted.join(', ')}]`);
const signed = b.lines.filter((l) => l.signature);
console.log(`\n${b.lines.length} AI line(s), ${signed.length} signed by the NEAR AI enclave${signed[0] ? ` (signer ${signed[0].signingAddress})` : ''}`);
done();
