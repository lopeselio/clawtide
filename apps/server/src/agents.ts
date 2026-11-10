import { createHash } from 'node:crypto';
import { botPool, poolHash, type Skill } from '@clawtide/rules';
import { call, view } from './chain.ts';
import { config, hasKey } from './config.ts';
import { voice, type SignedLine } from './nearai.ts';
import { currentPool, retirePool, setPool, revealRetired } from './pools.ts';
import { kvGet, kvSet } from './store.ts';

// The Driftwood Crabs: five AI rivals. Each is a sub-account of the contract whose only key is a
// function-call key for `build_rockpool`. Every day each one builds a fresh rockpool (its layout is
// drawn from a server secret, so reading this code doesn't solve it) and the referee publishes
// yesterday's layout onchain with `reveal_pool`, so raids against it can be replayed by anyone.
// In rounds they play from their own view at the room's difficulty (packages/rules bot.ts).

export interface AgentDef { label: string; name: string; persona: string }

export const AGENTS: AgentDef[] = [
  { label: 'pincer', name: 'Captain Pincer', persona: 'Captain Pincer, a pompous old hermit crab in a battered conch who thinks every pearl is his by right' },
  { label: 'barnacle', name: 'Old Barnacle', persona: 'Old Barnacle, a slow, grumbling crab who has dug these sandbars for forty tides' },
  { label: 'kelpie', name: 'Kelpie', persona: 'Kelpie, a quick, chatty young crab in a green-striped shell who loves a race' },
  { label: 'coral', name: 'Coral', persona: 'Coral, a careful, pink-shelled crab who counts every number twice before stepping' },
  { label: 'skitter', name: 'Skitter', persona: 'Skitter, a nervous little crab in a thimble-sized shell who panics near urchins' },
];

export const accountOf = (a: AgentDef): string => `${a.label}.${config.contract}`;
export const agentByAccount = (acct: string): AgentDef | undefined => AGENTS.find((a) => accountOf(a) === acct);
const today = (): number => Math.floor(Date.now() / 86_400_000);

/** Today's rockpool for an AI crab: drawn from the server secret, so it can't be read from the code. */
export function agentLayout(a: AgentDef, day = today()): { layout: string; salt: string } {
  const salt = createHash('sha256').update(`${config.sessionSecret}|${a.label}|${day}`).digest('hex').slice(0, 32);
  return { layout: botPool(`${a.label}|${salt}`), salt };
}

// ---------- what the AI crabs did (for the UI) ----------

export interface AgentAct { at: number; who: string; what: string; tx?: string }
const acts: AgentAct[] = kvGet<AgentAct[]>('acts', []);
export function logAct(who: string, what: string, tx?: string): void {
  acts.unshift({ at: Date.now(), who, what, tx });
  acts.length = Math.min(acts.length, 40);
  kvSet('acts', acts);
}
export const recentActs = (): AgentAct[] => acts;

/** Makes sure every AI crab has today's rockpool committed, and reveals the layouts it replaced. */
export async function agentTick(): Promise<void> {
  if (!config.chainEnabled) {
    // offline: the pools still exist locally so raids can be practised
    for (const a of AGENTS) if (!currentPool(accountOf(a))) { const { layout, salt } = agentLayout(a); setPool(accountOf(a), layout, salt); }
    return;
  }
  for (const a of AGENTS) {
    const acct = accountOf(a);
    if (!hasKey(acct)) continue;
    try {
      const { layout, salt } = agentLayout(a);
      const hash = poolHash(layout, salt);
      const onchain = await view<{ hash: string } | null>('get_pool', { account_id: acct }).catch(() => null);
      if (onchain?.hash !== hash) {
        const r = await call(acct, 'build_rockpool', { hash });
        retirePool(acct);
        setPool(acct, layout, salt);
        logAct(a.name, 'built a fresh rockpool', r.tx);
      } else if (currentPool(acct)?.hash !== hash) setPool(acct, layout, salt);
    } catch (e) {
      logAct(a.name, `couldn't build: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  await revealRetired();
}

const TAUNTS: Record<string, string[]> = {
  pincer: ['Every pearl on this bar is already mine.', 'Mind your claws, sprat.'],
  barnacle: ['Forty tides I have dug. You are tide forty-one.', 'Slow claws, full shell.'],
  kelpie: ['Race you to the first clam!', 'Too slow, too slow!'],
  coral: ['A two next to a one. Think, then hop.', 'Count twice, dig once.'],
  skitter: ['Is that an urchin? Is THAT an urchin?', 'P-please leave me a pearl.'],
};

/** A pre-round line, voiced by a TEE-hosted model when NEAR AI is configured (the model never plays). */
export function taunt(a: AgentDef, rivals: string[], pick: number): Promise<SignedLine> {
  const pool = TAUNTS[a.label] ?? ['The tide waits for no crab.'];
  return voice(
    a.name,
    `You are ${a.persona}, about to race other hermit crabs digging for pearls on a sandbar full of buried sea urchins. Say one short, playful taunt (under 14 words). No hashtags, no emojis. Never assume anyone's gender.`,
    `Your rivals: ${rivals.join(', ')}.`,
    pool[pick % pool.length],
  );
}

export type { Skill };
