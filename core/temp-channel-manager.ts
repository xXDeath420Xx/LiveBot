import db from '../utils/db';
import logger from '../utils/logger';
import { ChannelType, PermissionsBitField, VoiceState, VoiceChannel, GuildMember } from 'discord.js';
import { RowDataPacket } from 'mysql2';

interface TempChannelConfig extends RowDataPacket {
    guild_id: string;
    creator_channel_id: string;
    category_id: string;
    naming_template: string;
}

// In-memory set to track bot-created channels
const tempChannels = new Set<string>();

async function handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
    const guildId = newState.guild.id;
    try {
        const [[config]] = await db.execute<TempChannelConfig[]>('SELECT * FROM temp_channel_config WHERE guild_id = ?', [guildId]);

        if (!config || !config.creator_channel_id) return;

        // User joins the "Join to Create" channel
        if (newState.channelId === config.creator_channel_id) {
            const member = newState.member;
            if (!member) return;

            const namingTemplate = config.naming_template || "{user}'s Channel";
            const channelName = namingTemplate.replace(/{user}/g, member.displayName);

            let newChannel: VoiceChannel | undefined;
            try {
                newChannel = await newState.guild.channels.create({
                    name: channelName,
                    type: ChannelType.GuildVoice,
                    parent: config.category_id,
                    permissionOverwrites: [
                        {
                            id: newState.guild.roles.everyone,
                            deny: [PermissionsBitField.Flags.ViewChannel],
                        },
                    ],
                });

                tempChannels.add(newChannel.id);

                // Grant permissions to the user *before* moving them
                await newChannel.permissionOverwrites.edit(member.id, {
                    allow: [
                        PermissionsBitField.Flags.ViewChannel,
                        PermissionsBitField.Flags.ManageChannels,
                        PermissionsBitField.Flags.MuteMembers,
                        PermissionsBitField.Flags.DeafenMembers,
                        PermissionsBitField.Flags.MoveMembers,
                        PermissionsBitField.Flags.Connect,
                    ],
                });

                // Re-fetch the member to ensure they are still in the creator channel
                const freshMember = await newState.guild.members.fetch({ user: member.id, force: true });

                if (freshMember.voice.channelId === config.creator_channel_id) {
                    await freshMember.voice.setChannel(newChannel);
                    logger.info(`Created temp channel "${channelName}" for ${member.user.tag}.`, { guildId, category: 'temp-channels' });
                } else {
                    logger.warn(`User ${member.user.tag} left creator channel before move. Deleting temp channel ${newChannel.name}.`, { guildId, category: 'temp-channels' });
                    await newChannel.delete('User left before being moved.');
                    tempChannels.delete(newChannel.id);
                }

            } catch (error: any) {
                if (error.code === 40032) { // Target user is not connected to voice.
                    logger.warn(`User ${member.user.tag} left creator channel before move could complete. Cleaning up.`, { guildId, category: 'temp-channels' });
                } else {
                    logger.error(`Failed to create or move user to temp channel.`, { guildId, category: 'temp-channels', error: error.stack });
                }

                if (newChannel) {
                    await newChannel.delete('Error or user left during temp channel creation.').catch(e => logger.error(`Failed to cleanup channel ${newChannel!.id}`, { guildId, error: e.stack }));
                    tempChannels.delete(newChannel.id);
                }
            }
        }

        // User leaves a voice channel, check if it was a temporary one
        if (oldState.channelId && tempChannels.has(oldState.channelId)) {
            const oldChannel = oldState.channel;
            if (oldChannel && oldChannel.members.size === 0) {
                setTimeout(async () => {
                    const freshChannel = await oldState.guild.channels.fetch(oldState.channelId!).catch(() => null) as VoiceChannel | null;
                    if (freshChannel && freshChannel.members.size === 0) {
                        try {
                            await freshChannel.delete('Temporary channel is now empty.');
                            tempChannels.delete(freshChannel.id);
                            logger.info(`Deleted empty temp channel "${freshChannel.name}".`, { guildId, category: 'temp-channels' });
                        } catch (error: any) {
                            logger.error(`Failed to delete temp channel ${freshChannel.id}.`, { guildId, category: 'temp-channels', error: error.stack });
                        }
                    }
                }, 5000);
            }
        }
    } catch (error: any) {
        logger.error('Error in voice state update for temp channels.', { guildId, category: 'temp-channels', error: error.stack });
    }
}

export { handleVoiceStateUpdate };
