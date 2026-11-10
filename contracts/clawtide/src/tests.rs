use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const SECRET: &str = "secret";

fn ctx(who: &str, ms: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id("clawtide.testnet".parse().unwrap())
        .predecessor_account_id(who.parse().unwrap())
        .block_timestamp(ms * 1_000_000)
        .random_seed([7u8; 32])
        .build());
}

fn contract() -> Clawtide {
    ctx("clawtide.testnet", 1000);
    Clawtide::new("clawtide.testnet".parse().unwrap(), "ref.testnet".parse().unwrap())
}

fn op(inputs: &str, at: u32, pearls: u32, clams: u32, stings: u32) -> ChunkOpening {
    ChunkOpening { inputs: inputs.into(), at, pearls, clams, stings }
}

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

/// A full round: alice (signed in) and a guest; alice ends with 9 pearls, the guest with 4.
fn play_round(c: &mut Clawtide, id: &str) {
    ctx("ref.testnet", 2000);
    let _ = c.create_round(id.into(), sha_hex(SECRET), vec![SeatIn { account: Some(acct("alice.testnet")), name: "Alice".into() }, SeatIn { account: None, name: "Guest".into() }]);
    ctx("clawtide.testnet", 2100);
    c.draw_tide(id.into());
    let chunks = vec![vec![op("3:3", 40, 1, 0, 0), op("", 50, 0, 0, 0)], vec![op("31:5;40:5", 64, 9, 1, 0), op("33:7", 49, 4, 0, 1)]];
    ctx("ref.testnet", 2200);
    for (k, ch) in chunks.iter().enumerate() {
        let seals: Vec<String> = ch.iter().enumerate().map(|(seat, o)| seal_of(id, SECRET, seat, k as u32, o)).collect();
        c.seal(id.into(), k as u32, vec![seals]);
    }
    c.open_chunks(id.into(), SECRET.into(), 0, chunks);
    c.settle_round(id.into());
}

#[test]
fn shared_vector_matches_packages_rules() {
    // packages/rules/test/vector.json
    let o = op("3:3;7:5", 42, 6, 1, 0);
    let seal = seal_of("r-test", "secret", 1, 0, &o);
    assert_eq!(seal, "e8a4796431fdf409b537a0539e10e7bc2312eac3f4c0c190aa8290b038462757");
    assert_eq!(next_head(&head_zero("r-test"), 0, &[seal]), "a67390274cd56574cfd5da668ea3ae997d0723970878e3e4f63a97ece1a2ade7");
    assert_eq!(pool_hash(&".".repeat(81), "salt"), "e7f18a706174c46af465674f3815f39bba3858f754fb8d406b8e197779521a7a");
}

#[test]
fn a_round_draws_vrf_after_the_commit_then_opens_and_settles() {
    let mut c = contract();
    play_round(&mut c, "r-1");
    let r = c.get_round("r-1".into()).unwrap();
    let vrf = hex::encode([7u8; 32]);
    assert_eq!(r.vrf.as_deref(), Some(vrf.as_str()));
    assert_eq!(r.board_seed.unwrap(), board_seed(&vrf, SECRET));
    assert!(r.settled);
    assert_eq!(r.winner, Some(0));
    assert_eq!(r.minted, vec![9, 0]);
    assert_eq!(c.ft_balance_of(acct("alice.testnet")).0, 9);
    assert_eq!(c.ft_total_supply().0, 9);
    let rec = c.get_record(acct("alice.testnet"));
    assert_eq!((rec.rounds, rec.wins, rec.clams), (1, 1, 1));
    assert_eq!(c.get_crown().unwrap().account, acct("alice.testnet"));
}

#[test]
#[should_panic(expected = "the tide hasn't been drawn yet")]
fn no_seals_before_the_draw() {
    let mut c = contract();
    ctx("ref.testnet", 2000);
    let _ = c.create_round("r-2".into(), sha_hex(SECRET), vec![SeatIn { account: None, name: "G".into() }]);
    c.seal("r-2".into(), 0, vec![vec![sha_hex("x")]]);
}

#[test]
#[should_panic(expected = "only the contract draws the tide")]
fn only_the_contract_draws_the_tide() {
    let mut c = contract();
    ctx("ref.testnet", 2000);
    let _ = c.create_round("r-3".into(), sha_hex(SECRET), vec![SeatIn { account: None, name: "G".into() }]);
    c.draw_tide("r-3".into());
}

#[test]
#[should_panic(expected = "secret does not match its hash")]
fn a_wrong_secret_is_refused() {
    let mut c = contract();
    ctx("ref.testnet", 2000);
    let _ = c.create_round("r-4".into(), sha_hex(SECRET), vec![SeatIn { account: None, name: "G".into() }]);
    ctx("clawtide.testnet", 2100);
    c.draw_tide("r-4".into());
    ctx("ref.testnet", 2200);
    let o = op("", 3, 0, 0, 0);
    c.seal("r-4".into(), 0, vec![vec![seal_of("r-4", SECRET, 0, 0, &o)]]);
    c.open_chunks("r-4".into(), "other".into(), 0, vec![vec![o]]);
}

#[test]
#[should_panic(expected = "the openings don't rebuild the sealed chain head")]
fn tampered_openings_are_refused() {
    let mut c = contract();
    ctx("ref.testnet", 2000);
    let _ = c.create_round("r-5".into(), sha_hex(SECRET), vec![SeatIn { account: None, name: "G".into() }]);
    ctx("clawtide.testnet", 2100);
    c.draw_tide("r-5".into());
    ctx("ref.testnet", 2200);
    c.seal("r-5".into(), 0, vec![vec![seal_of("r-5", SECRET, 0, 0, &op("", 3, 2, 0, 0))]]);
    c.open_chunks("r-5".into(), SECRET.into(), 0, vec![vec![op("", 3, 50, 0, 0)]]);
}

#[test]
fn the_mint_is_capped_per_round() {
    let mut c = contract();
    ctx("ref.testnet", 2000);
    let _ = c.create_round("r-6".into(), sha_hex(SECRET), vec![SeatIn { account: Some(acct("bob.testnet")), name: "Bob".into() }]);
    ctx("clawtide.testnet", 2100);
    c.draw_tide("r-6".into());
    ctx("ref.testnet", 2200);
    let o = op("", 3, 90, 0, 0);
    c.seal("r-6".into(), 0, vec![vec![seal_of("r-6", SECRET, 0, 0, &o)]]);
    c.open_chunks("r-6".into(), SECRET.into(), 0, vec![vec![o]]);
    c.settle_round("r-6".into());
    assert_eq!(c.ft_balance_of(acct("bob.testnet")).0, ROUND_MINT_CAP as u128);
}

#[test]
#[should_panic(expected = "play a sandbar round first")]
fn rockpools_unlock_after_a_round() {
    let mut c = contract();
    ctx("carol.testnet", 3000);
    c.build_rockpool(sha_hex("p"));
}

#[test]
fn raids_take_a_share_shield_the_owner_and_allow_revenge() {
    let mut c = contract();
    play_round(&mut c, "r-7"); // alice: 9 PEARL, 1 round
    ctx("alice.testnet", 3000);
    let layout = format!("{}c{}", ".".repeat(4), ".".repeat(76));
    let h = pool_hash(&layout, "s");
    c.build_rockpool(h.clone());
    ctx("clawtide.testnet", 3000);
    c.register_agent(acct("coral.clawtide.testnet"), "Coral".into());
    ctx("coral.clawtide.testnet", 3000);
    c.build_rockpool(sha_hex("coral"));

    ctx("ref.testnet", 4000);
    c.begin_raid("x-1".into(), acct("coral.clawtide.testnet"), acct("alice.testnet"));
    c.settle_raid("x-1".into(), "1111111".into(), true, 33);
    assert_eq!(c.ft_balance_of(acct("alice.testnet")).0, 8);
    assert_eq!(c.ft_balance_of(acct("coral.clawtide.testnet")).0, 1);
    assert!(c.get_pool(acct("alice.testnet")).unwrap().shield_until.0 > 4000 * 1_000_000);

    // alice takes revenge although coral's pool isn't shielded anyway; a failed raid pays coral a bounty
    c.begin_raid("x-2".into(), acct("alice.testnet"), acct("coral.clawtide.testnet"));
    assert!(c.get_raid("x-2".into()).unwrap().revenge);
    c.settle_raid("x-2".into(), "12".into(), false, 0);
    assert_eq!(c.ft_balance_of(acct("coral.clawtide.testnet")).0, 1 + DEFENCE_BOUNTY as u128);
    assert_eq!(c.ft_total_supply().0, 9 + DEFENCE_BOUNTY as u128);

    // anyone can reveal the layout once the salt is public; a wrong one is refused
    c.reveal_pool(h.clone(), layout.clone(), "s".into());
    assert_eq!(c.revealed_pool(h).unwrap(), layout);
}

#[test]
#[should_panic(expected = "that rockpool is shielded")]
fn a_shielded_pool_cant_be_raided() {
    let mut c = contract();
    play_round(&mut c, "r-8");
    ctx("alice.testnet", 3000);
    c.build_rockpool(sha_hex("a"));
    ctx("ref.testnet", 4000);
    c.begin_raid("y-1".into(), acct("bob.testnet"), acct("alice.testnet"));
    c.settle_raid("y-1".into(), "1".into(), true, 10);
    c.begin_raid("y-2".into(), acct("dan.testnet"), acct("alice.testnet"));
}

#[test]
#[should_panic(expected = "no raids left today")]
fn raids_per_day_are_capped() {
    let mut c = contract();
    play_round(&mut c, "r-9");
    ctx("alice.testnet", 3000);
    c.build_rockpool(sha_hex("a"));
    ctx("ref.testnet", 4000);
    for k in 0..=RAIDS_PER_DAY {
        let id = format!("z-{k}");
        c.begin_raid(id.clone(), acct("bob.testnet"), acct("alice.testnet"));
        c.settle_raid(id, "1".into(), false, 0);
    }
}

#[test]
fn winner_rule_matches_rules() {
    let f = |p: u32, s: u32| Final { pearls: p, clams: 0, stings: s };
    assert_eq!(winner_of(&[f(4, 2), f(4, 1)]), Some(1));
    assert_eq!(winner_of(&[f(4, 1), f(4, 1)]), Some(0));
    assert_eq!(winner_of(&[f(1, 0), f(7, 3)]), Some(1));
}
