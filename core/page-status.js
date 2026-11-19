/**
 * On/off state of each dashboard page's feature, for the sidebar dots and the overview badges
 * (manage-tailwind.ejs). One map per guild: page -> 'on' | 'off' | 'none'.
 *
 *   on    the feature is running for this guild
 *   off   it has saved settings (or an explicit flag) but is switched off
 *   none  known, but never set up
 *   absent: no way to tell from config alone (the page shows no dot)
 *
 * Two sources, the later winning for the same page:
 *   1. core/feature-flags.js catalogFor() — the feature catalog's `active` / `configured` /
 *      explicit flag, filed under each feature's `page`. Several features can share a page
 *      (anti-raid and anti-nuke); the page is on when any of them is.
 *   2. Generated pages (core/feature-config-spec.js): the spec's master toggle (the first
 *      `toggle` field whose key is `enabled` or ends in `_enabled`), read from the spec's own
 *      table or from guild_feature_config, with the spec default when nothing is stored.
 *
 * manage-tailwind.ejs layers a few checks from data the route already loaded on top (welcome
 * channel set, reaction-role panels present, …). The map is cached for the configCache TTL
 * (60s) and dropped with the rest of the guild's entries after any dashboard write.
 */
import pool from '../utils/db.js';
import configCache from '../utils/configCache.js';
import logger from '../utils/logger.js';
import { catalogFor } from './feature-flags.js';
import { FEATURE_SPECS } from './feature-config-spec.js';

// Tables holding many unrelated columns, where a row always exists: a false switch there means
// "never turned on", not "turned off".
const SHARED_TABLES = new Set(['guilds', 'guild_settings', 'guild_config', 'logging_config']);

const RANK = { none: 0, off: 1, on: 2 };

function masterField(spec) {
    return (spec.fields || []).find((f) => f.type === 'toggle' && /(^|_)enabled$/.test(f.key)) || null;
}

function truthy(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return !['0', 'false', ''].includes(v.trim().toLowerCase());
    return Boolean(Number(v)) || v === true;
}

async function fromCatalog(guildId, out) {
    const catalog = await catalogFor(guildId);
    for (const f of catalog) {
        if (!f.page) continue;
        const state = f.active ? 'on' : (f.configured || f.explicitFlag === false) ? 'off' : 'none';
        if (!out[f.page] || RANK[state] > RANK[out[f.page]]) out[f.page] = state;
    }
}

async function fromSpecs(guildId, out) {
    const entries = Object.entries(FEATURE_SPECS).map(([key, spec]) => [key, spec, masterField(spec)]).filter(([, , m]) => m);
    let managed = new Map();
    if (entries.some(([, spec]) => spec.storage?.kind === 'managed')) {
        try {
            const [rows] = await pool.execute('SELECT feature_key, config FROM guild_feature_config WHERE guild_id = ?', [guildId]);
            managed = new Map(rows.map((r) => {
                let cfg = r.config;
                if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch { cfg = {}; } }
                return [r.feature_key, cfg || {}];
            }));
        } catch (err) {
            logger.debug(`[PageStatus] guild_feature_config read failed: ${err.message}`);
        }
    }
    const fallback = (m) => (truthy(m.default) ? 'on' : 'none');
    await Promise.all(entries.map(async ([key, spec, m]) => {
        let state = null;
        try {
            if (spec.storage?.kind === 'table' && spec.storage.table && spec.storage.key) {
                const [rows] = await pool.execute(
                    `SELECT \`${m.key}\` AS v FROM \`${spec.storage.table}\` WHERE \`${spec.storage.key}\` = ? LIMIT 1`, [guildId]);
                const v = rows.length ? truthy(rows[0].v) : null;
                if (v === true) state = 'on';
                else if (v === false) state = SHARED_TABLES.has(spec.storage.table) ? 'none' : 'off';
                else state = fallback(m);
            } else if (spec.storage?.kind === 'managed') {
                const cfg = managed.get(key);
                const v = cfg ? truthy(cfg[m.key]) : null;
                state = v === true ? 'on' : v === false ? 'off' : fallback(m);
            }
        } catch (err) {
            // A spec whose table or column is missing must not blank the map.
            logger.debug(`[PageStatus] ${key}: ${err.message}`);
        }
        if (state) out[key] = state;
    }));
}

async function compute(guildId) {
    const out = {};
    await fromCatalog(guildId, out).catch((err) => logger.debug(`[PageStatus] catalog failed: ${err.message}`));
    await fromSpecs(guildId, out).catch((err) => logger.debug(`[PageStatus] specs failed: ${err.message}`));
    return out;
}

/** @returns {Promise<Record<string, 'on'|'off'|'none'>>} a copy the caller may change */
export async function pageStatusFor(guildId) {
    const map = await configCache.get('page_status', String(guildId), () => compute(String(guildId)));
    return { ...map };
}

export default { pageStatusFor };
