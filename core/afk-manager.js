"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const logger_1 = __importDefault(require("../utils/logger"));
const db_1 = __importDefault(require("../utils/db"));
class AFKManager {
    constructor(client) {
        this.client = client;
        this.afkCache = new Map();
        this.loadAFKStatuses();
        logger_1.default.info('[AFKManager] AFK manager initialized');
    }
    async loadAFKStatuses() {
        try {
            const [statuses] = await db_1.default.execute('SELECT * FROM afk_status');
            for (const status of statuses) {
                this.afkCache.set(status.user_id, { guildId: status.guild_id, reason: status.reason, setAt: status.set_at });
            }
            logger_1.default.info(`[AFKManager] Loaded ${statuses.length} AFK statuses`);
        }
        catch (error) {
            logger_1.default.error(`[AFKManager] Failed to load AFK statuses: ${error.message}`);
        }
    }
    async setAFK(userId, guildId, reason = 'AFK') {
        try {
            await db_1.default.execute('INSERT INTO afk_status (user_id, guild_id, reason) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE reason = VALUES(reason), set_at = NOW()', [userId, guildId, reason]);
            this.afkCache.set(userId, { guildId, reason, setAt: new Date() });
            logger_1.default.info(`[AFKManager] User ${userId} set AFK`, { guildId, userId });
            return true;
        }
        catch (error) {
            logger_1.default.error(`[AFKManager] Failed to set AFK: ${error.message}`, { userId });
            return false;
        }
    }
    async removeAFK(userId, guildId) {
        try {
            await db_1.default.execute('DELETE FROM afk_status WHERE user_id = ?', [userId]);
            this.afkCache.delete(userId);
            logger_1.default.info(`[AFKManager] User ${userId} is no longer AFK`, { guildId, userId });
            return true;
        }
        catch (error) {
            logger_1.default.error(`[AFKManager] Failed to remove AFK: ${error.message}`, { userId });
            return false;
        }
    }
    isAFK(userId) {
        return this.afkCache.has(userId);
    }
    getAFK(userId) {
        return this.afkCache.get(userId) || null;
    }
    async handleMessage(message) {
        try {
            if (!message.guild || message.author.bot)
                return;
            const userId = message.author.id;
            const guildId = message.guild.id;
            if (this.isAFK(userId)) {
                const afk = this.getAFK(userId);
                if (afk && afk.guildId === guildId) {
                    await this.removeAFK(userId, guildId);
                    await message.reply('Welcome back!').then(m => setTimeout(() => m.delete().catch(() => { }), 5000));
                }
            }
            if (message.mentions.users.size > 0) {
                const afkMentions = [];
                for (const [mentionedId, user] of message.mentions.users) {
                    if (this.isAFK(mentionedId)) {
                        const afk = this.getAFK(mentionedId);
                        if (afk) {
                            afkMentions.push(`**${user.tag}** is currently AFK: *${afk.reason}*`);
                        }
                    }
                }
                if (afkMentions.length > 0) {
                    await message.reply({ content: afkMentions.join('\n'), allowedMentions: { repliedUser: false } });
                }
            }
        }
        catch (error) {
            logger_1.default.error(`[AFKManager] Message handling error: ${error.message}`);
        }
    }
}
exports.default = AFKManager;
