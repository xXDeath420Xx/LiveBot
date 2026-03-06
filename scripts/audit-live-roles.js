import pool from '../utils/db.js';
import logger from '../utils/logger.js';

/**
 * Audit live roles - find users with the role but no active announcements
 */
async function auditLiveRoles() {
    // Get the bot client
    const botManager = global.botManager || { getClientForGuild: () => null };

    if (!botManager.clients || botManager.clients.size === 0) {
        logger.error('[Audit] No bot clients available - must run from running bot process');
        logger.info('[Audit] Run this with: pm2 trigger "CertiFried Utility Bot" audit-roles');
        return;
    }

    let connection;
    try {
        connection = await pool.getConnection();

        // Get all guilds with live role configured
        const [guilds] = await connection.query(`
            SELECT DISTINCT guild_id, live_role_id
            FROM subscriptions
            WHERE live_role_id IS NOT NULL
        `);

        logger.info(`[Audit] Checking ${guilds.length} guilds for incorrect role assignments`);

        let totalIssues = 0;

        for (const { guild_id, live_role_id } of guilds) {
            // Get bot client for this guild
            const client = botManager.getClientForGuild(guild_id);
            if (!client) continue;

            const guild = client.guilds.cache.get(guild_id);
            if (!guild) continue;

            // Get all members with the live role
            const role = await guild.roles.fetch(live_role_id).catch(() => null);
            if (!role) continue;

            const membersWithRole = role.members;

            logger.info(`[Audit] Guild ${guild.name}: ${membersWithRole.size} members with live role`);

            for (const [userId, member] of membersWithRole) {
                // Check if user has any active announcements
                const [announcements] = await connection.query(`
                    SELECT COUNT(*) as count
                    FROM live_announcements
                    WHERE discord_user_id = ?
                    AND guild_id = ?
                `, [userId, guild_id]);

                if (announcements[0].count === 0) {
                    logger.warn(`[Audit] ⚠️  ${member.user.tag} has live role but NO active announcements`, {
                        guild: guild.name,
                        userId,
                        roleId: live_role_id
                    });
                    totalIssues++;
                }
            }
        }

        if (totalIssues === 0) {
            logger.info('[Audit] ✅ No issues found! All roles are correctly assigned.');
        } else {
            logger.warn(`[Audit] ⚠️  Found ${totalIssues} users with incorrect role assignments`);
            logger.info('[Audit] These will be fixed on the next stream check cycle (runs every 60 seconds)');
        }

    } catch (error) {
        logger.error('[Audit] Error:', { error: error.message, stack: error.stack });
    } finally {
        if (connection) connection.release();
    }
}

// Export for use as PM2 trigger or direct invocation
export default auditLiveRoles;

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    auditLiveRoles().then(() => {
        logger.info('[Audit] Complete');
        process.exit(0);
    }).catch(error => {
        logger.error('[Audit] Fatal error:', error);
        process.exit(1);
    });
}
