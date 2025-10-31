"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processAuditLog = processAuditLog;
const discord_js_1 = require("discord.js");
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
const actionTracker = {};
const monitoredActions = new Map([
    [discord_js_1.AuditLogEvent.ChannelDelete, 'channel_delete'],
    [discord_js_1.AuditLogEvent.RoleDelete, 'role_delete'],
    [discord_js_1.AuditLogEvent.MemberKick, 'kick'],
    [discord_js_1.AuditLogEvent.MemberBanAdd, 'ban']
]);
async function processAuditLog(auditLog, guild) {
    const { action, executorId } = auditLog;
    if (!monitoredActions.has(action) || !executorId) {
        return;
    }
    const [rows] = await db_1.default.execute('SELECT * FROM antinuke_config WHERE guild_id = ?', [guild.id]);
    const config = rows[0];
    if (!config || !config.is_enabled) {
        return;
    }
    const whitelistedUsers = config.whitelisted_users ? config.whitelisted_users.split(',') : [];
    if (executorId === guild.client.user.id || whitelistedUsers.includes(executorId)) {
        return;
    }
    const now = Date.now();
    const actionType = monitoredActions.get(action);
    if (!actionTracker[guild.id])
        actionTracker[guild.id] = {};
    if (!actionTracker[guild.id][executorId])
        actionTracker[guild.id][executorId] = {};
    if (!actionTracker[guild.id][executorId][actionType])
        actionTracker[guild.id][executorId][actionType] = [];
    const timestamps = actionTracker[guild.id][executorId][actionType];
    timestamps.push(now);
    const timeWindow = (config.time_window_seconds || 10) * 1000;
    const recentActions = timestamps.filter(ts => now - ts < timeWindow);
    actionTracker[guild.id][executorId][actionType] = recentActions;
    const threshold = config.action_thresholds?.[actionType] || 999;
    if (recentActions.length >= threshold) {
        logger_1.default.warn(`[Anti-Nuke] PANIC MODE TRIGGERED in ${guild.name} by ${executorId}. Action: ${actionType}, Count: ${recentActions.length}`);
        await triggerPanicMode(guild, executorId, actionType, recentActions.length);
        actionTracker[guild.id][executorId][actionType] = [];
    }
}
async function triggerPanicMode(guild, offenderId, reasonAction, reasonCount) {
    try {
        const offender = await guild.members.fetch(offenderId).catch(() => null);
        if (!offender || !offender.manageable) {
            logger_1.default.error(`[Anti-Nuke] Could not fetch or manage offending member ${offenderId} in ${guild.name}.`);
            return;
        }
        await offender.roles.set([], `Anti-Nuke Triggered: Performed ${reasonCount} ${reasonAction} actions.`);
        logger_1.default.info(`[Anti-Nuke] All roles removed from ${offender.user.tag}.`);
        const owner = await guild.fetchOwner();
        if (owner) {
            await owner.send(`**CRITICAL SECURITY ALERT IN ${guild.name}**\n` +
                `The Anti-Nuke system has been triggered.\n\n` +
                `**User:** ${offender.user.tag} (${offenderId})\n` +
                `**Reason:** Performed **${reasonCount}** \`${reasonAction}\` actions in a short period.\n` +
                `**Action Taken:** All roles have been removed from this user to prevent further damage.`).catch((e) => logger_1.default.error(`[Anti-Nuke] Failed to DM server owner:`, { error: e instanceof Error ? e.stack : e }));
        }
    }
    catch (error) {
        logger_1.default.error(`[Anti-Nuke] FAILED TO EXECUTE PANIC MODE in ${guild.name}:`, { error: error instanceof Error ? error.stack : error });
    }
}
