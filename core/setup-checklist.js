/*
 * Setup checklist: the "N of M recommended setup steps done" card on a server's dashboard
 * overview, with a one-click link to each step that is not done yet.
 *
 * It is not a new store. Every step reads state that already exists:
 *
 *   basics       the config rows the matching pages save (moderation_config.mod_log_channel_id,
 *                logging_config.log_channel_id, welcome_settings.channel_id, enabled automod_rules)
 *   protections  the high-weight rows of the Server security grid (core/security-overview.js
 *                getProtectionScore -> core/security-overview-logic.js PROTECTION_GRID), so the
 *                checklist and the security score can never disagree about what is on
 *
 * A step whose state could not be read (`null`) is left out rather than counted as missing. Each
 * step links to its page and, where the page has one, the exact field (?field=<element id>, which
 * the manage page scrolls to and highlights; see dashboard/public/js/cf-manage.js).
 *
 * Dismissal is per user and per server (user_preferences.ui_options.hiddenChecklists, migration
 * 335; core/user-preferences.js). buildChecklist() is pure and tested in tests/nav-polish.test.js;
 * getSetupChecklist() is the live read, served at GET /api/guilds/:id/insight/checklist.
 */
import pool from '../utils/db.js';
import { getProtectionScore } from './security-overview.js';

/** Setup basics, in display order. `field` is the element id on the page. */
export const BASICS = Object.freeze([
    { key: 'modLog', label: 'Choose a mod log channel', why: 'Bans, kicks, timeouts and warnings are posted there.', page: 'moderation', field: 'f-moderation-mod_log_channel_id' },
    { key: 'serverLog', label: 'Choose a server log channel', why: 'Message edits and deletes, joins, leaves and role changes.', page: 'logging', field: 'log-channel-id' },
    { key: 'welcome', label: 'Welcome new members', why: 'A welcome message in a channel you choose.', page: 'welcome', field: 'f-welcome-channel_id' },
    { key: 'automod', label: 'Turn on an AutoMod rule', why: 'Filters spam, invites, caps or banned words.', page: 'automod', field: null },
]);

/**
 * Protections from the security grid that every server should have on: the double-weight ones
 * (they stop the commonest attacks) plus verification. Labels are the checklist wording; pages
 * and on/off state come from the grid row.
 */
export const PROTECTIONS = Object.freeze([
    { key: 'verification', label: 'Turn on verification', why: 'New members prove they are real before they can talk.', field: 'vfEnabled' },
    { key: 'raid', label: 'Turn on raid detection', why: 'Spots join floods and acts before they post.', field: 'raidEnabled' },
    { key: 'antiNuke', label: 'Turn on anti-nuke', why: 'Stops a compromised admin deleting channels and roles.', field: 'antiNukeEnabled' },
    { key: 'spammer', label: "Turn on Discord's spammer check", why: 'Acts on accounts Discord itself has flagged as spammers.', field: 'spammerEnabled' },
    { key: 'phishing', label: 'Block phishing links', why: 'Deletes known scam and phishing links.', field: 'phishing_enabled' },
    { key: 'globalBan', label: 'Join the global ban network', why: 'Bans people already banned elsewhere for scams and raids.', field: 'globalban_enabled' },
]);

const truthy = (v) => v === true || v === 1 || v === '1';

/**
 * @param {object} o
 *   grid    rows from protectionsGrid(): [{ key, label, page, on: true|false|null }]
 *   basics  { modLog, serverLog, welcome, automod }: true | false | null (unknown)
 * @returns {{ items: Array<{ key, kind, label, why, page, field, done }>, done: number, total: number, percent: number, complete: boolean }}
 */
export function buildChecklist({ grid = [], basics = {} } = {}) {
    const items = [];
    for (const b of BASICS) {
        const state = basics[b.key];
        if (state === null || state === undefined) continue;
        items.push({ key: b.key, kind: 'setup', label: b.label, why: b.why, page: b.page, field: b.field, done: !!state });
    }
    const byKey = new Map((grid || []).map((g) => [g.key, g]));
    for (const p of PROTECTIONS) {
        const row = byKey.get(p.key);
        if (!row || row.on === null || row.on === undefined) continue;
        items.push({ key: p.key, kind: 'protection', label: p.label, why: p.why, page: row.page, field: p.field, done: !!row.on });
    }
    const done = items.filter((i) => i.done).length;
    const total = items.length;
    return { items, done, total, percent: total ? Math.round((done / total) * 100) : 0, complete: total > 0 && done === total };
}

/** One query's first row, or null when the table/columns cannot be read (state unknown). */
async function first(sql, params) {
    try {
        const [rows] = await pool.execute(sql, params);
        return { row: rows[0] || null };
    } catch {
        return null;
    }
}

/** The live checklist for one server. */
export async function getSetupChecklist(guildId) {
    const [score, mod, log, welcome, automod] = await Promise.all([
        getProtectionScore(guildId).catch(() => ({ grid: [] })),
        first('SELECT mod_log_channel_id FROM moderation_config WHERE guild_id = ?', [guildId]),
        first('SELECT log_channel_id, enabled FROM logging_config WHERE guild_id = ?', [guildId]),
        first('SELECT channel_id FROM welcome_settings WHERE guild_id = ?', [guildId]),
        first('SELECT COUNT(*) AS n FROM automod_rules WHERE guild_id = ? AND is_enabled = 1', [guildId]),
    ]);
    const basics = {
        modLog: mod ? !!mod.row?.mod_log_channel_id : null,
        serverLog: log ? !!log.row?.log_channel_id && (log.row.enabled == null || truthy(log.row.enabled)) : null,
        welcome: welcome ? !!welcome.row?.channel_id : null,
        automod: automod ? Number(automod.row?.n || 0) > 0 : null,
    };
    return buildChecklist({ grid: score.grid, basics });
}

export default { BASICS, PROTECTIONS, buildChecklist, getSetupChecklist };
