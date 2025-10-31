import type { Client, Message, TextBasedChannel } from 'discord.js';
import type { RowDataPacket } from 'mysql2';
import logger from '../utils/logger';
import db from '../utils/db';

interface AutomodPattern extends RowDataPacket {
    id: number;
    guild_id: string;
    pattern_type: 'regex' | 'contains' | 'exact' | 'domain';
    pattern: string;
    action: 'warn' | 'mute' | 'kick' | 'ban';
    reason: string;
    enabled: number;
}

interface SpamConfig extends RowDataPacket {
    guild_id: string;
    time_window: number;
    max_messages: number;
    max_mentions: number;
    max_emojis: number;
    max_repeated_chars: number;
    action: 'warn' | 'mute' | 'kick';
    enabled: number;
}

interface SpamTracking {
    messages: Array<{ timestamp: number; content: string }>;
    lastCleanup: number;
}

class AdvancedAutomodManager {
    private patterns: Map<string, AutomodPattern[]>;
    private spamTracking: Map<string, SpamTracking>;

    constructor(_client: Client) {
        this.patterns = new Map();
        this.spamTracking = new Map();
        this.loadPatterns();
        logger.info('[AdvancedAutomodManager] Advanced automod manager initialized');
    }

    async loadPatterns(): Promise<void> {
        try {
            const [patterns] = await db.execute<AutomodPattern[]>('SELECT * FROM automod_patterns WHERE enabled = 1');
            patterns.forEach(pattern => {
                if (!this.patterns.has(pattern.guild_id)) this.patterns.set(pattern.guild_id, []);
                this.patterns.get(pattern.guild_id)!.push(pattern);
            });
            logger.info(`[AdvancedAutomodManager] Loaded ${patterns.length} automod patterns`);
        } catch (error: any) {
            logger.error(`[AdvancedAutomodManager] Failed to load patterns: ${error.message}`);
        }
    }

    async checkMessage(message: Message): Promise<boolean> {
        if (!message.guild || message.author.bot) return false;

        const guildId = message.guild.id;
        const content = message.content;

        // Check spam
        await this.checkSpam(message);

        // Check patterns
        const patterns = this.patterns.get(guildId) || [];
        for (const pattern of patterns) {
            if (await this.matchesPattern(content, pattern)) {
                await this.executeAction(message, pattern);
                return true;
            }
        }

        return false;
    }

    async matchesPattern(content: string, pattern: AutomodPattern): Promise<boolean> {
        try {
            if (pattern.pattern_type === 'regex') {
                const regex = new RegExp(pattern.pattern, 'i');
                return regex.test(content);
            } else if (pattern.pattern_type === 'contains') {
                return content.toLowerCase().includes(pattern.pattern.toLowerCase());
            } else if (pattern.pattern_type === 'exact') {
                return content.toLowerCase() === pattern.pattern.toLowerCase();
            } else if (pattern.pattern_type === 'domain') {
                const urlRegex = /https?:\/\/[^\s]+/gi;
                const urls = content.match(urlRegex) || [];
                return urls.some(url => url.includes(pattern.pattern));
            }
        } catch (error: any) {
            logger.error(`[AdvancedAutomodManager] Pattern match error: ${error.message}`, { patternId: pattern.id });
        }
        return false;
    }

    async checkSpam(message: Message): Promise<boolean> {
        try {
            if (!message.guild) return false;

            const [[config]] = await db.execute<SpamConfig[]>('SELECT * FROM automod_spam_config WHERE guild_id = ? AND enabled = 1', [message.guild.id]);
            if (!config) return false;

            const userId = message.author.id;
            const guildId = message.guild.id;
            const key = `${guildId}_${userId}`;

            // Initialize tracking
            if (!this.spamTracking.has(key)) {
                this.spamTracking.set(key, { messages: [], lastCleanup: Date.now() });
            }

            const tracking = this.spamTracking.get(key)!;
            const now = Date.now();

            // Cleanup old messages
            tracking.messages = tracking.messages.filter(m => now - m.timestamp < config.time_window * 1000);

            // Add current message
            tracking.messages.push({ timestamp: now, content: message.content });

            // Check message spam
            if (tracking.messages.length > config.max_messages) {
                await this.executeSpamAction(message, config, 'message_spam');
                this.spamTracking.delete(key);
                return true;
            }

            // Check repeated messages
            const recentContent = tracking.messages.map(m => m.content);
            const duplicates = recentContent.filter(c => c === message.content).length;
            if (duplicates > 3) {
                await this.executeSpamAction(message, config, 'repeated_spam');
                this.spamTracking.delete(key);
                return true;
            }

            // Check mention spam
            const mentions = (message.content.match(/<@!?\d+>/g) || []).length;
            if (mentions > config.max_mentions) {
                await this.executeSpamAction(message, config, 'mention_spam');
                return true;
            }

            // Check emoji spam
            const emojis = (message.content.match(/<a?:\w+:\d+>/g) || []).length + (message.content.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
            if (emojis > config.max_emojis) {
                await this.executeSpamAction(message, config, 'emoji_spam');
                return true;
            }

            // Check character spam
            const charCounts: Record<string, number> = {};
            for (const char of message.content) {
                charCounts[char] = (charCounts[char] || 0) + 1;
                if (charCounts[char] > config.max_repeated_chars) {
                    await this.executeSpamAction(message, config, 'character_spam');
                    return true;
                }
            }

            return false;
        } catch (error: any) {
            logger.error(`[AdvancedAutomodManager] Spam check error: ${error.message}`, { guildId: message.guild?.id, userId: message.author.id });
            return false;
        }
    }

    async executeAction(message: Message, pattern: AutomodPattern): Promise<void> {
        try {
            await message.delete().catch(() => {});

            const reason = pattern.reason || 'Automod pattern match';

            if (pattern.action === 'warn') {
                const channel = message.channel as TextBasedChannel & { send: (content: string) => Promise<Message> };
                await channel.send(`${message.author}, warned for: ${reason}`).then(m => setTimeout(() => m.delete(), 5000));
            } else if (pattern.action === 'mute') {
                const muteDuration = 10 * 60 * 1000;
                await message.member!.timeout(muteDuration, reason);
                const channel = message.channel as TextBasedChannel & { send: (content: string) => Promise<Message> };
                await channel.send(`${message.author} has been muted for 10 minutes: ${reason}`).then(m => setTimeout(() => m.delete(), 5000));
            } else if (pattern.action === 'kick') {
                await message.member!.kick(reason);
            } else if (pattern.action === 'ban') {
                await message.member!.ban({ reason, deleteMessageSeconds: 86400 });
            }

            logger.info(`[AdvancedAutomodManager] Executed ${pattern.action} on ${message.author.tag}`, { guildId: message.guild?.id, userId: message.author.id, reason });
        } catch (error: any) {
            logger.error(`[AdvancedAutomodManager] Action execution error: ${error.message}`, { action: pattern.action, guildId: message.guild?.id });
        }
    }

    async executeSpamAction(message: Message, config: SpamConfig, spamType: string): Promise<void> {
        try {
            await message.delete().catch(() => {});

            const reason = `Spam detected: ${spamType}`;

            if (config.action === 'warn') {
                const channel = message.channel as TextBasedChannel & { send: (content: string) => Promise<Message> };
                await channel.send(`${message.author}, stop spamming!`).then((m: Message) => setTimeout(() => m.delete(), 5000));
            } else if (config.action === 'mute') {
                await message.member!.timeout(10 * 60 * 1000, reason);
                const channel = message.channel as TextBasedChannel & { send: (content: string) => Promise<Message> };
                await channel.send(`${message.author} has been muted for spamming.`).then((m: Message) => setTimeout(() => m.delete(), 5000));
            } else if (config.action === 'kick') {
                await message.member!.kick(reason);
            }

            logger.info(`[AdvancedAutomodManager] Spam action ${config.action} on ${message.author.tag}`, { guildId: message.guild?.id, userId: message.author.id, spamType });
        } catch (error: any) {
            logger.error(`[AdvancedAutomodManager] Spam action error: ${error.message}`, { guildId: message.guild?.id });
        }
    }

    async addPattern(guildId: string, patternType: string, pattern: string, action: string, reason: string): Promise<boolean> {
        try {
            await db.execute('INSERT INTO automod_patterns (guild_id, pattern_type, pattern, action, reason) VALUES (?, ?, ?, ?, ?)',
                [guildId, patternType, pattern, action, reason]);
            await this.loadPatterns();
            logger.info(`[AdvancedAutomodManager] Added pattern for guild ${guildId}`, { guildId, patternType });
            return true;
        } catch (error: any) {
            logger.error(`[AdvancedAutomodManager] Failed to add pattern: ${error.message}`, { guildId });
            return false;
        }
    }

    async removePattern(patternId: number): Promise<boolean> {
        try {
            await db.execute('DELETE FROM automod_patterns WHERE id = ?', [patternId]);
            await this.loadPatterns();
            logger.info(`[AdvancedAutomodManager] Removed pattern ${patternId}`);
            return true;
        } catch (error: any) {
            logger.error(`[AdvancedAutomodManager] Failed to remove pattern: ${error.message}`);
            return false;
        }
    }
}

export default AdvancedAutomodManager;
