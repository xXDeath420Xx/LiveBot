"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const logger_1 = __importDefault(require("../utils/logger"));
const db_1 = __importDefault(require("../utils/db"));
class AdvancedAutomodManager {
    constructor(client) {
        this.client = client;
        this.patterns = new Map();
        this.spamTracking = new Map();
        this.loadPatterns();
        logger_1.default.info('[AdvancedAutomodManager] Advanced automod manager initialized');
    }
    async loadPatterns() {
        try {
            const [patterns] = await db_1.default.execute('SELECT * FROM automod_patterns WHERE enabled = 1');
            patterns.forEach(pattern => {
                if (!this.patterns.has(pattern.guild_id))
                    this.patterns.set(pattern.guild_id, []);
                this.patterns.get(pattern.guild_id).push(pattern);
            });
            logger_1.default.info(`[AdvancedAutomodManager] Loaded ${patterns.length} automod patterns`);
        }
        catch (error) {
            logger_1.default.error(`[AdvancedAutomodManager] Failed to load patterns: ${error.message}`);
        }
    }
    async checkMessage(message) {
        if (!message.guild || message.author.bot)
            return false;
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
            }
            else if (pattern.pattern_type === 'contains') {
                return content.toLowerCase().includes(pattern.pattern.toLowerCase());
            }
            else if (pattern.pattern_type === 'exact') {
                return content.toLowerCase() === pattern.pattern.toLowerCase();
            }
            else if (pattern.pattern_type === 'domain') {
                const urlRegex = /https?:\/\/[^\s]+/gi;
                const urls = content.match(urlRegex) || [];
                return urls.some(url => url.includes(pattern.pattern));
            }
        }
        catch (error) {
            logger_1.default.error(`[AdvancedAutomodManager] Pattern match error: ${error.message}`, { patternId: pattern.id });
        }
        return false;
    }
    async checkSpam(message) {
        try {
            if (!message.guild)
                return false;
            const [[config]] = await db_1.default.execute('SELECT * FROM automod_spam_config WHERE guild_id = ? AND enabled = 1', [message.guild.id]);
            if (!config)
                return false;
            const userId = message.author.id;
            const guildId = message.guild.id;
            const key = `${guildId}_${userId}`;
            // Initialize tracking
            if (!this.spamTracking.has(key)) {
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
            const charCounts = {};
            for (const char of message.content) {
                charCounts[char] = (charCounts[char] || 0) + 1;
                if (charCounts[char] > config.max_repeated_chars) {
                    await this.executeSpamAction(message, config, 'character_spam');
                    return true;
                }
            }
            return false;
        }
        catch (error) {
            logger_1.default.error(`[AdvancedAutomodManager] Spam check error: ${error.message}`, { guildId: message.guild?.id, userId: message.author.id });
            return false;
        }
    }
    async executeAction(message, pattern) {
        try {
            await message.delete().catch(() => { });
            const reason = pattern.reason || 'Automod pattern match';
            if (pattern.action === 'warn') {
                await message.channel.send(`${message.author}, warned for: ${reason}`).then(m => setTimeout(() => m.delete(), 5000));
            }
            else if (pattern.action === 'mute') {
                const muteDuration = 10 * 60 * 1000;
                await message.member.timeout(muteDuration, reason);
                await message.channel.send(`${message.author} has been muted for 10 minutes: ${reason}`).then(m => setTimeout(() => m.delete(), 5000));
            }
            else if (pattern.action === 'kick') {
                await message.member.kick(reason);
            }
            else if (pattern.action === 'ban') {
                await message.member.ban({ reason, deleteMessageSeconds: 86400 });
            }
            logger_1.default.info(`[AdvancedAutomodManager] Executed ${pattern.action} on ${message.author.tag}`, { guildId: message.guild?.id, userId: message.author.id, reason });
        }
        catch (error) {
            logger_1.default.error(`[AdvancedAutomodManager] Action execution error: ${error.message}`, { action: pattern.action, guildId: message.guild?.id });
        }
    }
    async executeSpamAction(message, config, spamType) {
        try {
            await message.delete().catch(() => { });
            const reason = `Spam detected: ${spamType}`;
            if (config.action === 'warn') {
                await message.channel.send(`${message.author}, stop spamming!`).then(m => setTimeout(() => m.delete(), 5000));
            }
            else if (config.action === 'mute') {
                await message.member.timeout(10 * 60 * 1000, reason);
                await message.channel.send(`${message.author} has been muted for spamming.`).then(m => setTimeout(() => m.delete(), 5000));
            }
            else if (config.action === 'kick') {
                await message.member.kick(reason);
            }
            logger_1.default.info(`[AdvancedAutomodManager] Spam action ${config.action} on ${message.author.tag}`, { guildId: message.guild?.id, userId: message.author.id, spamType });
        }
        catch (error) {
            logger_1.default.error(`[AdvancedAutomodManager] Spam action error: ${error.message}`, { guildId: message.guild?.id });
        }
    }
    async addPattern(guildId, patternType, pattern, action, reason) {
        try {
            await db_1.default.execute('INSERT INTO automod_patterns (guild_id, pattern_type, pattern, action, reason) VALUES (?, ?, ?, ?, ?)', [guildId, patternType, pattern, action, reason]);
            await this.loadPatterns();
            logger_1.default.info(`[AdvancedAutomodManager] Added pattern for guild ${guildId}`, { guildId, patternType });
            return true;
        }
        catch (error) {
            logger_1.default.error(`[AdvancedAutomodManager] Failed to add pattern: ${error.message}`, { guildId });
            return false;
        }
    }
    async removePattern(patternId) {
        try {
            await db_1.default.execute('DELETE FROM automod_patterns WHERE id = ?', [patternId]);
            await this.loadPatterns();
            logger_1.default.info(`[AdvancedAutomodManager] Removed pattern ${patternId}`);
            return true;
        }
        catch (error) {
            logger_1.default.error(`[AdvancedAutomodManager] Failed to remove pattern: ${error.message}`);
            return false;
        }
    }
}
exports.default = AdvancedAutomodManager;
