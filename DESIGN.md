# Clawtide — design

## Pitch

Competitive minesweeper for up to four hermit crabs, live, on a shared tidal sandbar. Numbers count the sea urchins buried around each dug tile; everyone races for pearls and clams on the same board; stepping on an urchin flings you back to the shore (nobody is out). The last clam brings the tide and a new sandbar rises. A crown sits on the leader and everyone hunts it. Between sandbars: build a rockpool of hidden urchins, raid other crabs' pools with an energy gauge. Boards come from NEAR's VRF, and every round is sealed and settled onchain.

Inspired by the mechanics of Rabbit Royale (rabbit.rip). Theme, names, art and text are original.

## Rules (packages/rules)

- **Ticks**: 10 a second. A round lasts until the last clam opens, or 3:00.
- **Board** (`board.ts`): up to 24×16. Seven shapes, drawn with integer geometry only (ellipses as integer inequalities, no trig, so every JS engine builds the same board): Long Bar, Ring Atoll, Twin Bars (two ellipses and a causeway), Horseshoe Reef, Scattered Shoals (4–5 islets joined by spits), Eel Spit (a wandering band), Crescent Moon. Thick shapes get ragged shores; only the largest 8-connected stretch of sand is kept.
- **Landings**: one shore tile per seat, chosen farthest-point; each landing and its 8 neighbours are urchin-free, so a landing is always a 0 and opens a pocket.
- **Contents**: 20% of the sand hides urchins; 4–8 clams at least 5 hops from every landing; 13% of the remaining safe sand holds a loose pearl.
- **Digging**: hopping onto a buried tile digs it. A 0 floods its neighbours (shared: everyone sees what anyone dug). A clam is never exposed by a flood: it stays a lump until someone digs straight into it (a lone buried tile among zeros is the tell).
- **Hops**: one tile in 8 directions every 4 ticks. Inputs are just a direction (1–8); a tap is turned into hops by the server's pathing over dug sand (`nextStep`), and only the applied hops are logged.
- **Urchins**: stepping on one uncovers it (it stays as a blocking hazard), costs 2 pearls (lost), flings the crab to its landing and dazes it for 16 ticks.
- **Pearls**: +1 for stepping onto an uncovered pearl. **Clams**: stand still on an uncovered clam for 18 ticks: +5.
- **Crown**: the lone leader (most pearls, > 0). Hopping onto the crowned crab's tile pinches 1 pearl (20-tick cooldown per pincher).
- **Fairness**: who moves first rotates every tick.
- **Winner**: most pearls, then fewest stings, then lowest seat (the contract has the same rule).
- **Views** (`viewFor`): per tile water / buried / uncovered urchin / number 0–8, plus items on dug tiles and every crab's position and score. Never what's buried.

### The AI crabs (`bot.ts`)

Each AI decides one hop at a time from its own view and a generator kept in the round state (so replays make identical choices):
1. Uncovered loot reachable over dug sand (clams weighted; Hard skips loot a rival will reach first).
2. Normal/Hard: a crowned rival within 4 hops — go pinch.
3. Buried tiles next to reachable sand: deduced-safe ones first (single-constraint deduction; Hard adds the subset rule; Easy only one pass), Easy blunders into a random guess 18% of the time.
4. Otherwise the least risky guess (risk = worst share of remaining urchins among numbered neighbours).
Pacing ("thought" ticks per hop) is versioned: v1 frozen, v2 (current) about a person's pace (Easy 9–18, Normal 6–12, Hard 3–7). `pnpm sim 60 2`: ~40 s rounds with four AIs; Hard wins ~55%, Normal ~18%, Easy ~8%.

### Tutorial (`tutorial.ts`)

A hand-drawn 15×6 sandbar whose lessons arrive in order: hop, grab a pearl, pry the lone lump, flag the urchin behind a "1 touching one buried tile", then cross an urchin wall where `8,3 = 2` and `8,4 = 1` force the subset deduction that opens the only gap. It runs locally with the real rules.

## Onchain (contracts/clawtide)

### A round

1. `create_round(round_id, secret_hash, seats)` (referee): stores the commitment and returns a promise to itself, `draw_tide(round_id)`.
2. `draw_tide` runs in a later receipt (a different block) and stores `vrf = hex(env::random_seed_array())` — the block's VRF-derived seed, which nobody could know when the secret was fixed. The server polls `get_round` for it (about 2 s).
3. Board seed = `sha256("clawtide|board|{vrf}|{secret}")`.
4. `seal(round_id, from_chunk, chunks)`: every 30 ticks, one seal per seat: `sha256("clawtide|seal|{round}|{seat}|{chunk}|{salt}|{hops}|{at},{pearls},{clams},{stings}")`, salt = `sha256("clawtide|salt|{secret}|{seat}|{chunk}")`, folded into a chain head `sha256("{head}|{chunk}|{seals,…}")`. Pending chunks are batched into one transaction.
5. `open_chunks(round_id, secret, from, chunks)`: checks the secret, rebuilds every seal, re-folds the head (must equal the sealed one), records the board seed and the final standings.
6. `settle_round(round_id)` (anyone): winner by the rule above; mints min(pearls, 60) PEARL to each seat with an account (players and Driftwood Crabs; guests bank nothing); updates records and the season.

`pnpm verify <roundId>` checks all of that from the chain and the server's opened log, replays every tick with packages/rules (re-deciding every AI hop from its own view) and compares every sealed chunk state, the final hash and the mint.

### PEARL (NEP-141)

0 decimals. Minted only by `settle_round` (≤ 60 per seat per round) and as a 2-PEARL defence bounty when a raid fails; moved by successful raids and `ft_transfer`. Registration is free (the contract pays storage). `ft_metadata` carries a voxel pearl icon.

### Rockpools and raids

- **Layout**: 9×9, at most 14 urchins and 10 rocks, one pearl cache at least three rows up from the entry (bottom middle), and at least one urchin-free path (`layoutError`). Committed as `sha256("clawtide|pool|{layout}|{salt}")` by its owner (`build_rockpool`, gasless through the relayer; unlocked after one settled round; Driftwood Crabs anytime). The server keeps the layout; when it's replaced, the old one is published with `reveal_pool` (the contract checks the hash).
- **Raid**: the raider starts at the entry with 40 energy; a hop costs 1; an urchin costs 12, is uncovered and flings the raider back. Numbers show **only** on tiles the raider has stood on (no flood). Reaching the cache wins.
- **Limits** (contract): 5 raids a day per raider; a successful raid shields the pool for an hour; **revenge** (raiding whoever last raided you) ignores both. Win: take 10% of the owner's PEARL (at least 1, at most 20). Fail: the owner earns 2 PEARL.
- `pnpm verify raid <raidId>` replays the logged hops against the revealed layout from the chain alone.

### The Pearl Crown and seasons

`get_crown` = the account holding the most PEARL. Seasons are 7 days from deployment; `leaderboard` shows PEARL held and PEARL earned this season. In a round, the crown holder's seat is marked with ♛ from the start, and its rockpool is listed first for raids.

## The Driftwood Crabs

Captain Pincer, Old Barnacle, Kelpie, Coral, Skitter: sub-accounts of `clawtide.testnet` created by the contract with only a function-call key for `build_rockpool` (0.5 NEAR gas allowance). They bank PEARL from rounds like players. Every day each builds a fresh rockpool drawn from a server secret (so the public code doesn't solve it), and yesterday's is revealed onchain. Their pre-round taunts come from a NEAR AI Cloud model in a TEE (signed; optional); the model never plays.

## Server

Node + `ws`. Rooms (up to 4 seats; quick play fills with Driftwood Crabs; the next sandbar rises when you press Next). One replica: live rooms are in memory; round/raid records and rockpool layouts are JSON under `DATA_DIR` (Azure Files when hosted). Better Auth + better-near-auth: NEP-413 sign-in with an exact-message/host check, NEP-366 relaying only to the Clawtide contract with no deposit.

## Client

React + three.js. One `World`: instanced sand blocks (dug tiles sink), instanced digit planes, urchins, pearls, rocks, kelp flags and foam; clams and crabs are small voxel groups. Each seat's crab wears a different shell (spiral conch, turban, tall whelk, flat moon snail) in its seat colour and stands on a ring of that colour; eyes on stalks blink and look around, the big claw's pincer is hinged and clacks, six legs run a walk cycle as it scuttles sideways in hop arcs, and idle crabs fidget. A sting is a tumbling fling, then a dazed wobble under stars; the crowned crab's crown glints over a pulsing gold aura. The clam is a ribbed fan whose lid lifts as it's pried, and its pearl gleams and glows as it opens. Dug tiles look scooped and their numbers are outlined so they read on wet or dry sand; digging puffs clods and a ring of dust; loose pearls bob over a soft glow and sparkle when grabbed; an urchin bursts in spines with a purple shockwave; kelp flags sway. Effects come from pools (one instanced particle mesh, rings, glints), so nothing is allocated per burst. Each sandbar shape has its own time of day (midday bar, golden-hour atoll, dusk eel spit, …). The sea is one shader: the swell runs on the GPU, a signed-distance texture of the shoreline gives turquoise shallows, deep blue water, foam that laps the sand, blocky caustics and sparkles; a shelf of wet sand steps down under the shallows, with shells, pebbles, starfish, swaying seaweed and driftwood. The tide is a front in that distance field: it sweeps over the sand from the shore inwards, and a new sandbar rises as the water drains off it from the middle outwards. Sand is wet at the shore and dry inland. Soft sun shadows on desktop only; no post-processing; on touch screens no shadows and the pixel ratio is capped at 1.5.

Input: tap/click to walk (the last hop digs), long-press/right-click/Flag mode to flag, drag to pan, pinch/wheel to zoom; WASD/arrows/QEZC, 1 dig, 2 flag, 3 clack, Space re-centre. Phone portrait puts big buttons bottom-centre; phone landscape stacks them on the right; safe-area insets respected.

Onboarding: title (attract mode) → six-card illustrated walkthrough → guided practice sandbar → real play. "How to play" and "Practice sandbar" stay on the title.
