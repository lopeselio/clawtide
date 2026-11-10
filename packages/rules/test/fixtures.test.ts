import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { boardSeed, logFromOpenings, replay, stateHash, type Opening, type Skill } from '../src/index.ts';

// Rounds settled on testnet, frozen: later tuning must never change how they replay.
interface Fx { id: string; seats: { name: string; kind: string }[]; difficulty: Skill; rules: number; vrf: string; secret: string; boardSeed: string; chunks: Opening[][]; endTick: number; stateHash: string; winner: number }
const dir = join(import.meta.dirname, 'fixtures');

describe('settled rounds replay forever', () => {
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    it(f, () => {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Fx;
      expect(boardSeed(r.vrf, r.secret)).toBe(r.boardSeed);
      const s = replay({ seed: r.boardSeed, rules: r.rules, difficulty: r.difficulty, seats: r.seats.map((x) => ({ name: x.name, ...(x.kind === 'bot' ? { bot: r.difficulty } : {}) })) }, logFromOpenings(r.chunks), undefined, r.endTick);
      expect(s.tick).toBe(r.endTick);
      expect(s.winner).toBe(r.winner);
      expect(stateHash(s)).toBe(r.stateHash);
    });
  }
});
