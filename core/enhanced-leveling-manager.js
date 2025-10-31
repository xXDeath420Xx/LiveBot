"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const logger_1 = __importDefault(require("../utils/logger"));
const db_1 = __importDefault(require("../utils/db"));
class EnhancedLevelingManager {
    constructor(client) {
        this.client = client;
        this.voiceSessions = new Map(); // Track voice session start times
        this.xpCooldowns = new Map(); // Track XP cooldowns per user
        logger_1.default.info('[EnhancedLevelingManager] Enhanced leveling manager initialized');
    }
    async getConfig(guildId) {
        try {
            const [[config]] = await db_1.default.execute('SELECT * FROM level_config WHERE guild_id = ?', [guildId]);
            if (!config) {
                // Return default config
                return {
                    guild_id: guildId,
                    xp_per_message: 15,
                    xp_cooldown_seconds: 60,
                    xp_per_voice_minute: 5,
                    voice_xp_enabled: true,
                    level_up_message: 'Congrats {user}! You reached **Level {level}**!',
                    level_up_channel_id: null,
                    xp_multiplier_weekends: 1.0,
                    xp_multiplier_events: 1.0
                };
            }
            return config;
        }
        catch (error) {
            logger_1.default.error(`[EnhancedLevelingManager] Failed to get config: ${error.message}`, { guildId });
            return {
                guild_id: guildId,
                xp_per_message: 15,
                xp_cooldown_seconds: 60,
                xp_per_voice_minute: 5,
                voice_xp_enabled: true,
                level_up_message: 'Congrats {user}! You reached **Level {level}**!',
                level_up_channel_id: null,
                xp_multiplier_weekends: 1.0,
                xp_multiplier_events: 1.0
            };
        }
    }
    async handleMessageXP(message) {
        if (!message.guild || message.author.bot)
            return;
        const guildId = message.guild.id;
        const userId = message.author.id;
        const key = `${guildId}_${userId}`;
        // Check cooldown
        const lastXP = this.xpCooldowns.get(key);
        const config = await this.getConfig(guildId);
        const now = Date.now();
        if (lastXP && now - lastXP < config.xp_cooldown_seconds * 1000)
            return;
        // Calculate XP with multipliers
        let baseXP = config.xp_per_message;
        const multiplier = await this.getActiveMultiplier(guildId);
        const xpToAdd = Math.floor(baseXP * multiplier);
        // Add XP to database
        const oldLevel = await this.addXP(guildId, userId, xpToAdd);
        this.xpCooldowns.set(key, now);
        // Check for level up
        await this.checkLevelUp(message, oldLevel);
    }
    async addXP(guildId, userId, xpAmount) {
        try {
            // Get current user data
            const [[user]] = await db_1.default.execute('SELECT * FROM user_levels WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
            let currentXP = user ? user.xp : 0;
            let currentLevel = user ? user.level : 0;
            // Add XP
            currentXP += xpAmount;
            // Calculate new level
            let newLevel = currentLevel;
            while (currentXP >= this.getXPForLevel(newLevel + 1)) {
                currentXP -= this.getXPForLevel(newLevel + 1);
                newLevel++;
            }
            // Update database
            if (user) {
                await db_1.default.execute('UPDATE user_levels SET xp = ?, level = ? WHERE guild_id = ? AND user_id = ?', [currentXP, newLevel, guildId, userId]);
            }
            else {
                await db_1.default.execute('INSERT INTO user_levels (guild_id, user_id, xp, level) VALUES (?, ?, ?, ?)', [guildId, userId, currentXP, newLevel]);
            }
            return currentLevel;
        }
        catch (error) {
            logger_1.default.error(`[EnhancedLevelingManager] Failed to add XP: ${error.message}`, { guildId, userId });
            return 0;
        }
    }
    getXPForLevel(level) {
        return 5 * (level ** 2) + 50 * level + 100;
    }
    async checkLevelUp(message, oldLevel) {
        const [[user]] = await db_1.default.execute('SELECT level FROM user_levels WHERE guild_id = ? AND user_id = ?', [message.guild.id, message.author.id]);
        if (!user || user.level <= oldLevel)
            return;
        const config = await this.getConfig(message.guild.id);
        let levelUpMessage = config.level_up_message
            .replace('{user}', `<@${message.author.id}>`)
            .replace('{level}', user.level.toString())
            .replace('{username}', message.author.username);
        const embed = new discord_js_1.EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('🎉 Level Up!')
            .setDescription(levelUpMessage)
            .setThumbnail(message.author.displayAvatarURL())
            .setFooter({ text: `You are now level ${user.level}!` });
        // Check for role rewards
        const [[roleReward]] = await db_1.default.execute('SELECT role_id FROM role_rewards WHERE guild_id = ? AND level = ?', [message.guild.id, user.level]);
        if (roleReward) {
            const role = message.guild.roles.cache.get(roleReward.role_id);
            if (role) {
                await message.member.roles.add(role).catch(() => { });
                embed.addFields({ name: '🎁 Role Reward', value: `You earned the ${role} role!` });
            }
        }
        // Send to configured channel or current channel
        const channelId = config.level_up_channel_id || message.channel.id;
        const channel = message.guild.channels.cache.get(channelId);
        if (channel && channel.isTextBased()) {
            await channel.send({ embeds: [embed] }).catch(() => { });
        }
        logger_1.default.info(`[EnhancedLevelingManager] ${message.author.tag} leveled up to ${user.level}`, {
            guildId: message.guild.id,
            userId: message.author.id,
            level: user.level
        });
    }
    async getActiveMultiplier(guildId) {
        const config = await this.getConfig(guildId);
        let multiplier = 1.0;
        // Weekend multiplier
        const now = new Date();
        if (now.getDay() === 0 || now.getDay() === 6) {
            multiplier *= config.xp_multiplier_weekends;
        }
        // Check for active events
        const [[event]] = await db_1.default.execute('SELECT multiplier FROM xp_multiplier_events WHERE guild_id = ? AND enabled = 1 AND start_time <= NOW() AND end_time >= NOW() LIMIT 1', [guildId]);
        if (event) {
            multiplier *= parseFloat(event.multiplier.toString());
        }
        return multiplier;
    }
    // Voice XP Tracking
    async handleVoiceStateUpdate(oldState, newState) {
        try {
            const member = newState.member;
            if (!member || member.user.bot)
                return;
            const guildId = newState.guild.id;
            const userId = member.id;
            const key = `${guildId}_${userId}`;
            const config = await this.getConfig(guildId);
            if (!config.voice_xp_enabled)
                return;
            // User joined voice
            if (!oldState.channelId && newState.channelId) {
                this.voiceSessions.set(key, Date.now());
                logger_1.default.info(`[EnhancedLevelingManager] ${member.user.tag} started voice session`, { guildId, userId });
            }
            // User left voice
            else if (oldState.channelId && !newState.channelId) {
                const startTime = this.voiceSessions.get(key);
                if (startTime) {
                    const duration = Date.now() - startTime;
                    const minutes = Math.floor(duration / 60000);
                    if (minutes > 0) {
                        await this.addVoiceXP(guildId, userId, minutes, config);
                    }
                    this.voiceSessions.delete(key);
                }
            }
        }
        catch (error) {
            logger_1.default.error(`[EnhancedLevelingManager] Voice state update error: ${error.message}`, { error: error.message });
        }
    }
    async addVoiceXP(guildId, userId, minutes, config) {
        try {
            const xpPerMinute = config.xp_per_voice_minute;
            const multiplier = await this.getActiveMultiplier(guildId);
            const voiceXP = Math.floor(xpPerMinute * minutes * multiplier);
            await db_1.default.execute(`
                INSERT INTO user_levels (guild_id, user_id, voice_xp, total_voice_minutes, last_voice_update)
                VALUES (?, ?, ?, ?, NOW())
                ON DUPLICATE KEY UPDATE
                    voice_xp = voice_xp + VALUES(voice_xp),
                    total_voice_minutes = total_voice_minutes + VALUES(total_voice_minutes),
                    last_voice_update = NOW()
            `, [guildId, userId, voiceXP, minutes]);
            logger_1.default.info(`[EnhancedLevelingManager] Added ${voiceXP} voice XP for ${minutes} minutes`, {
                guildId,
                userId,
                minutes,
                voiceXP
            });
        }
        catch (error) {
            logger_1.default.error(`[EnhancedLevelingManager] Failed to add voice XP: ${error.message}`, { guildId, userId });
        }
    }
    async getVoiceStats(guildId, userId) {
        try {
            const [[stats]] = await db_1.default.execute('SELECT voice_xp, total_voice_minutes FROM user_levels WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
            return stats || { voice_xp: 0, total_voice_minutes: 0 };
        }
        catch (error) {
            logger_1.default.error(`[EnhancedLevelingManager] Failed to get voice stats: ${error.message}`, { guildId, userId });
            return { voice_xp: 0, total_voice_minutes: 0 };
        }
    }
    formatVoiceTime(minutes) {
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        if (hours > 0)
            return `${hours}h ${mins}m`;
        return `${mins}m`;
    }
}
exports.default = EnhancedLevelingManager;
