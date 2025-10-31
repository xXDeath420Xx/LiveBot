import { Client, GuildMember, Role } from 'discord.js';
import { RowDataPacket } from 'mysql2';
import logger from '../utils/logger';
import db from '../utils/db';

interface RolePersistenceData extends RowDataPacket {
    role_ids: string;
    last_updated: Date;
}

interface PersistenceStats extends RowDataPacket {
    total_users: number;
    avg_roles: number;
}

class RolePersistenceManager {
    private client: Client;

    constructor(client: Client) {
        this.client = client;
        logger.info('[RolePersistenceManager] Role persistence manager initialized');
    }

    async handleMemberRemove(member: GuildMember): Promise<void> {
        try {
            const guildId = member.guild.id;
            const userId = member.id;

            // Get all roles (excluding @everyone)
            const roles = member.roles.cache
                .filter(role => role.id !== guildId)
                .map(role => role.id);

            if (roles.length === 0) return;

            // Save roles to database
            await db.execute(`
                INSERT INTO role_persistence (guild_id, user_id, role_ids)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE role_ids = VALUES(role_ids)
            `, [guildId, userId, JSON.stringify(roles)]);

            logger.info(`[RolePersistenceManager] Saved ${roles.length} roles for ${member.user.tag}`, {
                guildId,
                userId,
                roleCount: roles.length
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(_error);
            logger.error(`[RolePersistenceManager] Failed to save roles: ${errorMessage}`, {
                guildId: member.guild.id,
                userId: member.id
            });
        }
    }

    async handleMemberAdd(member: GuildMember): Promise<void> {
        try {
            const guildId = member.guild.id;
            const userId = member.id;

            // Check if we have saved roles
            const [[data]] = await db.execute<RolePersistenceData[]>(
                'SELECT role_ids FROM role_persistence WHERE guild_id = ? AND user_id = ?',
                [guildId, userId]
            );

            if (!data || !data.role_ids) return;

            const roleIds: string[] = JSON.parse(data.role_ids);
            if (roleIds.length === 0) return;

            // Filter out roles that no longer exist or bot can't assign
            const validRoles: Role[] = roleIds
                .map(id => member.guild.roles.cache.get(id))
                .filter((role): role is Role => role !== undefined && role.editable);

            if (validRoles.length === 0) {
                logger.warn(`[RolePersistenceManager] No valid roles to restore for ${member.user.tag}`, { guildId, userId });
                return;
            }

            // Restore roles
            await member.roles.add(validRoles, 'Role Persistence: Restored from previous membership');

            logger.info(`[RolePersistenceManager] Restored ${validRoles.length} roles for ${member.user.tag}`, {
                guildId,
                userId,
                roleCount: validRoles.length
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(_error);
            logger.error(`[RolePersistenceManager] Failed to restore roles: ${errorMessage}`, {
                guildId: member.guild.id,
                userId: member.id
            });
        }
    }

    async handleRoleUpdate(oldMember: GuildMember, newMember: GuildMember): Promise<void> {
        try {
            // Only save if roles changed
            if (oldMember.roles.cache.size === newMember.roles.cache.size) {
                const oldRoles = new Set(oldMember.roles.cache.keys());
                const newRoles = new Set(newMember.roles.cache.keys());
                if ([...oldRoles].every(id => newRoles.has(id))) return;
            }

            const guildId = newMember.guild.id;
            const userId = newMember.id;

            const roles = newMember.roles.cache
                .filter(role => role.id !== guildId)
                .map(role => role.id);

            await db.execute(`
                INSERT INTO role_persistence (guild_id, user_id, role_ids)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE role_ids = VALUES(role_ids)
            `, [guildId, userId, JSON.stringify(roles)]);

            logger.debug(`[RolePersistenceManager] Updated roles for ${newMember.user.tag}`, {
                guildId,
                userId,
                roleCount: roles.length
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(_error);
            logger.error(`[RolePersistenceManager] Failed to update roles: ${errorMessage}`);
        }
    }

    async getSavedRoles(guildId: string, userId: string): Promise<{ roleIds: string[]; lastUpdated: Date } | null> {
        try {
            const [[data]] = await db.execute<RolePersistenceData[]>(
                'SELECT role_ids, last_updated FROM role_persistence WHERE guild_id = ? AND user_id = ?',
                [guildId, userId]
            );

            if (!data) return null;

            return {
                roleIds: JSON.parse(data.role_ids),
                lastUpdated: data.last_updated
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(_error);
            logger.error(`[RolePersistenceManager] Failed to get saved roles: ${errorMessage}`);
            return null;
        }
    }

    async clearSavedRoles(guildId: string, userId: string): Promise<boolean> {
        try {
            await db.execute(
                'DELETE FROM role_persistence WHERE guild_id = ? AND user_id = ?',
                [guildId, userId]
            );
            logger.info(`[RolePersistenceManager] Cleared saved roles for user ${userId}`, { guildId, userId });
            return true;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(_error);
            logger.error(`[RolePersistenceManager] Failed to clear saved roles: ${errorMessage}`);
            return false;
        }
    }

    async getPersistenceStats(guildId: string): Promise<{ total_users: number; avg_roles: number }> {
        try {
            const [[stats]] = await db.execute<PersistenceStats[]>(`
                SELECT
                    COUNT(*) as total_users,
                    AVG(JSON_LENGTH(role_ids)) as avg_roles
                FROM role_persistence
                WHERE guild_id = ?
            `, [guildId]);

            return stats || { total_users: 0, avg_roles: 0 };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(_error);
            logger.error(`[RolePersistenceManager] Failed to get stats: ${errorMessage}`);
            return { total_users: 0, avg_roles: 0 };
        }
    }
}

export default RolePersistenceManager;
