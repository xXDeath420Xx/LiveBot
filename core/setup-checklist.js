/*
 * Setup checklist: the "N of M recommended setup steps done" card on a server's dashboard
 * overview, with a one-click link to each step that is not done yet and, for the first steps, the
 * guide that explains it.
 *
 * Order. RECOMMENDED comes first, in its own order: the features new servers turned on most often in
 * their first week, among those whose first-week servers were still active 30 days later more often
 * than servers that did not turn them on (analysis of 2026-11-20, 99 servers; query and counts in
 * docs/onboarding-checklist-2026-11-20.md). The other steps follow: the rest of the basics, then the
 * rest of the double-weight protections.
 *
 * It is not a new store. Every step reads state that already exists:
 *
 *   basics       the config rows the matching pages save (moderation_config.mod_log_channel_id,
 *                logging_config.log_channel_id, welcome_settings.channel_id, enabled automod_rules,
 *                ticket_panels / ticket_config)
 *   protections  rows of the Server security grid (core/security-overview.js getProtectionScore ->
 *                core/security-overview-logic.js PROTECTION_GRID), so the checklist and the security
 *                score can never disagree about what is on
 *
 * A step whose state could not be read (`null`) is left out rather than counted as missing. Each
 * step links to its page and, where the page has one, the exact field (?field=<element id>, which
 * the manage page scrolls to and highlights; see dashboard/public/js/cf-manage.js). `guide` is a
 * slug in dashboard/content/guides.
 *
 * Dismissal is per user and per server (user_preferences.ui_options.hiddenChecklists, migration
 * 335; core/user-preferences.js). buildChecklist() is pure and tested in tests/nav-polish.test.js;
 * getSetupChecklist() is the live read, served at GET /api/guilds/:id/insight/checklist.
 */
import pool from '../utils/db.js';
import { getProtectionScore } from './security-overview.js';

/**
 * The first steps, in order (see the header). `from: 'basic'` reads the basics map, `from: 'grid'`
 * the security grid row with the same key (its page comes from the grid).
 */
export const RECOMMENDED = Object.freeze([
    { key: 'welcome', from: 'basic', label: 'Welcome new members', why: 'A welcome message in a channel you choose.', page: 'welcome', field: 'f-welcome-channel_id', guide: 'welcome' },
    { key: 'serverLog', from: 'basic', label: 'Choose a server log channel', why: 'Message edits and deletes, joins, leaves and role changes.', page: 'logging', field: 'log-channel-id', guide: 'moderation' },
    { key: 'raid', from: 'grid', label: 'Turn on raid detection', why: 'Spots join floods and acts before they post.', field: 'raidEnabled', guide: 'raid-protection' },
    { key: 'phishing', from: 'grid', label: 'Block phishing links', why: 'Deletes known scam and phishing links.', field: 'phishing_enabled', guide: 'scam-links' },
    { key: 'selfbot', from: 'grid', label: 'Turn on self-bot detection', why: 'Catches accounts that post through automation.', field: 'selfbotEnabled', guide: 'spam-filters' },
    { key: 'globalBan', from: 'grid', label: 'Join the global ban network', why: 'Bans people already banned elsewhere for scams and raids.', field: 'globalban_enabled', guide: 'global-ban' },
    { key: 'tickets', from: 'basic', label: 'Set up support tickets', why: 'Members open a private channel with your staff.', page: 'tickets', field: null, guide: 'support-tickets' },
]);

/** The other setup basics, in display order. `field` is the element id on the page. */
export const BASICS = Object.freeze([
    { key: 'modLog', label: 'Choose a mod log channel', why: 'Bans, kicks, timeouts and warnings are posted there.', page: 'moderation', field: 'f-moderation-mod_log_channel_id' },
    { key: 'automod', label: 'Turn on an AutoMod rule', why: 'Filters spam, invites, caps or banned words.', page: 'automod', field: null },
]);

/**
 * The other protections every server should have on: the double-weight ones from the security grid
 * (they stop the commonest attacks) plus verification. Labels are the checklist wording; pages and
 * on/off state come from the grid row.
 */
export const PROTECTIONS = Object.freeze([
    { key: 'verification', label: 'Turn on verification', why: 'New members prove they are real before they can talk.', field: 'vfEnabled' },
    { key: 'antiNuke', label: 'Turn on anti-nuke', why: 'Stops a compromised admin deleting channels and roles.', field: 'antiNukeEnabled' },
    { key: 'spammer', label: "Turn on Discord's spammer check", why: 'Acts on accounts Discord itself has flagged as spammers.', field: 'spammerEnabled' },
]);

const truthy = (v) => v === true || v === 1 || v === '1';

/**
 * @param {object} o
 *   grid    rows from protectionsGrid(): [{ key, label, page, on: true|false|null }]
 *   basics  { welcome, serverLog, tickets, modLog, automod }: true | false | null (unknown)
 * @returns {{ items: Array<{ key, kind, label, why, page, field, guide, done }>, done: number, total: number, percent: number, complete: boolean }}
 *   kind is 'recommended' (RECOMMENDED, with a guide), 'setup' or 'protection'.
 */
export function buildChecklist({ grid = [], basics = {} } = {}) {
    const items = [];
    const byKey = new Map((grid || []).map((g) => [g.key, g]));
    const known = (v) => v !== null && v !== undefined;
    for (const r of RECOMMENDED) {
        if (r.from === 'basic') {
            if (!known(basics[r.key])) continue;
            items.push({ key: r.key, kind: 'recommended', label: r.label, why: r.why, page: r.page, field: r.field, guide: r.guide, done: !!basics[r.key] });
        } else {
            const row = byKey.get(r.key);
            if (!row || !known(row.on)) continue;
            items.push({ key: r.key, kind: 'recommended', label: r.label, why: r.why, page: row.page, field: r.field, guide: r.guide, done: !!row.on });
        }
    }
    for (const b of BASICS) {
        if (!known(basics[b.key])) continue;
        items.push({ key: b.key, kind: 'setup', label: b.label, why: b.why, page: b.page, field: b.field, guide: null, done: !!basics[b.key] });
    }
    for (const p of PROTECTIONS) {
        const row = byKey.get(p.key);
        if (!row || !known(row.on)) continue;
        items.push({ key: p.key, kind: 'protection', label: p.label, why: p.why, page: row.page, field: p.field, guide: null, done: !!row.on });
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
    const [score, mod, log, welcome, automod, tickets] = await Promise.all([
        getProtectionScore(guildId).catch(() => ({ grid: [] })),
        first('SELECT mod_log_channel_id FROM moderation_config WHERE guild_id = ?', [guildId]),
        first('SELECT log_channel_id, enabled FROM logging_config WHERE guild_id = ?', [guildId]),
        first('SELECT channel_id FROM welcome_settings WHERE guild_id = ?', [guildId]),
        first('SELECT COUNT(*) AS n FROM automod_rules WHERE guild_id = ? AND is_enabled = 1', [guildId]),
        // A ticket panel from the dashboard, or the /support ticket setup config (the Ticket system row of
        // dashboard/services/feature-adoption.js counts the same two).
        first(`SELECT (SELECT COUNT(*) FROM ticket_panels WHERE guild_id = ? AND is_active = 1)
                    + (SELECT COUNT(*) FROM ticket_config WHERE guild_id = ?) AS n`, [guildId, guildId]),
    ]);
    const basics = {
        welcome: welcome ? !!welcome.row?.channel_id : null,
        serverLog: log ? !!log.row?.log_channel_id && (log.row.enabled == null || truthy(log.row.enabled)) : null,
        tickets: tickets ? Number(tickets.row?.n || 0) > 0 : null,
        modLog: mod ? !!mod.row?.mod_log_channel_id : null,
        automod: automod ? Number(automod.row?.n || 0) > 0 : null,
    };
    return buildChecklist({ grid: score.grid, basics });
}

export default { RECOMMENDED, BASICS, PROTECTIONS, buildChecklist, getSetupChecklist };
