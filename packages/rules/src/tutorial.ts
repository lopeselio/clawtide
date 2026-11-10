import { CLAM, EMPTY, PEARL, SAND, URCHIN, WATER, numbers, type Board } from './board.ts';

// The guided first sandbar: drawn by hand so every lesson comes up in order. It runs in the
// browser with the same rules as a real round, with no server and nothing onchain.
//   ~ water   . sand   p pearl   c clam   u urchin   S where you land

export const TUTORIAL_MAP = [
  '~~~~~~~~~~~~~~~',
  '~~...p..u..c.~~',
  '~S.......u...~~',
  '~..p.......p.~~',
  '~~...c...u..c~~',
  '~~~~~~~~~~~~~~~',
];

export function boardFromMap(rows: string[]): Board {
  const h = rows.length, w = rows[0].length;
  const land: number[] = [], content: number[] = [], spawns: number[] = [];
  rows.forEach((row, y) => row.split('').forEach((ch, x) => {
    land.push(ch === '~' ? WATER : SAND);
    content.push(ch === 'u' ? URCHIN : ch === 'p' ? PEARL : ch === 'c' ? CLAM : EMPTY);
    if (ch === 'S') spawns.push(y * w + x);
  }));
  return { shape: 'bar', w, h, land, content, num: numbers(w, h, content), spawns, clams: content.filter((c) => c === CLAM).length };
}

export const tutorialBoard = (): Board => boardFromMap(TUTORIAL_MAP);
export { SAND };
