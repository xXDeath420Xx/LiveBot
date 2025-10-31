"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
class TempRolesManager {
    constructor(client) {
        this.client = client;
        this.checkInterval = null;
    }
    async init() {
        logger_1.default.info('[TempRoles] Initializing Temporary Roles Manager...');
        this.checkInterval = setInterval(() => this.checkExpiredRoles(), 30000);
        await this.checkExpiredRoles();
        logger_1.default.info('[TempRoles] Temporary Roles Manager initialized');
    }
    async assignTempRole(guildId, userId, roleId, duration, assignedBy, reason = null) {
        try {
            const guild = this.client.guilds.cache.get(guildId);
            if (!guild)
                return { success: false, error: 'Guild not found' };
            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member)
                return { success: false, error: 'Member not found' };
            const role = guild.roles.cache.get(roleId);
            if (!role)
                return { success: false, error: 'Role not found' };
            await member.roles.add(role);
            const expiresAt = new Date(Date.now() + duration);
            await db_1.default.execute(`INSERT INTO temp_roles (guild_id, user_id, role_id, assigned_by, expires_at, reason)
                 VALUES (?, ?, ?, ?, ?, ?)`, [guildId, userId, roleId, assignedBy, expiresAt, reason]);
            logger_1.default.info(`[TempRoles] Assigned temporary role ${roleId} to ${userId}, expires ${expiresAt}`);
            return {
                success: true,
                expiresAt,
                message: `Role <@&${roleId}> assigned until <t:${Math.floor(expiresAt.getTime() / 1000)}:F>`
            };
        }
        catch (error) {
            logger_1.default.error('[TempRoles] Error assigning temporary role:', error);
            return { success: false, error: error.message };
        }
    }
    async removeTempRole(guildId, userId, roleId) {
        try {
            const guild = this.client.guilds.cache.get(guildId);
            if (!guild)
                return { success: false, error: 'Guild not found' };
            const member = await guild.members.fetch(userId).catch(() => null);
            if (member) {
                const role = guild.roles.cache.get(roleId);
                if (role && member.roles.cache.has(roleId)) {
                    await member.roles.remove(role);
                }
            }
            await db_1.default.execute(`UPDATE temp_roles SET auto_removed = TRUE, removed_at = NOW()
                 WHERE guild_id = ? AND user_id = ? AND role_id = ? AND auto_removed = FALSE`, [guildId, userId, roleId]);
            logger_1.default.info(`[TempRoles] Removed temporary role ${roleId} from ${userId}`);
            return { success: true };
        }
        catch (error) {
            logger_1.default.error('[TempRoles] Error removing temporary role:', error);
            return { success: false, error: error.message };
        }
    }
    async checkExpiredRoles() {
        try {
            const [expiredRoles] = await db_1.default.execute(`SELECT * FROM temp_roles WHERE expires_at <= NOW() AND auto_removed = FALSE`);
            if (expiredRoles.length === 0)
                return;
            logger_1.default.info(`[TempRoles] Found ${expiredRoles.length} expired temporary roles`);
            for (const tempRole of expiredRoles) {
                await this.removeTempRole(tempRole.guild_id, tempRole.user_id, tempRole.role_id);
            }
        }
        catch (error) {
            logger_1.default.error('[TempRoles] Error checking expired roles:', error);
        }
    }
    shutdown() {
        if (this.checkInterval)
            clearInterval(this.checkInterval);
        logger_1.default.info('[TempRoles] Temporary Roles Manager shut down');
    }
}
exports.default = TempRolesManager;
