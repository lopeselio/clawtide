import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { AGENTS, accountOf, agentByAccount, agentTick, recentActs } from './agents.ts';
import { BA_PATH, accountFromHeaders, authHandler } from './ba.ts';
import { view } from './chain.ts';
import { config, explorerTx, hasKey } from './config.ts';
import { attestation, nearAiEnabled } from './nearai.ts';
import { abandonRaid, currentPool, poolOwners, proposePool, raidHop, raidResult, startRaid, syncPool } from './pools.ts';
import { Room, asDifficulty } from './room.ts';
import { kvGet, kvSet, loadRaid, loadRound, recentRaids, recentRounds, type RoundRecord } from './store.ts';

// ---------- tiny HTTP helpers ----------

const json = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const cleanName = (n: unknown): string => String(n ?? '').replace(/[^A-Za-z0-9 _.'-]/g, '').trim().slice(0, 20) || 'Crab';
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > 16_000) throw new Error('too large'); chunks.push(c as Buffer); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>; } catch { return {}; }
}

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webp': 'image/webp' };
function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x');
  let file = normalize(join(config.webDist, decodeURIComponent(url.pathname)));
  if (!file.startsWith(normalize(config.webDist))) { res.writeHead(403).end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(config.webDist, 'index.html');
  if (!existsSync(file)) { res.writeHead(404).end('web app not built: pnpm build'); return; }
  const immutable = file.includes(`${join(config.webDist, 'assets')}`);
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
  createReadStream(file).pipe(res);
}

const cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.v as T;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
}

/** What anyone may see of a round: the secret and the openings only once it's over. */
function bundle(r: RoundRecord) {
  const over = r.endTick !== undefined;
  return {
    id: r.id, contract: config.contract, createdAt: r.createdAt, over, seats: r.seats, difficulty: r.difficulty, rules: r.rules,
    secretHash: r.secretHash, vrf: r.vrf, secret: over ? r.secret : undefined, boardSeed: over ? r.boardSeed : undefined, shape: r.shape,
    seals: r.seals, head: r.head, chunks: over ? r.chunks : [], endTick: r.endTick, end: r.end, winner: r.winner, stateHash: r.stateHash,
    expected: r.expected, sealedOnchain: r.sealedOnchain, openedOnchain: r.openedOnchain, settled: r.settled, error: r.error ?? null,
    txs: r.txs.map((t) => ({ ...t, url: explorerTx(t.hash) })),
    lines: r.lines.map((l) => ({ who: l.who, text: l.text, model: l.model, signature: l.signature, signingAddress: l.signingAddress, signedText: l.signedText })),
  };
}

const names = (): Record<string, string> => kvGet<Record<string, string>>('names', {});
const nameOf = (acct: string): string => agentByAccount(acct)?.name ?? names()[acct] ?? acct.replace(/\.testnet$/, '');

interface ChainPool { hash: string; shield_until: string; last_raider: string | null }

/** Rockpools anyone can raid, richest first; the crown's pool on top. */
async function poolList(me: string | null): Promise<unknown[]> {
  const crown = config.chainEnabled ? await cached('crown', 15_000, () => view<{ account: string } | null>('get_crown', {}).catch(() => null)) : null;
  const rows = await Promise.all(poolOwners().map(async (acct) => {
    const chain = config.chainEnabled ? await cached(`pool:${acct}`, 10_000, () => view<ChainPool | null>('get_pool', { account_id: acct }).catch(() => null)) : null;
    const pearls = config.chainEnabled ? Number(await cached(`bal:${acct}`, 10_000, () => view<string>('ft_balance_of', { account_id: acct }).catch(() => '0'))) : 0;
    const shieldMs = chain ? Math.max(0, Number(BigInt(chain.shield_until) / 1_000_000n) - Date.now()) : 0;
    return {
      account: acct, name: nameOf(acct), bot: !!agentByAccount(acct), pearls, shieldMs, crown: crown?.account === acct,
      live: !config.chainEnabled || chain?.hash === currentPool(acct)?.hash, revenge: !!me && !!chain && false,
    };
  }));
  const mine = me && config.chainEnabled ? await view<ChainPool | null>('get_pool', { account_id: me }).catch(() => null) : null;
  return rows.filter((r) => r.account !== me && r.live)
    .map((r) => ({ ...r, revenge: mine?.last_raider === r.account }))
    .sort((a, b) => Number(b.crown) - Number(a.crown) || Number(b.revenge) - Number(a.revenge) || b.pearls - a.pearls);
}

// ---------- routes ----------

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  try {
    if (p === BA_PATH || p.startsWith(`${BA_PATH}/`)) { await authHandler(req, res); return; }
    if (p === '/api/health') return json(res, 200, { ok: true, version: process.env.APP_VERSION ?? 'dev', rooms: Room.count() });
    const me = await accountFromHeaders(req.headers);
    if (p === '/api/config') {
      return json(res, 200, {
        network: config.network, contract: config.contract, referee: config.referee, chain: config.chainEnabled,
        relayer: hasKey(config.relayer) ? config.relayer : null, nearAi: nearAiEnabled(),
        bots: AGENTS.map((a) => ({ label: a.label, name: a.name, account: accountOf(a) })),
      });
    }
    if (p === '/api/me') {
      if (!me) return json(res, 401, { error: 'not signed in' });
      const [balance, record, pool] = config.chainEnabled
        ? await Promise.all([view<string>('ft_balance_of', { account_id: me }).catch(() => '0'), view('get_record', { account_id: me }).catch(() => null), view<ChainPool | null>('get_pool', { account_id: me }).catch(() => null)])
        : ['0', null, null];
      const mine = await syncPool(me);
      return json(res, 200, { accountId: me, name: names()[me] ?? null, balance: Number(balance), record, pool, layout: mine?.layout ?? null, layoutLive: !!pool && pool.hash === mine?.hash });
    }
    if (p === '/api/leaderboard') {
      if (!config.chainEnabled) return json(res, 200, { rows: [], crown: null, season: null });
      return json(res, 200, await cached('board', 12_000, async () => ({
        rows: await view('leaderboard', { limit: 15 }).catch(() => []),
        crown: await view('get_crown', {}).catch(() => null),
        season: await view('season_info', {}).catch(() => null),
      })));
    }
    if (p === '/api/agents') return json(res, 200, recentActs().map((a) => ({ ...a, url: a.tx ? explorerTx(a.tx) : undefined })));
    if (p === '/api/rounds') {
      return json(res, 200, recentRounds(12).map((r) => ({ id: r.id, createdAt: r.createdAt, names: r.seats.map((s) => s.name), winner: r.winner ?? null, settled: r.settled, shape: r.shape, mints: r.expected?.mints ?? [] })));
    }
    const rm = /^\/api\/round\/([a-z0-9-]{1,48})$/.exec(p);
    if (rm) { const r = loadRound(rm[1]); return r ? json(res, 200, bundle(r)) : json(res, 404, { error: 'no such round' }); }

    // ---------- rockpools and raids ----------
    if (p === '/api/pools') return json(res, 200, await poolList(me));
    if (p === '/api/raids') return json(res, 200, recentRaids(12).map((r) => ({ id: r.id, raider: r.raiderName, owner: r.ownerName, won: r.won, onchain: r.onchain, hops: r.hops.length, txs: r.txs.map((t) => ({ ...t, url: explorerTx(t.hash) })) })));
    if (p === '/api/pool' && req.method === 'POST') {
      if (!me) return json(res, 401, { error: 'sign in to build a rockpool' });
      const b = await body(req);
      const rec = proposePool(me, String(b.layout ?? ''));
      return json(res, 200, { hash: rec.hash, contract: config.contract, chain: config.chainEnabled });
    }
    if (p === '/api/raid/start' && req.method === 'POST') {
      const b = await body(req);
      const owner = String(b.owner ?? '');
      if (!me && !agentByAccount(owner)) return json(res, 401, { error: 'guests can practise on the AI crabs’ rockpools; sign in to raid players' });
      const r = await startRaid(me, me ? nameOf(me) : cleanName(b.name), owner, nameOf(owner));
      return json(res, 200, { ...r, owner, ownerName: nameOf(owner), onchain: !!me && config.chainEnabled });
    }
    if (p === '/api/raid/hop' && req.method === 'POST') {
      const b = await body(req);
      const r = raidHop(String(b.id ?? ''), Number(b.dir), me);
      return json(res, 200, { view: r.view, over: r.rec.over });
    }
    if (p === '/api/raid/quit' && req.method === 'POST') {
      const b = await body(req);
      return json(res, 200, { ok: !!abandonRaid(String(b.id ?? ''), me) });
    }
    const xm = /^\/api\/raid\/([a-z0-9-]{1,48})$/.exec(p);
    if (xm) {
      const r = (await raidResult(xm[1])) ?? loadRaid(xm[1]);
      return r ? json(res, 200, { ...r, contract: config.contract, txs: r.txs.map((t) => ({ ...t, url: explorerTx(t.hash) })) }) : json(res, 404, { error: 'no such raid' });
    }
    if (p === '/api/attestation') return json(res, 200, await attestation());
    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    serveStatic(req, res);
  } catch (e) {
    json(res, 400, { error: (e as Error).message.replace(/^.*?Smart contract panicked: /, '').slice(0, 300) });
  }
}

const server = createServer((req, res) => { void route(req, res); });

// ---------- websocket: rooms ----------

const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: { threshold: 256 }, maxPayload: 4_000 });
wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  let room: Room | null = null;
  let account: string | null = null;
  const ready = accountFromHeaders(req.headers).then((a) => { account = a; }).catch(() => undefined);
  let name = 'Crab';
  const reply = (m: unknown): void => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  ws.on('message', async (raw) => {
    await ready;
    let m: Record<string, unknown>;
    try { m = JSON.parse(String(raw)) as Record<string, unknown>; } catch { return; }
    try {
      switch (m.t) {
        case 'hello':
          name = cleanName(m.name);
          if (account && names()[account] !== name) kvSet('names', { ...names(), [account]: name });
          reply({ t: 'hello', account });
          break;
        case 'create': room?.leave(ws); room = new Room(); room.difficulty = asDifficulty(m.difficulty); room.join(ws, name, account); break;
        case 'quick': {
          room?.leave(ws);
          room = new Room();
          room.quick = true;
          room.difficulty = asDifficulty(m.difficulty);
          room.join(ws, name, account);
          const n = Math.max(1, Math.min(3, Number(m.bots ?? 3)));
          for (let k = 0; k < n; k++) room.addBot(null);
          room.setReady(ws, true);
          break;
        }
        case 'join': { const r = Room.get(String(m.code ?? '')); if (!r) throw new Error('no room with that code'); room?.leave(ws); r.join(ws, name, account); room = r; break; }
        case 'addBot': room?.addBot(ws, typeof m.label === 'string' ? m.label : undefined); break;
        case 'difficulty': room?.setDifficulty(ws, m.difficulty); break;
        case 'kick': room?.kick(ws, Number(m.seat)); break;
        case 'ready': room?.setReady(ws, !!m.ready); break;
        case 'again': room?.again(ws); break;
        case 'hop': room?.hop(ws, m.dir); break;
        case 'go': room?.go(ws, m.tile); break;
        case 'emote': room?.emote(ws); break;
        case 'leave': room?.leave(ws); room = null; break;
      }
    } catch (e) {
      reply({ t: 'error', msg: (e as Error).message });
    }
  });
  ws.on('close', () => room?.leave(ws));
});
setInterval(() => { for (const ws of wss.clients) if (ws.readyState === 1) ws.ping(); }, 25_000).unref();

server.listen(config.port, () => {
  console.log(`Clawtide on :${config.port} (contract ${config.contract}, chain ${config.chainEnabled ? 'on' : 'off'})`);
});

// the AI crabs keep a fresh rockpool every day (and offline, a local one to practise on)
const loop = (): void => { void agentTick().catch((e) => console.warn('agent tick:', (e as Error).message)); };
setTimeout(loop, 5000);
setInterval(loop, 30 * 60_000).unref();
