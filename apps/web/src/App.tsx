import { useCallback, useEffect, useRef, useState } from 'react';
import { RULES_VERSION, createState, step, viewFor, type Skill } from '@clawtide/rules';
import { api, explorerAccount, short, type AgentAct, type Board, type Difficulty, type LineMsg, type Me, type ResultsMsg, type RoomMsg, type RoundRow, type ServerConfig, type ServerMsg, type SnapMsg, type StartMsg } from './api.ts';
import { Guided } from './Guided.tsx';
import { Net, getDifficulty, getName, setDifficulty, setName, setTutorialDone, setWalkthroughDone, tutorialDone, walkthroughDone } from './net.ts';
import { Rockpools } from './Rockpool.tsx';
import { Round, frameOf } from './Round.tsx';
import { SEAT_COLORS, World } from './scene.ts';
import { isMuted, setMuted, sfx, unlockAudio } from './sound.ts';
import { Walkthrough } from './Walkthrough.tsx';
import { setContract, signIn, signOut } from './wallet.ts';

// The shell: one three.js world behind everything; title, walkthrough, practice, room, round and
// rockpools on top. On the title screen four Driftwood Crabs dig a random sandbar in attract mode.

type Screen = 'title' | 'tutorial' | 'room' | 'round' | 'rockpools';

export function App() {
  const host = useRef<HTMLDivElement>(null);
  const [world, setWorld] = useState<World | null>(null);
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [mute, setMute] = useState(isMuted());
  const [screen, setScreen] = useState<Screen>('title');
  const [room, setRoom] = useState<RoomMsg | null>(null);
  const [start, setStart] = useState<StartMsg | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [results, setResults] = useState<ResultsMsg | null>(null);
  const [lines, setLines] = useState<LineMsg[]>([]);
  const [err, setErr] = useState('');
  const [walk, setWalk] = useState<null | (() => void)>(null);
  const net = useRef<Net | null>(null);
  const snapSink = useRef<((s: SnapMsg) => void) | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const w = new World(host.current);
    // a handle for capture scripts (the README's thumbnail recipe)
    (window as unknown as { __clawtide?: World }).__clawtide = w;
    setWorld(w);
    return () => w.dispose();
  }, []);

  useEffect(() => {
    void api<ServerConfig>('/config').then((c) => { setCfg(c); setContract(c.contract); }).catch(() => undefined);
    void api<{ accountId: string }>('/me').then((m) => setAccount(m.accountId)).catch(() => setAccount(null));
    const key = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.code === 'KeyM') { const m = !isMuted(); setMuted(m); setMute(m); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  // attract mode: AI crabs dig random sandbars behind the title screen
  useEffect(() => {
    if (!world || screen !== 'title') return;
    let s = createState({ seed: `title-${Math.floor(Math.random() * 1e9)}`, rules: RULES_VERSION, seats: (['hard', 'normal', 'normal', 'easy'] as Skill[]).map((b, i) => ({ name: ['Captain Pincer', 'Kelpie', 'Coral', 'Skitter'][i], bot: b })) });
    world.setBoard(s.board.w, s.board.h, s.board.land, s.board.shape);
    let wait = 0;
    const t = setInterval(() => {
      if (s.over) {
        if (++wait < 30) return;
        wait = 0;
        s = createState({ seed: `title-${Math.floor(Math.random() * 1e9)}`, rules: RULES_VERSION, seats: s.crabs.map((c) => ({ name: c.name, bot: c.bot ?? 'normal' })) });
        world.setBoard(s.board.w, s.board.h, s.board.land, s.board.shape);
      }
      const { events } = step(s, []);
      const v = viewFor(s, -1);
      world.update({ ...frameOf(v), crabs: frameOf(v).crabs.map((c) => ({ ...c, me: false })) });
      for (const e of events) { if (e.k === 'sting') world.fx('sting', e.at); if (e.k === 'clam') world.fx('clam', e.at); if (e.k === 'tide') world.tide(); }
    }, 100);
    return () => clearInterval(t);
  }, [world, screen]);

  const onMsg = useCallback((m: ServerMsg) => {
    switch (m.t) {
      case 'room':
        setRoom(m);
        if (m.phase === 'lobby') { setScreen('room'); setResults(null); setStart(null); setDrawing(false); }
        break;
      case 'drawing': setDrawing(true); setScreen('room'); break;
      case 'start': setStart(m); setResults(null); setLines([]); setDrawing(false); setScreen('round'); break;
      case 'snap': snapSink.current?.(m); break;
      case 'line': setLines((l) => [...l, m]); break;
      case 'emote': if (world && start) { world.fx('emote', 0, m.seat); sfx('clack'); } break;
      case 'results': setResults(m); break;
      case 'error': setErr(m.msg); break;
      case 'kicked': setErr('The host removed you from the room.'); setScreen('title'); break;
    }
  }, [world, start]);

  const connect = useCallback((first: unknown) => {
    unlockAudio();
    setErr('');
    net.current?.close();
    const n = new Net((m) => onMsgRef.current(m), () => { setErr('Lost the connection to the server.'); setScreen('title'); });
    net.current = n;
    n.send({ t: 'hello', name: getName() || 'Crab' });
    n.send(first);
  }, []);
  const onMsgRef = useRef(onMsg);
  onMsgRef.current = onMsg;

  const leave = useCallback(() => {
    net.current?.send({ t: 'leave' });
    net.current?.close();
    net.current = null;
    setScreen('title'); setRoom(null); setStart(null); setResults(null);
  }, []);

  /** First visit: the walkthrough, then the practice sandbar, then the real thing. */
  const play = (go: () => void): void => {
    unlockAudio();
    if (!walkthroughDone()) setWalk(() => () => { setWalkthroughDone(); setScreen('tutorial'); });
    else if (!tutorialDone()) setScreen('tutorial');
    else go();
  };
  const quick = (): void => connect({ t: 'quick', bots: 3, difficulty: getDifficulty() });

  return (
    <>
      <div ref={host} className="world" />
      <header className="top">
        <a className="logo" href="/" onClick={(e) => { e.preventDefault(); if (screen !== 'round') { leave(); } }}>CLAWTIDE</a>
        <span className="grow" />
        <button className="ghost small hide-narrow" onClick={() => setWalk(() => () => setWalkthroughDone())}>How to play</button>
        <button className="ghost small" onClick={() => { const m = !mute; setMuted(m); setMute(m); }} title="Sound (M)" aria-label="Sound">{mute ? '♪ off' : '♪ on'}</button>
        <AccountBox account={account} setAccount={setAccount} />
      </header>
      {err && <div className="banner err" onClick={() => setErr('')}>{err}</div>}
      {world && screen === 'title' && !walk && (
        <Title cfg={cfg} account={account}
          play={() => play(quick)}
          practice={() => { unlockAudio(); setScreen('tutorial'); }}
          howto={() => setWalk(() => () => setWalkthroughDone())}
          create={() => play(() => connect({ t: 'create', difficulty: getDifficulty() }))}
          join={(code) => play(() => connect({ t: 'join', code }))}
          rockpools={() => { unlockAudio(); setScreen('rockpools'); }} />
      )}
      {world && screen === 'tutorial' && <Guided world={world} name={getName()} finish={() => { setTutorialDone(); quick(); }} quit={() => { setTutorialDone(); setScreen('title'); }} />}
      {screen === 'room' && room && <Lobby room={room} drawing={drawing} send={(m) => net.current?.send(m)} leave={leave} />}
      {screen === 'room' && !room && drawing && <div className="center panel-ish">The tide is drawing a sandbar…</div>}
      {world && screen === 'round' && start && (
        <Round key={start.roundId} world={world} start={start} results={results} lines={lines} send={(m) => net.current?.send(m)}
          subscribe={(fn) => { snapSink.current = fn; }} account={account}
          next={() => { net.current?.send({ t: 'again' }); if (room?.quick) net.current?.send({ t: 'ready', ready: true }); }} leave={leave} />
      )}
      {world && screen === 'rockpools' && <Rockpools world={world} account={account} name={getName() || 'Crab'} back={() => setScreen('title')} />}
      {walk && <Walkthrough done={() => { const f = walk; setWalk(null); f(); }} finishLabel={walkthroughDone() ? 'Got it' : 'Try a practice sandbar'} />}
    </>
  );
}

function AccountBox({ account, setAccount }: { account: string | null; setAccount: (a: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (account) {
    return (
      <span className="acct">
        <a href={explorerAccount(account)} target="_blank" rel="noreferrer">{short(account)}</a>
        <button className="ghost small" onClick={() => { void signOut().then(() => setAccount(null)); }}>Sign out</button>
      </span>
    );
  }
  return (
    <span className="acct">
      {err && <small className="err" title={err}>sign-in failed</small>}
      <button className="small" disabled={busy} onClick={() => {
        setBusy(true); setErr('');
        signIn().then(setAccount).catch((e: Error) => setErr(e.message)).finally(() => setBusy(false));
      }}>{busy ? 'Waiting for wallet…' : 'Sign in with NEAR'}</button>
    </span>
  );
}

// ---------- title ----------

const DIFFS: { d: Difficulty; label: string; hint: string }[] = [
  { d: 'easy', label: 'Easy', hint: 'slow, careless crabs: learn the numbers' },
  { d: 'normal', label: 'Normal', hint: 'steady crabs that read the numbers well' },
  { d: 'hard', label: 'Hard', hint: 'quick crabs that chain deductions' },
];
function DifficultyPicker({ value, onChange }: { value: Difficulty; onChange: (d: Difficulty) => void }) {
  return (
    <div className="difficulty">
      <div className="seg" role="radiogroup" aria-label="AI crab difficulty">
        {DIFFS.map((x) => <button key={x.d} role="radio" aria-checked={value === x.d} className={`small ${value === x.d ? 'on' : 'ghost'}`} onClick={() => onChange(x.d)}>{x.label}</button>)}
      </div>
      <small className="dim">{DIFFS.find((x) => x.d === value)?.hint}</small>
    </div>
  );
}

function Title({ cfg, account, play, practice, howto, create, join, rockpools }: {
  cfg: ServerConfig | null; account: string | null; play: () => void; practice: () => void; howto: () => void; create: () => void; join: (code: string) => void; rockpools: () => void;
}) {
  const [name, setNameState] = useState(getName());
  const [difficulty, setDiff] = useState<Difficulty>(getDifficulty());
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get('room')?.toUpperCase() ?? '');
  const [board, setBoard] = useState<Board | null>(null);
  const [rounds, setRounds] = useState<RoundRow[]>([]);
  const [acts, setActs] = useState<AgentAct[]>([]);
  const [open, setOpen] = useState(false);
  const keep = (): void => setName(name.trim().slice(0, 20));

  useEffect(() => {
    document.title = 'Clawtide';
    const load = (): void => {
      void api<Board>('/leaderboard').then(setBoard).catch(() => undefined);
      void api<RoundRow[]>('/rounds').then(setRounds).catch(() => undefined);
      void api<AgentAct[]>('/agents').then(setActs).catch(() => undefined);
    };
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);
  const crown = board?.crown;
  const seasonEnds = board?.season ? Math.max(0, Number(BigInt(board.season.ends_ns) / 1_000_000n) - Date.now()) : 0;

  return (
    <main className="title">
      <section className="hero card">
        <h1>CLAWTIDE</h1>
        <div className="tag">competitive minesweeper for hermit crabs, on NEAR</div>
        <p>Race up to three rival crabs (four on the sand) across a tidal sandbar. Numbers tell you how many <b>sea urchins</b> are buried around each tile; dig out <b>pearls</b> and pry open <b>clams</b> before your rivals. When the last clam opens, the tide swallows the sandbar and a new one rises. Every board comes from <b>NEAR’s VRF</b>, and every round is sealed onchain.</p>
        <label className="name">Your name <input value={name} maxLength={20} placeholder="Crab" onChange={(e) => setNameState(e.target.value.replace(/[^A-Za-z0-9 _.'-]/g, ''))} onBlur={keep} /></label>
        <button className="big" onClick={() => { keep(); sfx('click'); play(); }}>{walkthroughDone() && tutorialDone() ? 'Dig a sandbar' : 'Play'}</button>
        <DifficultyPicker value={difficulty} onChange={(d) => { setDiff(d); setDifficulty(d); sfx('click'); }} />
        <div className="row mid wrap">
          <button className="ghost" onClick={() => { keep(); rockpools(); }}>Rockpools &amp; raids</button>
          <button className="ghost" onClick={practice}>Practice sandbar</button>
          <button className="ghost" onClick={howto}>How to play</button>
        </div>
        <div className="row mid wrap">
          <button className="ghost small" onClick={() => { keep(); create(); }}>Create a room</button>
          <input className="code" value={code} maxLength={4} placeholder="CODE" aria-label="Room code" onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} />
          <button className="ghost small" disabled={code.length !== 4} onClick={() => { keep(); join(code); }}>Join</button>
        </div>
        <p className="dim small">No wallet needed to play. {account ? '' : 'Sign in with NEAR to bank pearls as PEARL, build a rockpool and chase the Pearl Crown.'}</p>
        <button className="ghost small more" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} the crown, the ledger and the proofs</button>
      </section>

      {open && (
        <div className="grid">
          <section className="panel">
            <h2>♛ The Pearl Crown</h2>
            {crown ? <p><b className="gold">{crown.name || short(crown.account)}</b> holds the crown with <b>{crown.pearls} PEARL</b>. Raid their rockpool to knock them off it.</p> : <p className="dim">{cfg && !cfg.chain ? 'Offline mode (CHAIN=0).' : 'Nobody yet. Bank pearls to claim it.'}</p>}
            {board?.season && <p className="small dim">Season {board.season.season} · ends in {Math.ceil(seasonEnds / 3_600_000)} h · {board.season.rounds_settled} sandbars and {board.season.raids} raids settled · {board.season.supply} PEARL in existence</p>}
            {(board?.rows.length ?? 0) > 0 && <table className="tbl"><thead><tr><th>#</th><th>Crab</th><th>PEARL</th><th>this season</th><th>wins</th></tr></thead><tbody>{board!.rows.slice(0, 10).map((r, i) => <tr key={r.account} className={r.account === account ? 'me' : ''}><td>{i + 1}</td><td>{i === 0 && '♛ '}{r.name || short(r.account)}</td><td>{r.pearls}</td><td>{r.season_pearls}</td><td>{r.wins}</td></tr>)}</tbody></table>}
          </section>
          {account ? <YourCrab account={account} /> : (
            <section className="panel">
              <h2>Your crab</h2>
              <p className="dim">Playing as a guest. Guests play every mode, but a guest round banks no PEARL for anyone (AI crabs included).</p>
              <p className="small dim">Sign in with NEAR (top right) to bank your pearls as PEARL, keep a record onchain and, after one sandbar, build a rockpool.</p>
            </section>
          )}
          <section className="panel">
            <h2>The Driftwood Crabs</h2>
            <p className="dim small">AI rivals with their own NEAR accounts (function-call keys that can only build rockpools). In a round each sees exactly what you see and deduces from the numbers; the difficulty sets how fast and how cleverly. Their pre-round taunts come from a NEAR AI model in a TEE; the model never plays.</p>
            <ul className="bots">{(cfg?.bots ?? []).map((b, i) => <li key={b.label}><span className="dot" style={{ background: SEAT_COLORS[i % 4] }} /><b>{b.name}</b> <a href={explorerAccount(b.account)} target="_blank" rel="noreferrer">{b.account}</a></li>)}</ul>
            {acts.slice(0, 3).map((a) => <p key={a.at} className="small dim">{a.who} {a.what} {a.url && <a href={a.url} target="_blank" rel="noreferrer">tx</a>}</p>)}
          </section>
          <section className="panel">
            <h2>Recent sandbars</h2>
            {rounds.length === 0 ? <p className="dim">None yet.</p> : (
              <table className="tbl"><tbody>{rounds.slice(0, 8).map((r) => <tr key={r.id}><td><a href={`/api/round/${r.id}`} target="_blank" rel="noreferrer">{r.id}</a></td><td>{r.winner !== null ? `${r.names[r.winner]} won` : '–'}</td><td>{r.settled ? '✓ settled' : '…'}</td></tr>)}</tbody></table>
            )}
            <p className="dim small">Check one yourself: <code>pnpm verify &lt;roundId&gt;</code> replays it from the opened log and the chain.</p>
          </section>
          <section className="panel">
            <h2>How the sandbar is kept honest</h2>
            <ol className="small">
              <li><b>Commit.</b> The referee posts sha256 of a secret to the contract.</li>
              <li><b>VRF draw.</b> In a later receipt the contract draws NEAR’s block randomness. Board = sha256(draw | secret): nobody could pick it.</li>
              <li><b>Seals.</b> Every 3 s each crab’s hops and score are hashed onchain.</li>
              <li><b>Open.</b> At the tide the secret and the log are revealed; the contract rebuilds every seal before it mints PEARL.</li>
            </ol>
            <p className="dim small">Contract {cfg ? <a href={explorerAccount(cfg.contract)} target="_blank" rel="noreferrer">{cfg.contract}</a> : '…'} on NEAR testnet.</p>
          </section>
        </div>
      )}
      <footer className="foot">Testnet only · procedural voxels and synthesised sound · part of the <a href="https://arcade.lopeselio.online/" target="_blank" rel="noreferrer">NEAR Arcade</a> · <a href="https://github.com/lopeselio/clawtide" target="_blank" rel="noreferrer">source</a></footer>
    </main>
  );
}

function YourCrab({ account }: { account: string }) {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => { void api<Me>('/me').then(setMe).catch(() => setMe(null)); }, [account]);
  const r = me?.record;
  return (
    <section className="panel">
      <h2>Your crab</h2>
      {!me ? <p className="dim">Loading…</p> : (
        <>
          <p><b className="gold">{me.balance} PEARL</b> · {r?.rounds ?? 0} sandbars · {r?.wins ?? 0} wins · {r?.clams ?? 0} clams · {r?.stings ?? 0} stings</p>
          <p className="small dim">Raids: {r?.raids_won ?? 0} won, {r?.raids_failed ?? 0} turned back · your pool was raided {r?.raided ?? 0}× and held {r?.defended ?? 0}×. {me.layoutLive ? 'Rockpool live.' : (r?.rounds ?? 0) >= 1 ? 'Build your rockpool from Rockpools & raids.' : 'Dig one sandbar to unlock your rockpool.'}</p>
        </>
      )}
    </section>
  );
}

// ---------- room ----------

function Lobby({ room, drawing, send, leave }: { room: RoomMsg; drawing: boolean; send: (m: unknown) => void; leave: () => void }) {
  const me = room.seats[room.you];
  const link = `${location.origin}/?room=${room.code}`;
  const [bot, setBot] = useState('');
  if (room.quick || drawing || room.phase === 'drawing') {
    return <div className="center panel-ish drawing"><b>The tide is drawing a sandbar…</b><br /><small className="dim">The secret’s hash is committed; NEAR’s VRF picks the rest.</small></div>;
  }
  return (
    <main className="lobby">
      <section className="panel">
        <h2>Room <span className="roomcode">{room.code}</span></h2>
        <p className="dim small">Send the code or the link; up to 4 crabs. Everyone presses Ready to start.</p>
        <div className="row"><input readOnly value={link} onFocus={(e) => e.target.select()} /><button className="ghost small" onClick={() => void navigator.clipboard?.writeText(link)}>Copy</button></div>
        <ul className="seats">
          {room.seats.map((s, i) => (
            <li key={i} className={s.ready ? 'ready' : ''}>
              <span className="dot" style={{ background: SEAT_COLORS[i] }} />
              <b>{s.name}</b>{i === room.you && ' (you)'} <small className="dim">{s.kind === 'bot' ? 'Driftwood Crab' : s.signedIn ? 'signed in' : 'guest'}</small>
              <span className="grow" />{s.ready ? '✓ ready' : 'waiting'}
              {room.host && i !== room.you && <button className="ghost small" onClick={() => send({ t: 'kick', seat: i })} aria-label={`Remove ${s.name} from the room`}>✕</button>}
            </li>
          ))}
        </ul>
        {room.host
          ? <DifficultyPicker value={room.difficulty} onChange={(d) => { setDifficulty(d); send({ t: 'difficulty', difficulty: d }); }} />
          : <p className="small dim">AI crabs play on <b>{room.difficulty}</b> (the host picks).</p>}
        {room.host && room.seats.length < 4 && (
          <div className="row">
            <select value={bot} onChange={(e) => setBot(e.target.value)}><option value="">any crab</option>{room.bots.filter((b) => !room.seats.some((s) => s.name === b.name)).map((b) => <option key={b.label} value={b.label}>{b.name}</option>)}</select>
            <button className="ghost small" onClick={() => send({ t: 'addBot', label: bot || undefined })}>Add a Driftwood Crab</button>
          </div>
        )}
        <div className="row">
          <button onClick={() => send({ t: 'ready', ready: !me?.ready })}>{me?.ready ? 'Not ready' : 'Ready'}</button>
          <button className="ghost" onClick={leave}>Leave</button>
        </div>
        {room.seats.length < 2 && <p className="dim small">A sandbar needs at least two crabs: add a Driftwood Crab or wait for a friend.</p>}
      </section>
    </main>
  );
}
