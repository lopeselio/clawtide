// Every number the game is tuned with. Ticks run at TICK_HZ; positions are tile indices.

export const RULES_VERSION = 1;
export const TICK_HZ = 10;
/** one sealed chunk: 3 s */
export const CHUNK = 30;
/** the tide comes in after 3:00 even if clams are left */
export const MAX_TICKS = 1800;
export const MAX_SEATS = 4;

/** ticks between two hops (a crab hops about two and a half tiles a second) */
export const HOP_TICKS = 4;
/** ticks a stung crab lies dazed on the shore */
export const STUN_TICKS = 16;
/** ticks of standing on a clam to pry it open */
export const CLAM_TICKS = 18;
export const CLAM_PEARLS = 5;
/** pearls an urchin knocks out of you (lost to the sea) */
export const STING_LOSS = 2;
/** hopping onto the crowned crab's tile pinches this many pearls off it */
export const PINCH = 1;
export const PINCH_COOLDOWN = 20;

/** board limits */
export const MAX_W = 24;
export const MAX_H = 16;
/** share of the sandbar's land that hides urchins (percent) */
export const URCHIN_PCT = 20;
/** share of the safe sand that hides a loose pearl (percent) */
export const PEARL_PCT = 13;

/** most pearls one seat can bank from one sandbar (the contract enforces the same cap) */
export const ROUND_MINT_CAP = 60;

// ---------- rockpools (raids) ----------
export const POOL = 9;
export const POOL_URCHINS = 14;
export const POOL_ROCKS = 10;
export const RAID_ENERGY = 40;
export const RAID_STEP = 1;
export const RAID_STING = 12;
/** the raider wades in here (bottom row, middle) */
export const POOL_ENTRY = (POOL - 1) * POOL + (POOL >> 1);
