// Read-only contract views straight from public NEAR testnet RPCs (not through our server).
// Each RPC is retried on a rate limit (429) or a network error with a growing pause, then the next is
// tried; if none answers, this throws one plain error.

const RPCS = ['https://testnet-rpc.intea.rs', 'https://near-testnet.drpc.org', 'https://rpc.testnet.fastnear.com'];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function chainView<T>(contract: string, method: string, args: object): Promise<T> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'optimistic', account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) } });
  for (const rpc of RPCS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let retry = false;
      try {
        const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(10_000) });
        if (res.status === 429 || res.status >= 500) retry = true;
        else {
          const j = (await res.json()) as { result?: { result: number[] }; error?: unknown };
          if (j.result) return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result))) as T;
          if (!/429|rate|too many/i.test(JSON.stringify(j.error ?? ''))) break; // a real error from this RPC: try the next
          retry = true;
        }
      } catch { retry = true; }
      if (!retry) break;
      await sleep(700 * (attempt + 1));
    }
  }
  throw new Error('NEAR testnet RPCs are busy (rate-limited); try again in a minute.');
}
