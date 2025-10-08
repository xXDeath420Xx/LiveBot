const db = require('../utils/db');
const logger = require('../utils/logger');

async function checkStatroles(client) {
    logger.info('[StatroleManager] Starting periodic check for activity-based roles.', { category: 'statroles' });
    try {
        const [configs] = await db.execute('SELECT * FROM statroles_config');
        if (configs.length === 0) return;

        for (const config of configs) {
            const guild = await client.guilds.fetch(config.guild_id).catch(() => null);
            if (!guild) continue;

            const role = await guild.roles.fetch(config.role_id).catch(() => null);
            if (!role || !role.editable) continue;

            const sinceDate = new Date(Date.now() - config.period_days * 24 * 60 * 60 * 1000);
            const activityType = config.activity_type === 'messages' ? 'message' : 'voice';
            const requiredCount = config.threshold;

            // Get all members of the guild
            const members = await guild.members.fetch();

            // Get all activity for the required type in the guild since the start date
            const [activity] = await db.execute(
                'SELECT user_id, SUM(count) as total_activity FROM activity_logs WHERE guild_id = ? AND type = ? AND timestamp >= ? GROUP BY user_id',
                [config.guild_id, activityType, sinceDate]
            );

            const activityMap = new Map(activity.map(a => [a.user_id, a.total_activity]));

            for (const member of members.values()) {
                if (member.user.bot) continue;

                let userActivity = activityMap.get(member.id) || 0;
                if (activityType === 'voice') {
                    userActivity = Math.floor(userActivity / 60); // Convert seconds to minutes
                }

                const hasRole = member.roles.cache.has(role.id);

                // Assign role if they meet the threshold and don't have it
                if (userActivity >= requiredCount && !hasRole) {
                    await member.roles.add(role, 'Statrole: Met activity requirements.');
                    logger.info(`Assigned statrole ${role.name} to ${member.user.tag} in ${guild.name}.`, { category: 'statroles' });
                }
                // Remove role if they no longer meet the threshold and have it
                else if (userActivity < requiredCount && hasRole) {
                    await member.roles.remove(role, 'Statrole: No longer meets activity requirements.');
                    logger.info(`Removed statrole ${role.name} from ${member.user.tag} in ${guild.name}.`, { category: 'statroles' });
                }
            }
        }
    } catch (error) {
        if (error.code !== 'ER_NO_SUCH_TABLE') {
            logger.error('[StatroleManager] Error checking stat roles:', error);
        }
    }
    logger.info('[StatroleManager] Finished periodic check.', { category: 'statroles' });
}

module.exports = { checkStatroles };
