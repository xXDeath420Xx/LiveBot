import logger from '../utils/logger';
import db from '../utils/db';
import { Client, GuildMember, VoiceState, VoiceChannel } from 'discord.js';
import { RowDataPacket } from 'mysql2';

interface VoiceSession {
    joinedAt: Date;
    channelId: string;
}

interface AutoVoiceConfig extends RowDataPacket {
    guild_id: string;
    trigger_channel_id: string;
    category_id: string;
    channel_name_format: string;
    user_limit: number | null;
    bitrate: number | null;
    enabled: boolean;
}

interface TempVoiceChannel extends RowDataPacket {
    channel_id: string;
    guild_id: string;
    owner_id: string;
    created_at: Date;
}

interface VoiceActivityStats extends RowDataPacket {
    total_time: number;
    session_count: number;
}

interface TopVoiceUser extends RowDataPacket {
    user_id: string;
    total_time: number;
    sessions: number;
}

class VoiceActivityManager {
    private client: Client;
    private activeSessions: Map<string, VoiceSession>;

    constructor(client: Client) {
        this.client = client;
        this.activeSessions = new Map();
        logger.info('[VoiceActivityManager] Voice activity manager initialized');
    }

    async handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
        try {
            const member = newState.member;
            if (!member || member.user.bot) return;

            const guildId = newState.guild.id;
            const userId = member.id;
            const key = `${guildId}_${userId}`;

            if (!oldState.channelId && newState.channelId) {
                await this.handleVoiceJoin(guildId, userId, newState.channelId);
                await this.handleAutoVoiceChannel(member, newState);
            } else if (oldState.channelId && !newState.channelId) {
                await this.handleVoiceLeave(guildId, userId, oldState.channelId);
                await this.handleTempChannelCleanup(oldState.channel);
            } else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
                await this.handleVoiceLeave(guildId, userId, oldState.channelId);
                await this.handleVoiceJoin(guildId, userId, newState.channelId);
                await this.handleTempChannelCleanup(oldState.channel);
            }
        } catch (error: any) {
            logger.error(`[VoiceActivityManager] Voice state update error: ${error.message}`, { error: error.message });
        }
    }

    async handleVoiceJoin(guildId: string, userId: string, channelId: string): Promise<void> {
        try {
            const key = `${guildId}_${userId}`;
            this.activeSessions.set(key, {
                joinedAt: new Date(),
                channelId
            });

            logger.info(`[VoiceActivityManager] User ${userId} joined voice channel ${channelId}`, { guildId, userId, channelId });
        } catch (error: any) {
            logger.error(`[VoiceActivityManager] Voice join error: ${error.message}`, { guildId, userId });
        }
    }

    async handleVoiceLeave(guildId: string, userId: string, channelId: string): Promise<void> {
        try {
            const key = `${guildId}_${userId}`;
            const session = this.activeSessions.get(key);

            if (session) {
                const leftAt = new Date();
                const duration = Math.floor((leftAt.getTime() - session.joinedAt.getTime()) / 1000);

                await db.execute(
                    'INSERT INTO voice_activity (guild_id, user_id, channel_id, joined_at, left_at, duration) VALUES (?, ?, ?, ?, ?, ?)',
                    [guildId, userId, channelId, session.joinedAt, leftAt, duration]
                );

                this.activeSessions.delete(key);
                logger.info(`[VoiceActivityManager] Logged voice session for ${userId}: ${duration}s`, { guildId, userId, duration });
            }
        } catch (error: any) {
            logger.error(`[VoiceActivityManager] Voice leave error: ${error.message}`, { guildId, userId });
        }
    }

    async handleAutoVoiceChannel(member: GuildMember, voiceState: VoiceState): Promise<void> {
        try {
            const [[config]] = await db.execute<AutoVoiceConfig[]>('SELECT * FROM auto_voice_config WHERE guild_id = ? AND enabled = 1', [member.guild.id]);
            if (!config || voiceState.channelId !== config.trigger_channel_id) return;

            const category = member.guild.channels.cache.get(config.category_id);
            if (!category) return;

            const channelName = config.channel_name_format
                .replace('{username}', member.user.username)
                .replace('{discriminator}', member.user.discriminator)
                .replace('{id}', member.id);

            const newChannel = await member.guild.channels.create({
                name: channelName,
                type: 2,
                parent: category.id,
                userLimit: config.user_limit || 0,
                bitrate: config.bitrate || 64000
            });

            await member.voice.setChannel(newChannel);

            await db.execute(
                'INSERT INTO temp_voice_channels (channel_id, guild_id, owner_id, created_at) VALUES (?, ?, ?, NOW())',
                [newChannel.id, member.guild.id, member.id]
            );

            logger.info(`[VoiceActivityManager] Created temp channel ${newChannel.name} for ${member.user.tag}`, { guildId: member.guild.id, channelId: newChannel.id });
        } catch (error: any) {
            logger.error(`[VoiceActivityManager] Auto voice channel error: ${error.message}`, { guildId: member.guild.id });
        }
    }

    async handleTempChannelCleanup(channel: VoiceChannel | null): Promise<void> {
        try {
            if (!channel) return;

            const [[tempChannel]] = await db.execute<TempVoiceChannel[]>('SELECT * FROM temp_voice_channels WHERE channel_id = ?', [channel.id]);
            if (!tempChannel) return;

            if (channel.members.size === 0) {
                await channel.delete('Temporary voice channel empty');
                await db.execute('DELETE FROM temp_voice_channels WHERE channel_id = ?', [channel.id]);
                logger.info(`[VoiceActivityManager] Deleted empty temp channel ${channel.name}`, { guildId: channel.guild.id, channelId: channel.id });
            }
        } catch (error: any) {
            logger.error(`[VoiceActivityManager] Temp channel cleanup error: ${error.message}`);
        }
    }

    async getVoiceActivityStats(guildId: string, userId: string | null = null): Promise<VoiceActivityStats> {
        try {
            let query = 'SELECT SUM(duration) as total_time, COUNT(*) as session_count FROM voice_activity WHERE guild_id = ?';
            const params: any[] = [guildId];

            if (userId) {
                query += ' AND user_id = ?';
                params.push(userId);
            }

            const [[stats]] = await db.execute<VoiceActivityStats[]>(query, params);
            return stats || { total_time: 0, session_count: 0 } as VoiceActivityStats;
        } catch (error: any) {
            logger.error(`[VoiceActivityManager] Stats error: ${error.message}`, { guildId, userId });
            return { total_time: 0, session_count: 0 } as VoiceActivityStats;
        }
    }

    async getTopVoiceUsers(guildId: string, limit: number = 10): Promise<TopVoiceUser[]> {
        try {
            const [users] = await db.execute<TopVoiceUser[]>(
                'SELECT user_id, SUM(duration) as total_time, COUNT(*) as sessions FROM voice_activity WHERE guild_id = ? GROUP BY user_id ORDER BY total_time DESC LIMIT ?',
                [guildId, limit]
            );
            return users;
        } catch (error: any) {
            logger.error(`[VoiceActivityManager] Top users error: ${error.message}`, { guildId });
            return [];
        }
    }

    formatDuration(seconds: number): string {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        if (hours > 0) return `${hours}h ${minutes}m`;
        return `${minutes}m`;
    }
}

export default VoiceActivityManager;
