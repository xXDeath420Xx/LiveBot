"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAvatarUploadChannel = getAvatarUploadChannel;
const discord_js_1 = require("discord.js");
const db_1 = __importDefault(require("./db"));
const logger_1 = require("./logger");
async function getAvatarUploadChannel(interaction) {
    const [guildSettingsRows] = await db_1.default.execute('SELECT avatar_upload_channel_id FROM guilds WHERE guild_id = ?', [interaction.guild.id]);
    const guildSettings = guildSettingsRows[0];
    const channelId = guildSettings?.avatar_upload_channel_id;
    if (!channelId) {
        await interaction.editReply({
            content: 'This server has not configured an avatar upload channel. An administrator must set one using `/config features set-avatar-channel` before using this feature.',
            // ephemeral: true // Note: ephemeral doesn't work with editReply
        });
        return null;
    }
    try {
        const channel = await interaction.client.channels.fetch(channelId);
        if (!channel || !(channel instanceof discord_js_1.TextChannel)) {
            throw new Error('Channel not found or is not a text channel.');
        }
        const botMember = await interaction.guild.members.fetch(interaction.client.user.id);
        const channelPermissions = botMember.permissionsIn(channel);
        if (!channelPermissions.has([discord_js_1.PermissionsBitField.Flags.SendMessages, discord_js_1.PermissionsBitField.Flags.AttachFiles])) {
            await interaction.editReply({
                content: `I do not have permission to send messages and attach files in the configured avatar channel (${channel}). Please check my permissions.`,
                // ephemeral: true
            });
            return null;
        }
        return channel;
    }
    catch (error) {
        logger_1.logger.error(`[Channel Helper] Error fetching avatar upload channel ${channelId} for guild ${interaction.guild.id}:`, { error });
        await interaction.editReply({
            content: 'The configured avatar upload channel could not be found or is invalid. An administrator may need to set a new one.',
            // ephemeral: true
        });
        return null;
    }
}
