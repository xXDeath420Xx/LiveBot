import logger from '../utils/logger';
import db from '../utils/db';
import { Client } from 'discord.js';
import { RowDataPacket } from 'mysql2';

interface TimedModerationAction extends RowDataPacket {
    id: number;
    guild_id: string;
    user_id: string;
    moderator_id: string;
    action_type: 'mute' | 'ban' | 'role_add' | 'role_remove';
    role_id: string | null;
    expires_at: Date;
    reason: string | null;
    executed: boolean;
    created_at: Date;
}

class TimedModerationManager {
    private client: Client;
    private checkInterval: NodeJS.Timeout | null;

    constructor(client: Client) {
        this.client = client;
        this.checkInterval = null;
        logger.info('[TimedModerationManager] Timed moderation manager initialized');
    }

    startScheduler(): void {
        // Check every 30 seconds for expired mod actions
        this.checkInterval = setInterval(() => {
            this.checkExpiredActions();
        }, 30 * 1000);

        logger.info('[TimedModerationManager] Scheduler started (30s interval)');
    }

    stopScheduler(): void {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            logger.info('[TimedModerationManager] Scheduler stopped');
        }
    }

    async checkExpiredActions(): Promise<void> {
        try {
            const [actions] = await db.execute<TimedModerationAction[]>(
                'SELECT * FROM timed_moderation WHERE executed = 0 AND expires_at <= NOW()'
            );

            if (actions.length === 0) return;

            logger.info(`[TimedModerationManager] Found ${actions.length} expired moderation actions`);

            for (const action of actions) {
                await this.executeTimedAction(action);
            }
        } catch (error: any) {
            logger.error(`[TimedModerationManager] Error checking expired actions: ${error.message}`);
        }
    }

    async executeTimedAction(action: TimedModerationAction): Promise<void> {
        try {
            const guild = this.client.guilds.cache.get(action.guild_id);
            if (!guild) {
                logger.warn(`[TimedModerationManager] Guild ${action.guild_id} not found`);
                await this.markExecuted(action.id);
                return;
            }

            const member = await guild.members.fetch(action.user_id).catch(() => null);

            switch (action.action_type) {
                case 'mute':
                    if (member) {
                        await member.timeout(null, `Timed mute expired - Originally by ${action.moderator_id}`);
                        logger.info(`[TimedModerationManager] Unmuted ${action.user_id}`, { guildId: guild.id });
                    }
                    break;

                case 'ban':
                    await guild.bans.remove(action.user_id, `Timed ban expired - Originally by ${action.moderator_id}`);
                    logger.info(`[TimedModerationManager] Unbanned ${action.user_id}`, { guildId: guild.id });
                    break;

                case 'role_add':
                    if (member && action.role_id) {
                        const role = guild.roles.cache.get(action.role_id);
                        if (role) {
                            await member.roles.remove(role, `Timed role addition expired`);
                            logger.info(`[TimedModerationManager] Removed role ${role.name} from ${action.user_id}`, { guildId: guild.id });
                        }
                    }
                    break;

                case 'role_remove':
                    if (member && action.role_id) {
                        const role = guild.roles.cache.get(action.role_id);
                        if (role) {
                            await member.roles.add(role, `Timed role removal expired`);
                            logger.info(`[TimedModerationManager] Restored role ${role.name} to ${action.user_id}`, { guildId: guild.id });
                        }
                    }
                    break;
            }

            await this.markExecuted(action.id);
        } catch (error: any) {
            logger.error(`[TimedModerationManager] Failed to execute action ${action.id}: ${error.message}`);
            await this.markExecuted(action.id); // Mark as executed even if failed to prevent retries
        }
    }

    async markExecuted(actionId: number): Promise<void> {
        await db.execute('UPDATE timed_moderation SET executed = 1 WHERE id = ?', [actionId]);
    }

    async createTimedMute(guildId: string, userId: string, moderatorId: string, duration: number, reason: string): Promise<Date | null> {
        try {
            const expiresAt = new Date(Date.now() + duration * 1000);

            await db.execute(`
                INSERT INTO timed_moderation (guild_id, user_id, moderator_id, action_type, expires_at, reason)
                VALUES (?, ?, ?, 'mute', ?, ?)
            `, [guildId, userId, moderatorId, expiresAt, reason]);

            logger.info(`[TimedModerationManager] Created timed mute for ${userId} (${duration}s)`, { guildId, duration });
            return expiresAt;
        } catch (error: any) {
            logger.error(`[TimedModerationManager] Failed to create timed mute: ${error.message}`);
            return null;
        }
    }

    async createTimedBan(guildId: string, userId: string, moderatorId: string, duration: number, reason: string): Promise<Date | null> {
        try {
            const expiresAt = new Date(Date.now() + duration * 1000);

            await db.execute(`
                INSERT INTO timed_moderation (guild_id, user_id, moderator_id, action_type, expires_at, reason)
                VALUES (?, ?, ?, 'ban', ?, ?)
            `, [guildId, userId, moderatorId, expiresAt, reason]);

            logger.info(`[TimedModerationManager] Created timed ban for ${userId} (${duration}s)`, { guildId, duration });
            return expiresAt;
        } catch (error: any) {
            logger.error(`[TimedModerationManager] Failed to create timed ban: ${error.message}`);
            return null;
        }
    }

    async createTimedRole(guildId: string, userId: string, moderatorId: string, roleId: string, duration: number, isAddition: boolean, reason: string): Promise<Date | null> {
        try {
            const expiresAt = new Date(Date.now() + duration * 1000);
            const actionType = isAddition ? 'role_add' : 'role_remove';

            await db.execute(`
                INSERT INTO timed_moderation (guild_id, user_id, moderator_id, action_type, role_id, expires_at, reason)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [guildId, userId, moderatorId, actionType, roleId, expiresAt, reason]);

            logger.info(`[TimedModerationManager] Created timed ${actionType} for ${userId} (${duration}s)`, { guildId, roleId });
            return expiresAt;
        } catch (error: any) {
            logger.error(`[TimedModerationManager] Failed to create timed role: ${error.message}`);
            return null;
        }
    }

    async getActiveActions(guildId: string, userId: string | null = null): Promise<TimedModerationAction[]> {
        try {
            let query = 'SELECT * FROM timed_moderation WHERE guild_id = ? AND executed = 0 AND expires_at > NOW()';
            const params: any[] = [guildId];

            if (userId) {
                query += ' AND user_id = ?';
                params.push(userId);
            }

            const [actions] = await db.execute<TimedModerationAction[]>(query, params);
            return actions;
        } catch (error: any) {
            logger.error(`[TimedModerationManager] Failed to get active actions: ${error.message}`);
            return [];
        }
    }

    async cancelAction(actionId: number): Promise<boolean> {
        try {
            await db.execute('UPDATE timed_moderation SET executed = 1 WHERE id = ?', [actionId]);
            logger.info(`[TimedModerationManager] Cancelled action ${actionId}`);
            return true;
        } catch (error: any) {
            logger.error(`[TimedModerationManager] Failed to cancel action: ${error.message}`);
            return false;
        }
    }

    formatDuration(seconds: number): string {
        const units = [
            { name: 'd', value: 86400 },
            { name: 'h', value: 3600 },
            { name: 'm', value: 60 },
            { name: 's', value: 1 }
        ];

        const parts: string[] = [];
        let remaining = seconds;

        for (const unit of units) {
            if (remaining >= unit.value) {
                const count = Math.floor(remaining / unit.value);
                parts.push(`${count}${unit.name}`);
                remaining %= unit.value;
            }
        }

        return parts.join(' ') || '0s';
    }
}

export default TimedModerationManager;
