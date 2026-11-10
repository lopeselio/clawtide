// pnpm sim [rounds] : AI crabs on random sandbars, to check balance and that every round ends.
declare const process: { argv: string[] };
import { RULES_VERSION } from './constants.ts';
import { SHAPES } from './board.ts';
import { createState, step } from './sim.ts';
import type { Skill } from './bot.ts';

const n = Number(process.argv[2] ?? 40);
const skills: Skill[] = ['easy', 'normal', 'hard', 'normal'];
const wins = [0, 0, 0, 0], pearls = [0, 0, 0, 0], stings = [0, 0, 0, 0];
let ticks = 0, tide = 0;
const shapes: Record<string, number> = {};
for (let k = 0; k < n; k++) {
  const s = createState({ seed: `sim-${k}`, rules: RULES_VERSION, seats: skills.map((b, i) => ({ name: `${b}${i}`, bot: b })) });
  shapes[s.board.shape] = (shapes[s.board.shape] ?? 0) + 1;
  while (!s.over) step(s, []);
  ticks += s.tick;
  if (s.end === 'tide') tide++;
  if (s.winner !== null) wins[s.winner]++;
  s.crabs.forEach((c, i) => { pearls[i] += c.pearls; stings[i] += c.stings; });
}
console.log(`${n} sandbars (${SHAPES.map((x) => `${x} ${shapes[x] ?? 0}`).join(', ')})`);
console.log(`average length ${(ticks / n / 10).toFixed(1)} s; ${tide} ended with the last clam, ${n - tide} on the clock`);
skills.forEach((b, i) => console.log(`seat ${i} ${b.padEnd(6)} wins ${wins[i]}  pearls/round ${(pearls[i] / n).toFixed(1)}  stings/round ${(stings[i] / n).toFixed(1)}`));
