"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleVoiceStateUpdate = handleVoiceStateUpdate;
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
const discord_js_1 = require("discord.js");
// In-memory set to track bot-created channels
const tempChannels = new Set();
async function handleVoiceStateUpdate(oldState, newState) {
    const guildId = newState.guild.id;
    try {
        const [[config]] = await db_1.default.execute('SELECT * FROM temp_channel_config WHERE guild_id = ?', [guildId]);
        if (!config || !config.creator_channel_id)
            return;
        // User joins the "Join to Create" channel
        if (newState.channelId === config.creator_channel_id) {
            const member = newState.member;
            if (!member)
                return;
            const namingTemplate = config.naming_template || "{user}'s Channel";
            const channelName = namingTemplate.replace(/{user}/g, member.displayName);
            let newChannel;
            try {
                newChannel = await newState.guild.channels.create({
                    name: channelName,
                    type: discord_js_1.ChannelType.GuildVoice,
                    parent: config.category_id,
                    permissionOverwrites: [
                        {
                            id: newState.guild.roles.everyone,
                            deny: [discord_js_1.PermissionsBitField.Flags.ViewChannel],
                        },
                    ],
                });
                tempChannels.add(newChannel.id);
                // Grant permissions to the user *before* moving them
                await newChannel.permissionOverwrites.edit(member.id, {
                    allow: [
                        discord_js_1.PermissionsBitField.Flags.ViewChannel,
                        discord_js_1.PermissionsBitField.Flags.ManageChannels,
                        discord_js_1.PermissionsBitField.Flags.MuteMembers,
                        discord_js_1.PermissionsBitField.Flags.DeafenMembers,
                        discord_js_1.PermissionsBitField.Flags.MoveMembers,
                        discord_js_1.PermissionsBitField.Flags.Connect,
                    ],
                });
                // Re-fetch the member to ensure they are still in the creator channel
                const freshMember = await newState.guild.members.fetch({ user: member.id, force: true });
                if (freshMember.voice.channelId === config.creator_channel_id) {
                    await freshMember.voice.setChannel(newChannel);
                    logger_1.default.info(`Created temp channel "${channelName}" for ${member.user.tag}.`, { guildId, category: 'temp-channels' });
                }
                else {
                    logger_1.default.warn(`User ${member.user.tag} left creator channel before move. Deleting temp channel ${newChannel.name}.`, { guildId, category: 'temp-channels' });
                    await newChannel.delete('User left before being moved.');
                    tempChannels.delete(newChannel.id);
                }
            }
            catch (error) {
                if (error.code === 40032) { // Target user is not connected to voice.
                    logger_1.default.warn(`User ${member.user.tag} left creator channel before move could complete. Cleaning up.`, { guildId, category: 'temp-channels' });
                }
                else {
                    logger_1.default.error(`Failed to create or move user to temp channel.`, { guildId, category: 'temp-channels', error: error.stack });
                }
                if (newChannel) {
                    await newChannel.delete('Error or user left during temp channel creation.').catch(e => logger_1.default.error(`Failed to cleanup channel ${newChannel.id}`, { guildId, error: e.stack }));
                    tempChannels.delete(newChannel.id);
                }
            }
        }
        // User leaves a voice channel, check if it was a temporary one
        if (oldState.channelId && tempChannels.has(oldState.channelId)) {
            const oldChannel = oldState.channel;
            if (oldChannel && oldChannel.members.size === 0) {
                setTimeout(async () => {
                    const freshChannel = await oldState.guild.channels.fetch(oldState.channelId).catch(() => null);
                    if (freshChannel && freshChannel.members.size === 0) {
                        try {
                            await freshChannel.delete('Temporary channel is now empty.');
                            tempChannels.delete(freshChannel.id);
                            logger_1.default.info(`Deleted empty temp channel "${freshChannel.name}".`, { guildId, category: 'temp-channels' });
                        }
                        catch (error) {
                            logger_1.default.error(`Failed to delete temp channel ${freshChannel.id}.`, { guildId, category: 'temp-channels', error: error.stack });
                        }
                    }
                }, 5000);
            }
        }
    }
    catch (error) {
        logger_1.default.error('Error in voice state update for temp channels.', { guildId, category: 'temp-channels', error: error.stack });
    }
}
