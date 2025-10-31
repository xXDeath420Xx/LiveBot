import { AuditLogEvent, Guild, GuildAuditLogsEntry } from 'discord.js';
import db from '../utils/db';
import logger from '../utils/logger';
import { RowDataPacket } from 'mysql2/promise';

interface AntiNukeConfig extends RowDataPacket {
    guild_id: string;
    is_enabled: boolean;
    whitelisted_users: string | null;
    time_window_seconds: number;
    action_thresholds: Record<string, number>;
}

interface ActionTracker {
    [guildId: string]: {
        [userId: string]: {
            [actionType: string]: number[];
        };
    };
}

const actionTracker: ActionTracker = {};

const monitoredActions = new Map<AuditLogEvent, string>([
    [AuditLogEvent.ChannelDelete, 'channel_delete'],
    [AuditLogEvent.RoleDelete, 'role_delete'],
    [AuditLogEvent.MemberKick, 'kick'],
    [AuditLogEvent.MemberBanAdd, 'ban']
]);

export async function processAuditLog(auditLog: GuildAuditLogsEntry, guild: Guild): Promise<void> {
    const { action, executorId } = auditLog;

    if (!monitoredActions.has(action) || !executorId) {
        return;
    }

    const [rows] = await db.execute<AntiNukeConfig[]>('SELECT * FROM antinuke_config WHERE guild_id = ?', [guild.id]);
    const config = rows[0];
    if (!config || !config.is_enabled) {
        return;
    }

    const whitelistedUsers = config.whitelisted_users ? config.whitelisted_users.split(',') : [];
    if (executorId === guild.client.user.id || whitelistedUsers.includes(executorId)) {
        return;
    }

    const now = Date.now();
    const actionType = monitoredActions.get(action)!;

    if (!actionTracker[guild.id]) actionTracker[guild.id] = {};
    if (!actionTracker[guild.id][executorId]) actionTracker[guild.id][executorId] = {};
    if (!actionTracker[guild.id][executorId][actionType]) actionTracker[guild.id][executorId][actionType] = [];

    const timestamps = actionTracker[guild.id][executorId][actionType];
    timestamps.push(now);

    const timeWindow = (config.time_window_seconds || 10) * 1000;
    const recentActions = timestamps?.filter(ts => now - ts < timeWindow);
    actionTracker[guild.id][executorId][actionType] = recentActions;

    const threshold = config.action_thresholds?.[actionType] || 999;

    if (recentActions.length >= threshold) {
        logger.warn(`[Anti-Nuke] PANIC MODE TRIGGERED in ${guild.name} by ${executorId}. Action: ${actionType}, Count: ${recentActions.length}`);
        await triggerPanicMode(guild, executorId, actionType, recentActions.length);
        actionTracker[guild.id][executorId][actionType] = [];
    }
}

async function triggerPanicMode(guild: Guild, offenderId: string, reasonAction: string, reasonCount: number): Promise<void> {
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
            ).catch((e: unknown) => logger.error(`[Anti-Nuke] Failed to DM server owner:`, { error: e instanceof Error ? e.stack : e }));
        }
    } catch (error: unknown) {
        logger.error(`[Anti-Nuke] FAILED TO EXECUTE PANIC MODE in ${guild.name}:`, { error: error instanceof Error ? error.stack : error });
    }
}
