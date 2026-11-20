/*
 * Per-guild config with a 30 s cache, invalidated on every write made through this module.
 */
import { q, T, CritterError } from './db.js';
import { CONFIG_CACHE_TTL_MS } from './constants.js';
import {
    CONFIG_DEFAULTS, normalizeConfig, applyConfigPatch, configToRow, checkGates,
} from './rules/config-rules.js';

const cache = new Map();

export function invalidateConfig(guildId) {
    if (guildId == null) cache.clear();
    else cache.delete(String(guildId));
}

/** Full config for a guild. A missing row reads as the defaults (module off). Read failures fall back to defaults. */
export async function getConfig(guildId) {
    const g = String(guildId);
    const hit = cache.get(g);
    if (hit && Date.now() - hit.at < CONFIG_CACHE_TTL_MS) return hit.cfg;
    let cfg;
    try {
        const [row] = await q(`SELECT * FROM ${T('config')} WHERE guild_id = ?`, [g]);
        cfg = row ? normalizeConfig(row) : normalizeConfig(CONFIG_DEFAULTS);
        cfg.hasRow = !!row;
    } catch {
        cfg = { ...normalizeConfig(CONFIG_DEFAULTS), hasRow: false };
        return cfg; // do not cache a failure
    }
    cache.set(g, { at: Date.now(), cfg });
    return cfg;
}

export async function isEnabled(guildId) {
    return (await getConfig(guildId)).enabled;
}

async function writeConfig(g, cfg) {
    const row = configToRow(cfg);
    const cols = Object.keys(row);
    await q(`INSERT INTO ${T('config')} (guild_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
             ON DUPLICATE KEY UPDATE ${cols.map(c => `${c} = VALUES(${c})`).join(', ')}`, [g, ...cols.map(c => row[c])]);
    invalidateConfig(g);
}

/**
 * Partial update (read-modify-write). Numbers are clamped, arrays sanitised, unknown keys ignored.
 * Throws CritterError BAD_CONFIG (data.field) when a numeric field is not a number.
 */
export async function updateConfig(guildId, patch) {
    const g = String(guildId);
    invalidateConfig(g);
    const current = await getConfig(g);
    let next;
    try {
        next = applyConfigPatch(current, patch);
    } catch (err) {
        throw new CritterError('BAD_CONFIG', err.message, { field: err.field });
    }
    await writeConfig(g, next);
    return getConfig(g);
}

/** The /owo toggle: upserts `enabled` only. */
export async function setEnabled(guildId, enabled) {
    const g = String(guildId);
    await q(`INSERT INTO ${T('config')} (guild_id, enabled) VALUES (?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)`, [g, enabled ? 1 : 0]);
    invalidateConfig(g);
    return getConfig(g);
}

/**
 * Gate check for a command. Loads the config and runs rules/config-rules.js checkGates.
 * @returns {Promise<{ ok: true, config } | { ok: false, code, config, ... }>}
 */
export async function gate(guildId, { featureKey = null, channelId = null, roleIds = [], skipPlaceGates = false } = {}) {
    const config = await getConfig(guildId);
    return { ...checkGates(config, { featureKey, channelId, roleIds, skipPlaceGates }), config };
}

export { checkGates };
