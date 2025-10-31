"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const logger_1 = __importDefault(require("../utils/logger"));
const db_1 = __importDefault(require("../utils/db"));
class TimedModerationManager {
    constructor(client) {
        this.client = client;
        this.checkInterval = null;
        logger_1.default.info('[TimedModerationManager] Timed moderation manager initialized');
    }
    startScheduler() {
        // Check every 30 seconds for expired mod actions
        this.checkInterval = setInterval(() => {
            this.checkExpiredActions();
        }, 30 * 1000);
        logger_1.default.info('[TimedModerationManager] Scheduler started (30s interval)');
    }
    stopScheduler() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            logger_1.default.info('[TimedModerationManager] Scheduler stopped');
        }
    }
    async checkExpiredActions() {
        try {
            const [actions] = await db_1.default.execute('SELECT * FROM timed_moderation WHERE executed = 0 AND expires_at <= NOW()');
            if (actions.length === 0)
                return;
            logger_1.default.info(`[TimedModerationManager] Found ${actions.length} expired moderation actions`);
            for (const action of actions) {
                await this.executeTimedAction(action);
            }
        }
        catch (error) {
            logger_1.default.error(`[TimedModerationManager] Error checking expired actions: ${error.message}`);
        }
    }
    async executeTimedAction(action) {
        try {
            const guild = this.client.guilds.cache.get(action.guild_id);
            if (!guild) {
                logger_1.default.warn(`[TimedModerationManager] Guild ${action.guild_id} not found`);
                await this.markExecuted(action.id);
                return;
            }
            const member = await guild.members.fetch(action.user_id).catch(() => null);
            switch (action.action_type) {
                case 'mute':
                    if (member) {
                        await member.timeout(null, `Timed mute expired - Originally by ${action.moderator_id}`);
                        logger_1.default.info(`[TimedModerationManager] Unmuted ${action.user_id}`, { guildId: guild.id });
                    }
                    break;
                case 'ban':
                    await guild.bans.remove(action.user_id, `Timed ban expired - Originally by ${action.moderator_id}`);
                    logger_1.default.info(`[TimedModerationManager] Unbanned ${action.user_id}`, { guildId: guild.id });
                    break;
                case 'role_add':
                    if (member && action.role_id) {
                        const role = guild.roles.cache.get(action.role_id);
                        if (role) {
                            await member.roles.remove(role, `Timed role addition expired`);
                            logger_1.default.info(`[TimedModerationManager] Removed role ${role.name} from ${action.user_id}`, { guildId: guild.id });
                        }
                    }
                    break;
                case 'role_remove':
                    if (member && action.role_id) {
                        const role = guild.roles.cache.get(action.role_id);
                        if (role) {
                            await member.roles.add(role, `Timed role removal expired`);
                            logger_1.default.info(`[TimedModerationManager] Restored role ${role.name} to ${action.user_id}`, { guildId: guild.id });
                        }
                    }
                    break;
            }
            await this.markExecuted(action.id);
        }
        catch (error) {
            logger_1.default.error(`[TimedModerationManager] Failed to execute action ${action.id}: ${error.message}`);
            await this.markExecuted(action.id); // Mark as executed even if failed to prevent retries
        }
    }
    async markExecuted(actionId) {
        await db_1.default.execute('UPDATE timed_moderation SET executed = 1 WHERE id = ?', [actionId]);
    }
    async createTimedMute(guildId, userId, moderatorId, duration, reason) {
        try {
            const expiresAt = new Date(Date.now() + duration * 1000);
            await db_1.default.execute(`
                INSERT INTO timed_moderation (guild_id, user_id, moderator_id, action_type, expires_at, reason)
                VALUES (?, ?, ?, 'mute', ?, ?)
            `, [guildId, userId, moderatorId, expiresAt, reason]);
            logger_1.default.info(`[TimedModerationManager] Created timed mute for ${userId} (${duration}s)`, { guildId, duration });
            return expiresAt;
        }
        catch (error) {
            logger_1.default.error(`[TimedModerationManager] Failed to create timed mute: ${error.message}`);
            return null;
        }
    }
    async createTimedBan(guildId, userId, moderatorId, duration, reason) {
        try {
            const expiresAt = new Date(Date.now() + duration * 1000);
            await db_1.default.execute(`
                INSERT INTO timed_moderation (guild_id, user_id, moderator_id, action_type, expires_at, reason)
                VALUES (?, ?, ?, 'ban', ?, ?)
            `, [guildId, userId, moderatorId, expiresAt, reason]);
            logger_1.default.info(`[TimedModerationManager] Created timed ban for ${userId} (${duration}s)`, { guildId, duration });
            return expiresAt;
        }
        catch (error) {
            logger_1.default.error(`[TimedModerationManager] Failed to create timed ban: ${error.message}`);
            return null;
        }
    }
    async createTimedRole(guildId, userId, moderatorId, roleId, duration, isAddition, reason) {
        try {
            const expiresAt = new Date(Date.now() + duration * 1000);
            const actionType = isAddition ? 'role_add' : 'role_remove';
            await db_1.default.execute(`
                INSERT INTO timed_moderation (guild_id, user_id, moderator_id, action_type, role_id, expires_at, reason)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [guildId, userId, moderatorId, actionType, roleId, expiresAt, reason]);
            logger_1.default.info(`[TimedModerationManager] Created timed ${actionType} for ${userId} (${duration}s)`, { guildId, roleId });
            return expiresAt;
        }
        catch (error) {
            logger_1.default.error(`[TimedModerationManager] Failed to create timed role: ${error.message}`);
            return null;
        }
    }
    async getActiveActions(guildId, userId = null) {
        try {
            let query = 'SELECT * FROM timed_moderation WHERE guild_id = ? AND executed = 0 AND expires_at > NOW()';
            const params = [guildId];
            if (userId) {
                query += ' AND user_id = ?';
                params.push(userId);
            }
            const [actions] = await db_1.default.execute(query, params);
            return actions;
        }
        catch (error) {
            logger_1.default.error(`[TimedModerationManager] Failed to get active actions: ${error.message}`);
            return [];
        }
    }
    async cancelAction(actionId) {
        try {
            await db_1.default.execute('UPDATE timed_moderation SET executed = 1 WHERE id = ?', [actionId]);
            logger_1.default.info(`[TimedModerationManager] Cancelled action ${actionId}`);
            return true;
        }
        catch (error) {
            logger_1.default.error(`[TimedModerationManager] Failed to cancel action: ${error.message}`);
            return false;
        }
    }
    formatDuration(seconds) {
        const units = [
            { name: 'd', value: 86400 },
            { name: 'h', value: 3600 },
            { name: 'm', value: 60 },
            { name: 's', value: 1 }
        ];
        const parts = [];
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
exports.default = TimedModerationManager;
