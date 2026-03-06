import { PermissionFlagsBits } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import configCache from '../utils/configCache.js';

class AdvancedAutomodManager {
    constructor(client) {
        this.patterns = new Map();
        this.spamTracking = new Map();
        this.MAX_SPAM_TRACKING = 5000; // Prevent unbounded growth
        this.loadPatterns();
        logger.info('[AdvancedAutomodManager] Advanced automod manager initialized');
    }

    async loadPatterns() {
        try {
            const [patterns] = await pool.execute('SELECT * FROM automod_patterns WHERE enabled = 1');
            patterns.forEach(pattern => {
                if (!this.patterns.has(pattern.guild_id)) this.patterns.set(pattern.guild_id, []);
                this.patterns.get(pattern.guild_id).push(pattern);
            });
            logger.info(`[AdvancedAutomodManager] Loaded ${patterns.length} automod patterns`);
        } catch (error) {
            logger.error(`[AdvancedAutomodManager] Failed to load patterns: ${error.message}`);
        }
    }

    async checkMessage(message) {
        if (!message.guild || message.author.bot) return false;

        // Skip automod for users with Administrator permission or guild owners
        if (message.member) {
            const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);
            const isOwner = message.member.id === message.guild.ownerId;
            if (isAdmin || isOwner) return false;
        }

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

    async matchesPattern(content, pattern) {
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
        } catch (error) {
            logger.error(`[AdvancedAutomodManager] Pattern match error: ${error.message}`, { patternId: pattern.id });
        }
        return false;
    }

    async checkSpam(message) {
        try {
            if (!message.guild) return false;

            // Use cached config lookup (60s TTL)
            const config = await configCache.get('automod_spam_config', message.guild.id, async () => {
                const [[result]] = await pool.execute('SELECT * FROM automod_spam_config WHERE guild_id = ? AND enabled = 1', [message.guild.id]);
                return result || null;
            });

            if (!config) {
                return false;
            }

            const userId = message.author.id;
            const guildId = message.guild.id;
            const key = `${guildId}_${userId}`;

            // Initialize tracking with max size enforcement
            if (!this.spamTracking.has(key)) {
                if (this.spamTracking.size >= this.MAX_SPAM_TRACKING) {
                    const oldestKey = this.spamTracking.keys().next().value;
                    this.spamTracking.delete(oldestKey);
                }
                this.spamTracking.set(key, { messages: [], lastCleanup: Date.now() });
            }

            const tracking = this.spamTracking.get(key);
            const now = Date.now();

            // Cleanup old messages
            tracking.messages = tracking.messages.filter(m => now - m.timestamp < config.time_window * 1000);

            // Add current message
            tracking.messages.push({ timestamp: now, content: message.content });

            // Check message spam
            if (tracking.messages.length > config.max_messages) {
                logger.info(`[AdvancedAutomodManager] Message spam detected: ${tracking.messages.length} messages in ${config.time_window}s`, {
                    guildId: message.guild.id,
                    userId: message.author.id,
                    channelId: message.channel.id,
                    threshold: config.max_messages
                });
                await this.executeSpamAction(message, config, 'message_spam');
                this.spamTracking.delete(key);
                return true;
            }

            // Check repeated messages
            const recentContent = tracking.messages.map(m => m.content);
            const duplicates = recentContent.filter(c => c === message.content).length;
            if (duplicates > 3) {
                logger.info(`[AdvancedAutomodManager] Repeated spam detected: ${duplicates} duplicate messages`, {
                    guildId: message.guild.id,
                    userId: message.author.id,
                    channelId: message.channel.id
                });
                await this.executeSpamAction(message, config, 'repeated_spam');
                this.spamTracking.delete(key);
                return true;
            }

            // Check mention spam
            const mentions = (message.content.match(/<@!?\d+>/g) || []).length;
            if (mentions > config.max_mentions) {
                logger.info(`[AdvancedAutomodManager] Mention spam detected: ${mentions} mentions`, {
                    guildId: message.guild.id,
                    userId: message.author.id,
                    channelId: message.channel.id,
                    threshold: config.max_mentions
                });
                await this.executeSpamAction(message, config, 'mention_spam');
                return true;
            }

            // Check emoji spam
            // Custom Discord emojis: <:name:id> or <a:name:id>
            const customEmojis = (message.content.match(/<a?:\w+:\d+>/g) || []).length;
            // Unicode emojis - comprehensive ranges covering all emoji blocks:
            // - Miscellaneous Symbols (U+2600-U+26FF): ☀️, ⚡, ☠️, ⭐, etc.
            // - Dingbats (U+2700-U+27BF): ✂️, ✅, ❤️, ❌, ✨, etc.
            // - Misc Technical (U+2300-U+23FF): ⌚, ⏰, etc.
            // - Enclosed Alphanumerics (U+24C2): Ⓜ️, etc.
            // - Geometric Shapes (U+25A0-U+25FF): ▶️, ◀️, etc.
            // - Misc Symbols and Pictographs (U+1F300-U+1F5FF): 🌀, 🎉, etc.
            // - Emoticons (U+1F600-U+1F64F): 😀, 😂, etc.
            // - Transport and Map (U+1F680-U+1F6FF): 🚀, 🚗, etc.
            // - Supplemental Symbols (U+1F900-U+1F9FF): 🤔, 🥰, etc.
            // - Extended-A (U+1FA00-U+1FAFF): 🩹, 🪄, etc.
            // - Regional Indicators/Flags (U+1F1E0-U+1F1FF): 🇺🇸, etc.
            const unicodeEmojiPattern = /[\u{1F300}-\u{1F9FF}]|[\u{1FA00}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{2300}-\u{23FF}]|[\u{25A0}-\u{25FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{200D}]|[\u{FE0F}]/gu;
            const unicodeEmojis = (message.content.match(unicodeEmojiPattern) || []).length;
            const totalEmojis = customEmojis + unicodeEmojis;

            if (totalEmojis > config.max_emojis) {
                logger.info(`[AdvancedAutomodManager] Emoji spam detected: ${totalEmojis} emojis (custom: ${customEmojis}, unicode: ${unicodeEmojis})`, {
                    guildId: message.guild.id,
                    userId: message.author.id,
                    channelId: message.channel.id,
                    threshold: config.max_emojis
                });
                await this.executeSpamAction(message, config, 'emoji_spam');
                return true;
            }

            // Check character spam
            const charCounts = {};
            for (const char of message.content) {
                charCounts[char] = (charCounts[char] || 0) + 1;
                if (charCounts[char] > config.max_repeated_chars) {
                    logger.info(`[AdvancedAutomodManager] Character spam detected: '${char}' repeated ${charCounts[char]} times`, {
                        guildId: message.guild.id,
                        userId: message.author.id,
                        channelId: message.channel.id,
                        threshold: config.max_repeated_chars
                    });
                    await this.executeSpamAction(message, config, 'character_spam');
                    return true;
                }
            }

            return false;
        } catch (error) {
            logger.error(`[AdvancedAutomodManager] Spam check error: ${error.message}`, { guildId: message.guild?.id, userId: message.author.id });
            return false;
        }
    }

    async executeAction(message, pattern) {
        try {
            await message.delete().catch(() => {});

            const reason = pattern.reason || 'Automod pattern match';

            if (pattern.action === 'warn') {
                await message.channel.send(`${message.author}, warned for: ${reason}`).then(m => setTimeout(() => m.delete(), 5000));
            } else if (pattern.action === 'mute') {
                const muteDuration = 10 * 60 * 1000;
                await message.member.timeout(muteDuration, reason);
                await message.channel.send(`${message.author} has been muted for 10 minutes: ${reason}`).then(m => setTimeout(() => m.delete(), 5000));
            } else if (pattern.action === 'kick') {
                await message.member.kick(reason);
            } else if (pattern.action === 'ban') {
                await message.member.ban({ reason, deleteMessageSeconds: 86400 });
            }

            logger.info(`[AdvancedAutomodManager] Executed ${pattern.action} on ${message.author.tag}`, { guildId: message.guild?.id, userId: message.author.id, reason });
        } catch (error) {
            logger.error(`[AdvancedAutomodManager] Action execution error: ${error.message}`, { action: pattern.action, guildId: message.guild?.id });
        }
    }

    async executeSpamAction(message, config, spamType) {
        try {
            await message.delete().catch(() => {});

            const reason = `Spam detected: ${spamType}`;

            if (config.action === 'warn') {
                await message.channel.send(`${message.author}, stop spamming!`).then((m) => setTimeout(() => m.delete(), 5000));
            } else if (config.action === 'mute') {
                await message.member.timeout(10 * 60 * 1000, reason);
                await message.channel.send(`${message.author} has been muted for spamming.`).then((m) => setTimeout(() => m.delete(), 5000));
            } else if (config.action === 'kick') {
                await message.member.kick(reason);
            }

            logger.info(`[AdvancedAutomodManager] Spam action ${config.action} on ${message.author.tag}`, { guildId: message.guild?.id, userId: message.author.id, spamType });
        } catch (error) {
            logger.error(`[AdvancedAutomodManager] Spam action error: ${error.message}`, { guildId: message.guild?.id });
        }
    }

    async addPattern(guildId, patternType, pattern, action, reason) {
        try {
            await pool.execute('INSERT INTO automod_patterns (guild_id, pattern_type, pattern, action, reason) VALUES (?, ?, ?, ?, ?)',
                [guildId, patternType, pattern, action, reason]);
            await this.loadPatterns();
            logger.info(`[AdvancedAutomodManager] Added pattern for guild ${guildId}`, { guildId, patternType });
            return true;
        } catch (error) {
            logger.error(`[AdvancedAutomodManager] Failed to add pattern: ${error.message}`, { guildId });
            return false;
        }
    }

    async removePattern(patternId) {
        try {
            await pool.execute('DELETE FROM automod_patterns WHERE id = ?', [patternId]);
            await this.loadPatterns();
            logger.info(`[AdvancedAutomodManager] Removed pattern ${patternId}`);
            return true;
        } catch (error) {
            logger.error(`[AdvancedAutomodManager] Failed to remove pattern: ${error.message}`);
            return false;
        }
    }
}

export default AdvancedAutomodManager;
