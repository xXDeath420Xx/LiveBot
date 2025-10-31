import type { Client, Message, VoiceState, GuildMember } from 'discord.js';
import type { RowDataPacket } from 'mysql2';
import { EmbedBuilder } from 'discord.js';
import logger from '../utils/logger';
import db from '../utils/db';

interface LevelConfig extends RowDataPacket {
    guild_id: string;
    xp_per_message: number;
    xp_cooldown_seconds: number;
    xp_per_voice_minute: number;
    voice_xp_enabled: boolean;
    level_up_message: string;
    level_up_channel_id: string | null;
    xp_multiplier_weekends: number;
    xp_multiplier_events: number;
}

interface UserLevel extends RowDataPacket {
    user_id: string;
    guild_id: string;
    xp: number;
    level: number;
    voice_xp: number;
    total_voice_minutes: number;
}

interface RoleReward extends RowDataPacket {
    guild_id: string;
    level: number;
    role_id: string;
}

interface XPMultiplierEvent extends RowDataPacket {
    guild_id: string;
    multiplier: number;
    start_time: Date;
    end_time: Date;
    enabled: boolean;
}

class EnhancedLevelingManager {
    private client: Client;
    private voiceSessions: Map<string, number>;
    private xpCooldowns: Map<string, number>;

    constructor(client: Client) {
        this.client = client;
        this.voiceSessions = new Map(); // Track voice session start times
        this.xpCooldowns = new Map(); // Track XP cooldowns per user
        logger.info('[EnhancedLevelingManager] Enhanced leveling manager initialized');
    }

    async getConfig(guildId: string): Promise<LevelConfig> {
        try {
            const [[config]] = await db.execute<LevelConfig[]>('SELECT * FROM level_config WHERE guild_id = ?', [guildId]);
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
                } as LevelConfig;
            }
            return config;
        } catch (error: any) {
            logger.error(`[EnhancedLevelingManager] Failed to get config: ${error.message}`, { guildId });
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
            } as LevelConfig;
        }
    }

    async handleMessageXP(message: Message): Promise<void> {
        if (!message.guild || message.author.bot) return;

        const guildId = message.guild.id;
        const userId = message.author.id;
        const key = `${guildId}_${userId}`;

        // Check cooldown
        const lastXP = this.xpCooldowns.get(key);
        const config = await this.getConfig(guildId);

        const now = Date.now();
        if (lastXP && now - lastXP < config.xp_cooldown_seconds * 1000) return;

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

    async addXP(guildId: string, userId: string, xpAmount: number): Promise<number> {
        try {
            // Get current user data
            const [[user]] = await db.execute<UserLevel[]>(
                'SELECT * FROM user_levels WHERE guild_id = ? AND user_id = ?',
                [guildId, userId]
            );

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
                await db.execute(
                    'UPDATE user_levels SET xp = ?, level = ? WHERE guild_id = ? AND user_id = ?',
                    [currentXP, newLevel, guildId, userId]
                );
            } else {
                await db.execute(
                    'INSERT INTO user_levels (guild_id, user_id, xp, level) VALUES (?, ?, ?, ?)',
                    [guildId, userId, currentXP, newLevel]
                );
            }

            return currentLevel;
        } catch (error: any) {
            logger.error(`[EnhancedLevelingManager] Failed to add XP: ${error.message}`, { guildId, userId });
            return 0;
        }
    }

    getXPForLevel(level: number): number {
        return 5 * (level ** 2) + 50 * level + 100;
    }

    async checkLevelUp(message: Message, oldLevel: number): Promise<void> {
        const [[user]] = await db.execute<UserLevel[]>(
            'SELECT level FROM user_levels WHERE guild_id = ? AND user_id = ?',
            [message.guild!.id, message.author.id]
        );

        if (!user || user.level <= oldLevel) return;

        const config = await this.getConfig(message.guild!.id);
        let levelUpMessage = config.level_up_message
            .replace('{user}', `<@${message.author.id}>`)
            .replace('{level}', user.level.toString())
            .replace('{username}', message.author.username);

        const embed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('🎉 Level Up!')
            .setDescription(levelUpMessage)
            .setThumbnail(message.author.displayAvatarURL())
            .setFooter({ text: `You are now level ${user.level}!` });

        // Check for role rewards
        const [[roleReward]] = await db.execute<RoleReward[]>(
            'SELECT role_id FROM role_rewards WHERE guild_id = ? AND level = ?',
            [message.guild!.id, user.level]
        );

        if (roleReward) {
            const role = message.guild!.roles.cache.get(roleReward.role_id);
            if (role) {
                await message.member!.roles.add(role).catch(() => {});
                embed.addFields({ name: '🎁 Role Reward', value: `You earned the ${role} role!` });
            }
        }

        // Send to configured channel or current channel
        const channelId = config.level_up_channel_id || message.channel.id;
        const channel = message.guild!.channels.cache.get(channelId);
        if (channel && channel.isTextBased()) {
            await (channel as any).send({ embeds: [embed] }).catch(() => {});
        }

        logger.info(`[EnhancedLevelingManager] ${message.author.tag} leveled up to ${user.level}`, {
            guildId: message.guild!.id,
            userId: message.author.id,
            level: user.level
        });
    }

    async getActiveMultiplier(guildId: string): Promise<number> {
        const config = await this.getConfig(guildId);
        let multiplier = 1.0;

        // Weekend multiplier
        const now = new Date();
        if (now.getDay() === 0 || now.getDay() === 6) {
            multiplier *= config.xp_multiplier_weekends;
        }

        // Check for active events
        const [[event]] = await db.execute<XPMultiplierEvent[]>(
            'SELECT multiplier FROM xp_multiplier_events WHERE guild_id = ? AND enabled = 1 AND start_time <= NOW() AND end_time >= NOW() LIMIT 1',
            [guildId]
        );

        if (event) {
            multiplier *= parseFloat(event.multiplier.toString());
        }

        return multiplier;
    }

    // Voice XP Tracking
    async handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
        try {
            const member = newState.member;
            if (!member || member.user.bot) return;

            const guildId = newState.guild.id;
            const userId = member.id;
            const key = `${guildId}_${userId}`;

            const config = await this.getConfig(guildId);
            if (!config.voice_xp_enabled) return;

            // User joined voice
            if (!oldState.channelId && newState.channelId) {
                this.voiceSessions.set(key, Date.now());
                logger.info(`[EnhancedLevelingManager] ${member.user.tag} started voice session`, { guildId, userId });
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
        } catch (error: any) {
            logger.error(`[EnhancedLevelingManager] Voice state update error: ${error.message}`, { error: error.message });
        }
    }

    async addVoiceXP(guildId: string, userId: string, minutes: number, config: LevelConfig): Promise<void> {
        try {
            const xpPerMinute = config.xp_per_voice_minute;
            const multiplier = await this.getActiveMultiplier(guildId);
            const voiceXP = Math.floor(xpPerMinute * minutes * multiplier);

            await db.execute(`
                INSERT INTO user_levels (guild_id, user_id, voice_xp, total_voice_minutes, last_voice_update)
                VALUES (?, ?, ?, ?, NOW())
                ON DUPLICATE KEY UPDATE
                    voice_xp = voice_xp + VALUES(voice_xp),
                    total_voice_minutes = total_voice_minutes + VALUES(total_voice_minutes),
                    last_voice_update = NOW()
            `, [guildId, userId, voiceXP, minutes]);

            logger.info(`[EnhancedLevelingManager] Added ${voiceXP} voice XP for ${minutes} minutes`, {
                guildId,
                userId,
                minutes,
                voiceXP
            });
        } catch (error: any) {
            logger.error(`[EnhancedLevelingManager] Failed to add voice XP: ${error.message}`, { guildId, userId });
        }
    }

    async getVoiceStats(guildId: string, userId: string): Promise<{ voice_xp: number; total_voice_minutes: number }> {
        try {
            const [[stats]] = await db.execute<UserLevel[]>(
                'SELECT voice_xp, total_voice_minutes FROM user_levels WHERE guild_id = ? AND user_id = ?',
                [guildId, userId]
            );
            return stats || { voice_xp: 0, total_voice_minutes: 0 };
        } catch (error: any) {
            logger.error(`[EnhancedLevelingManager] Failed to get voice stats: ${error.message}`, { guildId, userId });
            return { voice_xp: 0, total_voice_minutes: 0 };
        }
    }

    formatVoiceTime(minutes: number): string {
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        if (hours > 0) return `${hours}h ${mins}m`;
        return `${mins}m`;
    }
}

export default EnhancedLevelingManager;
