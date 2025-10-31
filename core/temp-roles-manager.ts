import db from '../utils/db';
import logger from '../utils/logger';
import { Client } from 'discord.js';
import { RowDataPacket } from 'mysql2';

interface TempRoleRecord extends RowDataPacket {
    id: number;
    guild_id: string;
    user_id: string;
    role_id: string;
    assigned_by: string;
    expires_at: Date;
    reason: string | null;
    auto_removed: boolean;
    removed_at: Date | null;
}

interface AssignmentResult {
    success: boolean;
    error?: string;
    expiresAt?: Date;
    message?: string;
}

class TempRolesManager {
    private client: Client;
    private checkInterval: NodeJS.Timeout | null;

    constructor(client: Client) {
        this.client = client;
        this.checkInterval = null;
    }

    async init(): Promise<void> {
        logger.info('[TempRoles] Initializing Temporary Roles Manager...');
        this.checkInterval = setInterval(() => this.checkExpiredRoles(), 30000);
        await this.checkExpiredRoles();
        logger.info('[TempRoles] Temporary Roles Manager initialized');
    }

    async assignTempRole(guildId: string, userId: string, roleId: string, duration: number, assignedBy: string, reason: string | null = null): Promise<AssignmentResult> {
        try {
            const guild = this.client.guilds.cache.get(guildId);
            if (!guild) return { success: false, error: 'Guild not found' };

            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member) return { success: false, error: 'Member not found' };

            const role = guild.roles.cache.get(roleId);
            if (!role) return { success: false, error: 'Role not found' };

            await member.roles.add(role);
            const expiresAt = new Date(Date.now() + duration);

            await db.execute(
                `INSERT INTO temp_roles (guild_id, user_id, role_id, assigned_by, expires_at, reason)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [guildId, userId, roleId, assignedBy, expiresAt, reason]
            );

            logger.info(`[TempRoles] Assigned temporary role ${roleId} to ${userId}, expires ${expiresAt}`);

            return {
                success: true,
                expiresAt,
                message: `Role <@&${roleId}> assigned until <t:${Math.floor(expiresAt.getTime() / 1000)}:F>`
            };
        } catch (error: any) {
            logger.error('[TempRoles] Error assigning temporary role:', error as Record<string, any>);
            return { success: false, error: error.message };
        }
    }

    async removeTempRole(guildId: string, userId: string, roleId: string): Promise<AssignmentResult> {
        try {
            const guild = this.client.guilds.cache.get(guildId);
            if (!guild) return { success: false, error: 'Guild not found' };

            const member = await guild.members.fetch(userId).catch(() => null);
            if (member) {
                const role = guild.roles.cache.get(roleId);
                if (role && member.roles.cache.has(roleId)) {
                    await member.roles.remove(role);
                }
            }

            await db.execute(
                `UPDATE temp_roles SET auto_removed = TRUE, removed_at = NOW()
                 WHERE guild_id = ? AND user_id = ? AND role_id = ? AND auto_removed = FALSE`,
                [guildId, userId, roleId]
            );

            logger.info(`[TempRoles] Removed temporary role ${roleId} from ${userId}`);
            return { success: true };
        } catch (error: any) {
            logger.error('[TempRoles] Error removing temporary role:', error as Record<string, any>);
            return { success: false, error: error.message };
        }
    }

    async checkExpiredRoles(): Promise<void> {
        try {
            const [expiredRoles] = await db.execute<TempRoleRecord[]>(
                `SELECT * FROM temp_roles WHERE expires_at <= NOW() AND auto_removed = FALSE`
            );

            if (expiredRoles.length === 0) return;

            logger.info(`[TempRoles] Found ${expiredRoles.length} expired temporary roles`);

            for (const tempRole of expiredRoles) {
                await this.removeTempRole(tempRole.guild_id, tempRole.user_id, tempRole.role_id);
            }
        } catch (error: any) {
            logger.error('[TempRoles] Error checking expired roles:', error as Record<string, any>);
        }
    }

    shutdown(): void {
        if (this.checkInterval) clearInterval(this.checkInterval);
        logger.info('[TempRoles] Temporary Roles Manager shut down');
    }
}

export default TempRolesManager;
