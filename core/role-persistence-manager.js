"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const logger_1 = __importDefault(require("../utils/logger"));
const db_1 = __importDefault(require("../utils/db"));
class RolePersistenceManager {
    constructor(client) {
        this.client = client;
        logger_1.default.info('[RolePersistenceManager] Role persistence manager initialized');
    }
    async handleMemberRemove(member) {
        try {
            const guildId = member.guild.id;
            const userId = member.id;
            // Get all roles (excluding @everyone)
            const roles = member.roles.cache
                .filter(role => role.id !== guildId)
                .map(role => role.id);
            if (roles.length === 0)
                return;
            // Save roles to database
            await db_1.default.execute(`
                INSERT INTO role_persistence (guild_id, user_id, role_ids)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE role_ids = VALUES(role_ids)
            `, [guildId, userId, JSON.stringify(roles)]);
            logger_1.default.info(`[RolePersistenceManager] Saved ${roles.length} roles for ${member.user.tag}`, {
                guildId,
                userId,
                roleCount: roles.length
            });
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[RolePersistenceManager] Failed to save roles: ${errorMessage}`, {
                guildId: member.guild.id,
                userId: member.id
            });
        }
    }
    async handleMemberAdd(member) {
        try {
            const guildId = member.guild.id;
            const userId = member.id;
            // Check if we have saved roles
            const [[data]] = await db_1.default.execute('SELECT role_ids FROM role_persistence WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
            if (!data || !data.role_ids)
                return;
            const roleIds = JSON.parse(data.role_ids);
            if (roleIds.length === 0)
                return;
            // Filter out roles that no longer exist or bot can't assign
            const validRoles = roleIds
                .map(id => member.guild.roles.cache.get(id))
                .filter((role) => role !== undefined && role.editable);
            if (validRoles.length === 0) {
                logger_1.default.warn(`[RolePersistenceManager] No valid roles to restore for ${member.user.tag}`, { guildId, userId });
                return;
            }
            // Restore roles
            await member.roles.add(validRoles, 'Role Persistence: Restored from previous membership');
            logger_1.default.info(`[RolePersistenceManager] Restored ${validRoles.length} roles for ${member.user.tag}`, {
                guildId,
                userId,
                roleCount: validRoles.length
            });
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[RolePersistenceManager] Failed to restore roles: ${errorMessage}`, {
                guildId: member.guild.id,
                userId: member.id
            });
        }
    }
    async handleRoleUpdate(oldMember, newMember) {
        try {
            // Only save if roles changed
            if (oldMember.roles.cache.size === newMember.roles.cache.size) {
                const oldRoles = new Set(oldMember.roles.cache.keys());
                const newRoles = new Set(newMember.roles.cache.keys());
                if ([...oldRoles].every(id => newRoles.has(id)))
                    return;
            }
            const guildId = newMember.guild.id;
            const userId = newMember.id;
            const roles = newMember.roles.cache
                .filter(role => role.id !== guildId)
                .map(role => role.id);
            await db_1.default.execute(`
                INSERT INTO role_persistence (guild_id, user_id, role_ids)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE role_ids = VALUES(role_ids)
            `, [guildId, userId, JSON.stringify(roles)]);
            logger_1.default.debug(`[RolePersistenceManager] Updated roles for ${newMember.user.tag}`, {
                guildId,
                userId,
                roleCount: roles.length
            });
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[RolePersistenceManager] Failed to update roles: ${errorMessage}`);
        }
    }
    async getSavedRoles(guildId, userId) {
        try {
            const [[data]] = await db_1.default.execute('SELECT role_ids, last_updated FROM role_persistence WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
            if (!data)
                return null;
            return {
                roleIds: JSON.parse(data.role_ids),
                lastUpdated: data.last_updated
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[RolePersistenceManager] Failed to get saved roles: ${errorMessage}`);
            return null;
        }
    }
    async clearSavedRoles(guildId, userId) {
        try {
            await db_1.default.execute('DELETE FROM role_persistence WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
            logger_1.default.info(`[RolePersistenceManager] Cleared saved roles for user ${userId}`, { guildId, userId });
            return true;
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[RolePersistenceManager] Failed to clear saved roles: ${errorMessage}`);
            return false;
        }
    }
    async getPersistenceStats(guildId) {
        try {
            const [[stats]] = await db_1.default.execute(`
                SELECT
                    COUNT(*) as total_users,
                    AVG(JSON_LENGTH(role_ids)) as avg_roles
                FROM role_persistence
                WHERE guild_id = ?
            `, [guildId]);
            return stats || { total_users: 0, avg_roles: 0 };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[RolePersistenceManager] Failed to get stats: ${errorMessage}`);
            return { total_users: 0, avg_roles: 0 };
        }
    }
}
exports.default = RolePersistenceManager;
