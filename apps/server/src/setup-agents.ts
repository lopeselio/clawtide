// One-time setup of the Driftwood Crabs on testnet. Idempotent: re-running skips what exists.
//   pnpm setup:agents
// For each: a sub-account of the contract whose ONLY key is a function-call key for
// `build_rockpool` (created by the contract itself), registered as an AI crab, with today's rockpool.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from 'near-api-js';
import { AGENTS, accountOf, agentTick } from './agents.ts';
import { call, provider, view } from './chain.ts';
import { config } from './config.ts';

const OWNER = config.contract;
const credDir = join(homedir(), '.near-credentials', config.network);
mkdirSync(credDir, { recursive: true });

async function exists(id: string): Promise<boolean> {
  try { await provider.viewAccount({ accountId: id, finalityQuery: { finality: 'final' } } as never); return true; } catch { return false; }
}

for (const a of AGENTS) {
  const acct = accountOf(a);
  const file = join(credDir, `${acct}.json`);
  if (!(await exists(acct))) {
    if (existsSync(file)) throw new Error(`${file} exists but ${acct} doesn't; move the old key away first`);
    const kp = KeyPair.fromRandom('ed25519');
    writeFileSync(file, JSON.stringify({ account_id: acct, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
    const r = await call(OWNER, 'create_agent_account', { name: a.label, public_key: kp.getPublicKey().toString() }, 100, 200_000_000_000_000_000_000_000n);
    console.log(`created ${acct} (function-call key for build_rockpool only) ${r.tx}`);
    await new Promise((res) => setTimeout(res, 2500));
  } else console.log(`${acct} exists`);
  if (!(await view<boolean>('is_agent', { account_id: acct }))) {
    const r = await call(OWNER, 'register_agent', { account: acct, name: a.name });
    console.log(`registered ${a.name} ${r.tx}`);
  }
}
await agentTick();
for (const a of AGENTS) console.log(`${a.name}: pool ${(await view<{ hash: string } | null>('get_pool', { account_id: accountOf(a) }))?.hash.slice(0, 16) ?? 'none'}…`);
console.log('done');
process.exit(0);
