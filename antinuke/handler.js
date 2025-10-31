const { AuditLogEvent } = require('discord.js');
const { db } = require('../utils/db');
const { logger } = require('../utils/logger');

const actionTracker = {};

const monitoredActions = new Map([
    [AuditLogEvent.ChannelDelete, 'channel_delete'],
    [AuditLogEvent.RoleDelete, 'role_delete'],
    [AuditLogEvent.MemberKick, 'kick'],
    [AuditLogEvent.MemberBanAdd, 'ban']
]);

async function processAuditLog(auditLog, guild) {
    const { action, executorId } = auditLog;

    if (!monitoredActions.has(action) || !executorId) {
        return;
    }

    const [[config]] = await db.execute('SELECT * FROM antinuke_config WHERE guild_id = ?', [guild.id]);
    if (!config || !config.is_enabled) {
        return;
    }

    const whitelistedUsers = config.whitelisted_users ? config.whitelisted_users.split(',') : [];
    if (executorId === guild.client.user.id || whitelistedUsers.includes(executorId)) {
        return;
    }
    
    const now = Date.now();
    const actionType = monitoredActions.get(action);
    
    if (!actionTracker[guild.id]) actionTracker[guild.id] = {};
    if (!actionTracker[guild.id][executorId]) actionTracker[guild.id][executorId] = {};
    if (!actionTracker[guild.id][executorId][actionType]) actionTracker[guild.id][executorId][actionType] = [];

    const timestamps = actionTracker[guild.id][executorId][actionType];
    timestamps.push(now);

    const timeWindow = (config.time_window_seconds || 10) * 1000;
    const recentActions = timestamps.filter(ts => now - ts < timeWindow);
    actionTracker[guild.id][executorId][actionType] = recentActions;

    const threshold = config.action_thresholds?.[actionType] || 999;

    if (recentActions.length >= threshold) {
        logger.warn(`[Anti-Nuke] PANIC MODE TRIGGERED in ${guild.name} by ${executorId}. Action: ${actionType}, Count: ${recentActions.length}`);
        await triggerPanicMode(guild, executorId, actionType, recentActions.length);
        actionTracker[guild.id][executorId][actionType] = [];
    }
}

async function triggerPanicMode(guild, offenderId, reasonAction, reasonCount) {
    try {
        const offender = await guild.members.fetch(offenderId).catch(() => null);
        if (!offender || !offender.manageable) {
            logger.error(`[Anti-Nuke] Could not fetch or manage offending member ${offenderId} in ${guild.name}.`);
            return;
        }

        await offender.roles.set([], `Anti-Nuke Triggered: Performed ${reasonCount} ${reasonAction} actions.`);
        logger.info(`[Anti-Nuke] All roles removed from ${offender.user.tag}.`);
        
        const owner = await guild.fetchOwner();
        if (owner) {
            await owner.send(
                `**CRITICAL SECURITY ALERT IN ${guild.name}**\n` +
                `The Anti-Nuke system has been triggered.\n\n` +
                `**User:** ${offender.user.tag} (${offenderId})\n` +
                `**Reason:** Performed **${reasonCount}** \`${reasonAction}\` actions in a short period.\n` +
                `**Action Taken:** All roles have been removed from this user to prevent further damage.`
            ).catch(e => logger.error(`[Anti-Nuke] Failed to DM server owner:`, e));
        }
    } catch (error) {
        logger.error(`[Anti-Nuke] FAILED TO EXECUTE PANIC MODE in ${guild.name}:`, error);
    }
}

module.exports = { processAuditLog };