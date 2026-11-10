# Clawtide — agent notes

- Hackathon rules: https://nearhackathon.com/HACKATHON.md (deadline 2026-11-14 23:59 UTC; repo must stay public).
- Design source of truth: DESIGN.md. Keep README "do X, see Y" steps current — AI judges run them.
- Independent of the other NEAR Arcade games: its own repo, contract, rules and server.
- Inspired by Rabbit Royale (rabbit.rip) mechanics only: no code, names, art or text from it. All art is procedural voxels; all sound is synthesised.
- packages/rules is deterministic and isomorphic (browser + Node): no Math.random, no Date, no DOM, no node: imports. Integer geometry only. A replay of the log must reproduce the state hash. Never change how an existing RULES_VERSION plays (settled rounds are pinned in test/fixtures); add a new version instead.
- Its seal, head and pool hashes must match contracts/clawtide byte for byte (shared vector: packages/rules/test/vector.json and contracts/clawtide/src/tests.rs).
- Boards come from sha256(vrf | secret): the referee commits sha256(secret) first, the contract draws env::random_seed_array() in a later receipt (draw_tide). Never let the server pick or reroll a board.
- Clients and AI crabs only ever get viewFor (what has been dug). Rockpool layouts stay on the server until replaced, then are revealed onchain.
- The LLM never moves a crab or decides a payout; packages/rules and the contract do. NEAR AI only voices taunts.
- Testnet only. Keys live in .env / ~/.near-credentials, never in the repo.
- Verify NEAR endpoints/SDK versions against docs.near.org/llms.txt and docs.near.ai/llms.txt, not memory.
- Commits: no Co-Authored-By or other AI attribution lines; small granular commits. Every change after the first push goes on a branch, through a PR, and is rebase-merged (`gh pr merge --rebase --delete-branch`).
