const db = require('../utils/db');
const logger = require('../utils/logger');
const { ChannelType, PermissionsBitField } = require('discord.js');

// In-memory set to track bot-created channels
const tempChannels = new Set();

async function handleVoiceStateUpdate(oldState, newState) {
    const guildId = newState.guild.id;
    try {
        const [[config]] = await db.execute('SELECT * FROM temp_channel_config WHERE guild_id = ?', [guildId]);

        if (!config || !config.creator_channel_id) return;
        
        // User joins the "Join to Create" channel
        if (newState.channelId === config.creator_channel_id) {
            const member = newState.member;
            const namingTemplate = config.naming_template || "{user}'s Channel";
            const channelName = namingTemplate.replace(/{user}/g, member.displayName);

            try {
                const newChannel = await newState.guild.channels.create({
                    name: channelName,
                    type: ChannelType.GuildVoice,
                    parent: config.category_id,
                    permissionOverwrites: [
                        {
                            id: member.id,
                            allow: [PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.MuteMembers, PermissionsBitField.Flags.DeafenMembers, PermissionsBitField.Flags.MoveMembers],
                        },
                    ],
                });

                await member.voice.setChannel(newChannel);
                tempChannels.add(newChannel.id);
                logger.info(`Created temp channel "${channelName}" for ${member.user.tag}.`, { guildId, category: 'temp-channels' });

            } catch (error) {
                logger.error(`Failed to create temp channel for ${member.user.tag}.`, { guildId, category: 'temp-channels', error: error.stack });
            }
        }

        // User leaves a voice channel, check if it was a temporary one
        if (oldState.channelId && tempChannels.has(oldState.channelId)) {
            const oldChannel = oldState.channel;
            if (oldChannel && oldChannel.members.size === 0) {
                try {
                    await oldChannel.delete('Temporary channel is now empty.');
                    tempChannels.delete(oldChannel.id);
                    logger.info(`Deleted empty temp channel "${oldChannel.name}".`, { guildId, category: 'temp-channels' });
                } catch (error) {
                    logger.error(`Failed to delete temp channel ${oldChannel.id}.`, { guildId, category: 'temp-channels', error: error.stack });
                }
            }
        }
    } catch (error) {
        logger.error('Error in voice state update for temp channels.', { guildId, category: 'temp-channels', error: error.stack });
    }
}

module.exports = { handleVoiceStateUpdate };