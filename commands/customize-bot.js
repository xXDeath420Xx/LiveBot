const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('customize-bot')
    .setDescription("Changes the bot's appearance (nickname/avatar) on this server.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .addStringOption(option => 
        option.setName('nickname')
            .setDescription('The new nickname for the bot on this server (32 chars max). Type \"reset\" to remove.')
            .setRequired(false))
    .addAttachmentOption(option => 
        option.setName('avatar')
            .setDescription('The new avatar the bot will use for announcements.')
            .setRequired(false))
    .addBooleanOption(option =>
        option.setName('reset_avatar')
            .setDescription('Set to true to reset the custom announcement avatar to bot default.')
            .setRequired(false)),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const newNickname = interaction.options.getString('nickname');
    const newAvatar = interaction.options.getAttachment('avatar');
    const resetAvatarFlag = interaction.options.getBoolean('reset_avatar');
    const guildId = interaction.guild.id;

    const shouldResetNickname = newNickname?.toLowerCase() === 'reset';

    let nicknameUpdated = false;
    let avatarUpdated = false;
    let avatarReset = false;
    let finalAvatarUrlForEmbed = null;

    try {
        const botMember = interaction.guild.members.me;

        if (shouldResetNickname) {
            try {
                await botMember.setNickname(null);
                await db.execute('UPDATE guilds SET bot_nickname = NULL WHERE guild_id = ?', [guildId]);
                nicknameUpdated = true;
            } catch (e) {
                return interaction.editReply({ content: "Failed to reset nickname. My role is likely not high enough in the role list or I lack permissions." });
            }
        } else if (newNickname) {
            try {
                await botMember.setNickname(newNickname);
                await db.execute('UPDATE guilds SET bot_nickname = ? WHERE guild_id = ?', [newNickname, guildId]);
                nicknameUpdated = true;
            } catch (e) {
                return interaction.editReply({ content: "Failed to set nickname. My role is likely not high enough in the role list." });
            }
        }
        
        let permanentAvatarUrl = undefined;
        if (resetAvatarFlag) {
            permanentAvatarUrl = null;
            avatarReset = true;
        } else if (newAvatar) {
            if (!newAvatar.contentType.startsWith('image/')) {
                return interaction.editReply({ content: 'Avatar must be an image file (PNG, JPG, GIF).' });
            }
            const tempUploadChannelId = process.env.TEMP_UPLOAD_CHANNEL_ID;
            if (!tempUploadChannelId) {
                throw new Error("Temporary upload channel ID is not configured. Set TEMP_UPLOAD_CHANNEL_ID in your .env file.");
            }
            try {
                const tempChannel = await interaction.client.channels.fetch(tempUploadChannelId);
                if (!tempChannel) throw new Error("Temporary upload channel not found.");
                
                const tempMessage = await tempChannel.send({ files: [{ attachment: newAvatar.url, name: newAvatar.name }] });
                permanentAvatarUrl = tempMessage.attachments.first().url;
                avatarUpdated = true;
            } catch (uploadError) {
                console.error('[Customize Bot Command] Error uploading temporary avatar to Discord:', uploadError);
                return interaction.editReply({ content: "Failed to upload custom avatar. Check bot's permissions or TEMP_UPLOAD_CHANNEL_ID." });
            }
        }

        if (permanentAvatarUrl !== undefined) {
            await db.execute('UPDATE guilds SET webhook_avatar_url = ? WHERE guild_id = ?', [permanentAvatarUrl, guildId]);
            finalAvatarUrlForEmbed = permanentAvatarUrl;
        }

        if (!nicknameUpdated && !avatarUpdated && !avatarReset) {
            return interaction.editReply({ content: 'No changes were requested.' });
        }

        const embed = new EmbedBuilder().setColor('#57F287').setTitle('Bot Appearance Updated!');
        let description = '';
        if (shouldResetNickname) description += 'Bot nickname has been reset to default.\n';
        else if (nicknameUpdated) description += `Nickname set to: **${newNickname}**\n`;

        if (avatarReset) description += 'Announcement avatar has been reset to default.\n';
        else if (avatarUpdated) description += 'Announcement avatar has been updated.\n';

        embed.setDescription(description.trim());

        if (avatarUpdated && finalAvatarUrlForEmbed) embed.setThumbnail(finalAvatarUrlForEmbed);
        else if (avatarReset) embed.setThumbnail(interaction.client.user.displayAvatarURL());
        
        await interaction.editReply({ embeds: [embed] });

    } catch (error) {
        console.error('Customize Bot Error:', error);
        await interaction.editReply({ content: `An error occurred: ${error.message}` });
    }
  }
};