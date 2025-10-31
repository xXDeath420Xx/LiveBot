"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
class SoundboardManager {
    constructor(client) {
        this.client = client;
    }
    async init() {
        logger_1.default.info('[Soundboard] Initializing Soundboard Manager...');
        // Sync soundboard sounds from Discord
        this.client.on('ready', () => this.syncAllGuildSounds());
        logger_1.default.info('[Soundboard] Soundboard Manager initialized');
    }
    async syncAllGuildSounds() {
        logger_1.default.info('[Soundboard] Syncing guild soundboard sounds...');
        for (const guild of this.client.guilds.cache.values()) {
            await this.syncGuildSounds(guild);
        }
        logger_1.default.info('[Soundboard] Guild soundboard sounds synced');
    }
    async syncGuildSounds(guild) {
        try {
            // Fetch soundboard sounds from Discord API
            const sounds = await guild.soundboards.fetch().catch(() => null);
            if (!sounds)
                return;
            for (const sound of sounds.values()) {
                await db_1.default.execute(`INSERT INTO soundboard_sounds
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
            logger_1.default.info(`[Soundboard] Synced ${sounds.size} sounds for guild ${guild.id}`);
        }
        catch (error) {
            logger_1.default.error(`[Soundboard] Error syncing sounds for guild ${guild.id}:`, error);
        }
    }
    async playSound(guildId, soundId, channelId, userId) {
        try {
            const guild = this.client.guilds.cache.get(guildId);
            if (!guild)
                return { success: false, error: 'Guild not found' };
            const channel = guild.channels.cache.get(channelId);
            if (!channel || !channel.isVoiceBased()) {
                return { success: false, error: 'Voice channel not found' };
            }
            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member)
                return { success: false, error: 'Member not found' };
            // Verify sound exists
            const [[sound]] = await db_1.default.execute('SELECT * FROM soundboard_sounds WHERE guild_id = ? AND sound_id = ?', [guildId, soundId]);
            if (!sound)
                return { success: false, error: 'Sound not found' };
            // Play sound via Discord API
            await member.voice.channel?.guild.members.me?.voice.sendSoundboardSound(soundId, channel);
            // Track usage
            await this.trackSoundUsage(soundId, guildId, userId, channelId);
            logger_1.default.info(`[Soundboard] Played sound ${soundId} in ${channelId} for user ${userId}`);
            return { success: true, message: `Played sound: ${sound.sound_name}` };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error('[Soundboard] Error playing sound:', error);
            return { success: false, error: errorMessage };
        }
    }
    async trackSoundUsage(soundId, guildId, userId, channelId) {
        try {
            await db_1.default.execute(`INSERT INTO soundboard_usage_stats (sound_id, guild_id, user_id, channel_id)
                 VALUES (?, ?, ?, ?)`, [soundId, guildId, userId, channelId]);
            await db_1.default.execute(`UPDATE soundboard_sounds
                 SET usage_count = usage_count + 1, last_used = NOW()
                 WHERE sound_id = ?`, [soundId]);
        }
        catch (error) {
            logger_1.default.error('[Soundboard] Error tracking sound usage:', error);
        }
    }
    async getSoundStats(guildId, limit = 20) {
        try {
            const [stats] = await db_1.default.execute(`SELECT * FROM soundboard_sounds
                 WHERE guild_id = ?
                 ORDER BY usage_count DESC
                 LIMIT ?`, [guildId, limit]);
            return stats;
        }
        catch (error) {
            logger_1.default.error('[Soundboard] Error getting sound stats:', error);
            return [];
        }
    }
    async getGuildSounds(guildId) {
        try {
            const [sounds] = await db_1.default.execute('SELECT * FROM soundboard_sounds WHERE guild_id = ? ORDER BY sound_name ASC', [guildId]);
            return sounds;
        }
        catch (error) {
            logger_1.default.error('[Soundboard] Error getting guild sounds:', error);
            return [];
        }
    }
    shutdown() {
        logger_1.default.info('[Soundboard] Soundboard Manager shut down');
    }
}
exports.default = SoundboardManager;
