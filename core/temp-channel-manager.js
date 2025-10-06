
const db = require('../utils/db');
const logger = require('../utils/logger');
const { ChannelType, PermissionsBitField } = require('discord.js');

// In-memory set to track bot-created channels
const tempChannels = new Set();

async function handleVoiceStateUpdate(oldState, newState) {
    const guildId = newState.guild.id;
    const [[config]] = await db.execute('SELECT * FROM temp_channel_config WHERE guild_id = ?', [guildId]);

    // Check if the feature is configured for this guild
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

            // Move the user to their new channel
            await member.voice.setChannel(newChannel);
            tempChannels.add(newChannel.id); // Track this as a temporary channel

        } catch (error) {
            logger.error(`[TempChannel] Failed to create temp channel for ${member.user.tag}:`, error);
        }
    }

    // User leaves a voice channel, check if it was a temporary one
    if (oldState.channelId && tempChannels.has(oldState.channelId)) {
        const oldChannel = oldState.channel;
        // If the channel is now empty, delete it
        if (oldChannel && oldChannel.members.size === 0) {
            try {
                await oldChannel.delete('Temporary channel is now empty.');
                tempChannels.delete(oldChannel.id); // Stop tracking it
            } catch (error) {
                logger.error(`[TempChannel] Failed to delete temp channel ${oldChannel.id}:`, error);
            }
        }
    }
}

module.exports = { handleVoiceStateUpdate };
