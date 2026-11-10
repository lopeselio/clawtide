import { useState, type ReactNode } from 'react';

// The first-run walkthrough: six illustrated cards. Shown once (remembered on this device);
// "How to play" reopens it. The pictures are tiny inline SVG boards, drawn here.

type Cell = '' | 'h' | 'u' | 'p' | 'c' | 'k' | 'f' | 'w' | `${number}`;
const SAND = '#f7e4b8', HIDDEN = '#dcb56f', WATER = '#1f8fb3';
const NUM = ['', '#1f5fae', '#2a8a4a', '#c4302b', '#2a3f8f'];

function Grid({ rows, glow = [] }: { rows: Cell[][]; glow?: [number, number][] }) {
  const s = 30;
  const h = rows.length, w = rows[0].length;
  return (
    <svg viewBox={`0 0 ${w * s} ${h * s}`} className="tut-svg" role="img" aria-hidden="true">
      {rows.map((r, y) => r.map((c, x) => {
        const X = x * s, Y = y * s;
        const glowing = glow.some(([gx, gy]) => gx === x && gy === y);
        return (
          <g key={`${x},${y}`}>
            <rect x={X + 1} y={Y + 1} width={s - 2} height={s - 2} rx={4} fill={c === 'w' ? WATER : c === 'h' || c === 'f' ? HIDDEN : SAND} stroke={glowing ? '#fff' : 'none'} strokeWidth={glowing ? 3 : 0} />
            {/^\d$/.test(c) && c !== '0' && <text x={X + s / 2} y={Y + s / 2 + 7} textAnchor="middle" fontSize="19" fontWeight="900" fill={NUM[Number(c)] ?? '#222'}>{c}</text>}
            {c === 'u' && <g transform={`translate(${X + s / 2},${Y + s / 2})`}><circle r="7" fill="#3b1f52" />{[0, 45, 90, 135, 180, 225, 270, 315].map((a) => <line key={a} x1="0" y1="0" x2={Math.cos((a * Math.PI) / 180) * 12} y2={Math.sin((a * Math.PI) / 180) * 12} stroke="#6c3fa0" strokeWidth="2.5" />)}</g>}
            {c === 'p' && <circle cx={X + s / 2} cy={Y + s / 2} r="6" fill="#fff6ff" stroke="#c9b8e8" strokeWidth="2" />}
            {c === 'c' && <g><ellipse cx={X + s / 2} cy={Y + s / 2 + 3} rx="11" ry="6" fill="#ff9eb5" /><ellipse cx={X + s / 2} cy={Y + s / 2 - 3} rx="11" ry="6" fill="#ffc7d4" /><circle cx={X + s / 2} cy={Y + s / 2} r="3" fill="#fff" /></g>}
            {c === 'k' && <g><rect x={X + 8} y={Y + 15} width="14" height="8" rx="2" fill="#e0533b" /><rect x={X + 10} y={Y + 6} width="10" height="10" rx="3" fill="#ff7a59" /><rect x={X + 4} y={Y + 13} width="5" height="5" fill="#e0533b" /><rect x={X + 21} y={Y + 13} width="5" height="5" fill="#e0533b" /></g>}
            {c === 'f' && <g><rect x={X + 13} y={Y + 6} width="2.5" height="18" fill="#2f8f4e" /><path d={`M${X + 15.5} ${Y + 6} l10 4 l-10 4 z`} fill="#ff4d6d" /></g>}
          </g>
        );
      }))}
    </svg>
  );
}

const STEPS: { title: string; art: ReactNode; body: ReactNode }[] = [
  {
    title: 'Race to dig the sandbar',
    art: <Grid rows={[['w', 'w', 'w', 'w', 'w', 'w'], ['w', 'k', '', 'p', 'h', 'w'], ['w', '', '1', 'h', 'h', 'w'], ['w', 'w', 'w', 'w', 'w', 'w']]} glow={[[3, 1]]} />,
    body: <>Up to four hermit crabs land on a tidal sandbar. <b>Tap a tile</b> to scuttle there (or use WASD); your last hop digs into buried sand. Grab <b>pearls</b> and pry open <b>clams</b> before your rivals do. Everything that's dug up is shared: if you uncover a pearl, anyone can snatch it.</>,
  },
  {
    title: 'Numbers count urchins',
    art: <Grid rows={[['h', 'u', 'h'], ['1', '2', 'u'], ['0', '1', '1']]} glow={[[1, 1]]} />,
    body: <>Every dug tile shows how many <b>sea urchins</b> hide in the 8 tiles around it. A <b>2</b> touching exactly two buried tiles means both are urchins. A <b>0</b> opens its whole neighbourhood at once. Plant a <b>kelp flag</b> on tiles you're sure about: <b>long-press</b> on a phone, <b>right-click</b> on desktop, or switch on <b>Flag</b> mode.</>,
  },
  {
    title: 'Urchins sting',
    art: <Grid rows={[['w', 'w', 'w', 'w', 'w'], ['k', '', '1', 'u', 'w'], ['w', '', '1', 'f', 'w'], ['w', 'w', 'w', 'w', 'w']]} glow={[[3, 1]]} />,
    body: <>Hop onto a buried urchin and it <b>flings you back to the shore</b> where you landed, dazed for a moment and 2 pearls lighter. Nobody is ever out: shake it off and dig on. The urchin stays uncovered as a warning to everyone.</>,
  },
  {
    title: 'Clams, and the tide',
    art: <Grid rows={[['w', 'w', 'w', 'w', 'w'], ['w', '0', '0', '0', 'w'], ['w', '0', 'c', '0', 'w'], ['w', 'w', 'w', 'w', 'w']]} glow={[[2, 2]]} />,
    body: <>Clams stay buried until someone digs right into them: a lone lump among zeros is a giveaway. <b>Stand still on a clam</b> for two seconds to pry it open: <b>+5 pearls</b>. When the <b>last clam</b> is opened, the tide swallows the sandbar and a new one rises: atolls, twin bars, horseshoes, shoals, eel spits.</>,
  },
  {
    title: 'The Pearl Crown',
    art: <div className="tut-crown">♛</div>,
    body: <>Whoever holds the most pearls wears the <b>crown</b>, and everyone hunts them: hop onto the crowned crab's tile to <b>pinch a pearl</b>. Across a 7-day season the crown sits on the richest crab in PEARL. After your first round you can build a <b>rockpool</b> of hidden urchins, and <b>raid</b> other crabs' pools with an energy gauge to steal a share of their PEARL.</>,
  },
  {
    title: 'What goes onchain',
    art: <div className="tut-chain"><span>sha256(secret)</span>→<span>NEAR VRF</span>→<span>board</span></div>,
    body: <>Before a sandbar exists, the referee commits the hash of a secret to the Clawtide contract on NEAR testnet. In a <b>later receipt</b> the contract draws a seed from the block's <b>VRF randomness</b>; the board is built from both, so neither the server nor any player can choose it. Every 3 seconds each crab's hops are <b>sealed</b> onchain; at the end the secret and the log are opened, the contract checks every seal and banks <b>PEARL</b> (a NEP-141 token). Anyone can replay a round with <code>pnpm verify</code>. Guests play without a wallet.</>,
  },
];

export function Walkthrough({ done, finishLabel = 'Try a practice sandbar' }: { done: () => void; finishLabel?: string }) {
  const [k, setK] = useState(0);
  const s = STEPS[k];
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="How to play">
      <div className="card tut">
        <div className="tut-art">{s.art}</div>
        <small className="dim">{k + 1} / {STEPS.length}</small>
        <h2>{s.title}</h2>
        <p>{s.body}</p>
        <div className="dots">{STEPS.map((_, i) => <i key={i} className={i === k ? 'on' : ''} onClick={() => setK(i)} />)}</div>
        <div className="row mid">
          {k > 0 && <button className="ghost" onClick={() => setK(k - 1)}>Back</button>}
          {k < STEPS.length - 1 ? <button onClick={() => setK(k + 1)}>Next</button> : <button onClick={done}>{finishLabel}</button>}
          {k < STEPS.length - 1 && <button className="ghost small" onClick={done}>Skip</button>}
        </div>
      </div>
    </div>
  );
}
