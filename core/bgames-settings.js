/*
 * Per-guild settings for emoji hunts, community goals, loyalty points and tournaments.
 *
 * Stored the way every "managed" feature stores them: one JSON blob per guild per feature in
 * guild_feature_config (core/feature-config.js). The dashboard's generic feature cards read and
 * write the same rows once their specs are registered in core/feature-config-spec.js, so the
 * defaults below MUST match the `default:` values in those specs.
 *
 * This module reads the row itself rather than going through feature-config.getConfig(), because
 * getConfig() only knows a feature once its spec exists — the slash-command settings here must
 * work whether or not the dashboard card has been added yet. Writes merge into the same JSON and
 * invalidate feature-config's cache so the dashboard never shows a stale value.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { invalidate as invalidateFeatureConfig, normaliseIdList } from './feature-config.js';
import { LOYALTY_DEFAULTS } from './loyalty-logic.js';

export const DEFAULTS = Object.freeze({
    emojihunt: Object.freeze({
        enabled: true,
        hunt_channels: [],              // where spots may be hidden; empty = the channel /start ran in
        announce_channel_id: null,      // start/results posts; empty = the channel /start ran in
        ping_role_id: null,
        default_emoji: '🥚',
        default_count: 5,
        default_duration_minutes: 30,
        finders_per_emoji: 1,
        points_per_find: 10,
        coins_per_find: 0,
        xp_per_find: 0,
        max_message_age_minutes: 1440,
        remove_unfound: true,
        auto_enabled: false,            // scheduled hunts are opt-in
        auto_interval_hours: 24,
    }),
    communitygoals: Object.freeze({
        enabled: true,
        announce_channel_id: null,
        ping_role_id: null,
        milestone_announcements: true,
    }),
    loyalty: LOYALTY_DEFAULTS,
    tournaments: Object.freeze({
        enabled: true,
        default_channel_id: null,
        organizer_role_id: null,
        ping_role_id: null,
        auto_confirm_hours: 12,
    }),
});

const LIST_KEYS = new Set(['hunt_channels']);
const BOOL_KEYS = new Set([
    'enabled', 'remove_unfound', 'auto_enabled', 'milestone_announcements',
]);

const CACHE_TTL_MS = 30_000;
const cache = new Map(); // `${feature}:${guildId}` -> { value, expires }

function truthy(v) {
    return v === true || v === 1 || v === '1' || v === 'true';
}

function normalise(feature, stored) {
    const out = { ...DEFAULTS[feature] };
    for (const [k, v] of Object.entries(stored || {})) {
        if (!(k in out) || v === null || v === undefined || v === '') continue;
        if (LIST_KEYS.has(k)) out[k] = normaliseIdList(v);
        else if (BOOL_KEYS.has(k)) out[k] = truthy(v);
        else if (typeof DEFAULTS[feature][k] === 'number') {
            const n = Number(v);
            if (Number.isFinite(n)) out[k] = n;
        } else out[k] = v;
    }
    for (const k of LIST_KEYS) {
        if (k in out) out[k] = normaliseIdList(out[k]); // always a fresh array, never the default's
    }
    return out;
}

async function readRaw(feature, guildId) {
    const [rows] = await pool.execute(
        'SELECT config FROM guild_feature_config WHERE guild_id = ? AND feature_key = ?',
        [guildId, feature]
    );
    if (!rows[0]?.config) return {};
    try {
        return typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config;
    } catch (err) {
        logger.error(`[BGamesSettings] Corrupt ${feature} config for ${guildId}: ${err.message}`);
        return {};
    }
}

/** Settings with defaults filled in. Never throws: on a DB error the defaults are returned. */
export async function getSettings(feature, guildId) {
    if (!DEFAULTS[feature]) throw new Error(`Unknown feature ${feature}`);
    const k = `${feature}:${guildId}`;
    const hit = cache.get(k);
    if (hit && hit.expires > Date.now()) return hit.value;
    let stored = {};
    try {
        stored = await readRaw(feature, guildId);
    } catch (err) {
        logger.error(`[BGamesSettings] Failed to read ${feature} for ${guildId}: ${err.message}`);
        return normalise(feature, {});
    }
    const value = normalise(feature, stored);
    cache.set(k, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
}

/**
 * Merge `patch` into a guild's settings. Values are stored in the shapes the dashboard writes:
 * toggles 1/0, numbers as numbers, channel lists as a JSON-array string.
 */
export async function updateSettings(feature, guildId, patch, updatedBy = null) {
    if (!DEFAULTS[feature]) throw new Error(`Unknown feature ${feature}`);
    const clean = {};
    for (const [k, v] of Object.entries(patch)) {
        if (!(k in DEFAULTS[feature]) || v === undefined) continue;
        if (LIST_KEYS.has(k)) clean[k] = JSON.stringify(normaliseIdList(v));
        else if (BOOL_KEYS.has(k)) clean[k] = v ? 1 : 0;
        else clean[k] = v;
    }
    if (!Object.keys(clean).length) return getSettings(feature, guildId);

    const current = await readRaw(feature, guildId);
    const merged = { ...current, ...clean };
    await pool.execute(
        `INSERT INTO guild_feature_config (guild_id, feature_key, config, updated_by)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE config = VALUES(config), updated_by = VALUES(updated_by)`,
        [guildId, feature, JSON.stringify(merged), updatedBy]
    );
    cache.delete(`${feature}:${guildId}`);
    invalidateFeatureConfig(feature, guildId);
    return getSettings(feature, guildId);
}

/** Guild ids that have a stored config row for `feature` (used by the schedulers). */
export async function guildsWithConfig(feature) {
    const [rows] = await pool.execute(
        'SELECT guild_id, config FROM guild_feature_config WHERE feature_key = ?',
        [feature]
    );
    const out = [];
    for (const r of rows) {
        let parsed = {};
        try { parsed = typeof r.config === 'string' ? JSON.parse(r.config) : (r.config || {}); }
        catch (err) {
            logger.warn(`[BGamesSettings] Skipping corrupt ${feature} config for ${r.guild_id}: ${err.message}`);
            continue;
        }
        out.push({ guildId: r.guild_id, settings: normalise(feature, parsed) });
    }
    return out;
}
