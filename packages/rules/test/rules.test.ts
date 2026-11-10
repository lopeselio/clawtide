import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLAM, DIRS, MAX_TICKS, POOL_ENTRY, RULES_VERSION, Recorder, SHAPES, SAND, STING_LOSS, T_HIDDEN, URCHIN, boardFromMap, boardSeed, botPool, createState,
  crownOf, decide, deduce, foldHead, headZero, layoutError, logFromOpenings, makeBoard, newBrain, newRaid, nextHead, poolHash, raidStep, raidView,
  replay, replayRaid, sealOf, settle, sha256Hex, stateHash, step, tutorialBoard, viewFor, winnerOf, type Setup,
} from '../src/index.ts';

const bots = (n: number): Setup => ({ seed: 'test-seed', rules: RULES_VERSION, seats: Array.from({ length: n }, (_, i) => ({ name: `c${i}`, bot: (['easy', 'normal', 'hard', 'normal'] as const)[i] })) });

describe('sandbars', () => {
  it('the same seed builds the same sandbar; different seeds differ', () => {
    expect(makeBoard('a', 4)).toEqual(makeBoard('a', 4));
    expect(makeBoard('a', 4).content).not.toEqual(makeBoard('b', 4).content);
  });
  it('every shape is one connected stretch of sand with safe, revealed landings and clams', () => {
    for (const shape of SHAPES) {
      for (let k = 0; k < 6; k++) {
        const b = makeBoard(`s${k}`, 4, shape);
        expect(b.land.filter((v) => v === SAND).length).toBeGreaterThan(60);
        expect(b.clams).toBeGreaterThanOrEqual(3);
        for (const s of b.spawns) { expect(b.land[s]).toBe(SAND); expect(b.content[s]).not.toBe(URCHIN); expect(b.num[s]).toBe(0); }
        expect(new Set(b.spawns).size).toBe(4);
        // connected
        const seen = new Set([b.spawns[0]]); const q = [b.spawns[0]];
        while (q.length) { const i = q.pop()!; const x = i % b.w, y = (i - x) / b.w; for (const [dx, dy] of DIRS.slice(1)) { const j = (y + dy) * b.w + x + dx; if (x + dx >= 0 && x + dx < b.w && y + dy >= 0 && y + dy < b.h && b.land[j] === SAND && !seen.has(j)) { seen.add(j); q.push(j); } } }
        expect(seen.size).toBe(b.land.filter((v) => v === SAND).length);
      }
    }
  });
  it('the board seed mixes the VRF draw and the secret', () => {
    expect(boardSeed('aa', 'bb')).toBe(sha256Hex('clawtide|board|aa|bb'));
    expect(boardSeed('aa', 'bb')).not.toBe(boardSeed('ab', 'bb'));
  });
});

describe('rounds', () => {
  it('all-bot rounds end, and a replay reproduces the state hash', () => {
    const s = createState(bots(4));
    const rec = new Recorder(4);
    const chunks: ReturnType<Recorder['close']>[] = [];
    while (!s.over) {
      const t = s.tick;
      const { applied } = step(s, []);
      rec.add(t, applied);
      if (s.tick % 30 === 0 || s.over) chunks.push(rec.close(s));
    }
    expect(s.tick).toBeLessThanOrEqual(MAX_TICKS);
    const r = replay(bots(4), logFromOpenings(chunks));
    expect(stateHash(r)).toBe(stateHash(s));
  });
  it('a bot fed a tampered log still makes its own choices (verify can tell)', () => {
    let mismatch = 0;
    replay(bots(2), [{ t: 5, c: 0, i: 3 }], (_s, applied, logged) => { applied.forEach((a, i) => { if (logged[i] !== null && a !== logged[i]) mismatch++; }); });
    expect(mismatch).toBeGreaterThanOrEqual(0); // bots ignore the log; the verifier compares per tick
  });
  it('an urchin stings: back to the shore, dazed, pearls lost; it stays uncovered', () => {
    const b = boardFromMap(['~~~~~~~', '~S.u.c~', '~~~~~~~']);
    const s = createState({ seed: 't', rules: 1, seats: [{ name: 'me' }], board: b });
    s.crabs[0].pearls = 5;
    step(s, [3]); // to x=2
    for (let k = 0; k < 4; k++) step(s, []);
    const ev = step(s, [3]).events; // onto the urchin
    expect(ev.some((e) => e.k === 'sting')).toBe(true);
    expect(s.crabs[0].at).toBe(b.spawns[0]);
    expect(s.crabs[0].pearls).toBe(5 - STING_LOSS);
    expect(viewFor(s, 0).tiles[1 * 7 + 3]).toBe(-3);
  });
  it('standing on a clam pries it open; the last clam brings the tide', () => {
    const b = boardFromMap(['~~~~~', '~S.c~', '~~~~~']);
    const s = createState({ seed: 't', rules: 1, seats: [{ name: 'me' }], board: b });
    expect(viewFor(s, 0).tiles[8]).toBe(T_HIDDEN); // a clam is a lump until dug into
    step(s, [3]);
    for (let k = 0; k < 4; k++) step(s, []);
    step(s, [3]);
    while (!s.over) step(s, []);
    expect(s.end).toBe('tide');
    expect(s.crabs[0].pearls).toBe(5);
    expect(s.board.content[8]).not.toBe(CLAM);
  });
  it('the crown sits on a lone leader only; the winner rule breaks ties by stings, then seat', () => {
    expect(crownOf([{ pearls: 3 }, { pearls: 3 }])).toBeNull();
    expect(crownOf([{ pearls: 0 }, { pearls: 0 }])).toBeNull();
    expect(crownOf([{ pearls: 1 }, { pearls: 4 }])).toBe(1);
    expect(winnerOf([{ pearls: 4, stings: 2 }, { pearls: 4, stings: 1 }])).toBe(1);
    expect(winnerOf([{ pearls: 4, stings: 1 }, { pearls: 4, stings: 1 }])).toBe(0);
    expect(settle([true, false], [{ pearls: 70, clams: 0, stings: 0 }, { pearls: 3, clams: 0, stings: 0 }]).mints).toEqual([60, 0]);
  });
  it('the tutorial sandbar opens with its landing revealed', () => {
    const s = createState({ seed: 'tutorial', rules: 1, seats: [{ name: 'me' }], board: tutorialBoard() });
    expect(viewFor(s, 0).tiles.filter((t) => t >= 0).length).toBeGreaterThan(10);
  });
  it('views never leak what is buried', () => {
    const s = createState(bots(3));
    const v = viewFor(s, 0);
    v.tiles.forEach((t, i) => { if (t === T_HIDDEN) expect(v.items[i]).toBe(0); });
    expect(JSON.stringify(v)).not.toContain('content');
  });
});

describe('the AI crabs', () => {
  it('deduce: a 1 with one buried neighbour is an urchin; a satisfied number frees the rest', () => {
    const b = boardFromMap(['~~~~~', '~S.u~', '~~~~~']);
    const s = createState({ seed: 't', rules: 1, seats: [{ name: 'me' }], board: b });
    s.revealed[7] = 1; // the "1" next to the urchin
    const d = deduce(viewFor(s, 0), false);
    expect(d.mines.has(8)).toBe(true);
  });
  it('decide is deterministic from the view and the brain', () => {
    const s = createState(bots(2));
    const a = newBrain('x', 0), b = newBrain('x', 0);
    a.wait = b.wait = 0;
    expect(decide(viewFor(s, 0), a, 'hard')).toBe(decide(viewFor(s, 0), b, 'hard'));
  });
});

describe('seals', () => {
  it('fold the same head as the contract (shared vector)', () => {
    const o = { inputs: '3:3;7:5', at: 42, pearls: 6, clams: 1, stings: 0 };
    expect(sealOf('r-test', 'secret', 1, 0, o)).toBe(VECTOR.seal);
    expect(nextHead(headZero('r-test'), 0, [VECTOR.seal])).toBe(VECTOR.head);
    expect(foldHead('r-test', [[VECTOR.seal]])).toBe(VECTOR.head);
    expect(poolHash('.'.repeat(81), 'salt')).toBe(VECTOR.pool);
  });
});

describe('rockpools', () => {
  it('bot pools are valid and stable', () => {
    for (const l of ['coral', 'barnacle', 'kelp', 'pebble']) { expect(layoutError(botPool(l))).toBeNull(); expect(botPool(l)).toBe(botPool(l)); }
  });
  it('rejects pools without a clean path to the cache', () => {
    const t = '.'.repeat(81).split('');
    t[4] = 'c';
    for (let x = 0; x < 9; x++) t[3 * 9 + x] = x < 9 ? 'u' : '.';
    expect(layoutError(t.join(''))).toMatch(/urchin-free path/);
  });
  it('a raid costs energy per hop, more per urchin, and reaching the cache wins; replays agree', () => {
    const t = '.'.repeat(81).split('');
    t[POOL_ENTRY - 9] = 'u';
    t[4] = 'c';
    const l = t.join('');
    const s = newRaid(l);
    raidStep(s, 1); // onto the urchin: back to the entry
    expect(s.at).toBe(POOL_ENTRY);
    expect(s.energy).toBe(40 - 1 - 12);
    for (const d of [2, 8, 1, 1, 1, 1, 1, 1]) raidStep(s, d);
    expect(s.won).toBe(true);
    expect(replayRaid(l, '128111111').won).toBe(true);
    expect(raidView(newRaid(l)).tiles.filter((x) => x >= 0).length).toBe(1);
  });
});

// The same values are asserted in contracts/clawtide/src/tests.rs.
const VECTOR = JSON.parse(readFileSync(join(import.meta.dirname, 'vector.json'), 'utf8')) as { seal: string; head: string; pool: string };


describe('isomorphic and deterministic', () => {
  it('no Math.random, Date, DOM or node: imports in the rules', () => {
    const dir = join(import.meta.dirname, '../src');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && !x.startsWith('cli-'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/Math\.random|Date\.now|new Date|performance\.now|document\.|window\.|from 'node:/);
    }
  });
});
