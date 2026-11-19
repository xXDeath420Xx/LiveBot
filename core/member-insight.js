/*
 * Member risk insight — the live side (the rules are in core/member-insight-logic.js).
 *
 *   riskFieldForJoin(member)        the "Risk" field core/log-manager.js logMemberJoin adds to the join log
 *   memberInsight(guild, userId)    the same, in full, for the dashboard (Users page, Roles > Members);
 *                                   works for people who already left
 *   getSettings / setSettings       per server: on/off and the "new account" threshold in days
 *                                   (logging_config.join_insight / join_new_account_days, migration 329;
 *                                   on, 7 days, until a server changes it — it only adds information)
 *
 * Everything is read from what the bot already keeps: the user object (age, avatar, public flags incl.
 * Discord's spammer flag), the global ban cache and signals (core/global-ban-manager.js), the permanent
 * join history (member_join_history) and earlier protection events here (join_gate_events). Failures
 * read as "unknown" and never stop the join log.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import configCache from '../utils/configCache.js';
import { isFlaggedSpammer } from './spammer-flag.js';
import {
    scoreJoinRisk, badgesFromFlags, formatRiskField, normaliseNewAccountDays, DEFAULT_NEW_ACCOUNT_DAYS,
} from './member-insight-logic.js';

// Lifecycle / passive-observation events the risk score ignores — a member who was DM'd a
// warning and then kicked by the inactivity pruner was not caught by a safety protection and
// shouldn't ping the join log's Risk field on their next join.
const NOT_A_HIT = ['allowed_approved', 'allowed_pending', 'verify_passed', 'name_logged', 'avatar_logged',
    'rejoin_observed', 'spammer_observed', 'prune_logged', 'prune_held', 'verify_held',
    'prune_inactive_warned', 'prune_inactive_kicked'];

export async function getSettings(guildId) {
    try {
        return await configCache.get('member_insight', guildId, async () => {
            const [[row]] = await pool.execute(
                'SELECT join_insight, join_new_account_days FROM logging_config WHERE guild_id = ?', [guildId]);
            return {
                enabled: row ? !!row.join_insight : true,
                newAccountDays: normaliseNewAccountDays(row?.join_new_account_days ?? DEFAULT_NEW_ACCOUNT_DAYS),
            };
        });
    } catch {
        return { enabled: true, newAccountDays: DEFAULT_NEW_ACCOUNT_DAYS };   // before migration 329
    }
}

export async function setSettings(guildId, { enabled, newAccountDays }) {
    const on = enabled ? 1 : 0;
    const days = normaliseNewAccountDays(newAccountDays);
    await pool.execute(
        `INSERT INTO logging_config (guild_id, join_insight, join_new_account_days) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE join_insight = VALUES(join_insight), join_new_account_days = VALUES(join_new_account_days)`,
        [guildId, on, days]);
    configCache.invalidate('member_insight', guildId);
    return { enabled: !!on, newAccountDays: days };
}

/** Network standing without leaking who reported: listed + confidence, or how many other servers banned them. */
async function networkFor(client, userId, guildId) {
    const manager = client?.globalBanManager;
    const record = manager?.banCache?.get(userId);
    if (record) {
        return { listed: true, confidence: manager.confidenceOf(record), severity: record.severity, category: record.category, independentServers: null };
    }
    try {
        const [[row]] = await pool.execute(
            `SELECT COUNT(DISTINCT COALESCE(guild_owner_id, guild_id)) AS n FROM global_ban_auto_aggregate
              WHERE user_id = ? AND guild_id <> ? AND action_type = 'ban'`, [userId, guildId]);
        return { listed: false, confidence: 0, independentServers: Number(row?.n) || 0 };
    } catch {
        return null;
    }
}

/** Every input scoreJoinRisk needs, for one user in one server. */
export async function gatherSignals(guild, user, settings = null) {
    const cfg = settings || await getSettings(guild.id);
    if (user.flags == null && typeof user.fetchFlags === 'function') await user.fetchFlags().catch(() => null);
    const [joins, prior, network] = await Promise.all([
        pool.execute('SELECT COUNT(*) AS n FROM member_join_history WHERE guild_id = ? AND user_id = ?', [guild.id, user.id])
            .then(([[r]]) => Number(r?.n) || 0).catch(() => 0),
        // Pull the hit rows (not just the count) so the Risk field can name which protections
        // caught them. Rows come back most-recent-first; we dedupe actions here.
        pool.execute(
            `SELECT action FROM join_gate_events WHERE guild_id = ? AND user_id = ?
               AND action NOT IN (${NOT_A_HIT.map(() => '?').join(',')})
               AND created_at > DATE_SUB(NOW(), INTERVAL 180 DAY) AND created_at < DATE_SUB(NOW(), INTERVAL 2 MINUTE)
             ORDER BY created_at DESC`,
            [guild.id, user.id, ...NOT_A_HIT])
            .then(([rows]) => {
                const actions = [];
                const seen = new Set();
                for (const r of rows) if (!seen.has(r.action)) { seen.add(r.action); actions.push(r.action); }
                return { count: rows.length, actions };
            })
            .catch(() => ({ count: 0, actions: [] })),
        networkFor(guild.client, user.id, guild.id),
    ]);
    return {
        bot: !!user.bot,
        accountAgeMs: user.createdTimestamp ? Date.now() - user.createdTimestamp : null,
        newAccountDays: cfg.newAccountDays,
        defaultAvatar: !user.avatar,
        spammer: isFlaggedSpammer(user),
        network,
        joins,
        priorHits: prior.count,
        priorHitActions: prior.actions,
        badges: badgesFromFlags(user.flags),
    };
}

/** The join log's Risk field, or null when the server switched it off (or anything failed). */
export async function riskFieldForJoin(member) {
    try {
        const settings = await getSettings(member.guild.id);
        if (!settings.enabled) return null;
        const input = await gatherSignals(member.guild, member.user, settings);
        const risk = scoreJoinRisk(input);
        return { field: formatRiskField(risk, input), risk };
    } catch (err) {
        logger.warn(`[MemberInsight] join insight failed for ${member?.id} in ${member?.guild?.id}: ${err.message}`);
        return null;
    }
}

/** Everything the dashboard shows about one user's risk in this server. */
export async function memberInsight(guild, userId) {
    const member = await guild.members.fetch(userId).catch(() => null);
    const user = member?.user || await guild.client.users.fetch(userId).catch(() => null);
    if (!user) return null;
    const settings = await getSettings(guild.id);
    const input = await gatherSignals(guild, user, settings);
    const risk = scoreJoinRisk(input);
    let network = null;
    try {
        network = guild.client.globalBanManager ? await guild.client.globalBanManager.getNetworkCheck(user.id, guild.id) : null;
    } catch { network = null; }
    return {
        user: {
            id: user.id, username: user.username, displayName: member?.displayName ?? user.globalName ?? user.username,
            avatar: user.displayAvatarURL({ size: 64 }), createdAt: user.createdTimestamp, bot: !!user.bot,
        },
        inServer: !!member,
        joinedAt: member?.joinedTimestamp ?? null,
        settings,
        risk,
        facts: {
            accountAgeDays: input.accountAgeMs == null ? null : Math.floor(input.accountAgeMs / 86_400_000),
            defaultAvatar: input.defaultAvatar,
            spammer: input.spammer,
            joins: input.joins,
            priorHits: input.priorHits,
            priorHitActions: input.priorHitActions || [],
            badges: input.badges,
        },
        network,
    };
}

export default { getSettings, setSettings, gatherSignals, riskFieldForJoin, memberInsight };
