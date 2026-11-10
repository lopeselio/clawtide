// End-to-end run against the live testnet contract and a running server, as a signed-in player.
// Creates a fresh test account each run (no real wallet involved).
//   pnpm e2e [baseUrl]            (default http://localhost:8851)
// Steps: sign in through Better Auth + better-near-auth (NEP-413) -> dig a sandbar against three AI
// crabs over the WebSocket (the player is steered by the same AI mind, fed only the view the server
// sends) -> wait for the VRF draw, seals, openings and settlement -> build a rockpool with a gasless
// NEP-366 meta-transaction through the relayer -> raid an AI crab's rockpool (begun and settled onchain).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPair, KeyPairSigner, actions, type KeyPairString } from 'near-api-js';
import { Near } from 'near-kit';
import { sha256 } from '@noble/hashes/sha2.js';
import WebSocket from 'ws';
import { POOL, RT_ROCK, RT_URCHIN, botPool, decide, neighbours, newBrain, stepTo, type RaidView, type View } from '@clawtide/rules';

const URL_ = process.argv[2] ?? process.env.E2E_URL ?? 'http://localhost:8851';
const CONTRACT = process.env.CONTRACT_ID ?? 'clawtide.testnet';
const stamp = Date.now().toString(36);
const step = (s: string): void => console.log(`\n▶ ${s}`);
const ok = (s: string): void => console.log(`  ✓ ${s}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const tx = (h: string): string => `https://testnet.nearblocks.io/txns/${h}`;

const credFile = (a: string): string => join(homedir(), '.near-credentials', 'testnet', `${a}.json`);
function faucetAccount(id: string): KeyPairString {
  execFileSync('near', ['account', 'create-account', 'sponsor-by-faucet-service', id, 'autogenerate-new-keypair', 'save-to-legacy-keychain', 'network-config', 'testnet', 'create'], { stdio: 'ignore' });
  return JSON.parse(readFileSync(credFile(id), 'utf8')).private_key as KeyPairString;
}
/** When the faucet is rate-limited: a sub-account of the contract's owner account, funded with 0.2 NEAR. */
async function fundedSubAccount(label: string): Promise<{ id: string; key: KeyPairString }> {
  const funder = process.env.E2E_FUNDER ?? CONTRACT;
  const fk = JSON.parse(readFileSync(credFile(funder), 'utf8')).private_key as KeyPairString;
  const kp = KeyPair.fromRandom('ed25519');
  const sub = `${label}.${funder}`;
  const f = new Account(funder, new JsonRpcProvider({ url: 'https://rpc.testnet.fastnear.com' }), KeyPairSigner.fromSecretKey(fk));
  await f.signAndSendTransaction({ receiverId: sub, actions: [actions.createAccount(), actions.transfer(200_000_000_000_000_000_000_000n), actions.addFullAccessKey(kp.getPublicKey())], waitUntil: 'EXECUTED_OPTIMISTIC' });
  writeFileSync(credFile(sub), JSON.stringify({ account_id: sub, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  return { id: sub, key: kp.toString() as KeyPairString };
}

function nep413Hash(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  const u32 = (n: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
  const str = (t: string): Uint8Array => { const e = new TextEncoder().encode(t); return Buffer.concat([u32(e.length), e]); };
  return sha256(Buffer.concat([u32(2 ** 31 + 413), str(message), nonce, str(recipient), new Uint8Array([0])]));
}

let id = `clawtide-e2e-${stamp}.testnet`;
step(`create ${id} from the testnet faucet`);
let key: KeyPairString;
try { key = faucetAccount(id); } catch {
  ({ id, key } = await fundedSubAccount(`e2e-${stamp}`));
  console.log(`  (the faucet is rate-limited: using ${id}, funded by its parent account)`);
}
const provider = new FailoverRpcProvider(['https://rpc.testnet.fastnear.com', 'https://near-testnet.drpc.org', 'https://testnet-rpc.intea.rs'].map((url) => new JsonRpcProvider({ url })));
await sleep(3000);
ok('account funded');

const view = async <T>(method: string, args: object): Promise<T> => (await provider.callFunction({ contractId: CONTRACT, method, args: args as Record<string, unknown>, blockQuery: { finality: 'optimistic' } })) as T;
let cookie = '';
const origin = new URL(URL_).origin;
async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${URL_}/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const j = (await res.json()) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(`${path}: ${j.error ?? j.message ?? res.status}`);
  return j;
}

const kit = new Near({ network: 'testnet', privateKey: key as `ed25519:${string}`, defaultSignerId: id });
async function relay(method: string, args: object): Promise<string> {
  const { payload } = await kit.transaction(id).functionCall(CONTRACT, method, args, { gas: '50 Tgas', attachedDeposit: '0 yocto' }).delegate();
  const r = await api<{ txHash: string }>('/ba/near/relay', { payload });
  for (let k = 0; k < 30; k++) {
    const st = await api<{ status: string }>(`/ba/near/relay-status/${r.txHash}`);
    if (st.status === 'completed') return r.txHash;
    if (st.status === 'failed') throw new Error(`${method} relay failed (${r.txHash})`);
    await sleep(1500);
  }
  return r.txHash;
}

step('sign in: Better Auth + better-near-auth (the wallet signs "Sign in to <host>")');
const host = new URL(URL_).host;
const { nonce } = await api<{ nonce: string }>('/ba/near/nonce', { accountId: id, networkId: 'testnet' });
const kp = KeyPair.fromString(key);
const message = `Sign in to ${host}`;
const sig = kp.sign(nep413Hash(message, Buffer.from(nonce, 'hex'), host));
await api('/ba/near/verify', { signedMessage: { accountId: id, publicKey: kp.getPublicKey().toString(), signature: Buffer.from(sig.signature).toString('base64') }, message, recipient: host, nonce, accountId: id });
ok(`session cookie set; the server sees ${(await api<{ accountId: string }>('/me')).accountId}`);

step('dig a sandbar against three AI crabs over the WebSocket');
const ws = new WebSocket(`${URL_.replace(/^http/, 'ws')}/ws`, { headers: { cookie, origin } });
await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
const send = (m: unknown): void => ws.send(JSON.stringify(m));
let roundId = '';
const brain = newBrain(`e2e|${stamp}`, 0);
const results = await new Promise<{ winner: number | null; seats: { name: string; pearls: number; clams: number; stings: number }[]; end: string; shapeName: string }>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('the round took too long')), 5 * 60_000);
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw)) as Record<string, unknown>;
    if (m.t === 'error') { clearTimeout(timer); reject(new Error(String(m.msg))); }
    if (m.t === 'drawing') ok(`round ${m.roundId}: secret hash ${String(m.secretHash).slice(0, 16)}… committed; waiting for the contract's VRF draw`);
    if (m.t === 'start') {
      roundId = String(m.roundId);
      ok(`the tide drew ${String(m.vrf).slice(0, 16)}… (onchain: ${m.onchain}); the sandbar is a ${m.shapeName} with ${m.clams} clams`);
    }
    if (m.t === 'line') ok(`${m.who}: “${m.text}”${m.signed ? ' (signed by NEAR AI TEE)' : ''}`);
    if (m.t === 'snap') {
      const v = m.v as View;
      const me = v.crabs[v.me];
      if (me.stun || me.cool) return;
      const d = decide(v, brain, 'normal');
      if (d) send({ t: 'hop', dir: d });
    }
    if (m.t === 'results') { clearTimeout(timer); resolve(m as never); }
  });
  send({ t: 'hello', name: 'E2E Crab' });
  send({ t: 'quick', bots: 3, difficulty: 'normal' });
});
ws.close();
ok(`the tide came in (${results.end === 'tide' ? 'last clam opened' : 'time'}) on the ${results.shapeName}; ${results.winner === null ? 'nobody' : results.seats[results.winner].name} won. ${results.seats.map((x) => `${x.name} ${x.pearls} pearls`).join(', ')}`);

step('wait for the seals to be opened and the round settled onchain');
let b: { settled: boolean; error: string | null; txs: { what: string; url: string }[] } = { settled: false, error: null, txs: [] };
for (let k = 0; k < 90 && !b.settled; k++) { await sleep(3000); b = await api(`/round/${roundId}`); if (b.error && /settle/.test(b.error)) break; }
if (!b.settled) throw new Error(`not settled: ${b.error}`);
for (const t of b.txs.filter((x) => !x.what.startsWith('seal'))) ok(`${t.what.padEnd(26)} ${t.url}`);
ok(`${b.txs.filter((t) => t.what.startsWith('seal')).length} seal transactions`);
const cr = await view<{ winner: number | null; minted: number[]; vrf: string; board_seed: string }>('get_round', { round_id: roundId });
ok(`contract: winner seat ${cr.winner}, PEARL minted [${cr.minted.join(', ')}], board seed ${cr.board_seed.slice(0, 16)}…`);
const bal = await view<string>('ft_balance_of', { account_id: id });
ok(`${id} holds ${bal} PEARL`);

step('build a rockpool, gasless (NEP-366 meta-transaction through the relayer)');
const layout = botPool(`e2e-${stamp}`);
const { hash } = await api<{ hash: string }>('/pool', { layout });
ok(`build_rockpool ${tx(await relay('build_rockpool', { hash }))}`);
await sleep(2000);
const meNow = await api<{ layoutLive: boolean; pool: { hash: string } | null }>('/me');
ok(`the contract holds ${meNow.pool?.hash.slice(0, 16)}…; the server keeps the layout secret (live: ${meNow.layoutLive})`);

step("raid an AI crab's rockpool (energy gauge, numbers only where you've stood)");
const pools = await api<{ account: string; name: string; bot: boolean; shieldMs: number }[]>('/pools');
const target = pools.find((p) => p.bot && p.shieldMs === 0) ?? pools[0];
const raid = await api<{ id: string; view: RaidView }>('/raid/start', { owner: target.account });
ok(`raid ${raid.id} on ${target.name}'s rockpool begun onchain`);
let rv = raid.view;
const cache = rv.tiles.indexOf(-5);
const cheb = (a: number, c: number): number => Math.max(Math.abs((a % POOL) - (c % POOL)), Math.abs(Math.floor(a / POOL) - Math.floor(c / POOL)));
for (let guard = 0; !rv.over && guard < 80; guard++) {
  // safe if any stood-on neighbour shows 0; otherwise prefer low numbers, then closeness to the cache
  const score = (j: number): number => {
    if (rv.tiles[j] === RT_ROCK || rv.tiles[j] === RT_URCHIN) return 1e9;
    const nb = neighbours(POOL, POOL, j).filter((n) => rv.tiles[n] >= 0);
    const safe = rv.tiles[j] >= 0 || rv.tiles[j] === -5 || nb.some((n) => rv.tiles[n] === 0);
    return (safe ? 0 : 100 + Math.max(0, ...nb.map((n) => rv.tiles[n])) * 50) + cheb(j, cache) * 10;
  };
  let best = -1, bs = 1e9;
  for (let d = 1; d <= 8; d++) { const j = stepTo(POOL, POOL, rv.at, d); if (j >= 0 && score(j) < bs) { bs = score(j); best = d; } }
  rv = (await api<{ view: RaidView }>('/raid/hop', { id: raid.id, dir: best })).view;
}
ok(`${rv.won ? 'reached the cache' : 'turned back'} after ${rv.hops} hops (${rv.stings} sting${rv.stings === 1 ? '' : 's'}, ${rv.energy} energy left)`);
const rr = await api<{ txs: { what: string; url: string }[] }>(`/raid/${raid.id}`);
for (const t of rr.txs) ok(`${t.what.padEnd(12)} ${t.url}`);
const chainRaid = await view<{ won: boolean; taken: number; bounty: number; hops: string }>('get_raid', { raid_id: raid.id });
ok(`contract: won ${chainRaid.won}, took ${chainRaid.taken} PEARL, bounty ${chainRaid.bounty}, hops "${chainRaid.hops}"`);


console.log(`\nall player steps passed. Check the round yourself:\n  pnpm verify ${roundId}${URL_ === 'http://localhost:8851' ? '' : ` --host ${URL_}`}\nand the raid (once ${target.name} rebuilds and the layout is revealed):\n  pnpm verify raid ${raid.id}`);
process.exit(0);
