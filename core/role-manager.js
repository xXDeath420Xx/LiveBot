const logger = require('../utils/logger');
const db = require('../utils/db');

async function cleanupInvalidRole(guildId, roleId) {
    if (!guildId || !roleId) return;
    logger.warn(`[Role Cleanup] Aggressively purging invalid role ID ${roleId} for guild ${guildId}.`);
    try {
        await db.execute('UPDATE guilds SET live_role_id = NULL WHERE guild_id = ? AND live_role_id = ?', [guildId, roleId]);
        await db.execute('UPDATE twitch_teams SET live_role_id = NULL WHERE guild_id = ? AND live_role_id = ?', [guildId, roleId]);
    } catch (dbError) {
        logger.error(`[Role Cleanup] DB Error while purging role ${roleId} for guild ${guildId}:`, { error: dbError });
    }
}

async function handleRole(member, roleIds, action, guildId) {
    logger.debug(`[Role Manager] Attempting to ${action} roles for member ${member.id} in guild ${guildId}. Roles: ${roleIds.join(', ')}`);
    if (!member || !roleIds || roleIds.length === 0) {
        logger.debug(`[Role Manager] Skipping role action due to invalid member or roleIds.`);
        return;
    }
    for (const roleId of roleIds) {
        if (!roleId) {
            logger.debug(`[Role Manager] Skipping invalid roleId in list.`);
            continue;
        }
        try {
            if (action === 'add' && !member.roles.cache.has(roleId)) {
                logger.info(`[Role Manager] Adding role ${roleId} to member ${member.id} in guild ${guildId}.`);
                await member.roles.add(roleId);
                logger.info(`[Role Manager] Successfully added role ${roleId} to member ${member.id}.`);
            } else if (action === 'remove' && member.roles.cache.has(roleId)) {
                logger.info(`[Role Manager] Removing role ${roleId} from member ${member.id} in guild ${guildId}.`);
                await member.roles.remove(roleId);
                logger.info(`[Role Manager] Successfully removed role ${roleId} from member ${member.id}.`);
            } else {
                logger.debug(`[Role Manager] Role ${roleId} for member ${member.id} already in desired state (${action}).`);
            }
        } catch (e) {
            if (e.code === 10011 || (e.message && e.message.includes('Unknown Role'))) {
                logger.warn(`[Role Manager] Role ${roleId} for guild ${guildId} is unknown/invalid. Initiating cleanup.`);
                await cleanupInvalidRole(guildId, roleId);
            } else {
                logger.error(`[Role Manager] Failed to ${action} role ${roleId} for ${member.id} in ${guildId}: ${e.message}`, { error: e });
            }
        }
    }
}

module.exports = { handleRole, cleanupInvalidRole };