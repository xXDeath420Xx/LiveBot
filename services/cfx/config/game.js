// Greenhouse Tycoon (cfx v2): the numeric rules of the game in one place.
// Display names and player-facing text live in copy.js; catalogue entries in catalog.js.

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

// Owner decision 2026-11-18 (audit B12): staff earn for at most 12 hours while the player is away.
export const OFFLINE_CAP_MS = 12 * HOUR_MS;

// Owner decision 2026-11-18 (audit B12): seasons last 30 days with weekly challenges.
export const SEASON_LENGTH_DAYS = 30;

export const LIMITS = Object.freeze({
    // Every money and item amount stays a safe JS integer (< 2^53) end to end.
    MAX_BALANCE: 9_000_000_000_000_000,
    MAX_CASH_DELTA: 1_000_000_000_000,
    MAX_ITEM_DELTA: 1_000_000,
    MAX_ITEM_QUANTITY: 1_000_000_000_000,
    MAX_LINES_PER_OP: 20,
    MAX_ITEM_ID: 2_147_483_647,
    MAX_PLOTS: 24,
    MAX_LEVEL: 100
});

export const ITEM_KINDS = Object.freeze(['seed', 'produce', 'boost']);

// Quality bands 0..3 (names in copy.js). Seeds and boosts always use band 0.
export const QUALITY_BANDS = 4;

// Why money or items moved. Every ledger row carries one of these.
export const LEDGER_REASONS = Object.freeze([
    'starter', 'daily', 'plant', 'harvest', 'sell', 'buy', 'upgrade', 'staff_hire', 'staff_claim',
    'order', 'breed', 'boost', 'quest', 'achievement', 'season_reward', 'admin_adjust', 'test',
    // phase 4
    'challenge', 'replant', 'decoration', 'review_seed'
]);

// What a brand-new account receives once per identity (not once per account; see store/accounts.js).
export const STARTER_KIT = Object.freeze({
    cash: 500,
    plots: 2,
    seeds: Object.freeze([
        Object.freeze({ varietyId: 1, quantity: 5 }),
        Object.freeze({ varietyId: 2, quantity: 5 }),
        Object.freeze({ varietyId: 3, quantity: 5 })
    ])
});

// Varieties with an id below this come from catalog.js; hybrids bred by players start here.
export const FIRST_HYBRID_ID = 1000;

export const GROWTH = Object.freeze({
    MIN_GROW_MS: 30 * SECOND_MS,
    MAX_SPEED_PCT: 75
});

// Display names (phase 3): players rename themselves with POST /account/name (store/accounts.js rename()),
// at most once per RENAME_COOLDOWN_MS. Word rules: lib/name-filter.js. Twitch panel players start as
// DEFAULT_DISPLAY_NAME (copy.js) because the panel token carries no name.
export const NAMES = Object.freeze({ MIN_LENGTH: 2, MAX_LENGTH: 24, RENAME_COOLDOWN_MS: 7 * DAY_MS });

// Account linking (store/accounts.js). One identity per platform per account.
export const LINKING = Object.freeze({
    PLATFORMS: Object.freeze(['twitch', 'twitch_opaque', 'kick', 'discord', 'dev']),
    CODE_LENGTH: 8,
    CODE_ALPHABET: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', // no 0/O/1/I
    CODE_TTL_MS: 10 * MINUTE_MS,
    MAX_ACTIVE_CODES: 3,
    RELINK_COOLDOWN_MS: 7 * DAY_MS,
    MAX_FAILED_CODES_PER_HOUR: 10
});

// Phase 2 gameplay numbers. Tuned with the economy simulator (services/cfx/sim/, tests/cfx/v2/economy-sim.test.js);
// change them there first and re-run it.
export const TUNING = Object.freeze({
    // Watering: once per planting, from half-grown until ready, cuts the time still to go (so checking in
    // mid-grow pays off; a plant watered at exactly half-grown finishes in 75 % of the time). No cooldown: the
    // "watered" mark belongs to the planting (gh_plots.watered_at_ms, cleared by the next planting), so a
    // plot can never be stuck "on cooldown" (the old game's bug class).
    WATER_MIN_PROGRESS_PCT: 50,
    WATER_CUT_PCT: 50,
    // XP for a harvest: XP_PER_GROW_MINUTE per minute of the variety's base grow time, at least 1.
    XP_PER_GROW_MINUTE: 2,
    // XP for selling: one point per this much cash (rounded down).
    SELL_CASH_PER_XP: 60,
    DAILY: Object.freeze({ BASE_CASH: 100, PER_LEVEL_CASH: 15, STREAK_STEP_CASH: 20, STREAK_MAX: 7, STREAK_SEEDS: 5 }),
    ORDERS: Object.freeze({
        PER_DAY: 3,
        MIN_DAYS: 1,
        MAX_DAYS: 3,
        PREMIUM_MIN_PCT: 135,
        PREMIUM_MAX_PCT: 175,
        XP_BONUS_PCT: 150,
        KEEP_DAYS: 30
    }),
    BREEDING: Object.freeze({
        MIN_LEVEL: 4,
        SLOTS: 1,
        TIME_FACTOR_PCT: 300,
        MIN_MS: 10 * MINUTE_MS,
        MAX_MS: 6 * HOUR_MS,
        FEE_PCT: 200,
        SEEDS_OUT: 3,
        XP_NEW: 120,
        XP_REPEAT: 30
    }),
    STAFF: Object.freeze({ HIRE_GROWTH_PCT: 160 }),
    // Hybrid seeds sold in the shop once discovered: base price x yield x this %.
    HYBRID_SEED_PRICE_PCT: 70
});

export const SEASON_SCORE = Object.freeze({
    DAILY_CAP: 1000,
    // 'sale' is per SALE_CASH_PER_POINT cash of a sale; 'quest' per daily quest (weekly quests count 3,
    // a finished weekly challenge 4).
    POINTS: Object.freeze({ harvest: 2, sale: 1, order: 30, quest: 50, new_variety: 40 }),
    SALE_CASH_PER_POINT: 250
});

// ------------------------------------------------------------------ phase 4: meta game
// Tuned with the economy simulator (sim/economy.js, `node services/cfx/sim/report.js 90 --replant`).

// Quests: three daily and three weekly per account, picked deterministically from the catalogue
// (catalog.js QUESTS) per account and day/week. Rewards grow with the level the quest was made at.
export const QUESTS = Object.freeze({
    DAILY_COUNT: 3,
    WEEKLY_COUNT: 3,
    DAILY_REWARD: Object.freeze({ cashBase: 0, cashPerLevel: 8, xpBase: 5, xpPerLevel: 2 }),
    WEEKLY_REWARD: Object.freeze({ cashBase: 0, cashPerLevel: 40, xpBase: 30, xpPerLevel: 10 }),
    WEEKLY_SEASON_QUESTS: 3, // a weekly quest counts as this many daily quests for the season score
    CHALLENGE_SEASON_QUESTS: 4
});

// Seasons (owner decision: 30 days; rewards scaled to this economy, weighted towards badges).
// Weekly challenges: weeks 1-4 of a season; each needs MIN_ACTIVE_PLAYERS players seen in the 7 days before
// it starts (gh_config 'challenges.minActivePlayers' overrides), else it is skipped.
export const SEASON = Object.freeze({
    LENGTH_DAYS: SEASON_LENGTH_DAYS,
    CHALLENGE_WEEKS: 4,
    MIN_ACTIVE_PLAYERS: 3,
    ACTIVE_WINDOW_DAYS: 7,
    CHALLENGE_REWARD: Object.freeze({ cash: 2000, xp: 300 }),
    CHALLENGE_PODIUM: Object.freeze({ places: 3, cash: 5000 }),
    // Best tier wins (catalog.js SEASON_TIERS); a standing below PARTICIPATION_MIN_SCORE gets nothing.
    PARTICIPATION_MIN_SCORE: 100,
    PAYOUT_BATCH: 200
});

// Replant (prestige): reset the greenhouse for a permanent bonus. Owner approved 2026-11-18.
//   Kept: the collection (as a record), achievements, stats, badges, decorations, season standing.
//   Reset: cash, XP and level, upgrades, staff, plots (back to the starter two), inventory, crosses, orders.
//   Each replant adds PRICE_PCT to sale prices and XP_PCT to XP, counted for at most MAX_COUNTED replants.
export const REPLANT = Object.freeze({
    MIN_LEVEL: 25,
    PRICE_PCT: 10,
    XP_PCT: 10,
    MAX_COUNTED: 5
});

// Decorations: cosmetic, bought with cash (the sink for players who finished the upgrade tree).
export const DECORATIONS_RULES = Object.freeze({ MAX_PLACED: 6 });

export const NOTIFICATIONS = Object.freeze({ PAGE: 20, KEEP_DAYS: 30, MAX_UNREAD_SHOWN: 99 });

export const LEADERBOARD = Object.freeze({ PAGE_SIZE: 20, MAX_PAGES: 25, CACHE_MS: 60_000 });

// The Twitch review account (README "Twitch review account"): one shared, sandboxed save, reset nightly.
export const REVIEW = Object.freeze({
    PLATFORM_USER_ID: 'review-1',
    DISPLAY_NAME: 'Review save',
    RESET_HOUR_UTC: 4,
    FRESH_AFTER_MS: 30 * MINUTE_MS
});
