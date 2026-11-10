# Clawtide

**Competitive minesweeper for hermit crabs, on NEAR.** Up to four crabs land on a tidal sandbar. Every tile you dig shows how many **sea urchins** are buried in the eight tiles around it. Race your rivals to dig up **pearls** and pry open **clams**; step on an urchin and you're flung back to the shore, dazed and two pearls lighter (nobody is ever out). When the last clam opens, **the tide swallows the sandbar** and a new one rises: long bars, ring atolls, twin bars, horseshoe reefs, scattered shoals, eel spits, crescents. The crab holding the most pearls wears the **crown**, and everyone hunts it: hop onto the crowned crab to pinch a pearl.

Between sandbars, build a **rockpool** of hidden urchins and **raid** other crabs' rockpools with an energy gauge to steal a share of their PEARL. The **Pearl Crown** sits on the richest crab of the 7-day season.

**Nobody can choose or predict a board.** The referee first commits `sha256(secret)` to the contract; the contract then draws NEAR's block VRF randomness (`env::random_seed_array()`) **in a later receipt**, and the board seed is `sha256(vrf | secret)`. During play each crab's hops are **sealed onchain every 3 seconds**; at the tide the secret and the whole log are opened, and the contract rebuilds every seal before it mints a single PEARL. `pnpm verify <roundId>` replays any round from the chain and the opened log, with no keys.

Built for NEAR HACKATHON (Nov 2026), part of the [NEAR Arcade](https://arcade.lopeselio.online/). Design: [DESIGN.md](DESIGN.md). Play: **https://clawtide.lopeselio.online/** (also https://clawtide.jollyrock-a3368b02.northeurope.azurecontainerapps.io/).

![Four crabs digging a sandbar](thumbs/clawtide.webp)

- Contract (testnet): [`clawtide.testnet`](https://testnet.nearblocks.io/address/clawtide.testnet): rounds with a VRF draw, sealed hop logs, PEARL (NEP-141), rockpools, raids, the crown and seasons.
- Referee: [`clawtide-ref.testnet`](https://testnet.nearblocks.io/address/clawtide-ref.testnet). Gasless relayer: [`clawtide-relay.testnet`](https://testnet.nearblocks.io/address/clawtide-relay.testnet).
- AI rivals, the **Driftwood Crabs** (sub-accounts whose only key is a function-call key for `build_rockpool`): `pincer.`, `barnacle.`, `kelpie.`, `coral.`, `skitter.clawtide.testnet`.

## Try it (do X, see Y)

```bash
pnpm install
pnpm build            # the web app
pnpm start            # http://localhost:8851 (server + built web app)
```

With no NEAR keys, run `CHAIN=0 pnpm start`: everything plays the same, but nothing is written onchain (rounds say "offline round", and the Driftwood Crabs keep local rockpools to practise on).

1. **Open http://localhost:8851.** Behind the CLAWTIDE title, four Driftwood Crabs dig a random sandbar on a voxel sea (attract mode). **Show the crown, the ledger and the proofs** opens panels for the *Pearl Crown* (the richest crab, the season, the PEARL ledger), *Your crab*, *The Driftwood Crabs* (their NEAR accounts and what they did onchain), *Recent sandbars* and *How the sandbar is kept honest*.
2. **Press Play.** The first time, a six-card illustrated walkthrough explains digging, the numbers, urchins, clams and the tide, the crown and rockpools, and what goes onchain (reopen it with **How to play**). Then a **practice sandbar** (hand-drawn, running the real rules in your browser) walks you through five lessons in order: *hop*, *grab a pearl*, *pry a clam* (a lone buried tile among zeros), *flag an urchin* (a 1 that touches one buried tile), and *cross the urchin wall* (a subset deduction). Open both far clams and the tide comes in; **Dig a real sandbar** takes you to the real thing.
3. **Dig a sandbar.** (Pick **Easy / Normal / Hard** for the AI crabs first; remembered on this device.) You see "The tide is drawing a sandbar…" while the secret's hash is committed and the contract draws its VRF seed; then the sandbar rises out of the sea with its name (e.g. *Ring Atoll: 4 clams*), a 3-2-1 countdown plays and one crab taunts you (with a NEAR AI key, the line is signed by the NEAR AI TEE). The chip at the bottom reads **⛓ VRF draw ✓ · sealed N×** and links the draw transaction.
4. **Play.** **Tap or click a tile** and your crab scuttles there over dug sand; the last hop digs. **WASD/arrows** hop one tile (**Q E Z C** diagonals); **1** digs the tile under the mouse, **2** flags it, **3** clacks your claws, **Space** re-centres. **Right-click** (desktop) or **long-press** (phone) plants a kelp flag; on a phone the big **Flag** button turns taps into flags. Dug tiles sink and show their number; a 0 opens its neighbourhood; pearls bob on the sand until someone grabs them. Standing on a clam pries it open (the lid lifts as the bar fills): +5 pearls. An urchin bursts in purple spines and flings you back to your landing spot in a tumbling arc, with dazed stars. The scoreboard (top right) marks the crowned crab with ♛; hop onto it to pinch a pearl.
5. **The tide.** When the last clam opens (or after 3:00) the sea rises over the sandbar. The results show pearls, clams, stings and the **PEARL banked** per signed-in crab; **Onchain proof** lists `create_round + draw_tide`, every `seal`, the `open chunks` batch and `settle_round` on nearblocks, and "settled ✓". **Next sandbar** raises a new one at once.
6. **Check it yourself**, with no keys and without trusting our server:

   ```
   pnpm verify <roundId>                                       # local server
   pnpm verify <roundId> --host https://clawtide.lopeselio.online   # hosted
   pnpm verify raid <raidId>                                   # a raid, from the chain alone
   ```

7. **Multiplayer.** **Create a room** and send the 4-letter code or the `?room=CODE` link; friends **Join** (up to 4; a human can take a Driftwood Crab's seat). The host adds Driftwood Crabs and sets the difficulty; everyone presses **Ready**.
8. **Sign in with NEAR** (top right; NEAR Connect: Meteor, Intear, HOT, MyNearWallet, …). The wallet signs "Sign in to <host>" (NEP-413). Your pearls are now banked as **PEARL** (a NEP-141 token, 0 decimals, at most 60 per sandbar) and your record (sandbars, wins, clams, stings, raids) is kept onchain.
9. **Rockpools & raids** (from the title). **Raid a rockpool** lists every pool, crown first, then revenge targets, then the richest. Press **Raid**: you wade into a 9×9 pool at the bottom with **40 energy** (1 per hop, 12 per urchin, which also flings you back), seeing rocks and the pearl cache but numbers **only on tiles you've stood on**. Reach the cache to take 10% of the owner's PEARL (up to 20) and shield their pool for an hour; run dry and the owner earns 2 PEARL. Signed in, every raid is begun and settled onchain (`begin_raid`, `settle_raid`, linked in the result); guests can practise on the Driftwood Crabs' pools. **My rockpool** (after one signed-in sandbar): paint up to 14 urchins and 10 rocks and place your cache, then **Commit to NEAR (gasless)**: only `sha256(layout | salt)` goes onchain, through a NEP-366 meta-transaction paid by `clawtide-relay.testnet`.
10. **Headless:** `pnpm e2e` (server at http://localhost:8851) makes a fresh test account, signs in through NEP-413, digs a sandbar against three Driftwood Crabs over the WebSocket (steered only by the views it receives), waits for the VRF draw, seals, openings and settlement, builds a rockpool gaslessly through the relayer, and raids a Driftwood Crab's rockpool onchain.

### A live run (testnet, 10 Nov 2026)

`pnpm e2e` against the local server and `clawtide.testnet`:

```
▶ dig a sandbar against three AI crabs over the WebSocket
  ✓ round r-mwaftabr-894bbb: secret hash committed; waiting for the contract's VRF draw
  ✓ the tide drew … (onchain: true); the sandbar is a Horseshoe Reef with 4 clams
  ✓ Coral: “Tick-tock, E2E! I count twice so I don’t get poked!” (signed by NEAR AI TEE)
  ✓ the tide came in (last clam opened); Kelpie won. E2E Crab 7 pearls, Kelpie 12, Coral 1, Old Barnacle 8
▶ wait for the seals to be opened and the round settled onchain
  ✓ create_round + draw_tide   https://testnet.nearblocks.io/txns/2AHdC4tzjtTvQYNQsQiGfvQvpVcYB8AnTiEAB4QQGVke
  ✓ open chunks 0–5            https://testnet.nearblocks.io/txns/8gw1tnA2AZk2R4GzPgZr13atSiXff6YwJGZxqqC7By4t
  ✓ settle_round               https://testnet.nearblocks.io/txns/Du3wyMGeKF4655h78WCkb1Ys3462HYHrgRw1FJSSN6FX
  ✓ 6 seal transactions
  ✓ contract: winner seat 1, PEARL minted [7, 12, 1, 8]
▶ build a rockpool, gasless (NEP-366 meta-transaction through the relayer)
  ✓ build_rockpool https://testnet.nearblocks.io/txns/A1RE4U6t7JznfDwF4AvgxLqfXXwevpN8gbEe9wzi4u1p
▶ raid an AI crab's rockpool
  ✓ begin_raid   https://testnet.nearblocks.io/txns/48GkHJCnLkEruwG49vt9SBmb5W2KUV5QzYkoGEy1DgYR
  ✓ settle_raid  https://testnet.nearblocks.io/txns/HmzT68WxzdcepujAqFw8VNfAR2a5VVyfVCLm8CZSjM1b
```

`pnpm verify r-mwafdm9d-e0617e` on another settled round:

```
✓ the contract has this round
✓ the revealed secret matches the hash committed at create_round  2ea9cbe79099085e
✓ the contract drew its VRF seed in a later receipt (block 277042609)  6fcb9a069b6d85f4
✓ board seed = sha256(vrf | secret), as the contract recorded it  db3e38429b6929e6
✓ every opening rebuilds its seal (12 chunks × 4 seats)
✓ the seals fold into the contract's chain head  cf3994e04097231d
✓ the contract opened every chunk and re-folded the same head
✓ every AI hop is what that crab decides from its own view  103 AI hops
✓ every logged human hop replays as logged
✓ the replay passes through every sealed chunk state (12 chunks)
✓ the replay ends where the server's round ended (tick 333, the last clam opened)
✓ the final standings match what the contract opened
✓ the contract settled it
✓ winner: Coral
✓ PEARL minted per seat: [7, 7, 9, 6]
all checks passed
```

## How it works

| Piece | Where |
| --- | --- |
| Rules: sandbar shapes, the round, AI crabs, seals, rockpools, raids, the tutorial board. Deterministic and isomorphic (browser + Node), integer-only, no `Math.random`/`Date`. | `packages/rules` |
| Contract: commit → VRF draw (`draw_tide`, a callback in a later receipt) → seals → open → settle; PEARL (NEP-141); rockpools, raids, the crown, seasons; AI crab accounts. near-sdk 5.29.1. | `contracts/clawtide` |
| Server: rooms at 10 ticks a second, walk-to-tile, the onchain round lifecycle, rockpools (layouts kept secret until replaced, then revealed onchain), raids, Better Auth + better-near-auth (NEP-413 sign-in, NEP-366 relayer), NEAR AI taunts, `verify`, `e2e`. | `apps/server` |
| Web: React + three.js. Instanced voxel sand, digits, urchins, pearls, clams, voxel hermit crabs, the crown, particles, the tide; touch (tap, long-press, drag, pinch) and mouse/keyboard; synthesised sound. | `apps/web` |

The LLM never decides anything: packages/rules plays the AI crabs from their own views, and the contract banks the pearls.

### What the chain does *not* prove

- The contract checks the commitment, the VRF draw, every seal, the chain head and the mint rule; it does not replay the round (that's `pnpm verify`, which anyone can run).
- The referee knows the board once the draw is in (it holds the secret), and sends every client only what has been dug. It could abort a round it didn't like, but every `create_round` and its draw stay onchain, so that would show.
- A raid's rockpool layout stays secret while it's in use, so the contract trusts the referee's "reached the cache" until the layout is revealed (`reveal_pool`, automatic when the owner rebuilds and daily for the Driftwood Crabs); then `pnpm verify raid <id>` replays it.

## Tests

```bash
pnpm test             # rules: shapes, replay, stings, clams, crown, deduction, seal vector, raids, a frozen settled round, no randomness
pnpm contract:test    # contract: the same hash vector, VRF draw after commit, tampered openings, mint cap, rockpools, raids, shields, revenge
pnpm sim 60           # 60 all-AI sandbars: length, wins and pearls per difficulty
pnpm e2e              # the live testnet flow above (needs a running server and keys)
```

## Deploying

`scripts/deploy-azure.sh` builds the image in Azure Container Registry and runs it on Azure Container Apps (resource group `clawtide`, one replica because rooms live in memory); `scripts/azure-storage.sh` mounts an Azure Files share at `/data` for round and raid records and rockpool layouts (on the very first deploy the app only becomes healthy once this has run, because it writes to `/data`). Keys come from `~/.near-credentials` and `.env` (never the repo). `pnpm setup:agents` creates the Driftwood Crabs once.

## Lineage and disclosures

Inspired by the mechanics of rabbit.rip's *Rabbit Royale* (competitive minesweeper with a meta of burrows and raids). No code, names, art or text from it: the theme, every name, the voxel art (procedural) and the sound (synthesised) are original. Testnet only.

## License

MIT
