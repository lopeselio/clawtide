import { useCallback, useEffect, useState } from 'react';
import { POOL, POOL_ENTRY, POOL_ROCKS, POOL_URCHINS, RAID_ENERGY, RT_CACHE, RT_HIDDEN, RT_ROCK, RT_URCHIN, dirTo, layoutError, type RaidView } from '@clawtide/rules';
import { api, short, type Me, type PoolRow, type RaidRow, type Tx } from './api.ts';
import { KEY_DIRS } from './Round.tsx';
import { SEAT_COLORS, W_CACHE, W_HIDDEN, W_ROCK, W_URCHIN, type World } from './scene.ts';
import { sfx } from './sound.ts';
import { call } from './wallet.ts';

// Rockpools: raid other crabs' pools (async, one hop at a time, an energy gauge) and build your own.
// The raid plays in the same 3D world; the builder is a plain grid, easy on a phone.

export function Rockpools({ world, account, name, back }: { world: World; account: string | null; name: string; back: () => void }) {
  const [tab, setTab] = useState<'raid' | 'build'>('raid');
  const [pools, setPools] = useState<PoolRow[]>([]);
  const [raids, setRaids] = useState<RaidRow[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [raid, setRaid] = useState<{ id: string; owner: string; ownerName: string; onchain: boolean } | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    void api<PoolRow[]>('/pools').then(setPools).catch(() => undefined);
    void api<RaidRow[]>('/raids').then(setRaids).catch(() => undefined);
    if (account) void api<Me>('/me').then(setMe).catch(() => setMe(null));
  }, [account]);
  useEffect(load, [load]);

  const begin = async (p: PoolRow): Promise<void> => {
    setErr('');
    try {
      const r = await api<{ id: string; view: RaidView; owner: string; ownerName: string; onchain: boolean }>('/raid/start', { owner: p.account, name });
      setRaid({ id: r.id, owner: r.owner, ownerName: r.ownerName, onchain: r.onchain });
      sfx('go');
    } catch (e) { setErr((e as Error).message); }
  };

  if (raid) return <Raid world={world} raid={raid} done={() => { setRaid(null); load(); }} />;

  return (
    <main className="lobby rockpools">
      <section className="panel wide">
        <div className="row">
          <h2 className="grow">Rockpools</h2>
          <button className="ghost small" onClick={back}>Back</button>
        </div>
        <div className="seg">
          <button className={`small ${tab === 'raid' ? 'on' : 'ghost'}`} onClick={() => setTab('raid')}>Raid a rockpool</button>
          <button className={`small ${tab === 'build' ? 'on' : 'ghost'}`} onClick={() => setTab('build')}>My rockpool</button>
        </div>
        {err && <p className="err small">{err}</p>}
        {tab === 'raid' ? (
          <>
            <p className="small dim">Wade in at the bottom with <b>{RAID_ENERGY} energy</b>: 1 per hop, 12 per urchin (which also flings you back to the entry). Numbers only show on tiles you've stood on. Reach the <b>pearl cache</b> to take 10% of the owner's PEARL (up to 20). A pool that's raided gets a 1-hour shield; you get 5 raids a day, and <b>revenge</b> on whoever raided you last is always allowed. {account ? '' : 'Guests can practise on the Driftwood Crabs’ pools (nothing is taken).'}</p>
            <ul className="pools">
              {pools.map((p) => (
                <li key={p.account}>
                  <span className="grow"><b>{p.crown && <span className="crown">♛ </span>}{p.name}</b> <small className="dim">{p.bot ? 'Driftwood Crab' : short(p.account)} · {p.pearls} PEARL</small>{p.revenge && <small className="mint"> · revenge!</small>}</span>
                  {p.shieldMs > 0 && !p.revenge
                    ? <small className="dim">shielded {Math.ceil(p.shieldMs / 60000)} min</small>
                    : <button className="small" disabled={!account && !p.bot} onClick={() => void begin(p)}>Raid</button>}
                </li>
              ))}
              {!pools.length && <li className="dim">No rockpools yet.</li>}
            </ul>
            {raids.length > 0 && <>
              <h3>Recent raids</h3>
              <table className="tbl small"><tbody>{raids.slice(0, 6).map((r) => <tr key={r.id}><td>{r.raider}</td><td>→ {r.owner}</td><td>{r.won ? <b className="mint">took pearls</b> : <span className="dim">turned back</span>}</td><td>{r.txs.map((t) => <a key={t.hash} href={t.url} target="_blank" rel="noreferrer">{t.what === 'begin_raid' ? 'begin ' : 'settle'}</a>)}</td></tr>)}</tbody></table>
            </>}
          </>
        ) : <Builder account={account} me={me} reload={load} />}
      </section>
    </main>
  );
}

// ---------- the raid ----------

const toWorld = (t: number): number => (t === RT_ROCK ? W_ROCK : t === RT_CACHE ? W_CACHE : t === RT_URCHIN ? W_URCHIN : t === RT_HIDDEN ? W_HIDDEN : t);

function Raid({ world, raid, done }: { world: World; raid: { id: string; owner: string; ownerName: string; onchain: boolean }; done: () => void }) {
  const [v, setV] = useState<RaidView | null>(null);
  const [busy, setBusy] = useState(false);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [result, setResult] = useState<{ taken: number } | null>(null);

  const show = useCallback((rv: RaidView) => {
    setV(rv);
    world.update({ tiles: rv.tiles.map(toWorld), items: rv.tiles.map(() => 0), crabs: [{ at: rv.at, name: 'You', color: SEAT_COLORS[0], stun: 0, pry: 0, crowned: false, me: true, pearls: rv.energy }] });
  }, [world]);

  const hop = useCallback(async (dir: number) => {
    if (!dir || busy) return;
    setBusy(true);
    try {
      const r = await api<{ view: RaidView; over: boolean }>('/raid/hop', { id: raid.id, dir });
      if (r.view.stings > (v?.stings ?? 0)) { sfx('sting'); world.fx('sting', POOL_ENTRY); } else sfx('hop', r.view.at);
      show(r.view);
      if (r.over) {
        sfx(r.view.won ? 'win' : 'lose');
        const rec = await api<{ txs: Tx[] }>(`/raid/${raid.id}`);
        setTxs(rec.txs);
        if (raid.onchain) {
          const chain = await fetchRaid(raid.id);
          setResult({ taken: chain?.taken ?? 0 });
        }
      }
    } catch { /* a refused hop (rock, edge) */ } finally { setBusy(false); }
  }, [busy, raid, show, v?.stings, world]);

  useEffect(() => {
    world.setBoard(POOL, POOL, new Array(POOL * POOL).fill(1));
    world.showReach = true;
    void api<{ view: RaidView }>('/raid/hop', { id: raid.id, dir: 0 }).then((r) => show(r.view)).catch(() => undefined);
    return () => { world.showReach = false; world.onTap = null; world.onMark = null; };
  }, [raid.id, show, world]);

  useEffect(() => {
    world.onTap = (tile) => { if (v && !v.over) void hop(dirTo(POOL, v.at, tile)); };
    world.onMark = (tile) => { if (world.toggleMark(tile)) sfx('mark'); };
    const key = (e: KeyboardEvent): void => { const d = KEY_DIRS[e.code]; if (d) { e.preventDefault(); void hop(d); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [hop, v, world]);

  if (!v) return <div className="hud"><div className="center panel-ish">Wading in…</div></div>;
  return (
    <div className="hud">
      <div className="hud-tl panel-ish raid-hud">
        <b>Raiding {raid.ownerName}</b>
        <div className="energy"><i style={{ width: `${(Math.max(0, v.energy) / RAID_ENERGY) * 100}%` }} /></div>
        <small>{Math.max(0, v.energy)} energy · {v.hops} hops · {v.stings} sting{v.stings === 1 ? '' : 's'}</small>
      </div>
      {!v.over && <div className="hint panel-ish">Tap a glowing tile next to you to hop (or WASD). Reach the big clam. Long-press / right-click flags a tile.</div>}
      <div className="tbtns">
        {!v.over && <button className="tbtn ghost" onClick={() => { void api('/raid/quit', { id: raid.id }).then(() => done()); }}>✕<small>Give up</small></button>}
      </div>
      {v.over && (
        <div className="center results card">
          <h2 className={v.won ? 'win' : 'lose'}>{v.won ? 'You reached the cache!' : 'Out of energy: turned back'}</h2>
          <p className="small">{raid.onchain ? (v.won ? `You took ${result ? result.taken : '…'} PEARL from ${raid.ownerName}; their pool is shielded for an hour.` : `${raid.ownerName}'s rockpool held: it earns them 2 PEARL.`) : 'Practice raid: nothing changed hands. Sign in to raid for real.'}</p>
          {txs.length > 0 && <ul className="txs small">{txs.map((t) => <li key={t.hash}><a href={t.url} target="_blank" rel="noreferrer">{t.what}</a></li>)}</ul>}
          {raid.onchain && <p className="small dim">Its layout stays secret until {raid.ownerName} rebuilds; then it's revealed onchain and <code>pnpm verify raid {raid.id}</code> replays your hops.</p>}
          <div className="row mid"><button className="big" onClick={done}>Back to the rockpools</button></div>
        </div>
      )}
    </div>
  );
}

async function fetchRaid(id: string): Promise<{ taken: number } | null> {
  for (let k = 0; k < 10; k++) {
    const r = await api<{ txs: Tx[] }>(`/raid/${id}`).catch(() => null);
    if (r?.txs.some((t) => t.what === 'settle_raid')) break;
    await new Promise((res) => setTimeout(res, 1500));
  }
  try {
    const cfg = await api<{ contract: string }>('/config');
    const res = await fetch('https://near-testnet.drpc.org', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'optimistic', account_id: cfg.contract, method_name: 'get_raid', args_base64: btoa(JSON.stringify({ raid_id: id })) } }) });
    const j = (await res.json()) as { result?: { result: number[] } };
    return j.result ? JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result))) as { taken: number } : null;
  } catch { return null; }
}

// ---------- the builder ----------

type Tool = 'u' | 'r' | 'c' | '.';
const TOOLS: { t: Tool; label: string }[] = [{ t: 'u', label: 'Urchin' }, { t: 'r', label: 'Rock' }, { t: 'c', label: 'Pearl cache' }, { t: '.', label: 'Sand' }];

function Builder({ account, me, reload }: { account: string | null; me: Me | null; reload: () => void }) {
  const [cells, setCells] = useState<string[]>(() => me?.layout?.split('') ?? starter());
  const [tool, setTool] = useState<Tool>('u');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => { if (me?.layout) setCells(me.layout.split('')); }, [me?.layout]);
  if (!account) return <p className="dim">Sign in with NEAR (top right) to build a rockpool. Your layout's hash goes onchain; the layout itself stays secret until you replace it.</p>;
  if (!me) return <p className="dim">Loading…</p>;
  if ((me.record?.rounds ?? 0) < 1) return <p className="dim">Dig one sandbar while signed in, then come back to build your rockpool.</p>;
  const layout = cells.join('');
  const err = layoutError(layout);
  const count = (ch: string): number => cells.filter((x) => x === ch).length;
  const paint = (i: number): void => {
    if (i === POOL_ENTRY) return;
    const next = cells.slice();
    if (tool === 'c') for (let k = 0; k < next.length; k++) if (next[k] === 'c') next[k] = '.';
    if (tool === 'u' && cells[i] !== 'u' && count('u') >= POOL_URCHINS) return;
    if (tool === 'r' && cells[i] !== 'r' && count('r') >= POOL_ROCKS) return;
    next[i] = next[i] === tool && tool !== 'c' ? '.' : tool;
    setCells(next);
    sfx('click');
  };
  const commit = async (): Promise<void> => {
    setBusy(true); setMsg('');
    try {
      const { hash } = await api<{ hash: string }>('/pool', { layout });
      const r = await call('build_rockpool', { hash });
      setMsg(`Committed ${r.gasless ? '(gasless)' : ''}: ${hash.slice(0, 12)}…`);
      await new Promise((res) => setTimeout(res, 1500));
      reload();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="builder">
      <p className="small dim">Hide up to {POOL_URCHINS} urchins and {POOL_ROCKS} rocks, and place your pearl cache at least three rows up. Raiders wade in at the marked bottom tile. There must be at least one urchin-free path to the cache. {me.layoutLive ? <b className="mint">Your pool is live onchain.</b> : me.pool ? 'Your onchain pool is from another device; commit again to replace it.' : 'Not committed yet.'}</p>
      <div className="seg">{TOOLS.map((x) => <button key={x.t} className={`small ${tool === x.t ? 'on' : 'ghost'}`} onClick={() => setTool(x.t)}>{x.label}</button>)}</div>
      <div className="pool-grid" style={{ gridTemplateColumns: `repeat(${POOL}, 1fr)` }}>
        {cells.map((c, i) => <button key={i} className={`pc c-${c === '.' ? 's' : c} ${i === POOL_ENTRY ? 'entry' : ''}`} onClick={() => paint(i)} aria-label={`tile ${i}`}>{c === 'u' ? '✸' : c === 'r' ? '▲' : c === 'c' ? '◉' : i === POOL_ENTRY ? '⇧' : ''}</button>)}
      </div>
      <p className="small">{count('u')}/{POOL_URCHINS} urchins · {count('r')}/{POOL_ROCKS} rocks {err ? <span className="err">· {err}</span> : <span className="mint">· ready</span>}</p>
      <div className="row"><button disabled={!!err || busy} onClick={() => void commit()}>{busy ? 'Committing…' : 'Commit to NEAR (gasless)'}</button><button className="ghost small" onClick={() => setCells(starter())}>Reset</button></div>
      {msg && <p className="small">{msg}</p>}
    </div>
  );
}

function starter(): string[] {
  const t = new Array(POOL * POOL).fill('.');
  t[POOL >> 1] = 'c';
  return t;
}
