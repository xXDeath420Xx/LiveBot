/*
 * Security overview — the live side (pure parts in core/security-overview-logic.js). One read of the
 * existing stores for the dashboard overview ("Server security" panel) and the Security page's score:
 *
 *   protections   which of every automated protection are on (protectionsOverview() + the global ban
 *                 mode, auto lockdown and join insight) and a weighted score
 *   threats       what the protections stopped in the last 30 days, by protection
 *   banChart      bans per day for 30 days, automated vs by people (audit_logs + core/ban-log-logic.js)
 *   topRules      the rules / filters that fired most (name filters, message threats, join gate events)
 *   lockdowns     the last raid lockdowns (raid_lockdowns)
 *   lastScans     when each member scan / backfill last ran or last found something
 *   recentBans    the newest automated bans (core/ban-log.js)
 *
 * Read-only; every query fails soft (a missing table reads as nothing).
 */
import pool from '../utils/db.js';
import { protectionsOverview } from './protection-exempt.js';
import { getSettings as insightSettings } from './member-insight.js';
import { classifyBanRow, assembleBanLog } from './ban-log-logic.js';
import { getBanLog } from './ban-log.js';
import { userBits } from './user-display.js';
import { normaliseMode, normaliseThreshold } from './global-ban-confidence.js';
import {
    protectionsGrid, securityScore, dailyBuckets, topRules, BLOCKING_EVENT_ACTIONS, eventGroup,
} from './security-overview-logic.js';

const q = async (sql, params = []) => {
    try { const [r] = await pool.execute(sql, params); return r; } catch { return []; }
};
const one = async (sql, params = []) => (await q(sql, params))[0] || null;

function fleetIdsFor(guild) {
    const manager = guild.client?.globalBanManager;
    if (manager?.fleetIds) return manager.fleetIds();
    return new Set(guild.client?.user?.id ? [guild.client.user.id] : []);
}

/** Just the grid and score (the Security page's tile). */
export async function getProtectionScore(guildId) {
    const ov = await protectionsOverview(guildId);
    const p = { ...ov.protections };
    const gb = await one('SELECT enabled, mode, confidence_threshold FROM global_ban_config WHERE guild_id = ?', [guildId]);
    if (gb) p.globalBan = { on: !!gb.enabled, mode: normaliseMode(gb.mode), threshold: normaliseThreshold(gb.confidence_threshold) };
    const rl = await one('SELECT auto_lockdown_enabled, auto_lockdown_action FROM raid_detection_config WHERE guild_id = ?', [guildId]);
    p.raidLockdown = rl ? { on: !!rl.auto_lockdown_enabled, action: rl.auto_lockdown_action } : false;
    p.joinInsight = { on: (await insightSettings(guildId)).enabled };
    const grid = protectionsGrid(p);
    return { grid, score: securityScore(grid) };
}

export async function getSecurityOverview(guild) {
    const guildId = guild.id;
    const { grid, score } = await getProtectionScore(guildId);
    const DAYS = 30;
    const since = `DATE_SUB(NOW(), INTERVAL ${DAYS} DAY)`;
    const placeholders = BLOCKING_EVENT_ACTIONS.map(() => '?').join(',');

    const [gate, phish, gbActions, lockStats, autoInfractions, selfbot, bans, humanBans, nameRules, domains] = await Promise.all([
        q(`SELECT action, COUNT(*) AS n FROM join_gate_events WHERE guild_id = ? AND created_at > ${since}
             AND action IN (${placeholders}) GROUP BY action`, [guildId, ...BLOCKING_EVENT_ACTIONS]),
        q(`SELECT COALESCE(source, 'link') AS source, COUNT(*) AS n FROM phishing_detections WHERE guild_id = ? AND created_at > ${since} GROUP BY source`, [guildId]),
        q(`SELECT action, COUNT(*) AS n FROM global_ban_action_log WHERE guild_id = ? AND action IN ('ban','kick','alert') AND created_at > ${since} GROUP BY action`, [guildId]),
        one(`SELECT COUNT(*) AS n, COALESCE(SUM(joins_blocked), 0) AS blocked FROM raid_lockdowns WHERE guild_id = ? AND started_at > ${since}`, [guildId]),
        q(`SELECT type, COUNT(*) AS n FROM infractions WHERE guild_id = ? AND created_at > ${since}
             AND type IN ('RaidDetection','SelfbotDetection','AdaptiveSpam','AntiSpam') GROUP BY type`, [guildId]),
        one(`SELECT COUNT(*) AS n FROM selfbot_detections WHERE guild_id = ? AND detected_at > ${since}`, [guildId]),
        q(`SELECT user_id, moderator_id, reason, metadata, timestamp FROM audit_logs
             WHERE guild_id = ? AND event_type = 'GUILD_BAN_ADD' AND timestamp > ${since} LIMIT 5000`, [guildId]),
        q(`SELECT user_id, moderator_id, created_at FROM infractions WHERE guild_id = ? AND type = 'Ban' AND created_at > ${since}`, [guildId]),
        q(`SELECT filter_label AS label, COUNT(*) AS n FROM name_filter_reviews WHERE guild_id = ? AND found_at > ${since}
             AND filter_label IS NOT NULL AND kind NOT IN ('nsfw_avatar','nsfw_image') GROUP BY filter_label ORDER BY n DESC LIMIT 10`, [guildId]),
        q(`SELECT matched_domain AS label, COUNT(*) AS n FROM phishing_detections WHERE guild_id = ? AND created_at > ${since}
             GROUP BY matched_domain ORDER BY n DESC LIMIT 10`, [guildId]),
    ]);

    // What was stopped, by protection.
    const threats = {};
    const add = (label, n) => { if (Number(n)) threats[label] = (threats[label] || 0) + Number(n); };
    for (const r of gate) add(eventGroup(r.action), r.n);
    for (const r of phish) add(r.source === 'manual' || r.source === 'auto-list' ? 'Phishing links' : r.source === 'nsfw_image' ? 'NSFW chat images' : 'Message threats', r.n);
    for (const r of gbActions) add('Global ban network', r.n);
    add('Raid lockdown (joins blocked)', lockStats?.blocked);
    const INF = { RaidDetection: 'Raid detection', SelfbotDetection: 'Self-bot detection', AdaptiveSpam: 'Spam filters', AntiSpam: 'Spam filters' };
    for (const r of autoInfractions) add(INF[r.type] || r.type, r.n);
    if (!autoInfractions.some(r => r.type === 'SelfbotDetection')) add('Self-bot detection', selfbot?.n);
    const threatList = Object.entries(threats).sort((a, b) => b[1] - a[1]).map(([label, n]) => ({ label, n }));

    // Bans per day: automated (our protections) vs everyone else.
    const fleetIds = fleetIdsFor(guild);
    const banItems = bans.map(b => ({
        at: new Date(b.timestamp).getTime(),
        kind: classifyBanRow(b, { fleetIds, humanBans }).automated ? 'automated' : 'manual',
    }));
    const banChart = dailyBuckets(banItems, { days: DAYS, kinds: ['automated', 'manual'] });
    const automatedRows = assembleBanLog({ bans, humanBans, fleetIds, limit: 5000 });

    const byProtection = {};
    for (const r of automatedRows) byProtection[r.label] = (byProtection[r.label] || 0) + 1;
    const rules = topRules([
        nameRules.map(r => ({ label: `Name filter: ${r.label}`, n: r.n })),
        domains.filter(r => r.label).map(r => ({ label: `Link: ${r.label}`, n: r.n })),
        gate.map(r => ({ label: eventGroup(r.action), n: r.n })),
        Object.entries(byProtection).map(([label, n]) => ({ label: `Bans: ${label}`, n })),
    ], 8);

    const lockdowns = await q(
        `SELECT id, status, action, trigger_kind, trigger_detail, reason, started_at, ends_at, ended_at, end_reason, joins_blocked
           FROM raid_lockdowns WHERE guild_id = ? ORDER BY started_at DESC LIMIT 10`, [guildId]);

    const lastScans = [
        { key: 'spammer', label: 'Spammer scan (last applied)', at: (await one(
            "SELECT MAX(created_at) AS at FROM join_gate_events WHERE guild_id = ? AND action LIKE 'spammer\\_%' AND detail LIKE 'scan%'", [guildId]))?.at ?? null,
            page: 'security' },
        { key: 'names', label: 'Name filters (last finding)', at: (await one(
            "SELECT MAX(found_at) AS at FROM name_filter_reviews WHERE guild_id = ? AND kind = 'name'", [guildId]))?.at ?? null, page: 'name-filters' },
        { key: 'avatars', label: 'Avatar protection (last finding)', at: (await one(
            "SELECT MAX(found_at) AS at FROM name_filter_reviews WHERE guild_id = ? AND kind = 'avatar'", [guildId]))?.at ?? null, page: 'avatar-protection' },
        { key: 'nsfw', label: 'NSFW protection (last finding)', at: (await one(
            "SELECT MAX(found_at) AS at FROM name_filter_reviews WHERE guild_id = ? AND kind IN ('nsfw_avatar','nsfw_image')", [guildId]))?.at ?? null, page: 'nsfw-protection' },
        { key: 'joins', label: 'Join history backfill', at: (await one(
            'SELECT rejoin_backfilled_at AS at FROM join_gate_config WHERE guild_id = ?', [guildId]))?.at ?? null, page: 'rejoin' },
        { key: 'activity', label: 'Activity audit', at: (await one(
            "SELECT MAX(completed_at) AS at FROM activity_audits WHERE guild_id = ? AND completed_at IS NOT NULL", [guildId]))?.at ?? null, page: 'activity-audit' },
    ];

    let recentBans = [];
    try { recentBans = (await getBanLog(guild, { days: DAYS, limit: 8 })); } catch { recentBans = []; }
    // Who, not an id (core/user-display.js): the name logged at ban time when the caches have nobody.
    recentBans = recentBans.map(b => ({ ...b, user: userBits(guild, b.userId, { storedName: b.username }) }));

    return {
        protections: grid,
        score,
        threats: { days: DAYS, total: threatList.reduce((n, r) => n + r.n, 0), byProtection: threatList },
        banChart,
        bans30d: { automated: banItems.filter(b => b.kind === 'automated').length, manual: banItems.filter(b => b.kind === 'manual').length },
        topRules: rules,
        lockdowns,
        lastScans,
        recentBans,
    };
}

export default { getSecurityOverview, getProtectionScore };
