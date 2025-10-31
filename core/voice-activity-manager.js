"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const logger_1 = __importDefault(require("../utils/logger"));
const db_1 = __importDefault(require("../utils/db"));
class VoiceActivityManager {
    constructor(client) {
        this.client = client;
        this.activeSessions = new Map();
        logger_1.default.info('[VoiceActivityManager] Voice activity manager initialized');
    }
    async handleVoiceStateUpdate(oldState, newState) {
        try {
            const member = newState.member;
            if (!member || member.user.bot)
                return;
            const guildId = newState.guild.id;
            const userId = member.id;
            const key = `${guildId}_${userId}`;
            if (!oldState.channelId && newState.channelId) {
                await this.handleVoiceJoin(guildId, userId, newState.channelId);
                await this.handleAutoVoiceChannel(member, newState);
            }
            else if (oldState.channelId && !newState.channelId) {
                await this.handleVoiceLeave(guildId, userId, oldState.channelId);
                await this.handleTempChannelCleanup(oldState.channel);
            }
            else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
                await this.handleVoiceLeave(guildId, userId, oldState.channelId);
                await this.handleVoiceJoin(guildId, userId, newState.channelId);
                await this.handleTempChannelCleanup(oldState.channel);
            }
        }
        catch (error) {
            logger_1.default.error(`[VoiceActivityManager] Voice state update error: ${error.message}`, { error: error.message });
        }
    }
    async handleVoiceJoin(guildId, userId, channelId) {
        try {
            const key = `${guildId}_${userId}`;
            this.activeSessions.set(key, {
                joinedAt: new Date(),
                channelId
            });
            logger_1.default.info(`[VoiceActivityManager] User ${userId} joined voice channel ${channelId}`, { guildId, userId, channelId });
        }
        catch (error) {
            logger_1.default.error(`[VoiceActivityManager] Voice join error: ${error.message}`, { guildId, userId });
        }
    }
    async handleVoiceLeave(guildId, userId, channelId) {
        try {
            const key = `${guildId}_${userId}`;
            const session = this.activeSessions.get(key);
            if (session) {
                const leftAt = new Date();
                const duration = Math.floor((leftAt.getTime() - session.joinedAt.getTime()) / 1000);
                await db_1.default.execute('INSERT INTO voice_activity (guild_id, user_id, channel_id, joined_at, left_at, duration) VALUES (?, ?, ?, ?, ?, ?)', [guildId, userId, channelId, session.joinedAt, leftAt, duration]);
                this.activeSessions.delete(key);
                logger_1.default.info(`[VoiceActivityManager] Logged voice session for ${userId}: ${duration}s`, { guildId, userId, duration });
            }
        }
        catch (error) {
            logger_1.default.error(`[VoiceActivityManager] Voice leave error: ${error.message}`, { guildId, userId });
        }
    }
    async handleAutoVoiceChannel(member, voiceState) {
        try {
            const [[config]] = await db_1.default.execute('SELECT * FROM auto_voice_config WHERE guild_id = ? AND enabled = 1', [member.guild.id]);
            if (!config || voiceState.channelId !== config.trigger_channel_id)
                return;
            const category = member.guild.channels.cache.get(config.category_id);
            if (!category)
                return;
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
            await db_1.default.execute('INSERT INTO temp_voice_channels (channel_id, guild_id, owner_id, created_at) VALUES (?, ?, ?, NOW())', [newChannel.id, member.guild.id, member.id]);
            logger_1.default.info(`[VoiceActivityManager] Created temp channel ${newChannel.name} for ${member.user.tag}`, { guildId: member.guild.id, channelId: newChannel.id });
        }
        catch (error) {
            logger_1.default.error(`[VoiceActivityManager] Auto voice channel error: ${error.message}`, { guildId: member.guild.id });
        }
    }
    async handleTempChannelCleanup(channel) {
        try {
            if (!channel)
                return;
            const [[tempChannel]] = await db_1.default.execute('SELECT * FROM temp_voice_channels WHERE channel_id = ?', [channel.id]);
            if (!tempChannel)
                return;
            if (channel.members.size === 0) {
                await channel.delete('Temporary voice channel empty');
                await db_1.default.execute('DELETE FROM temp_voice_channels WHERE channel_id = ?', [channel.id]);
                logger_1.default.info(`[VoiceActivityManager] Deleted empty temp channel ${channel.name}`, { guildId: channel.guild.id, channelId: channel.id });
            }
        }
        catch (error) {
            logger_1.default.error(`[VoiceActivityManager] Temp channel cleanup error: ${error.message}`);
        }
    }
    async getVoiceActivityStats(guildId, userId = null) {
        try {
            let query = 'SELECT SUM(duration) as total_time, COUNT(*) as session_count FROM voice_activity WHERE guild_id = ?';
            const params = [guildId];
            if (userId) {
                query += ' AND user_id = ?';
                params.push(userId);
            }
            const [[stats]] = await db_1.default.execute(query, params);
            return stats || { total_time: 0, session_count: 0 };
        }
        catch (error) {
            logger_1.default.error(`[VoiceActivityManager] Stats error: ${error.message}`, { guildId, userId });
            return { total_time: 0, session_count: 0 };
        }
    }
    async getTopVoiceUsers(guildId, limit = 10) {
        try {
            const [users] = await db_1.default.execute('SELECT user_id, SUM(duration) as total_time, COUNT(*) as sessions FROM voice_activity WHERE guild_id = ? GROUP BY user_id ORDER BY total_time DESC LIMIT ?', [guildId, limit]);
            return users;
        }
        catch (error) {
            logger_1.default.error(`[VoiceActivityManager] Top users error: ${error.message}`, { guildId });
            return [];
        }
    }
    formatDuration(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        if (hours > 0)
            return `${hours}h ${minutes}m`;
        return `${minutes}m`;
    }
}
exports.default = VoiceActivityManager;
