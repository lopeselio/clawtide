import { useEffect, useRef, useState } from 'react';
import { RULES_VERSION, TICK_HZ, createState, nextStep, step, tutorialBoard, viewFor, type State, type View } from '@clawtide/rules';
import { KEY_DIRS, frameOf, playEvents } from './Round.tsx';
import type { World } from './scene.ts';
import { sfx, startSurf, stopSurf } from './sound.ts';

// The guided first sandbar. A hand-drawn board, the real rules, running right here in the browser
// (no server, nothing onchain). Prompts move on as you do each thing for the first time.

const LESSONS: { title: string; text: string }[] = [
  { title: 'Hop', text: 'Tap a sand tile next to your crab to hop there. On a keyboard: WASD or the arrow keys (Q E Z C for diagonals).' },
  { title: 'Grab a pearl', text: 'Pearls on dug-up sand belong to whoever gets there first. Tap one to scuttle over and grab it.' },
  { title: 'Pry a clam', text: 'See the lone buried tile at the bottom, surrounded by zeros? It can’t be an urchin, so something’s inside. Dig into it and stand still on the clam until it pops open.' },
  { title: 'Flag an urchin', text: 'Numbers count the urchins in the 8 tiles around. The 1 at the top right of the dug sand touches only one buried tile: that’s an urchin. Flag it: long-press it (phone), right-click it (desktop), or turn on Flag mode and tap.' },
  { title: 'Cross the urchin wall', text: 'Two clams lie beyond the urchins. Read the numbers to find the one safe gap. If you guess wrong you’re flung back to shore, dazed, but never out. Open both clams to bring in the tide.' },
];

export function Guided({ world, name, finish, quit }: { world: World; name: string; finish: () => void; quit: () => void }) {
  const st = useRef<State | null>(null);
  const goal = useRef(-1);
  const want = useRef(0);
  const [v, setV] = useState<View | null>(null);
  const [lesson, setLesson] = useState(0);
  const [markMode, setMarkMode] = useState(false);
  const [feed, setFeed] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const markRef = useRef(false);
  markRef.current = markMode;
  const lessonRef = useRef(0);
  const advance = (to: number): void => { if (lessonRef.current < to) { lessonRef.current = to; setLesson(to); sfx('pearl'); } };

  useEffect(() => {
    const s = createState({ seed: 'tutorial', rules: RULES_VERSION, seats: [{ name: name || 'You' }], board: tutorialBoard() });
    st.current = s;
    world.setBoard(s.board.w, s.board.h, s.board.land, 'tutorial');
    const v0 = viewFor(s, 0);
    world.update(frameOf(v0));
    world.focus(v0.crabs[0].at);
    world.showReach = true;
    setV(v0);
    startSurf();
    const mark = (tile: number): void => {
      if (world.toggleMark(tile)) { sfx('mark'); if (world.marks.size && lessonRef.current === 3) advance(4); }
    };
    world.onTap = (tile) => { if (markRef.current) mark(tile); else { goal.current = tile; want.current = 0; sfx('click'); } };
    world.onMark = mark;
    const key = (e: KeyboardEvent): void => {
      const d = KEY_DIRS[e.code];
      if (d) { e.preventDefault(); want.current = d; goal.current = -1; }
      const h = world.hovered();
      if (e.code === 'Digit1' && h >= 0) goal.current = h;
      if (e.code === 'Digit2' && h >= 0) mark(h);
      if (e.code === 'Digit3') sfx('clack');
    };
    window.addEventListener('keydown', key);
    const timer = setInterval(() => {
      const s = st.current!;
      if (s.over) return;
      const c = s.crabs[0];
      let input: number | undefined;
      if (!c.stun && !c.cool) {
        if (want.current) { input = want.current; want.current = 0; } else if (goal.current >= 0) {
          if (goal.current === c.at) goal.current = -1;
          else { input = nextStep(viewFor(s, 0), c.at, goal.current) || undefined; if (!input) goal.current = -1; }
        }
      }
      const { events } = step(s, [input]);
      const nv = viewFor(s, 0);
      for (const e of events) {
        if (e.k === 'hop') advance(1);
        if (e.k === 'pearl') advance(2);
        if (e.k === 'clam' && lessonRef.current <= 2) advance(3);
        if (e.k === 'sting') goal.current = -1;
      }
      playEvents(world, events, nv, (t) => setFeed((f) => [t, ...f].slice(0, 3)));
      world.update(frameOf(nv));
      setV(nv);
      if (s.over) { setOver(true); window.setTimeout(() => sfx('win'), 900); }
    }, 1000 / TICK_HZ);
    return () => { clearInterval(timer); window.removeEventListener('keydown', key); world.onTap = null; world.onMark = null; world.showReach = false; stopSurf(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!v) return null;
  const me = v.crabs[0];
  const L = LESSONS[Math.min(lesson, LESSONS.length - 1)];
  return (
    <div className="hud">
      <div className="hud-tl panel-ish">
        <div className="pearls"><i className="pearl-ico" />{me.pearls}</div>
        <small>{me.stun ? <b className="bad">stung! dazed…</b> : me.pry ? <b className="mint">prying… {Math.round((me.pry / 18) * 100)}%</b> : `${v.clamsLeft} clam${v.clamsLeft === 1 ? '' : 's'} left`}</small>
      </div>
      <div className="lesson card">
        <small className="dim">Practice sandbar · {Math.min(lesson + 1, LESSONS.length)} / {LESSONS.length}</small>
        <h3>{L.title}</h3>
        <p>{L.text}</p>
        <div className="dots">{LESSONS.map((_, i) => <i key={i} className={i < lesson ? 'done' : i === lesson ? 'on' : ''} />)}</div>
      </div>
      <div className="feed">{feed.map((f, k) => <p key={`${k}-${f}`}>{f}</p>)}</div>
      <div className="tbtns">
        <button className={`tbtn ${markMode ? 'on' : 'ghost'}`} onClick={() => { setMarkMode(!markMode); sfx('click'); }} aria-pressed={markMode}>⚑<small>{markMode ? 'Flagging' : 'Flag'}</small></button>
        <button className="tbtn ghost" onClick={() => world.recenter()}>◎<small>Me</small></button>
        <button className="tbtn ghost" onClick={quit}>✕<small>Skip</small></button>
      </div>
      {over && (
        <div className="center results card">
          <h2 className="win">The tide comes in!</h2>
          <p>You opened every clam and banked <b>{me.pearls} pearls</b> (practice pearls: nothing went onchain). That’s the whole game: now race up to three rivals for real.</p>
          <div className="row mid"><button className="big" onClick={finish}>Dig a real sandbar</button></div>
        </div>
      )}
    </div>
  );
}
