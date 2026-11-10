//! Clawtide onchain: sandbar rounds, PEARL, rockpools and raids.
//!
//! - **Rounds**: the referee commits `sha256(secret)` (`create_round`). The contract then draws a
//!   VRF-derived random seed (`env::random_seed_array()`) in a *later* receipt (`draw_tide`, a
//!   callback to itself), so neither the referee nor any player can know it when the secret is
//!   fixed. The board seed is `sha256("clawtide|board|{vrf}|{secret}")`: the referee can't pick a
//!   board, and players can't predict one. During play the referee posts each 3-second chunk's
//!   per-seat seals (`seal`, folded into one chain head); at the end it reveals the secret and opens
//!   every chunk (`open_chunks`). The contract rebuilds every seal, re-folds the head, checks the
//!   secret against its hash and records the board seed. `settle_round` then banks pearls.
//! - **PEARL** is a NEP-141 token (0 decimals) minted for pearls banked from sandbars, moved by raids.
//! - **Rockpools**: every account (and AI crab) commits the hash of its rockpool layout
//!   (`build_rockpool`). Raids are refereed (`begin_raid`, `settle_raid`) under limits the contract
//!   enforces: raids per day, a shield after a successful raid, and revenge that ignores both. Each
//!   raid's hops are kept onchain; layouts are revealed later (`reveal_pool`) so raids can be replayed.
//! - **The Pearl Crown** sits on the account holding the most PEARL. Seasons are 7 days long and
//!   rank pearls earned in the season.
//!
//! The round itself (hops, urchins, clams) lives in packages/rules and is replayed off-chain by
//! `pnpm verify`; this contract checks what a contract can check cheaply.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PublicKey};

#[cfg(test)]
mod tests;

pub const MAX_SEATS: usize = 4;
/// 3:00 at 30 ticks per chunk
pub const MAX_CHUNKS: u32 = 60;
pub const ROUND_MINT_CAP: u64 = 60;
pub const RAIDS_PER_DAY: u32 = 5;
pub const SHIELD_NS: u64 = 3_600_000_000_000;
pub const SEASON_NS: u64 = 7 * 86_400_000_000_000;
pub const DAY_NS: u64 = 86_400_000_000_000;
/// share of the owner's PEARL a successful raid takes (percent), and its cap
pub const RAID_TAKE_PCT: u64 = 10;
pub const RAID_TAKE_MAX: u64 = 20;
/// PEARL minted to an owner whose rockpool turned a raider back
pub const DEFENCE_BOUNTY: u64 = 2;
/// rounds an account must have played before it can build a rockpool
pub const BUILD_AFTER_ROUNDS: u32 = 1;
/// tiles on a sandbar (24 × 16) and on a rockpool (9 × 9): bounds for opened positions
pub const MAX_TILE: u32 = 24 * 16;
pub const POOL_TILES: usize = 81;
/// Methods an AI crab's function-call key may call.
pub const AGENT_METHODS: &str = "build_rockpool";
pub const AGENT_GAS_ALLOWANCE: NearToken = NearToken::from_millinear(500);
const GAS_FOR_DRAW: Gas = Gas::from_tgas(10);
const MAX_NAME: usize = 20;

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Rounds,
    Balances,
    Records,
    Names,
    Agents,
    Pools,
    PoolHashes,
    Revealed,
    Raids,
    Season,
}

// ---------- data ----------

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct SeatIn {
    /// None for a guest: plays, but banks nothing
    pub account: Option<AccountId>,
    pub name: String,
}

/// One seat's opened chunk: its hops and its standing when the chunk closed.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ChunkOpening {
    pub inputs: String,
    pub at: u32,
    pub pearls: u32,
    pub clams: u32,
    pub stings: u32,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Final {
    pub pearls: u32,
    pub clams: u32,
    pub stings: u32,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Round {
    pub secret_hash: String,
    pub seats: Vec<SeatIn>,
    pub created_ns: U64,
    /// the VRF-derived draw, made in a receipt after the commitment
    pub vrf: Option<String>,
    pub vrf_block: Option<U64>,
    pub chunks: u32,
    pub head: String,
    pub opened: u32,
    pub open_head: String,
    pub secret: Option<String>,
    /// sha256("clawtide|board|{vrf}|{secret}"), recorded once the secret is revealed
    pub board_seed: Option<String>,
    pub finals: Vec<Final>,
    pub settled: bool,
    pub winner: Option<u8>,
    pub minted: Vec<u64>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default)]
pub struct Record {
    pub rounds: u32,
    pub wins: u32,
    pub pearls_banked: u64,
    pub clams: u32,
    pub stings: u32,
    pub raids_won: u32,
    pub raids_failed: u32,
    pub raided: u32,
    pub defended: u32,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Pool {
    pub hash: String,
    pub built_ns: U64,
    pub shield_until: U64,
    pub last_raider: Option<AccountId>,
    pub raid_day: u64,
    pub raids_today: u32,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Raid {
    pub raider: AccountId,
    pub owner: AccountId,
    pub pool_hash: String,
    pub revenge: bool,
    pub started_ns: U64,
    pub done: bool,
    pub won: bool,
    pub hops: String,
    pub energy_left: u32,
    pub taken: u64,
    pub bounty: u64,
}

#[near(serializers = [json])]
pub struct BoardRow {
    pub account: AccountId,
    pub name: String,
    pub pearls: u64,
    pub season_pearls: u64,
    pub wins: u32,
}

#[near(serializers = [json])]
pub struct Crown {
    pub account: AccountId,
    pub name: String,
    pub pearls: u64,
}

#[near(serializers = [json])]
pub struct SeasonInfo {
    pub season: u64,
    pub started_ns: U64,
    pub ends_ns: U64,
    pub supply: U128,
    pub rounds_settled: u64,
    pub raids: u64,
}

#[near(serializers = [json])]
pub struct FtMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
    pub decimals: u8,
}

#[near(serializers = [json])]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[near(event_json(standard = "clawtide"))]
pub enum Event {
    #[event_version("1.0.0")]
    RoundCreated { round_id: String, secret_hash: String, accounts: Vec<Option<AccountId>> },
    #[event_version("1.0.0")]
    TideDrawn { round_id: String, vrf: String, block: U64 },
    #[event_version("1.0.0")]
    Sealed { round_id: String, chunk: u32, seals: Vec<String>, head: String },
    #[event_version("1.0.0")]
    Opened { round_id: String, from: u32, to: u32, board_seed: String },
    #[event_version("1.0.0")]
    Settled { round_id: String, winner: Option<u8>, minted: Vec<u64> },
    #[event_version("1.0.0")]
    PoolBuilt { account: AccountId, hash: String },
    #[event_version("1.0.0")]
    PoolRevealed { hash: String },
    #[event_version("1.0.0")]
    RaidBegun { raid_id: String, raider: AccountId, owner: AccountId, revenge: bool },
    #[event_version("1.0.0")]
    RaidSettled { raid_id: String, won: bool, hops: String, taken: u64, bounty: u64 },
}

fn nep141(event: &str, data: serde_json::Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "nep141", "version": "1.0.0", "event": event, "data": [data] })));
}

// ---------- the hashes packages/rules builds too ----------

pub fn sha_hex(s: &str) -> String {
    hex::encode(env::sha256_array(s.as_bytes()))
}
pub fn salt_of(secret: &str, seat: usize, chunk: u32) -> String {
    sha_hex(&format!("clawtide|salt|{secret}|{seat}|{chunk}"))
}
pub fn seal_of(round_id: &str, secret: &str, seat: usize, chunk: u32, o: &ChunkOpening) -> String {
    let salt = salt_of(secret, seat, chunk);
    sha_hex(&format!("clawtide|seal|{round_id}|{seat}|{chunk}|{salt}|{}|{},{},{},{}", o.inputs, o.at, o.pearls, o.clams, o.stings))
}
pub fn head_zero(round_id: &str) -> String {
    sha_hex(&format!("clawtide|head|{round_id}"))
}
pub fn next_head(head: &str, chunk: u32, seals: &[String]) -> String {
    sha_hex(&format!("{head}|{chunk}|{}", seals.join(",")))
}
pub fn board_seed(vrf: &str, secret: &str) -> String {
    sha_hex(&format!("clawtide|board|{vrf}|{secret}"))
}
pub fn pool_hash(layout: &str, salt: &str) -> String {
    sha_hex(&format!("clawtide|pool|{layout}|{salt}"))
}

/// Most pearls, then fewest stings, then the lowest seat (packages/rules winnerOf).
pub fn winner_of(finals: &[Final]) -> Option<u8> {
    let mut best: Option<usize> = None;
    for (i, f) in finals.iter().enumerate() {
        match best {
            None => best = Some(i),
            Some(b) => {
                let w = &finals[b];
                if f.pearls > w.pearls || (f.pearls == w.pearls && f.stings < w.stings) {
                    best = Some(i);
                }
            }
        }
    }
    best.map(|i| i as u8)
}

fn valid_name(name: &str) -> bool {
    !name.trim().is_empty() && name.len() <= MAX_NAME && name.chars().all(|c| c.is_ascii_alphanumeric() || " -_.'".contains(c))
}
fn valid_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn valid_inputs(s: &str) -> bool {
    s.len() <= 4000 && s.bytes().all(|b| b.is_ascii_digit() || b == b':' || b == b';')
}
fn valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 48 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

// ---------- contract ----------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Clawtide {
    owner: AccountId,
    referee: AccountId,
    epoch_ns: u64,
    rounds: LookupMap<String, Round>,
    balances: IterableMap<AccountId, u64>,
    supply: u64,
    records: LookupMap<AccountId, Record>,
    names: LookupMap<AccountId, String>,
    agents: LookupSet<AccountId>,
    pools: LookupMap<AccountId, Pool>,
    /// every rockpool hash ever committed (so a reveal can't be invented)
    pool_hashes: LookupSet<String>,
    revealed: LookupMap<String, String>,
    raids: LookupMap<String, Raid>,
    season: u64,
    season_pearls: IterableMap<AccountId, u64>,
    rounds_settled: u64,
    raids_settled: u64,
}

#[near]
impl Clawtide {
    #[init]
    pub fn new(owner: AccountId, referee: AccountId) -> Self {
        Self {
            owner,
            referee,
            epoch_ns: env::block_timestamp(),
            rounds: LookupMap::new(Key::Rounds),
            balances: IterableMap::new(Key::Balances),
            supply: 0,
            records: LookupMap::new(Key::Records),
            names: LookupMap::new(Key::Names),
            agents: LookupSet::new(Key::Agents),
            pools: LookupMap::new(Key::Pools),
            pool_hashes: LookupSet::new(Key::PoolHashes),
            revealed: LookupMap::new(Key::Revealed),
            raids: LookupMap::new(Key::Raids),
            season: 0,
            season_pearls: IterableMap::new(Key::Season),
            rounds_settled: 0,
            raids_settled: 0,
        }
    }

    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
    }
    fn only_referee(&self) {
        require!(env::predecessor_account_id() == self.referee, "only the referee");
    }

    pub fn set_referee(&mut self, referee: AccountId) {
        self.only_owner();
        self.referee = referee;
    }

    /// Creates `{name}.{this contract}` whose only key is a function-call key for `build_rockpool`.
    #[payable]
    pub fn create_agent_account(&mut self, name: String, public_key: PublicKey) -> Promise {
        self.only_owner();
        require!(!name.is_empty() && !name.contains('.'), "agent name must be one label");
        let account: AccountId = format!("{name}.{}", env::current_account_id()).parse().unwrap_or_else(|_| env::panic_str("invalid agent name"));
        Promise::new(account).create_account().transfer(env::attached_deposit()).add_access_key_allowance(
            public_key,
            near_sdk::Allowance::limited(AGENT_GAS_ALLOWANCE).unwrap(),
            env::current_account_id(),
            AGENT_METHODS,
        )
    }

    /// Marks an account as an AI crab (it may build a rockpool before playing a round).
    pub fn register_agent(&mut self, account: AccountId, name: String) {
        self.only_owner();
        require!(valid_name(&name), "bad name");
        self.agents.insert(account.clone());
        self.names.insert(account, name);
    }

    // ---------- rounds ----------

    /// Commits the referee's secret and asks for the tide: a VRF draw in a later receipt.
    pub fn create_round(&mut self, round_id: String, secret_hash: String, seats: Vec<SeatIn>) -> Promise {
        self.only_referee();
        require!(valid_id(&round_id), "bad round id");
        require!(self.rounds.get(&round_id).is_none(), "round exists");
        require!(valid_hex64(&secret_hash), "secret hash must be 64 lowercase hex");
        require!(!seats.is_empty() && seats.len() <= MAX_SEATS, "1-4 seats");
        for s in &seats {
            require!(valid_name(&s.name), "bad seat name");
        }
        Event::RoundCreated { round_id: round_id.clone(), secret_hash: secret_hash.clone(), accounts: seats.iter().map(|s| s.account.clone()).collect() }.emit();
        let head = head_zero(&round_id);
        self.rounds.insert(
            round_id.clone(),
            Round {
                secret_hash,
                seats,
                created_ns: U64(env::block_timestamp()),
                vrf: None,
                vrf_block: None,
                chunks: 0,
                head: head.clone(),
                opened: 0,
                open_head: head,
                secret: None,
                board_seed: None,
                finals: vec![],
                settled: false,
                winner: None,
                minted: vec![],
            },
        );
        Promise::new(env::current_account_id()).function_call(
            "draw_tide",
            serde_json::to_vec(&json!({ "round_id": round_id })).unwrap(),
            NearToken::from_yoctonear(0),
            GAS_FOR_DRAW,
        )
    }

    /// Runs in the receipt after `create_round`: the block's VRF-derived seed becomes the round's draw.
    #[private]
    pub fn draw_tide(&mut self, round_id: String) -> String {
        require!(env::predecessor_account_id() == env::current_account_id(), "only the contract draws the tide");
        let r = self.rounds.get_mut(&round_id).unwrap_or_else(|| env::panic_str("no such round"));
        require!(r.vrf.is_none(), "already drawn");
        let vrf = hex::encode(env::random_seed_array());
        r.vrf = Some(vrf.clone());
        r.vrf_block = Some(U64(env::block_height()));
        Event::TideDrawn { round_id, vrf: vrf.clone(), block: U64(env::block_height()) }.emit();
        vrf
    }

    /// Posts the next chunks' seals (one per seat each) and folds them into the chain head.
    pub fn seal(&mut self, round_id: String, from_chunk: u32, chunks: Vec<Vec<String>>) {
        self.only_referee();
        let r = self.rounds.get_mut(&round_id).unwrap_or_else(|| env::panic_str("no such round"));
        require!(r.vrf.is_some(), "the tide hasn't been drawn yet");
        require!(!r.settled && r.opened == 0, "round closed");
        require!(from_chunk == r.chunks, "chunks must be sealed in order");
        require!(r.chunks + chunks.len() as u32 <= MAX_CHUNKS, "too many chunks");
        for seals in chunks {
            require!(seals.len() == r.seats.len(), "one seal per seat");
            require!(seals.iter().all(|s| valid_hex64(s)), "seals must be 64 lowercase hex");
            let chunk = r.chunks;
            r.head = next_head(&r.head, chunk, &seals);
            r.chunks += 1;
            Event::Sealed { round_id: round_id.clone(), chunk, seals, head: r.head.clone() }.emit();
        }
    }

    /// Reveals the secret and opens chunks in order. Every opening must rebuild its seal, and once
    /// all are open the re-folded head must equal the sealed one.
    pub fn open_chunks(&mut self, round_id: String, secret: String, from_chunk: u32, chunks: Vec<Vec<ChunkOpening>>) {
        self.only_referee();
        let r = self.rounds.get_mut(&round_id).unwrap_or_else(|| env::panic_str("no such round"));
        require!(!r.settled, "round closed");
        require!(sha_hex(&secret) == r.secret_hash, "secret does not match its hash");
        require!(from_chunk == r.opened, "chunks must be opened in order");
        require!(r.opened + chunks.len() as u32 <= r.chunks, "more chunks than were sealed");
        let n = r.seats.len();
        for openings in chunks {
            require!(openings.len() == n, "one opening per seat");
            let chunk = r.opened;
            let mut seals = Vec::with_capacity(n);
            for (seat, o) in openings.iter().enumerate() {
                require!(valid_inputs(&o.inputs), "bad inputs");
                require!(o.at < MAX_TILE && o.pearls <= 500, "impossible state");
                seals.push(seal_of(&round_id, &secret, seat, chunk, o));
            }
            r.open_head = next_head(&r.open_head, chunk, &seals);
            r.finals = openings.iter().map(|o| Final { pearls: o.pearls, clams: o.clams, stings: o.stings }).collect();
            r.opened += 1;
        }
        if r.opened == r.chunks {
            require!(r.open_head == r.head, "the openings don't rebuild the sealed chain head");
        }
        let seed = board_seed(r.vrf.as_deref().unwrap_or_default(), &secret);
        r.board_seed = Some(seed.clone());
        r.secret = Some(secret);
        Event::Opened { round_id, from: from_chunk, to: r.opened, board_seed: seed }.emit();
    }

    /// Settles a fully opened round from its final standings. Anyone may call it.
    pub fn settle_round(&mut self, round_id: String) {
        let mut r = self.rounds.get(&round_id).cloned().unwrap_or_else(|| env::panic_str("no such round"));
        require!(!r.settled, "round closed");
        require!(r.chunks > 0 && r.opened == r.chunks && r.open_head == r.head, "open every sealed chunk first");
        let winner = winner_of(&r.finals);
        let mut minted = vec![0u64; r.seats.len()];
        for (i, seat) in r.seats.iter().enumerate() {
            let Some(acct) = &seat.account else { continue };
            let f = &r.finals[i];
            let m = (f.pearls as u64).min(ROUND_MINT_CAP);
            if m > 0 {
                self.mint(acct, m, &format!("{round_id}: {m} pearls banked"));
            }
            minted[i] = m;
            self.names.insert(acct.clone(), seat.name.clone());
            let rec = self.records.entry(acct.clone()).or_default();
            rec.rounds += 1;
            rec.pearls_banked += m;
            rec.clams += f.clams;
            rec.stings += f.stings;
            if winner == Some(i as u8) && r.seats.len() > 1 {
                rec.wins += 1;
            }
        }
        Event::Settled { round_id: round_id.clone(), winner, minted: minted.clone() }.emit();
        self.rounds_settled += 1;
        r.settled = true;
        r.winner = winner;
        r.minted = minted;
        self.rounds.insert(round_id, r);
    }

    // ---------- rockpools ----------

    /// Commits the hash of your rockpool layout (`sha256("clawtide|pool|{layout}|{salt}")`).
    /// Works from a function-call key and through the gasless relayer.
    pub fn build_rockpool(&mut self, hash: String) {
        let who = env::predecessor_account_id();
        require!(valid_hex64(&hash), "hash must be 64 lowercase hex");
        let rounds = self.records.get(&who).map(|r| r.rounds).unwrap_or(0);
        require!(self.agents.contains(&who) || rounds >= BUILD_AFTER_ROUNDS, "play a sandbar round first");
        let now = env::block_timestamp();
        let pool = match self.pools.get(&who) {
            Some(p) => Pool { hash: hash.clone(), built_ns: U64(now), ..p.clone() },
            None => Pool { hash: hash.clone(), built_ns: U64(now), shield_until: U64(0), last_raider: None, raid_day: 0, raids_today: 0 },
        };
        self.pools.insert(who.clone(), pool);
        self.pool_hashes.insert(hash.clone());
        Event::PoolBuilt { account: who, hash }.emit();
    }

    /// Publishes a committed layout so raids against it can be replayed. Anyone may call it.
    pub fn reveal_pool(&mut self, hash: String, layout: String, salt: String) {
        require!(self.pool_hashes.contains(&hash), "no rockpool was built with that hash");
        require!(layout.len() == POOL_TILES && layout.bytes().all(|b| b"urc.".contains(&b)), "bad layout");
        require!(salt.len() <= 128, "salt too long");
        require!(pool_hash(&layout, &salt) == hash, "layout and salt don't make that hash");
        self.revealed.insert(hash.clone(), layout);
        Event::PoolRevealed { hash }.emit();
    }

    /// Starts a raid, enforcing the limits: one raid at a time per id, at most RAIDS_PER_DAY a day
    /// for the raider, never into a shielded pool. Revenge (raiding whoever last raided you) skips both.
    pub fn begin_raid(&mut self, raid_id: String, raider: AccountId, owner: AccountId) {
        self.only_referee();
        require!(valid_id(&raid_id) && self.raids.get(&raid_id).is_none(), "bad or used raid id");
        require!(raider != owner, "you can't raid your own rockpool");
        let now = env::block_timestamp();
        let day = now / DAY_NS;
        let target = self.pools.get(&owner).cloned().unwrap_or_else(|| env::panic_str("that crab has no rockpool"));
        let revenge = self.pools.get(&raider).and_then(|p| p.last_raider.clone()) == Some(owner.clone());
        if !revenge {
            require!(target.shield_until.0 <= now, "that rockpool is shielded");
            let mine = self.pools.get(&raider).cloned();
            let used = mine.as_ref().filter(|p| p.raid_day == day).map(|p| p.raids_today).unwrap_or(0);
            require!(used < RAIDS_PER_DAY, "no raids left today");
            if let Some(mut p) = mine {
                p.raid_day = day;
                p.raids_today = used + 1;
                self.pools.insert(raider.clone(), p);
            } else {
                // a raider without a pool: track the count on a placeholder record
                self.pools.insert(raider.clone(), Pool { hash: String::new(), built_ns: U64(0), shield_until: U64(0), last_raider: None, raid_day: day, raids_today: 1 });
            }
        }
        self.raids.insert(
            raid_id.clone(),
            Raid { raider: raider.clone(), owner: owner.clone(), pool_hash: target.hash, revenge, started_ns: U64(now), done: false, won: false, hops: String::new(), energy_left: 0, taken: 0, bounty: 0 },
        );
        Event::RaidBegun { raid_id, raider, owner, revenge }.emit();
    }

    /// Ends a raid: a raider who reached the cache takes a share of the owner's PEARL and the owner
    /// is shielded for an hour; a raider turned back earns the owner a small bounty.
    pub fn settle_raid(&mut self, raid_id: String, hops: String, won: bool, energy_left: u32) {
        self.only_referee();
        let mut raid = self.raids.get(&raid_id).cloned().unwrap_or_else(|| env::panic_str("no such raid"));
        require!(!raid.done, "raid settled");
        require!(hops.len() <= 400 && hops.bytes().all(|b| (b'1'..=b'8').contains(&b)), "bad hops");
        let now = env::block_timestamp();
        if won {
            let bal = self.balance(&raid.owner);
            let take = (bal * RAID_TAKE_PCT / 100).max(bal.min(1)).min(RAID_TAKE_MAX);
            if take > 0 {
                self.debit(&raid.owner, take);
                self.credit(&raid.raider, take);
                nep141("ft_transfer", json!({ "old_owner_id": raid.owner, "new_owner_id": raid.raider, "amount": take.to_string(), "memo": format!("raid {raid_id}") }));
            }
            raid.taken = take;
            if let Some(p) = self.pools.get_mut(&raid.owner) {
                p.shield_until = U64(now + SHIELD_NS);
                p.last_raider = Some(raid.raider.clone());
            }
            self.records.entry(raid.raider.clone()).or_default().raids_won += 1;
            self.records.entry(raid.owner.clone()).or_default().raided += 1;
        } else {
            self.mint(&raid.owner, DEFENCE_BOUNTY, &format!("raid {raid_id}: rockpool held"));
            raid.bounty = DEFENCE_BOUNTY;
            self.records.entry(raid.raider.clone()).or_default().raids_failed += 1;
            self.records.entry(raid.owner.clone()).or_default().defended += 1;
        }
        raid.done = true;
        raid.won = won;
        raid.hops = hops.clone();
        raid.energy_left = energy_left;
        Event::RaidSettled { raid_id: raid_id.clone(), won, hops, taken: raid.taken, bounty: raid.bounty }.emit();
        self.raids_settled += 1;
        self.raids.insert(raid_id, raid);
    }

    // ---------- views ----------

    pub fn get_round(&self, round_id: String) -> Option<Round> {
        self.rounds.get(&round_id).cloned()
    }
    pub fn get_raid(&self, raid_id: String) -> Option<Raid> {
        self.raids.get(&raid_id).cloned()
    }
    pub fn get_pool(&self, account_id: AccountId) -> Option<Pool> {
        self.pools.get(&account_id).cloned().filter(|p| !p.hash.is_empty())
    }
    pub fn revealed_pool(&self, hash: String) -> Option<String> {
        self.revealed.get(&hash).cloned()
    }
    pub fn get_record(&self, account_id: AccountId) -> Record {
        self.records.get(&account_id).cloned().unwrap_or_default()
    }
    pub fn get_referee(&self) -> AccountId {
        self.referee.clone()
    }
    pub fn is_agent(&self, account_id: AccountId) -> bool {
        self.agents.contains(&account_id)
    }
    /// The Pearl Crown: the account holding the most PEARL (ties: the first to get there stays).
    pub fn get_crown(&self) -> Option<Crown> {
        let mut best: Option<(&AccountId, u64)> = None;
        for (a, b) in self.balances.iter() {
            if *b > 0 && best.map(|(_, x)| *b > x).unwrap_or(true) {
                best = Some((a, *b));
            }
        }
        best.map(|(a, p)| Crown { account: a.clone(), name: self.names.get(a).cloned().unwrap_or_default(), pearls: p })
    }
    pub fn season_info(&self) -> SeasonInfo {
        let s = self.season_index();
        SeasonInfo {
            season: s + 1,
            started_ns: U64(self.epoch_ns + s * SEASON_NS),
            ends_ns: U64(self.epoch_ns + (s + 1) * SEASON_NS),
            supply: U128(self.supply as u128),
            rounds_settled: self.rounds_settled,
            raids: self.raids_settled,
        }
    }
    /// Richest first; each row also shows pearls earned this season.
    pub fn leaderboard(&self, limit: Option<u32>) -> Vec<BoardRow> {
        let current = self.season_index() == self.season;
        let mut rows: Vec<BoardRow> = self
            .balances
            .iter()
            .map(|(a, b)| BoardRow {
                account: a.clone(),
                name: self.names.get(a).cloned().unwrap_or_default(),
                pearls: *b,
                season_pearls: if current { self.season_pearls.get(a).copied().unwrap_or(0) } else { 0 },
                wins: self.records.get(a).map(|r| r.wins).unwrap_or(0),
            })
            .collect();
        rows.sort_by(|a, b| b.pearls.cmp(&a.pearls).then(b.season_pearls.cmp(&a.season_pearls)).then(a.account.cmp(&b.account)));
        rows.truncate(limit.unwrap_or(20).min(100) as usize);
        rows
    }

    // ---------- NEP-141: PEARL ----------

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        near_sdk::assert_one_yocto();
        let sender = env::predecessor_account_id();
        let amount = amount.0 as u64;
        require!(amount > 0 && sender != receiver_id, "bad transfer");
        self.debit(&sender, amount);
        self.credit(&receiver_id, amount);
        let mut data = json!({ "old_owner_id": sender, "new_owner_id": receiver_id, "amount": amount.to_string() });
        if let Some(m) = memo {
            data["memo"] = json!(m);
        }
        nep141("ft_transfer", data);
    }
    pub fn ft_total_supply(&self) -> U128 {
        U128(self.supply as u128)
    }
    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balance(&account_id) as u128)
    }
    pub fn ft_metadata(&self) -> FtMetadata {
        FtMetadata { spec: "ft-1.0.0".into(), name: "Pearl".into(), symbol: "PEARL".into(), icon: Some(pearl_icon()), reference: None, reference_hash: None, decimals: 0 }
    }
    /// Registration is free: every account can hold PEARL (the contract pays the storage).
    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        let _ = (account_id, registration_only);
        let deposit = env::attached_deposit();
        if !deposit.is_zero() {
            Promise::new(env::predecessor_account_id()).transfer(deposit).detach();
        }
        StorageBalance { total: U128(0), available: U128(0) }
    }
    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        let _ = account_id;
        Some(StorageBalance { total: U128(0), available: U128(0) })
    }

    // ---------- internals ----------

    fn season_index(&self) -> u64 {
        (env::block_timestamp().saturating_sub(self.epoch_ns)) / SEASON_NS
    }
    fn balance(&self, who: &AccountId) -> u64 {
        self.balances.get(who).copied().unwrap_or(0)
    }
    fn credit(&mut self, who: &AccountId, amount: u64) {
        let b = self.balance(who);
        self.balances.insert(who.clone(), b + amount);
        let s = self.season_index();
        if s != self.season {
            self.season = s;
            self.season_pearls.clear();
        }
        let e = self.season_pearls.get(who).copied().unwrap_or(0);
        self.season_pearls.insert(who.clone(), e + amount);
    }
    fn debit(&mut self, who: &AccountId, amount: u64) {
        let b = self.balance(who);
        require!(b >= amount, "not enough PEARL");
        self.balances.insert(who.clone(), b - amount);
    }
    fn mint(&mut self, who: &AccountId, amount: u64, memo: &str) {
        self.credit(who, amount);
        self.supply += amount;
        nep141("ft_mint", json!({ "owner_id": who, "amount": amount.to_string(), "memo": memo }));
    }
}

fn pearl_icon() -> String {
    let svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' shape-rendering='crispEdges'><rect width='16' height='16' fill='#0b2a3a'/><rect x='5' y='4' width='6' height='8' fill='#f3ecff'/><rect x='4' y='5' width='8' height='6' fill='#f3ecff'/><rect x='6' y='5' width='2' height='2' fill='#ffffff'/><rect x='9' y='9' width='2' height='2' fill='#c9b8e8'/></svg>";
    format!("data:image/svg+xml,{}", svg.replace('<', "%3C").replace('>', "%3E").replace('#', "%23"))
}
