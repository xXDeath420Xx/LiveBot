/*
 * Live roles the bot handed out, so it can take back the ones left behind.
 *
 * A live role is added and removed inside the stream check cycle, but only for streamers that still
 * have a subscription in that server. When the subscription disappears mid-stream — Community
 * Support's monthly expiry, a staff removal, a team sync — nothing ever takes the role back:
 * cleanupOrphanedAnnouncements deletes the message, not the role. Members stayed "On Air" for weeks.
 *
 * Only roles recorded here are ever removed by the sweep. Several servers use their live role as a
 * community role too and hand it out by hand; a role staff gave is never in this ledger, so it is
 * never touched.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { leftoverAction, isGoneError } from '../utils/live-role-logic.js';

export async function recordLiveRoleGrant(guildId, userId, roleId) {
    await pool.execute(
        `INSERT INTO live_role_grants (guild_id, user_id, role_id) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE granted_at = CURRENT_TIMESTAMP`,
        [guildId, userId, roleId]);
}

export async function forgetLiveRoleGrant(guildId, userId, roleId) {
    await pool.execute(
        'DELETE FROM live_role_grants WHERE guild_id = ? AND user_id = ? AND role_id = ?', [guildId, userId, roleId]);
}

/** Take back recorded live roles from members no longer tracked in that server. */
export async function cleanupLeftoverLiveRoles(client) {
    let removed = 0, forgotten = 0;
    try {
        const [grants] = await pool.query('SELECT guild_id, user_id, role_id FROM live_role_grants');
        const byGuild = new Map();
        for (const g of grants) {
            if (!byGuild.has(g.guild_id)) byGuild.set(g.guild_id, []);
            byGuild.get(g.guild_id).push(g);
        }

        for (const [guildId, list] of byGuild) {
            const guildClient = (global.botManager ? global.botManager.getClientForGuild(guildId) : null) || client;
            const guild = guildClient?.guilds?.cache?.get(guildId);
            if (!guild) continue; // not reachable right now: keep the records for a later sweep

            const [tracked] = await pool.query(
                `SELECT DISTINCT s.discord_user_id AS id FROM streamers s
                   JOIN subscriptions sub ON sub.streamer_id = s.streamer_id AND sub.guild_id = ?
                  WHERE s.discord_user_id IN (?)`, [guildId, [...new Set(list.map(g => g.user_id))]]);
            const trackedIds = new Set(tracked.map(r => r.id));

            for (const g of list) {
                let fetchError = null;
                const member = guild.members.cache.get(g.user_id)
                    || await guild.members.fetch(g.user_id).catch(e => { fetchError = e; return null; });
                if (!member && !isGoneError(fetchError)) continue; // a hiccup, not an answer: retry later

                const action = leftoverAction({
                    inServer: !!member, hasRole: !!member?.roles.cache.has(g.role_id), tracked: trackedIds.has(g.user_id) });
                if (action === 'keep') continue;
                if (action === 'remove') {
                    try {
                        await member.roles.remove(g.role_id, 'Live role left behind: this streamer is no longer tracked in this server');
                        removed++;
                        logger.info(`[LiveRoles] Took back leftover live role ${g.role_id} from ${member.user.tag} in ${guild.name} `
                            + `(${guildId}): no longer tracked there`, { category: 'streams', guildId, userId: g.user_id });
                    } catch (err) {
                        if (!isGoneError(err)) {
                            logger.warn(`[LiveRoles] Could not take back live role ${g.role_id} from ${g.user_id} in ${guildId}: ${err.message}`,
                                { category: 'streams', guildId, code: err.code });
                            continue; // keep the record; the next sweep retries
                        }
                    }
                } else {
                    forgotten++;
                }
                await forgetLiveRoleGrant(guildId, g.user_id, g.role_id);
            }
        }
        if (removed || forgotten) {
            logger.info(`[LiveRoles] Leftover live role sweep: ${removed} taken back, ${forgotten} records cleared`, { category: 'streams' });
        }
    } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE') logger.error('[LiveRoles] leftover live role sweep failed', { error: err.message, category: 'streams' });
    }
    return { removed, forgotten };
}

export default { recordLiveRoleGrant, forgetLiveRoleGrant, cleanupLeftoverLiveRoles };
