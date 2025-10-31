"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const logger_1 = __importDefault(require("../utils/logger"));
const db_1 = __importDefault(require("../utils/db"));
class MusicStatusManager {
    constructor(client) {
        this.client = client;
        this.musicSessions = new Map();
        this.startTime = Date.now();
        logger_1.default.info('[MusicStatusManager] Music status manager initialized');
    }
    async updateMusicSession(guildId, sessionData) {
        try {
            const { voiceChannelId, textChannelId, currentTrack, queueSize, djMode, isPlaying, volume, filters } = sessionData;
            this.musicSessions.set(guildId, { ...sessionData, lastUpdated: new Date() });
            await db_1.default.execute(`
                INSERT INTO music_sessions (guild_id, voice_channel_id, text_channel_id, current_track, queue_size, dj_mode_enabled, is_playing, volume, filters, started_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
                ON DUPLICATE KEY UPDATE voice_channel_id = VALUES(voice_channel_id), text_channel_id = VALUES(text_channel_id),
                    current_track = VALUES(current_track), queue_size = VALUES(queue_size), dj_mode_enabled = VALUES(dj_mode_enabled),
                    is_playing = VALUES(is_playing), volume = VALUES(volume), filters = VALUES(filters), updated_at = NOW()
            `, [guildId, voiceChannelId, textChannelId, JSON.stringify(currentTrack), queueSize, djMode ? 1 : 0, isPlaying ? 1 : 0, volume || 100, JSON.stringify(filters || [])]);
            logger_1.default.info(`[MusicStatusManager] Updated music session for guild ${guildId}`, { guildId, category: 'music-status' });
        }
        catch (error) {
            logger_1.default.error(`[MusicStatusManager] Failed to update music session: ${error.message}`, { guildId, error: error.message, category: 'music-status' });
        }
    }
    async removeMusicSession(guildId) {
        try {
            this.musicSessions.delete(guildId);
            await db_1.default.execute('DELETE FROM music_sessions WHERE guild_id = ?', [guildId]);
            logger_1.default.info(`[MusicStatusManager] Removed music session for guild ${guildId}`, { guildId, category: 'music-status' });
        }
        catch (error) {
            logger_1.default.error(`[MusicStatusManager] Failed to remove music session: ${error.message}`, { guildId, error: error.message, category: 'music-status' });
        }
    }
    async logTrackPlay(guildId, track, userId) {
        try {
            await db_1.default.execute(`INSERT INTO music_statistics (guild_id, track_title, track_url, track_source, played_by, played_at, duration) VALUES (?, ?, ?, ?, ?, NOW(), ?)`, [guildId, track.title || 'Unknown', track.url || '', track.source || 'youtube', userId, track.duration || 0]);
            logger_1.default.info(`[MusicStatusManager] Logged track play: ${track.title}`, { guildId, userId, track: track.title, category: 'music-status' });
        }
        catch (error) {
            logger_1.default.error(`[MusicStatusManager] Failed to log track play: ${error.message}`, { guildId, error: error.message, category: 'music-status' });
        }
    }
    async getAllSessions() {
        try {
            const [sessions] = await db_1.default.execute('SELECT * FROM music_sessions ORDER BY updated_at DESC');
            const enriched = await Promise.all(sessions.map(async (session) => {
                try {
                    const guild = this.client.guilds.cache.get(session.guild_id);
                    if (!guild)
                        return null;
                    const voiceChannel = guild.channels.cache.get(session.voice_channel_id);
                    const textChannel = guild.channels.cache.get(session.text_channel_id);
                    return {
                        ...session,
                        guild_name: guild.name,
                        guild_icon: guild.iconURL({ size: 64 }),
                        voice_channel_name: voiceChannel?.name || 'Unknown',
                        text_channel_name: textChannel?.name || 'Unknown',
                        member_count: (voiceChannel && 'members' in voiceChannel) ? voiceChannel.members?.size || 0 : 0,
                        current_track: JSON.parse(session.current_track || '{}'),
                        filters: JSON.parse(session.filters || '[]')
                    };
                }
                catch (err) {
                    return null;
                }
            }));
            return enriched.filter(s => s !== null);
        }
        catch (error) {
            logger_1.default.error(`[MusicStatusManager] Failed to get all sessions: ${error.message}`, { error: error.message, category: 'music-status' });
            return [];
        }
    }
    async getMusicStatistics(guildId = null) {
        try {
            const whereClause = guildId ? 'WHERE guild_id = ?' : '';
            const params = guildId ? [guildId] : [];
            const [stats] = await db_1.default.execute(`SELECT COUNT(*) as total_plays, COUNT(DISTINCT guild_id) as unique_guilds, COUNT(DISTINCT played_by) as unique_users, SUM(duration) as total_duration FROM music_statistics ${whereClause}`, params);
            const [topTracks] = await db_1.default.execute(`SELECT track_title, track_source, COUNT(*) as play_count FROM music_statistics ${whereClause} GROUP BY track_title, track_source ORDER BY play_count DESC LIMIT 10`, params);
            return { ...stats[0], topTracks };
        }
        catch (error) {
            logger_1.default.error(`[MusicStatusManager] Failed to get music statistics: ${error.message}`, { guildId, error: error.message, category: 'music-status' });
            return { total_plays: 0, unique_guilds: 0, unique_users: 0, total_duration: 0, topTracks: [] };
        }
    }
    getGeneralStats() {
        const uptime = Date.now() - this.startTime;
        // Count active voice connections from discord-player queues
        let voiceConnections = 0;
        if (this.client.player && this.client.player.queues) {
            voiceConnections = this.client.player.queues.cache.size;
        }
        return {
            uptime,
            uptimeFormatted: this.formatUptime(uptime),
            activeMusicSessions: this.musicSessions.size,
            totalGuilds: this.client.guilds.cache.size,
            totalUsers: this.client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0),
            voiceConnections: voiceConnections
        };
    }
    formatUptime(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        if (days > 0)
            return days + 'd ' + (hours % 24) + 'h ' + (minutes % 60) + 'm';
        if (hours > 0)
            return hours + 'h ' + (minutes % 60) + 'm';
        if (minutes > 0)
            return minutes + 'm ' + (seconds % 60) + 's';
        return seconds + 's';
    }
}
module.exports = MusicStatusManager;
