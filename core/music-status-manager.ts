import logger from '../utils/logger';
import db from '../utils/db';
import { Client } from 'discord.js';
import { RowDataPacket } from 'mysql2';

interface SessionData {
    voiceChannelId: string;
    textChannelId: string;
    currentTrack: any;
    queueSize: number;
    djMode: boolean;
    isPlaying: boolean;
    volume?: number;
    filters?: any[];
}

interface SessionWithTimestamp extends SessionData {
    lastUpdated: Date;
}

interface TrackData {
    title?: string;
    url?: string;
    source?: string;
    duration?: number;
}

interface MusicSession extends RowDataPacket {
    guild_id: string;
    voice_channel_id: string;
    text_channel_id: string;
    current_track: string;
    queue_size: number;
    dj_mode_enabled: number;
    is_playing: number;
    volume: number;
    filters: string;
    started_at: Date;
    updated_at: Date;
    guild_name?: string;
    guild_icon?: string | null;
    voice_channel_name?: string;
    text_channel_name?: string;
    member_count?: number;
}

interface MusicStatistics extends RowDataPacket {
    total_plays: number;
    unique_guilds: number;
    unique_users: number;
    total_duration: number;
}

interface TopTrack extends RowDataPacket {
    track_title: string;
    track_source: string;
    play_count: number;
}

interface MusicStatsResult {
    total_plays: number;
    unique_guilds: number;
    unique_users: number;
    total_duration: number;
    topTracks: TopTrack[];
}

interface GeneralStats {
    uptime: number;
    uptimeFormatted: string;
    activeMusicSessions: number;
    totalGuilds: number;
    totalUsers: number;
    voiceConnections: number;
}

class MusicStatusManager {
    private client: Client;
    private musicSessions: Map<string, SessionWithTimestamp>;
    private startTime: number;

    constructor(client: Client) {
        this.client = client;
        this.musicSessions = new Map();
        this.startTime = Date.now();
        logger.info('[MusicStatusManager] Music status manager initialized');
    }

    async updateMusicSession(guildId: string, sessionData: SessionData): Promise<void> {
        try {
            const { voiceChannelId, textChannelId, currentTrack, queueSize, djMode, isPlaying, volume, filters } = sessionData;
            this.musicSessions.set(guildId, { ...sessionData, lastUpdated: new Date() });

            await db.execute(`
                INSERT INTO music_sessions (guild_id, voice_channel_id, text_channel_id, current_track, queue_size, dj_mode_enabled, is_playing, volume, filters, started_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
                ON DUPLICATE KEY UPDATE voice_channel_id = VALUES(voice_channel_id), text_channel_id = VALUES(text_channel_id),
                    current_track = VALUES(current_track), queue_size = VALUES(queue_size), dj_mode_enabled = VALUES(dj_mode_enabled),
                    is_playing = VALUES(is_playing), volume = VALUES(volume), filters = VALUES(filters), updated_at = NOW()
            `, [guildId, voiceChannelId, textChannelId, JSON.stringify(currentTrack), queueSize, djMode ? 1 : 0, isPlaying ? 1 : 0, volume || 100, JSON.stringify(filters || [])]);

            logger.info(`[MusicStatusManager] Updated music session for guild ${guildId}`, { guildId, category: 'music-status' });
        } catch (error: any) {
            logger.error(`[MusicStatusManager] Failed to update music session: ${error.message}`, { guildId, error: error.message, category: 'music-status' });
        }
    }

    async removeMusicSession(guildId: string): Promise<void> {
        try {
            this.musicSessions.delete(guildId);
            await db.execute('DELETE FROM music_sessions WHERE guild_id = ?', [guildId]);
            logger.info(`[MusicStatusManager] Removed music session for guild ${guildId}`, { guildId, category: 'music-status' });
        } catch (error: any) {
            logger.error(`[MusicStatusManager] Failed to remove music session: ${error.message}`, { guildId, error: error.message, category: 'music-status' });
        }
    }

    async logTrackPlay(guildId: string, track: TrackData, userId: string): Promise<void> {
        try {
            await db.execute(`INSERT INTO music_statistics (guild_id, track_title, track_url, track_source, played_by, played_at, duration) VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
                [guildId, track.title || 'Unknown', track.url || '', track.source || 'youtube', userId, track.duration || 0]);
            logger.info(`[MusicStatusManager] Logged track play: ${track.title}`, { guildId, userId, track: track.title, category: 'music-status' });
        } catch (error: any) {
            logger.error(`[MusicStatusManager] Failed to log track play: ${error.message}`, { guildId, error: error.message, category: 'music-status' });
        }
    }

    async getAllSessions(): Promise<any[]> {
        try {
            const [sessions] = await db.execute<MusicSession[]>('SELECT * FROM music_sessions ORDER BY updated_at DESC');
            const enriched = await Promise.all(sessions.map(async (session) => {
                try {
                    const guild = this.client.guilds.cache.get(session.guild_id);
                    if (!guild) return null;

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
                } catch (err) {
                    return null;
                }
            }));

            return enriched.filter(s => s !== null);
        } catch (error: any) {
            logger.error(`[MusicStatusManager] Failed to get all sessions: ${error.message}`, { error: error.message, category: 'music-status' });
            return [];
        }
    }

    async getMusicStatistics(guildId: string | null = null): Promise<MusicStatsResult> {
        try {
            const whereClause = guildId ? 'WHERE guild_id = ?' : '';
            const params = guildId ? [guildId] : [];

            const [stats] = await db.execute<MusicStatistics[]>(`SELECT COUNT(*) as total_plays, COUNT(DISTINCT guild_id) as unique_guilds, COUNT(DISTINCT played_by) as unique_users, SUM(duration) as total_duration FROM music_statistics ${whereClause}`, params);
            const [topTracks] = await db.execute<TopTrack[]>(`SELECT track_title, track_source, COUNT(*) as play_count FROM music_statistics ${whereClause} GROUP BY track_title, track_source ORDER BY play_count DESC LIMIT 10`, params);

            return { ...stats[0], topTracks };
        } catch (error: any) {
            logger.error(`[MusicStatusManager] Failed to get music statistics: ${error.message}`, { guildId, error: error.message, category: 'music-status' });
            return { total_plays: 0, unique_guilds: 0, unique_users: 0, total_duration: 0, topTracks: [] };
        }
    }

    getGeneralStats(): GeneralStats {
        const uptime = Date.now() - this.startTime;
        // Count active voice connections from discord-player queues
        let voiceConnections = 0;
        if ((this.client as any).player && (this.client as any).player.queues) {
            voiceConnections = (this.client as any).player.queues.cache.size;
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

    formatUptime(ms: number): string {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return days + 'd ' + (hours % 24) + 'h ' + (minutes % 60) + 'm';
        if (hours > 0) return hours + 'h ' + (minutes % 60) + 'm';
        if (minutes > 0) return minutes + 'm ' + (seconds % 60) + 's';
        return seconds + 's';
    }
}

export = MusicStatusManager;
