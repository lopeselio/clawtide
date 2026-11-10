import { useEffect, useRef, useState } from 'react';
import type { SimEvent, View } from '@clawtide/rules';
import type { LineMsg, ResultsMsg, SnapMsg, StartMsg } from './api.ts';
import { SEAT_COLORS, W_HIDDEN, type Frame, type World } from './scene.ts';
import { sfx, startSurf, stopSurf } from './sound.ts';

// A live sandbar: the 3D world fills the screen; the HUD floats on top. Tap/click a tile to walk
// there (the last hop digs), long-press/right-click (or Mark mode) to plant a kelp flag on a tile
// you think hides an urchin. Keyboard: WASD/arrows hop (Q E Z C diagonals), 1 dig the hovered
// tile, 2 mark it, 3 clack your claws, Space re-centres.

export const frameOf = (v: View, names?: string[]): Frame => ({
  tiles: v.tiles,
  items: v.items,
  crabs: v.crabs.map((c, i) => ({ at: c.at, name: names?.[i] ?? c.name, color: SEAT_COLORS[i % 4], stun: c.stun, pry: c.pry, crowned: v.crown === i, me: i === v.me, pearls: c.pearls })),
});

export const KEY_DIRS: Record<string, number> = {
  KeyW: 1, ArrowUp: 1, KeyE: 2, KeyD: 3, ArrowRight: 3, KeyC: 4, KeyS: 5, ArrowDown: 5, KeyZ: 6, KeyA: 7, ArrowLeft: 7, KeyQ: 8,
};

interface FeedLine { k: number; text: string; cls: string }
let feedK = 0;

/** Turns rule events into sounds, effects and feed lines. Shared with the guided tutorial. */
export function playEvents(world: World, ev: SimEvent[], v: View, push: (text: string, cls?: string) => void): void {
  const me = v.me;
  const name = (c: number): string => (c === me ? 'You' : v.crabs[c]?.name ?? '?');
  for (const e of ev) {
    switch (e.k) {
      case 'hop': if (e.c === me) sfx('hop', e.to); break;
      case 'reveal': if (e.tiles.length > 3) sfx('dig'); break;
      case 'pearl': if (e.c === me) sfx('pearl'); world.fx('pearl', e.at); break;
      case 'clam': world.fx('clam', e.at); sfx('clam'); push(`${name(e.c)} pried open a clam: +5 pearls`, e.c === me ? 'mine' : ''); break;
      case 'sting': world.fx('sting', e.at); if (e.c === me) sfx('sting'); push(`${name(e.c)} stepped on an urchin${e.lost ? ` and lost ${e.lost} pearl${e.lost > 1 ? 's' : ''}` : ''}!`, e.c === me ? 'bad' : ''); break;
      case 'pinch': sfx(e.c === me ? 'pinch' : e.from === me ? 'pinched' : 'pinch'); push(`${name(e.c)} pinched a pearl off the crowned ${e.from === me ? 'you' : name(e.from)}`, e.c === me ? 'mine' : e.from === me ? 'bad' : ''); break;
      case 'takeover': push(`${v.crabs[e.c]?.name} left; a Driftwood Crab takes over the shell`); break;
      case 'tide': sfx('tide'); world.tide(); push(e.reason === 'tide' ? 'The last clam is open: the tide swallows the sandbar!' : 'Time! The tide comes in.', 'big'); break;
    }
  }
}

export function Round({ world, start, results, lines, send, subscribe, next, leave, account }: {
  world: World; start: StartMsg; results: ResultsMsg | null; lines: LineMsg[]; send: (m: unknown) => void;
  subscribe: (fn: (s: SnapMsg) => void) => void; next: () => void; leave: () => void; account: string | null;
}) {
  const [v, setV] = useState<View>(start.v);
  const [sealed, setSealed] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [markMode, setMarkMode] = useState(false);
  const [help, setHelp] = useState(true);
  const markRef = useRef(false);
  markRef.current = markMode;
  const names = start.seats.map((s) => s.name);
  const push = (text: string, cls = ''): void => setFeed((f) => [{ k: feedK++, text, cls }, ...f].slice(0, 5));

  useEffect(() => {
    world.setBoard(start.w, start.h, start.land);
    world.update(frameOf(start.v, names));
    world.focus(start.v.crabs[start.you].at);
    world.showReach = false;
    startSurf();
    const mark = (tile: number): void => { if (world.toggleMark(tile)) sfx('mark'); };
    world.onTap = (tile) => { if (markRef.current) mark(tile); else { send({ t: 'go', tile }); sfx('click'); } setHelp(false); };
    world.onMark = mark;
    subscribe((s) => {
      setV(s.v);
      setSealed(s.sealed);
      world.update(frameOf(s.v, names));
      playEvents(world, s.ev, s.v, push);
    });
    const beeps: number[] = [];
    for (let k = 3; k >= 1; k--) beeps.push(window.setTimeout(() => sfx('beep'), start.startsAt - Date.now() - k * 1000));
    beeps.push(window.setTimeout(() => sfx('go'), start.startsAt - Date.now()));
    const key = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const d = KEY_DIRS[e.code];
      if (d) { e.preventDefault(); send({ t: 'hop', dir: d }); setHelp(false); return; }
      const h = world.hovered();
      if (e.code === 'Digit1' && h >= 0) send({ t: 'go', tile: h });
      if (e.code === 'Digit2' && h >= 0) mark(h);
      if (e.code === 'Digit3') { send({ t: 'emote' }); sfx('clack'); }
      if (e.code === 'Space') { e.preventDefault(); world.recenter(); }
    };
    window.addEventListener('keydown', key);
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => { window.removeEventListener('keydown', key); clearInterval(timer); beeps.forEach(clearTimeout); world.onTap = null; world.onMark = null; stopSurf(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start.roundId]);

  useEffect(() => { if (lines.length) push(`${lines[lines.length - 1].who}: “${lines[lines.length - 1].text}”`, 'line'); }, [lines.length]);
  useEffect(() => {
    if (!results) return;
    const won = results.winner === start.you;
    window.setTimeout(() => sfx(won ? 'win' : 'lose'), 900);
  }, [results?.roundId, results === null]);

  const me = v.crabs[v.me];
  const counting = now < start.startsAt;
  const secs = Math.max(0, Math.ceil((start.maxTicks - v.tick) / start.tickHz));
  const order = v.crabs.map((c, i) => ({ c, i })).sort((a, b) => b.c.pearls - a.c.pearls);
  const hiddenLeft = v.tiles.filter((t) => t === W_HIDDEN).length;

  return (
    <div className="hud">
      <div className="hud-tl panel-ish">
        <div className="pearls"><i className="pearl-ico" />{me.pearls}</div>
        <small>{me.stun ? <b className="bad">stung! dazed…</b> : me.pry ? <b className="mint">prying… {Math.round((me.pry / 18) * 100)}%</b> : `${me.clams} clam${me.clams === 1 ? '' : 's'} · ${me.stings} sting${me.stings === 1 ? '' : 's'}`}</small>
      </div>
      <div className="hud-tc panel-ish">
        <b>{start.shapeName}</b>
        <span>{v.clamsLeft} clam{v.clamsLeft === 1 ? '' : 's'} left</span>
        <span className={secs < 20 ? 'bad' : ''}>{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</span>
      </div>
      <ol className="scores panel-ish">
        {order.map(({ c, i }) => (
          <li key={i} className={i === v.me ? 'me' : ''}>
            <span className="dot" style={{ background: SEAT_COLORS[i] }} />
            <span className="nm">{v.crown === i && <b className="crown">♛ </b>}{start.seats[i]?.crowned && <b className="crown" title="holds the Pearl Crown this season">♛ </b>}{c.name}</span>
            <b>{c.pearls}</b>
          </li>
        ))}
      </ol>
      <div className="feed">{feed.map((f) => <p key={f.k} className={f.cls}>{f.text}</p>)}</div>
      <div className="chain-chip panel-ish">
        {start.onchain
          ? <>⛓ VRF draw <a href={start.txs[0]?.url} target="_blank" rel="noreferrer">✓</a> · sealed {sealed}×</>
          : <>⛓ offline round</>}
      </div>
      {help && !counting && !results && (
        <div className="hint panel-ish">
          <b>Tap a tile</b> to scuttle there; your last hop digs. Numbers count urchins in the 8 tiles around. <b>Long-press</b> or <b>right-click</b> to flag a tile. <span className="desk">Keys: WASD hop, 1 dig, 2 flag, 3 clack.</span>
        </div>
      )}
      <div className="tbtns">
        <button className={`tbtn ${markMode ? 'on' : 'ghost'}`} onClick={() => { setMarkMode(!markMode); sfx('click'); }} aria-pressed={markMode}>⚑<small>{markMode ? 'Flagging' : 'Flag'}</small></button>
        <button className="tbtn ghost" onClick={() => { send({ t: 'emote' }); sfx('clack'); }}>✂<small>Clack</small></button>
        <button className="tbtn ghost" onClick={() => world.recenter()}>◎<small>Me</small></button>
      </div>
      {counting && <div className="center big-count" key={Math.ceil((start.startsAt - now) / 1000)}>{Math.ceil((start.startsAt - now) / 1000)}</div>}
      {counting && <div className="center sub-count panel-ish">A <b>{start.shapeName}</b> rises: {start.clams} clams, {hiddenLeft} tiles of sand. {start.onchain ? 'Its layout comes from NEAR’s VRF draw.' : ''}</div>}
      {results && <Results r={results} you={start.you} next={next} leave={leave} account={account} />}
    </div>
  );
}

function Results({ r, you, next, leave, account }: { r: ResultsMsg; you: number; next: () => void; leave: () => void; account: string | null }) {
  const won = r.winner === you;
  const order = r.seats.map((s, i) => ({ s, i })).sort((a, b) => b.s.pearls - a.s.pearls);
  const banked = r.expected?.mints[you] ?? 0;
  return (
    <div className="center results card">
      <h2 className={won ? 'win' : 'lose'}>{won ? 'You win the sandbar!' : `${r.winner !== null ? r.seats[r.winner].name : 'Nobody'} wins the sandbar`}</h2>
      <p className="dim small">{r.end === 'tide' ? 'The last clam was opened and the tide swallowed the' : 'Time ran out on the'} {r.shapeName}.</p>
      <table className="tbl">
        <thead><tr><th /><th>Crab</th><th>Pearls</th><th>Clams</th><th>Stings</th><th>PEARL banked</th></tr></thead>
        <tbody>{order.map(({ s, i }) => (
          <tr key={i} className={i === you ? 'me' : ''}><td><span className="dot" style={{ background: SEAT_COLORS[i] }} /></td><td>{s.name}{i === r.winner && ' ♛'}</td><td>{s.pearls}</td><td>{s.clams}</td><td>{s.stings}</td><td>{s.account ? (r.expected?.mints[i] ?? 0) : <span className="dim">guest</span>}</td></tr>
        ))}</tbody>
      </table>
      {account
        ? <p className="small">{banked} PEARL {r.settled ? 'banked to' : 'will be banked to'} <b>{account}</b>{r.settled ? ' ✓' : ' (settling onchain…)'}</p>
        : <p className="small dim">Playing as a guest: sign in with NEAR to bank your pearls as PEARL and build a rockpool.</p>}
      {r.chain ? (
        <details className="small">
          <summary>Onchain proof: {r.settled ? 'settled ✓' : 'opening the log…'}</summary>
          <ul className="txs">{r.txs.map((t) => <li key={t.hash}><a href={t.url} target="_blank" rel="noreferrer">{t.what}</a></li>)}</ul>
          <p className="dim">Replay it yourself: <code>pnpm verify {r.roundId}</code></p>
        </details>
      ) : <p className="small dim">{r.error ?? 'Offline round: nothing went onchain.'}</p>}
      <div className="row mid">
        <button className="big" onClick={next}>Next sandbar</button>
        <button className="ghost" onClick={leave}>Leave</button>
      </div>
    </div>
  );
}
