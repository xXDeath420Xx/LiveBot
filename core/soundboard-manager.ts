import { Client, Guild } from 'discord.js';
import { RowDataPacket } from 'mysql2';
import db from '../utils/db';
import logger from '../utils/logger';

interface SoundboardSoundRow extends RowDataPacket {
    sound_id: string;
    sound_name: string;
    volume: number;
    emoji: string | null;
    available: boolean;
    created_by: string | null;
    usage_count: number;
    last_used: Date | null;
}

interface ExecuteResult {
    success: boolean;
    error?: string;
    message?: string;
    messageId?: string;
}

class SoundboardManager {
    private client: Client;

    constructor(client: Client) {
        this.client = client;
    }

    async init(): Promise<void> {
        logger.info('[Soundboard] Initializing Soundboard Manager...');

        // Sync soundboard sounds from Discord
        this.client.on('ready', () => this.syncAllGuildSounds());

        logger.info('[Soundboard] Soundboard Manager initialized');
    }

    async syncAllGuildSounds(): Promise<void> {
        logger.info('[Soundboard] Syncing guild soundboard sounds...');
        for (const guild of this.client.guilds.cache.values()) {
            await this.syncGuildSounds(guild);
        }
        logger.info('[Soundboard] Guild soundboard sounds synced');
    }

    async syncGuildSounds(guild: Guild): Promise<void> {
        try {
            // Fetch soundboard sounds from Discord API
            const sounds = await guild.soundboards.fetch().catch(() => null);
            if (!sounds) return;

            for (const sound of sounds.values()) {
                await db.execute(`INSERT INTO soundboard_sounds
                    (guild_id, sound_id, sound_name, volume, emoji, available, created_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE
                    sound_name = VALUES(sound_name),
                    volume = VALUES(volume),
                    emoji = VALUES(emoji),
                    available = VALUES(available)`, [
                    guild.id,
                    sound.soundId,
                    sound.name,
                    sound.volume || 1.0,
                    sound.emoji?.name || null,
                    sound.available || true,
                    sound.user?.id || null
                ]);
            }

            logger.info(`[Soundboard] Synced ${sounds.size} sounds for guild ${guild.id}`);
        } catch (error) {
            logger.error(`[Soundboard] Error syncing sounds for guild ${guild.id}:`, error as Record<string, any>);
        }
    }

    async playSound(guildId: string, soundId: string, channelId: string, userId: string): Promise<ExecuteResult> {
        try {
            const guild = this.client.guilds.cache.get(guildId);
            if (!guild) return { success: false, error: 'Guild not found' };

            const channel = guild.channels.cache.get(channelId);
            if (!channel || !channel.isVoiceBased()) {
                return { success: false, error: 'Voice channel not found' };
            }

            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member) return { success: false, error: 'Member not found' };

            // Verify sound exists
            const [[sound]] = await db.execute<SoundboardSoundRow[]>(
                'SELECT * FROM soundboard_sounds WHERE guild_id = ? AND sound_id = ?',
                [guildId, soundId]
            );
            if (!sound) return { success: false, error: 'Sound not found' };

            // Play sound via Discord API
            await member.voice.channel?.guild.members.me?.voice.sendSoundboardSound(soundId, channel);

            // Track usage
            await this.trackSoundUsage(soundId, guildId, userId, channelId);

            logger.info(`[Soundboard] Played sound ${soundId} in ${channelId} for user ${userId}`);
            return { success: true, message: `Played sound: ${sound.sound_name}` };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(_error);
            logger.error('[Soundboard] Error playing sound:', error as Record<string, any>);
            return { success: false, error: errorMessage };
        }
    }

    async trackSoundUsage(soundId: string, guildId: string, userId: string, channelId: string): Promise<void> {
        try {
            await db.execute(`INSERT INTO soundboard_usage_stats (sound_id, guild_id, user_id, channel_id)
                 VALUES (?, ?, ?, ?)`, [soundId, guildId, userId, channelId]);

            await db.execute(`UPDATE soundboard_sounds
                 SET usage_count = usage_count + 1, last_used = NOW()
                 WHERE sound_id = ?`, [soundId]);
        } catch (error) {
            logger.error('[Soundboard] Error tracking sound usage:', error as Record<string, any>);
        }
    }

    async getSoundStats(guildId: string, limit: number = 20): Promise<SoundboardSoundRow[]> {
        try {
            const [stats] = await db.execute<SoundboardSoundRow[]>(`SELECT * FROM soundboard_sounds
                 WHERE guild_id = ?
                 ORDER BY usage_count DESC
                 LIMIT ?`, [guildId, limit]);

            return stats;
        } catch (error) {
            logger.error('[Soundboard] Error getting sound stats:', error as Record<string, any>);
            return [];
        }
    }

    async getGuildSounds(guildId: string): Promise<SoundboardSoundRow[]> {
        try {
            const [sounds] = await db.execute<SoundboardSoundRow[]>(
                'SELECT * FROM soundboard_sounds WHERE guild_id = ? ORDER BY sound_name ASC',
                [guildId]
            );

            return sounds;
        } catch (error) {
            logger.error('[Soundboard] Error getting guild sounds:', error as Record<string, any>);
            return [];
        }
    }

    shutdown(): void {
        logger.info('[Soundboard] Soundboard Manager shut down');
    }
}

export default SoundboardManager;
