/*
 * Read/write access to per-guild feature settings.
 *
 * Two backing stores, chosen per feature in core/feature-config-spec.js:
 *   - a feature's own config table, when it already had one
 *   - `guild_feature_config` (migration 197) for features that had nowhere to store settings
 *
 * Callers do not care which: `getConfig('grow', guildId)` returns a plain object with defaults
 * filled in either way.
 *
 * Reads are cached for a short window because these are consulted on the hot path — every
 * invocation of a gated command hits `isEnabledIn()` — and a guild's settings change rarely.
 * Any write through this module invalidates the entry, so the dashboard never shows stale state.
 */

import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { getSpec, defaultsFor } from './feature-config-spec.js';

const CACHE_TTL_MS = 60_000;
const cache = new Map(); // `${feature}:${guildId}` -> { value, expires }

function cacheKey(feature, guildId) {
    return `${feature}:${guildId}`;
}

export function invalidate(feature, guildId) {
    cache.delete(cacheKey(feature, guildId));
}

export function invalidateGuild(guildId) {
    for (const k of cache.keys()) {
        if (k.endsWith(`:${guildId}`)) cache.delete(k);
    }
}

/**
 * Current settings for a feature in a guild, with spec defaults filled in for anything unset.
 * Never throws — a config read failing must not take a command down with it, so on error the
 * defaults are returned and the problem is logged.
 */
export async function getConfig(feature, guildId) {
    const spec = getSpec(feature);
    if (!spec) return {};

    const key = cacheKey(feature, guildId);
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;

    let stored = {};
    try {
        if (spec.storage.kind === 'table') {
            const [rows] = await pool.execute(
                `SELECT * FROM \`${spec.storage.table}\` WHERE \`${spec.storage.key}\` = ? LIMIT 1`,
                [guildId]
            );
            stored = rows[0] ?? {};
        } else {
            const [rows] = await pool.execute(
                'SELECT config FROM guild_feature_config WHERE guild_id = ? AND feature_key = ?',
                [guildId, feature]
            );
            if (rows[0]?.config) {
                stored = typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config;
            }
        }
    } catch (err) {
        logger.error(`[FeatureConfig] Failed to read ${feature} for ${guildId}: ${err.message}`);
        return defaultsFor(feature);
    }

    // Spec defaults underneath, stored values on top — but a stored NULL means "unset", not
    // "explicitly empty", so it must not shadow a default.
    const value = { ...defaultsFor(feature) };
    for (const [k, v] of Object.entries(stored)) {
        if (v !== null && v !== undefined) value[k] = v;
    }

    cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
}

/** Merge a partial update into a feature's settings. Returns the new full config. */
export async function setConfig(feature, guildId, patch, updatedBy = null) {
    const spec = getSpec(feature);
    if (!spec) throw new Error(`Unknown feature "${feature}"`);

    const allowed = new Set(spec.fields.map(f => f.key));
    const clean = {};
    for (const [k, v] of Object.entries(patch)) {
        if (allowed.has(k)) clean[k] = v;
    }
    if (!Object.keys(clean).length) return getConfig(feature, guildId);

    if (spec.storage.kind === 'table') {
        // Column names come from the spec, never from the request body.
        const cols = Object.keys(clean);
        const placeholders = cols.map(() => '?').join(', ');
        const updates = cols.map(c => `\`${c}\` = VALUES(\`${c}\`)`).join(', ');
        await pool.execute(
            `INSERT INTO \`${spec.storage.table}\` (\`${spec.storage.key}\`, ${cols.map(c => `\`${c}\``).join(', ')})
             VALUES (?, ${placeholders})
             ON DUPLICATE KEY UPDATE ${updates}`,
            [guildId, ...cols.map(c => clean[c])]
        );
    } else {
        const current = await getRawManaged(guildId, feature);
        const merged = { ...current, ...clean };
        await pool.execute(
            `INSERT INTO guild_feature_config (guild_id, feature_key, config, updated_by)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE config = VALUES(config), updated_by = VALUES(updated_by)`,
            [guildId, feature, JSON.stringify(merged), updatedBy]
        );
    }

    invalidate(feature, guildId);
    return getConfig(feature, guildId);
}

async function getRawManaged(guildId, feature) {
    const [rows] = await pool.execute(
        'SELECT config FROM guild_feature_config WHERE guild_id = ? AND feature_key = ?',
        [guildId, feature]
    );
    if (!rows[0]?.config) return {};
    return typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config;
}

/** Truthy across the shapes these values arrive in: 1/0 from MySQL, true/false from JSON. */
function truthy(v) {
    return v === true || v === 1 || v === '1';
}

/**
 * Should this feature run for this interaction?
 *
 * Answers the enabled flag, the channel allowlist and the age-gate role in one call, so a
 * command needs one guard rather than three. Returns `{ allowed, reason }` — the reason is
 * written for the member, not the log.
 */
export async function checkAccess(feature, interaction, enabledKey = 'enabled') {
    const spec = getSpec(feature);
    if (!spec || !interaction.guild) return { allowed: true, reason: null };

    const cfg = await getConfig(feature, interaction.guild.id);

    // Features use either `enabled` or a per-section flag; absent means "no switch, always on".
    if (enabledKey in cfg && !truthy(cfg[enabledKey])) {
        return { allowed: false, reason: `**${spec.label}** is turned off in this server.` };
    }

    const allowedChannels = normaliseIdList(cfg.allowed_channels);
    if (allowedChannels.length && !allowedChannels.includes(interaction.channelId)) {
        return {
            allowed: false,
            reason: `**${spec.label}** can only be used in ${allowedChannels.map(id => `<#${id}>`).join(', ')}.`,
        };
    }

    if (truthy(cfg.require_age_gate) && cfg.age_role_id) {
        const member = interaction.member;
        const has = member?.roles?.cache?.has?.(cfg.age_role_id);
        if (!has) {
            return {
                allowed: false,
                reason: `**${spec.label}** requires the <@&${cfg.age_role_id}> role in this server.`,
            };
        }
    }

    return { allowed: true, reason: null };
}

/**
 * Channel/role lists are stored as a JSON array by the dashboard but may be a comma-separated
 * string in an older column. Accept both and always hand back an array of id strings.
 */
export function normaliseIdList(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v.map(String).filter(Boolean);
    if (typeof v === 'string') {
        const t = v.trim();
        if (t.startsWith('[')) {
            try { return JSON.parse(t).map(String).filter(Boolean); } catch { return []; }
        }
        return t.split(',').map(s => s.trim()).filter(Boolean);
    }
    return [];
}

export default { getConfig, setConfig, checkAccess, invalidate, invalidateGuild, normaliseIdList };
