/*
 * Critters: fixed game constants. Data that a designer would tune (tiers, species, gems, weapons, prices)
 * lives in ./data; this file holds the structural limits and the CertiFried house rules.
 */

/** The game currency. Defined once; every surface reads it from here. */
export const CURRENCY = Object.freeze({
    name: 'acorns',
    singular: 'acorn',
    emoji: '\u{1F330}', // chestnut
    // Shape expected by core/economy-manager.js formatMoney(amount, meta).
    meta: Object.freeze({ currency_name: 'acorns', currency_emoji: '\u{1F330}' }),
});

/** Format an amount with the game currency, e.g. "🌰 1,250 acorns". */
export function formatAcorns(amount) {
    const n = Number(amount) || 0;
    return `${CURRENCY.emoji} ${n.toLocaleString('en-US')} ${n === 1 ? CURRENCY.singular : CURRENCY.name}`;
}

export const STARTING_BALANCE = 15000;

// Teams and pets
export const TEAM_LIMIT = 5;
export const TEAM_SLOTS = 3;
export const TEAM_NAME_MAX = 50;
export const NICKNAME_MAX = 35;

// Battle
export const BATTLE_TURN_CAP = 20;
export const BATTLE_BET_CAP = 250000;
export const CHALLENGE_WINDOW_SECONDS = 60;
export const ESCROW_PENDING_SECONDS = 75; // 60 s window + 15 s grace
export const ESCROW_FIGHTING_SECONDS = 300;
export const BATTLE_FRAME_DELAY_MS = 1600;

// Passive play
export const AUTOHUNT_INTERVAL_MS = 30 * 60 * 1000;
export const AUTOHUNT_MAX_QUEUED = 24;
export const RANCH_TICK_MS = 60 * 60 * 1000;
export const RANCH_MAX_HOURS = 24;

// Cooldowns
export const DAY_MS = 24 * 60 * 60 * 1000;
export const DAILY_COOLDOWN_MS = DAY_MS;
export const DAILY_STREAK_GRACE_MS = 48 * 60 * 60 * 1000;
export const LUCK_COOLDOWN_MS = DAY_MS;

// Config
export const CONFIG_CACHE_TTL_MS = 30 * 1000;
export const HUNT_COOLDOWN_DEFAULT = 15;
export const HUNT_COOLDOWN_MIN = 1;
export const HUNT_COOLDOWN_MAX = 3600;
export const MULTIPLIER_MIN = 0.1;
export const MULTIPLIER_MAX = 10;

// Inventory actions
export const LOOTBOX_OPEN_MAX = 100;
export const GEM_USE_MAX_IDS = 4;
export const CRATE_GRANT_MAX = 1000;

// Floor (channel drops). The ceiling protects a channel floor from absurd totals.
export const FLOOR_CEILING = 4_000_000_000;

// Profile
export const PROFILE_ABOUT_MAX = 255;
export const PROFILE_TITLE_MAX = 30;

// Transactions view
export const TRANSACTIONS_DEFAULT = 15;
export const TRANSACTIONS_MAX = 50;

/** Epoch stamp used for "never" windows, so a new row never eats a first daily drop. */
export const EPOCH = new Date(Date.UTC(1970, 0, 1, 0, 0, 1));
