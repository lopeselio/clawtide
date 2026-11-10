import { ROUND_MINT_CAP } from './constants.ts';
import { winnerOf } from './sim.ts';

// What the contract does at settle_round, computed the same way off-chain: every seat with an
// account banks its pearls (at most ROUND_MINT_CAP), the winner is recorded.

export interface Final { pearls: number; clams: number; stings: number }
export interface Settlement { winner: number | null; mints: number[] }

export function settle(hasAccount: boolean[], finals: Final[]): Settlement {
  return {
    winner: winnerOf(finals),
    mints: finals.map((f, i) => (hasAccount[i] ? Math.min(f.pearls, ROUND_MINT_CAP) : 0)),
  };
}
