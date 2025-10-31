import logger from '../utils/logger';
import db from '../utils/db';
import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, PermissionFlagsBits, ChannelType, Client, GuildMember, VoiceState, VoiceChannel, Guild } from 'discord.js';
import { RowDataPacket } from 'mysql2';

interface VoiceSession {
    joinedAt: Date;
    channelId: string;
}

interface PendingCreation {
    guildId: string;
    categoryId: string;
    timestamp: number;
}

interface TempChannelPermissions {
    ownerId: string;
    allowedUsers: string[];
}

interface AutoVoiceConfig extends RowDataPacket {
    guild_id: string;
    trigger_channel_id: string;
    category_id: string;
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

class EnhancedVoiceChannelManager {
    private client: Client;
    private activeSessions: Map<string, VoiceSession>;
    private pendingCreations: Map<string, PendingCreation>;
    private tempChannelPermissions: Map<string, TempChannelPermissions>;

    constructor(client: Client) {
        this.client = client;
        this.activeSessions = new Map();
        this.pendingCreations = new Map(); // Track users waiting for modal response
        this.tempChannelPermissions = new Map(); // Track custom permissions for temp channels
        logger.info('[EnhancedVoiceChannelManager] Enhanced voice channel manager initialized');
    }

    async handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
        try {
            const member = newState.member;
            if (!member || member.user.bot) return;

            const guildId = newState.guild.id;
            const userId = member.id;
            const key = `${guildId}_${userId}`;

            // User joined a voice channel
            if (!oldState.channelId && newState.channelId) {
                await this.handleVoiceJoin(guildId, userId, newState.channelId);
                await this.checkAutoVoiceChannelTrigger(member, newState);
            }
            // User left a voice channel
            else if (oldState.channelId && !newState.channelId) {
                await this.handleVoiceLeave(guildId, userId, oldState.channelId);
                await this.handleTempChannelCleanup(oldState.channel);
            }
            // User moved between channels
            else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
                await this.handleVoiceLeave(guildId, userId, oldState.channelId);
                await this.handleVoiceJoin(guildId, userId, newState.channelId);
                await this.handleTempChannelCleanup(oldState.channel);
                await this.checkAutoVoiceChannelTrigger(member, newState);
            }
        } catch (error: any) {
            logger.error(`[EnhancedVoiceChannelManager] Voice state update error: ${error.message}`, { error: error.message });
        }
    }

    async handleVoiceJoin(guildId: string, userId: string, channelId: string): Promise<void> {
        try {
            const key = `${guildId}_${userId}`;
            this.activeSessions.set(key, {
                joinedAt: new Date(),
                channelId
            });

            logger.info(`[EnhancedVoiceChannelManager] User ${userId} joined voice channel ${channelId}`, { guildId, userId, channelId });
        } catch (error: any) {
            logger.error(`[EnhancedVoiceChannelManager] Voice join error: ${error.message}`, { guildId, userId });
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
                logger.info(`[EnhancedVoiceChannelManager] Logged voice session for ${userId}: ${duration}s`, { guildId, userId, duration });
            }
        } catch (error: any) {
            logger.error(`[EnhancedVoiceChannelManager] Voice leave error: ${error.message}`, { guildId, userId });
        }
    }

    async checkAutoVoiceChannelTrigger(member: GuildMember, voiceState: VoiceState): Promise<void> {
        try {
            const [[config]] = await db.execute<AutoVoiceConfig[]>('SELECT * FROM auto_voice_config WHERE guild_id = ? AND enabled = 1', [member.guild.id]);
            if (!config || voiceState.channelId !== config.trigger_channel_id) return;

            // User joined the trigger channel - they need to fill out the modal
            this.pendingCreations.set(member.id, {
                guildId: member.guild.id,
                categoryId: config.category_id,
                timestamp: Date.now()
            });

            // Send them a DM with instructions and a button to open the modal
            try {
                await member.send({
                    content: `👋 Welcome to the Voice Channel Hub!\n\nYou've joined the channel creator. Use the **/voice create** command in the server to customize your temporary voice channel!`
                });
            } catch (dmError) {
                logger.warn(`[EnhancedVoiceChannelManager] Could not DM user ${member.user.tag}`, { guildId: member.guild.id });
            }

            // Auto-create with defaults after 10 seconds if they don't respond
            setTimeout(async () => {
                if (this.pendingCreations.has(member.id)) {
                    await this.createDefaultVoiceChannel(member, config);
                }
            }, 10000);

        } catch (error: any) {
            logger.error(`[EnhancedVoiceChannelManager] Trigger check error: ${error.message}`, { guildId: member.guild.id });
        }
    }

    async createDefaultVoiceChannel(member: GuildMember, config: AutoVoiceConfig): Promise<void> {
        try {
            const pending = this.pendingCreations.get(member.id);
            if (!pending) return;

            const category = member.guild.channels.cache.get(config.category_id);
            if (!category) return;

            const channelName = `${member.user.username}'s Channel`;

            const newChannel = await member.guild.channels.create({
                name: channelName,
                type: ChannelType.GuildVoice,
                parent: category.id,
                userLimit: config.user_limit || 0,
                bitrate: config.bitrate || 64000
            });

            // Move user to the new channel
            if (member.voice.channelId) {
                await member.voice.setChannel(newChannel);
            }

            // Save to database
            await db.execute(
                'INSERT INTO temp_voice_channels (channel_id, guild_id, owner_id, created_at) VALUES (?, ?, ?, NOW())',
                [newChannel.id, member.guild.id, member.id]
            );

            this.pendingCreations.delete(member.id);

            logger.info(`[EnhancedVoiceChannelManager] Created default temp channel for ${member.user.tag}`, {
                guildId: member.guild.id,
                channelId: newChannel.id
            });
        } catch (error: any) {
            logger.error(`[EnhancedVoiceChannelManager] Default channel creation error: ${error.message}`);
        }
    }

    async createCustomVoiceChannel(member: GuildMember, channelName: string, userLimit: number, isPrivate: boolean, allowedUsers: string[] = []): Promise<VoiceChannel | null> {
        try {
            const pending = this.pendingCreations.get(member.id);
            if (!pending) {
                logger.warn(`[EnhancedVoiceChannelManager] No pending creation for ${member.user.tag}`);
                return null;
            }

            const guild = member.guild;
            const category = guild.channels.cache.get(pending.categoryId);
            if (!category) return null;

            // Create the channel
            const newChannel = await guild.channels.create({
                name: channelName || `${member.user.username}'s Channel`,
                type: ChannelType.GuildVoice,
                parent: category.id,
                userLimit: userLimit || 0,
                bitrate: 64000
            });

            // Set up permissions if private
            if (isPrivate) {
                // Deny @everyone
                await newChannel.permissionOverwrites.create(guild.id, {
                    Connect: false,
                    ViewChannel: false
                });

                // Allow owner
                await newChannel.permissionOverwrites.create(member.id, {
                    Connect: true,
                    ViewChannel: true,
                    ManageChannels: true,
                    MoveMembers: true,
                    MuteMembers: true
                });

                // Allow specified users
                for (const userId of allowedUsers) {
                    await newChannel.permissionOverwrites.create(userId, {
                        Connect: true,
                        ViewChannel: true
                    });
                }

                // Store allowed users for this channel
                this.tempChannelPermissions.set(newChannel.id, {
                    ownerId: member.id,
                    allowedUsers: [member.id, ...allowedUsers]
                });
            } else {
                // Give owner special permissions even in public channels
                await newChannel.permissionOverwrites.create(member.id, {
                    ManageChannels: true,
                    MoveMembers: true,
                    MuteMembers: true
                });
            }

            // Move user to new channel
            if (member.voice.channelId) {
                await member.voice.setChannel(newChannel);
            }

            // Save to database
            await db.execute(
                'INSERT INTO temp_voice_channels (channel_id, guild_id, owner_id, created_at) VALUES (?, ?, ?, NOW())',
                [newChannel.id, guild.id, member.id]
            );

            this.pendingCreations.delete(member.id);

            logger.info(`[EnhancedVoiceChannelManager] Created custom temp channel "${channelName}" for ${member.user.tag}`, {
                guildId: guild.id,
                channelId: newChannel.id,
                isPrivate,
                userLimit
            });

            return newChannel;
        } catch (error: any) {
            logger.error(`[EnhancedVoiceChannelManager] Custom channel creation error: ${error.message}`);
            return null;
        }
    }

    async handleTempChannelCleanup(channel: VoiceChannel | null): Promise<void> {
        try {
            if (!channel) return;

            const [[tempChannel]] = await db.execute<TempVoiceChannel[]>('SELECT * FROM temp_voice_channels WHERE channel_id = ?', [channel.id]);
            if (!tempChannel) return;

            // Check if channel is empty
            if (channel.members.size === 0) {
                await channel.delete('Temporary voice channel empty');
                await db.execute('DELETE FROM temp_voice_channels WHERE channel_id = ?', [channel.id]);
                this.tempChannelPermissions.delete(channel.id);
                logger.info(`[EnhancedVoiceChannelManager] Deleted empty temp channel ${channel.name}`, {
                    guildId: channel.guild.id,
                    channelId: channel.id
                });
            }
        } catch (error: any) {
            logger.error(`[EnhancedVoiceChannelManager] Temp channel cleanup error: ${error.message}`);
        }
    }

    async allowUserToChannel(channelId: string, userId: string): Promise<boolean> {
        try {
            const channel = this.client.channels.cache.get(channelId) as VoiceChannel | undefined;
            if (!channel) return false;

            await channel.permissionOverwrites.create(userId, {
                Connect: true,
                ViewChannel: true
            });

            // Update stored permissions
            const perms = this.tempChannelPermissions.get(channelId);
            if (perms) {
                perms.allowedUsers.push(userId);
                this.tempChannelPermissions.set(channelId, perms);
            }

            logger.info(`[EnhancedVoiceChannelManager] Allowed user ${userId} to channel ${channelId}`);
            return true;
        } catch (error: any) {
            logger.error(`[EnhancedVoiceChannelManager] Failed to allow user: ${error.message}`);
            return false;
        }
    }

    async removeUserFromChannel(channelId: string, userId: string): Promise<boolean> {
        try {
            const channel = this.client.channels.cache.get(channelId) as VoiceChannel | undefined;
            if (!channel) return false;

            await channel.permissionOverwrites.delete(userId);

            // Update stored permissions
            const perms = this.tempChannelPermissions.get(channelId);
            if (perms) {
                perms.allowedUsers = perms.allowedUsers.filter(id => id !== userId);
                this.tempChannelPermissions.set(channelId, perms);
            }

            logger.info(`[EnhancedVoiceChannelManager] Removed user ${userId} from channel ${channelId}`);
            return true;
        } catch (error: any) {
            logger.error(`[EnhancedVoiceChannelManager] Failed to remove user: ${error.message}`);
            return false;
        }
    }

    async isChannelOwner(channelId: string, userId: string): Promise<boolean> {
        try {
            const [[tempChannel]] = await db.execute<TempVoiceChannel[]>(
                'SELECT owner_id FROM temp_voice_channels WHERE channel_id = ?',
                [channelId]
            );
            return tempChannel && tempChannel.owner_id === userId;
        } catch (error: any) {
            logger.error(`[EnhancedVoiceChannelManager] Owner check error: ${error.message}`);
            return false;
        }
    }

    hasPendingCreation(userId: string): boolean {
        return this.pendingCreations.has(userId);
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
            logger.error(`[EnhancedVoiceChannelManager] Stats error: ${error.message}`, { guildId, userId });
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
            logger.error(`[EnhancedVoiceChannelManager] Top users error: ${error.message}`, { guildId });
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

export default EnhancedVoiceChannelManager;
