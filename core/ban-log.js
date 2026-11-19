/*
 * Automated-ban log — the live side (the assembly rules are in core/ban-log-logic.js).
 *
 *   getBanLog(guild)                   every ban our protections made (90 days), with the reason, the
 *                                      evidence each protection kept, and whether it has been lifted
 *   unbanFromLog(guild, userId, actor) the dashboard's one-click Unban: checks the bot can, lifts the
 *                                      ban, restarts the rejoin limit's count (as an unban by staff
 *                                      does, core/join-history.js) and logs it
 *
 * Reads the existing stores only (audit_logs, infractions, join_gate_events, phishing_detections,
 * global_ban_action_log); writes nothing of its own except the rejoin reset. Shown on the Moderation
 * page (dashboard/routes/api/features/insight.js); the overview reads the recent ones.
 */
import { PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { assembleBanLog, EVENT_PROTECTION } from './ban-log-logic.js';
import { addReset } from './join-history.js';
import { logFeatureEvent, userLabel } from './feature-log.js';

export const BAN_LOG_DAYS = 90;

function fleetIdsFor(guild) {
    const manager = guild.client?.globalBanManager;
    if (manager?.fleetIds) return manager.fleetIds();
    return new Set(guild.client?.user?.id ? [guild.client.user.id] : []);
}

const rows = async (sql, params) => {
    try { const [r] = await pool.execute(sql, params); return r; } catch (err) {
        logger.warn(`[BanLog] query failed: ${err.message}`);
        return [];
    }
};

/** The evidence each protection kept, normalised for matchEvidence. */
async function loadEvidence(guildId, days) {
    const out = [];
    const gate = await rows(
        `SELECT user_id, action, detail, created_at FROM join_gate_events
          WHERE guild_id = ? AND action IN ('spammer_banned','name_banned','avatar_banned','verify_banned','rejoin_banned','nsfw_banned')
            AND created_at > DATE_SUB(NOW(), INTERVAL ${days} DAY)`, [guildId]);
    for (const r of gate) {
        out.push({ userId: r.user_id, at: r.created_at, protection: EVENT_PROTECTION[r.action] || null, text: r.detail || null });
    }
    const phish = await rows(
        `SELECT user_id, channel_id, message_id, matched_domain, source, created_at FROM phishing_detections
          WHERE guild_id = ? AND action_taken = 'ban' AND created_at > DATE_SUB(NOW(), INTERVAL ${days} DAY)`, [guildId]);
    for (const r of phish) {
        out.push({
            userId: r.user_id, at: r.created_at, protection: null,
            text: [r.source, r.matched_domain].filter(Boolean).join(': ') || null,
            url: r.message_id && r.channel_id ? `https://discord.com/channels/${guildId}/${r.channel_id}/${r.message_id}` : null,
            page: 'message-threats',
        });
    }
    const gb = await rows(
        `SELECT user_id, global_ban_entry_id, details, created_at FROM global_ban_action_log
          WHERE guild_id = ? AND action = 'ban' AND created_at > DATE_SUB(NOW(), INTERVAL ${days} DAY)`, [guildId]);
    for (const r of gb) {
        out.push({
            userId: r.user_id, at: r.created_at, protection: 'global_ban',
            text: `${r.global_ban_entry_id ? `Network entry #${r.global_ban_entry_id}. ` : ''}${r.details || ''}`.trim() || null,
            page: 'global-ban',
        });
    }
    return out;
}

/** Automated bans in this server, newest first. */
export async function getBanLog(guild, { days = BAN_LOG_DAYS, limit = 200 } = {}) {
    const d = Math.max(1, Math.min(365, Number.parseInt(days, 10) || BAN_LOG_DAYS));
    const [bans, unbans, humanBans, evidence] = await Promise.all([
        rows(`SELECT user_id, moderator_id, reason, metadata, timestamp FROM audit_logs
               WHERE guild_id = ? AND event_type = 'GUILD_BAN_ADD' AND timestamp > DATE_SUB(NOW(), INTERVAL ${d} DAY)
               ORDER BY timestamp DESC LIMIT 2000`, [guild.id]),
        rows(`SELECT user_id, timestamp FROM audit_logs
               WHERE guild_id = ? AND event_type = 'GUILD_BAN_REMOVE' AND timestamp > DATE_SUB(NOW(), INTERVAL ${d} DAY)`, [guild.id]),
        rows(`SELECT user_id, moderator_id, created_at FROM infractions
               WHERE guild_id = ? AND type = 'Ban' AND created_at > DATE_SUB(NOW(), INTERVAL ${d} DAY)`, [guild.id]),
        loadEvidence(guild.id, d),
    ]);
    return assembleBanLog({ bans, unbans, humanBans, evidence, fleetIds: fleetIdsFor(guild), limit });
}

/**
 * Lift a ban from the dashboard. The caller has already checked the person may (Ban Members).
 * @returns {Promise<{ ok: true } | { ok: false, status: number, error: string }>}
 */
export async function unbanFromLog(guild, userId, actor) {
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!me?.permissions.has(PermissionFlagsBits.BanMembers)) {
        return { ok: false, status: 409, error: 'Manual action needed: the bot does not have the Ban Members permission in this server, so it cannot lift bans. Give its role Ban Members, or unban in Server Settings > Bans.' };
    }
    const name = String(actor?.username || 'staff').replace(/[^\x20-\x7E]/g, '').slice(0, 40) || 'staff';
    try {
        await guild.bans.remove(userId, `Unbanned from the dashboard ban log by ${name}`);
    } catch (err) {
        if (err?.code === 10026) return { ok: false, status: 404, error: 'They are not banned any more.' };
        if (err?.code === 50013) return { ok: false, status: 409, error: 'Manual action needed: Discord refused (missing permission). Give the bot Ban Members, or unban in Server Settings > Bans.' };
        logger.error(`[BanLog] unban failed for ${userId} in ${guild.id}: ${err.message}`);
        return { ok: false, status: 500, error: 'Discord did not lift the ban. Try again in a minute.' };
    }
    // Let them back in for real: the rejoin limit counts from here (events/guildBanRemove.js also
    // writes one for the owning bot; a second reset row changes nothing).
    await addReset(guild.id, userId, 'unban', actor?.id ?? null).catch(err =>
        logger.warn(`[BanLog] could not reset rejoin count for ${userId}: ${err.message}`));
    void logFeatureEvent(() => (guild), 'moderation.unban', () => ({
        title: '🔓 Ban Lifted From the Dashboard',
        fields: [['Member', `<@${userId}> (${userId})`], ['By', actor ? userLabel(actor) : 'Dashboard'],
            ['Where', 'Moderation page, automated ban log', false]],
    }));
    logger.info(`[BanLog] ${name} unbanned ${userId} in ${guild.id} from the dashboard`);
    return { ok: true };
}

export default { getBanLog, unbanFromLog, BAN_LOG_DAYS };
