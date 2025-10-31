import type { Client, Message } from 'discord.js';
import type { RowDataPacket } from 'mysql2';
import logger from '../utils/logger';
import db from '../utils/db';

interface AFKStatus extends RowDataPacket {
    user_id: string;
    guild_id: string;
    reason: string;
    set_at: Date;
}

interface AFKData {
    guildId: string;
    reason: string;
    setAt: Date;
}

class AFKManager {
    private _client: Client;
    private afkCache: Map<string, AFKData>;

    constructor(client: Client) {
        this._client = client;
        this.afkCache = new Map();
        this.loadAFKStatuses();
        logger.info('[AFKManager] AFK manager initialized');
    }

    async loadAFKStatuses(): Promise<void> {
        try {
            const [statuses] = await db.execute<AFKStatus[]>('SELECT * FROM afk_status');
            for (const status of statuses) {
                this.afkCache.set(status.user_id, { guildId: status.guild_id, reason: status.reason, setAt: status.set_at });
            }
            logger.info(`[AFKManager] Loaded ${statuses.length} AFK statuses`);
        } catch (error: any) {
            logger.error(`[AFKManager] Failed to load AFK statuses: ${error.message}`);
        }
    }

    async setAFK(userId: string, guildId: string, reason: string = 'AFK'): Promise<boolean> {
        try {
            await db.execute('INSERT INTO afk_status (user_id, guild_id, reason) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE reason = VALUES(reason), set_at = NOW()', [userId, guildId, reason]);
            this.afkCache.set(userId, { guildId, reason, setAt: new Date() });
            logger.info(`[AFKManager] User ${userId} set AFK`, { guildId, userId });
            return true;
        } catch (error: any) {
            logger.error(`[AFKManager] Failed to set AFK: ${error.message}`, { userId });
            return false;
        }
    }

    async removeAFK(userId: string, guildId: string): Promise<boolean> {
        try {
            await db.execute('DELETE FROM afk_status WHERE user_id = ?', [userId]);
            this.afkCache.delete(userId);
            logger.info(`[AFKManager] User ${userId} is no longer AFK`, { guildId, userId });
            return true;
        } catch (error: any) {
            logger.error(`[AFKManager] Failed to remove AFK: ${error.message}`, { userId });
            return false;
        }
    }

    isAFK(userId: string): boolean {
        return this.afkCache.has(userId);
    }

    getAFK(userId: string): AFKData | null {
        return this.afkCache.get(userId) || null;
    }

    async handleMessage(message: Message): Promise<void> {
        try {
            if (!message.guild || message.author.bot) return;
            const userId = message.author.id;
            const guildId = message.guild.id;

            if (this.isAFK(userId)) {
                const afk = this.getAFK(userId);
                if (afk && afk.guildId === guildId) {
                    await this.removeAFK(userId, guildId);
                    await message.reply('Welcome back!').then(m => setTimeout(() => m.delete().catch(() => {}), 5000));
                }
            }

            if (message.mentions.users.size > 0) {
                const afkMentions: string[] = [];
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
        } catch (error: any) {
            logger.error(`[AFKManager] Message handling error: ${error.message}`);
        }
    }
}

export default AFKManager;
