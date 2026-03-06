import logger from '../utils/logger.js';
import pool from '../utils/db.js';

class AFKManager {
    constructor(client) {
        this.client = client;
        this.afkCache = new Map();
        this.MAX_AFK_CACHE = 10000; // Prevent unbounded growth
        this.loadAFKStatuses();
        logger.info('[AFKManager] AFK manager initialized');
    }

    async loadAFKStatuses() {
        try {
            const [statuses] = await pool.execute('SELECT * FROM afk_statuses');
            for (const status of statuses) {
                this.afkCache.set(status.user_id, {
                    guildId: status.guild_id,
                    message: status.message,
                    timestamp: status.timestamp
                });
            }
            logger.info(`[AFKManager] Loaded ${statuses.length} AFK statuses`);
        } catch (error) {
            logger.error(`[AFKManager] Failed to load AFK statuses: ${error.message}`);
        }
    }

    async setAFK(userId, guildId, message = 'AFK') {
        try {
            await pool.execute(
                'INSERT INTO afk_statuses (user_id, guild_id, message, timestamp) VALUES (?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE message = VALUES(message), timestamp = NOW()',
                [userId, guildId, message]
            );
            // Enforce max size
            if (this.afkCache.size >= this.MAX_AFK_CACHE && !this.afkCache.has(userId)) {
                const oldestKey = this.afkCache.keys().next().value;
                this.afkCache.delete(oldestKey);
            }
            this.afkCache.set(userId, { guildId, message, timestamp: new Date() });
            logger.info(`[AFKManager] User ${userId} set AFK in guild ${guildId}`);
            return true;
        } catch (error) {
            logger.error(`[AFKManager] Failed to set AFK for user ${userId}: ${error.message}`);
            return false;
        }
    }

    async removeAFK(userId, guildId) {
        try {
            await pool.execute('DELETE FROM afk_statuses WHERE user_id = ? AND guild_id = ?', [userId, guildId]);
            this.afkCache.delete(userId);
            logger.info(`[AFKManager] User ${userId} is no longer AFK in guild ${guildId}`);
            return true;
        } catch (error) {
            logger.error(`[AFKManager] Failed to remove AFK for user ${userId}: ${error.message}`);
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
            if (!message.guild || message.author.bot) return;

            const userId = message.author.id;
            const guildId = message.guild.id;

            // Check if the message author is AFK
            if (this.isAFK(userId)) {
                const afk = this.getAFK(userId);
                if (afk && afk.guildId === guildId) {
                    await this.removeAFK(userId, guildId);
                    const reply = await message.reply('Welcome back! Your AFK status has been removed.');
                    setTimeout(() => reply.delete().catch(() => {}), 5000);
                }
            }

            // Check if any mentioned users are AFK
            if (message.mentions.users.size > 0) {
                const afkMentions = [];
                for (const [mentionedId, user] of message.mentions.users) {
                    if (this.isAFK(mentionedId)) {
                        const afk = this.getAFK(mentionedId);
                        if (afk && afk.guildId === guildId) {
                            const timeAgo = Math.floor((Date.now() - afk.timestamp.getTime()) / 1000);
                            afkMentions.push(`**${user.tag}** is currently AFK: *${afk.message}* (<t:${Math.floor(afk.timestamp.getTime() / 1000)}:R>)`);
                        }
                    }
                }
                if (afkMentions.length > 0) {
                    await message.reply({
                        content: afkMentions.join('\n'),
                        allowedMentions: { repliedUser: false }
                    });
                }
            }
        } catch (error) {
            logger.error(`[AFKManager] Message handling error: ${error.message}`);
        }
    }
}

export default AFKManager;
