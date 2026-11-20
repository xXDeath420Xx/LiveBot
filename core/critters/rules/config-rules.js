/*
 * Per-guild config: defaults, sanitising and the gate check. Pure (no DB).
 *
 * Config keys (columns of critter_config) are interface and keep the legacy names:
 * enabled, hunt_cooldown_seconds, reward_currency_multiplier, reward_xp_multiplier, sell_multiplier,
 * sacrifice_xp_multiplier, disabled_subcommands, allowed_channel_ids, blocked_role_ids, announce_rare_catches.
 *
 * reward_xp_multiplier is USED: it scales the pet XP a hunt gives the active team.
 */
import {
    HUNT_COOLDOWN_DEFAULT, HUNT_COOLDOWN_MIN, HUNT_COOLDOWN_MAX, MULTIPLIER_MIN, MULTIPLIER_MAX,
} from '../constants.js';

export const CONFIG_DEFAULTS = Object.freeze({
    enabled: false,
    hunt_cooldown_seconds: HUNT_COOLDOWN_DEFAULT,
    reward_currency_multiplier: 1,
    reward_xp_multiplier: 1,
    sell_multiplier: 0.5,
    sacrifice_xp_multiplier: 1,
    disabled_subcommands: [],
    allowed_channel_ids: [],
    blocked_role_ids: [],
    announce_rare_catches: true,
});

export const NUMERIC_KEYS = Object.freeze(['hunt_cooldown_seconds', 'reward_currency_multiplier', 'reward_xp_multiplier', 'sell_multiplier', 'sacrifice_xp_multiplier']);
export const BOOLEAN_KEYS = Object.freeze(['enabled', 'announce_rare_catches']);
export const ARRAY_KEYS = Object.freeze(['disabled_subcommands', 'allowed_channel_ids', 'blocked_role_ids']);
export const CONFIG_KEYS = Object.freeze([...BOOLEAN_KEYS, ...NUMERIC_KEYS, ...ARRAY_KEYS]);

/**
 * Canonical feature keys: one per command path, every path included. These are what disabled_subcommands holds.
 * The 48 legacy keys are all kept with the same meaning; lootbox, gems, use, boss, count, team-delete and feed
 * are new so that every path can be switched off.
 */
export const FEATURE_KEYS = Object.freeze([
    'hunt', 'zoo', 'leaderboard', 'catalog', 'sell', 'sacrifice', 'daily', 'balance', 'give', 'stats',
    'team', 'team-create', 'team-add', 'team-remove', 'team-switch', 'team-rename', 'team-delete',
    'equip', 'unequip', 'pet-name', 'battle', 'weapon', 'crate', 'lootbox', 'gems', 'use', 'quest', 'shards',
    'dismantle', 'forge', 'favorite', 'forge-prices', 'ranch', 'ranch-claim', 'pray', 'curse', 'cookie',
    'top', 'lottery', 'drop', 'pickup', 'duel', 'battle-settings', 'give-limits', 'transactions',
    'wallpaper', 'ring', 'marry', 'shop', 'profile', 'autohunt', 'luck', 'boss', 'count', 'feed',
]);
const FEATURE_SET = new Set(FEATURE_KEYS);

/**
 * Command path -> feature key. Paths are the usage-tracking paths ("owo hunt", "owo team add", "owo2 marry accept",
 * "owo-profile view", "autohunt claim", "luck"). Group entries ("owo2 wallpaper") cover every leaf below them.
 * null = never gated by a feature key (admin toggles and grants, owoify).
 */
export const PATH_FEATURES = Object.freeze({
    'owo hunt': 'hunt', 'owo zoo': 'zoo', 'owo leaderboard': 'leaderboard', 'owo catalog': 'catalog',
    'owo sell': 'sell', 'owo sacrifice': 'sacrifice', 'owo daily': 'daily', 'owo balance': 'balance',
    'owo give': 'give', 'owo stats': 'stats', 'owo weapon': 'weapon', 'owo crate': 'crate',
    'owo lootbox': 'lootbox', 'owo gems': 'gems', 'owo use': 'use', 'owo grant-crate': null,
    'owo team view': 'team', 'owo team create': 'team-create', 'owo team add': 'team-add',
    'owo team remove': 'team-remove', 'owo team switch': 'team-switch', 'owo team rename': 'team-rename',
    'owo team delete': 'team-delete', 'owo equip': 'equip', 'owo unequip': 'unequip', 'owo pet-name': 'pet-name',
    'owo battle': 'battle', 'owo quest': 'quest', 'owo boss': 'boss', 'owo toggle': null, 'owo count': 'count',
    'owo2 shards': 'shards', 'owo2 dismantle': 'dismantle', 'owo2 forge': 'forge', 'owo2 favorite': 'favorite',
    'owo2 forge-prices': 'forge-prices', 'owo2 ranch': 'ranch', 'owo2 ranch-claim': 'ranch-claim',
    'owo2 pray': 'pray', 'owo2 curse': 'curse', 'owo2 cookie': 'cookie', 'owo2 top': 'top',
    'owo2 lottery': 'lottery', 'owo2 drop': 'drop', 'owo2 pickup': 'pickup', 'owo2 give-limits': 'give-limits',
    'owo2 transactions': 'transactions', 'owo2 duel': 'duel', 'owo2 battle-settings': 'battle-settings',
    'owo2 wallpaper': 'wallpaper', 'owo2 ring': 'ring', 'owo2 marry': 'marry', 'owo2 shop': 'shop',
    'owo2 feed': 'feed', 'owo2 profile': 'profile', 'owo2 autohunt': 'autohunt',
    'owo-profile': 'profile', 'autohunt': 'autohunt', 'luck': 'luck', 'owoify': null, 'fun luck': 'luck', 'fun owoify': null,
});

/** Feature key for a command path; walks up the path ("owo2 marry accept" -> "owo2 marry"). undefined = unknown path. */
export function featureKeyForPath(path) {
    let p = String(path || '').trim().toLowerCase().replace(/\s+/g, ' ');
    // "owo <x>" paths that were folded in from owo2 resolve through owo2.
    while (p) {
        if (Object.prototype.hasOwnProperty.call(PATH_FEATURES, p)) return PATH_FEATURES[p];
        if (p.startsWith('owo ')) {
            const alt = `owo2 ${p.slice(4)}`;
            if (Object.prototype.hasOwnProperty.call(PATH_FEATURES, alt)) return PATH_FEATURES[alt];
        }
        const cut = p.lastIndexOf(' ');
        if (cut < 0) break;
        p = p.slice(0, cut);
    }
    return undefined;
}

/** Legacy disabled_subcommands value -> new keys. Legacy keys share the new names; unknown keys are dropped. */
export function mapLegacyFeatureKeys(list) {
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
        const k = String(raw || '').trim().toLowerCase();
        if (FEATURE_SET.has(k) && !out.includes(k)) out.push(k);
    }
    return out;
}

const SNOWFLAKE = /^\d{15,25}$/;

export function parseJsonArray(value) {
    if (Array.isArray(value)) return value;
    if (value == null || value === '') return [];
    try {
        const v = JSON.parse(String(value));
        return Array.isArray(v) ? v : [];
    } catch {
        return [];
    }
}

export function sanitizeSnowflakes(value) {
    const out = [];
    for (const v of parseJsonArray(value)) {
        const s = String(v).trim();
        if (SNOWFLAKE.test(s) && !out.includes(s)) out.push(s);
    }
    return out;
}

export function sanitizeFeatureKeys(value) {
    return mapLegacyFeatureKeys(parseJsonArray(value));
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round2 = (n) => Math.round(n * 100) / 100;

/** Normalise a DB row (or partial object) into a full config object. Unknown / bad values fall back to defaults. */
export function normalizeConfig(row) {
    const r = row || {};
    const num = (k, lo, hi, int = false) => {
        const n = Number(r[k]);
        if (!Number.isFinite(n)) return CONFIG_DEFAULTS[k];
        return int ? clamp(Math.round(n), lo, hi) : round2(clamp(n, lo, hi));
    };
    return {
        enabled: r.enabled == null ? CONFIG_DEFAULTS.enabled : !!Number(r.enabled) || r.enabled === true,
        hunt_cooldown_seconds: num('hunt_cooldown_seconds', HUNT_COOLDOWN_MIN, HUNT_COOLDOWN_MAX, true),
        reward_currency_multiplier: num('reward_currency_multiplier', MULTIPLIER_MIN, MULTIPLIER_MAX),
        reward_xp_multiplier: num('reward_xp_multiplier', MULTIPLIER_MIN, MULTIPLIER_MAX),
        sell_multiplier: num('sell_multiplier', MULTIPLIER_MIN, MULTIPLIER_MAX),
        sacrifice_xp_multiplier: num('sacrifice_xp_multiplier', MULTIPLIER_MIN, MULTIPLIER_MAX),
        disabled_subcommands: sanitizeFeatureKeys(r.disabled_subcommands),
        allowed_channel_ids: sanitizeSnowflakes(r.allowed_channel_ids),
        blocked_role_ids: sanitizeSnowflakes(r.blocked_role_ids),
        announce_rare_catches: r.announce_rare_catches == null ? CONFIG_DEFAULTS.announce_rare_catches : !!Number(r.announce_rare_catches) || r.announce_rare_catches === true,
    };
}

/**
 * Apply a partial update to a config. Throws { field, message } (a plain Error with .field) when a numeric
 * field is not a number. Unspecified keys are unchanged; arrays are sanitised; numbers clamped.
 */
export function applyConfigPatch(current, patch) {
    const next = { ...normalizeConfig(current) };
    for (const [k, v] of Object.entries(patch || {})) {
        if (!CONFIG_KEYS.includes(k)) continue;
        if (NUMERIC_KEYS.includes(k)) {
            const n = Number(v);
            if (v === null || v === '' || typeof v === 'boolean' || !Number.isFinite(n)) {
                const err = new Error(`${k} must be a number`);
                err.field = k;
                throw err;
            }
            next[k] = n;
        } else if (BOOLEAN_KEYS.includes(k)) {
            next[k] = v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
        } else {
            next[k] = v;
        }
    }
    return normalizeConfig(next);
}

/** Row values for writing a normalised config. */
export function configToRow(cfg) {
    return {
        enabled: cfg.enabled ? 1 : 0,
        hunt_cooldown_seconds: cfg.hunt_cooldown_seconds,
        reward_currency_multiplier: cfg.reward_currency_multiplier,
        reward_xp_multiplier: cfg.reward_xp_multiplier,
        sell_multiplier: cfg.sell_multiplier,
        sacrifice_xp_multiplier: cfg.sacrifice_xp_multiplier,
        disabled_subcommands: JSON.stringify(cfg.disabled_subcommands),
        allowed_channel_ids: JSON.stringify(cfg.allowed_channel_ids),
        blocked_role_ids: JSON.stringify(cfg.blocked_role_ids),
        announce_rare_catches: cfg.announce_rare_catches ? 1 : 0,
    };
}

/**
 * The gate check, in order: enabled, feature key, channel allow-list, role block-list.
 * The channel and role gates apply to EVERY game command (legacy applied them to hunting only).
 * Pass featureKey null for paths that are never feature-gated.
 * @returns {{ok:true} | {ok:false, code:'DISABLED'|'FEATURE_OFF'|'CHANNEL'|'ROLE', featureKey?, allowedChannelIds?, moreChannels?}}
 */
export function checkGates(cfg, { featureKey = null, channelId = null, roleIds = [], skipPlaceGates = false } = {}) {
    const c = cfg && typeof cfg.enabled === 'boolean' ? cfg : normalizeConfig(cfg);
    if (!c.enabled) return { ok: false, code: 'DISABLED' };
    if (featureKey && c.disabled_subcommands.includes(featureKey)) return { ok: false, code: 'FEATURE_OFF', featureKey };
    if (!skipPlaceGates) {
        if (c.allowed_channel_ids.length > 0 && channelId && !c.allowed_channel_ids.includes(String(channelId))) {
            return {
                ok: false, code: 'CHANNEL',
                allowedChannelIds: c.allowed_channel_ids.slice(0, 3),
                moreChannels: c.allowed_channel_ids.length > 3,
            };
        }
        if (c.blocked_role_ids.length > 0) {
            const roles = new Set((roleIds || []).map(String));
            if (c.blocked_role_ids.some(r => roles.has(r))) return { ok: false, code: 'ROLE' };
        }
    }
    return { ok: true };
}
