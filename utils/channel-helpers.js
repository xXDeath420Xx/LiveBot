const {PermissionsBitField} = require("discord.js");
const db = require("./db");

async function getAvatarUploadChannel(interaction) {
  const [[guildSettings]] = await db.execute("SELECT avatar_upload_channel_id FROM guilds WHERE guild_id = ?", [interaction.guild.id]);
  const channelId = guildSettings?.avatar_upload_channel_id;

  if (!channelId) {
    await interaction.editReply({content: "This server has not configured an avatar upload channel. An administrator must set one using `/config features set-avatar-channel` before using this feature.", ephemeral: true});
    return null;
  }

  try {
    const channel = await interaction.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error("Channel not found or is not a text channel.");
    }

    const botMember = await interaction.guild.members.fetch(interaction.client.user.id);
    if (!botMember.permissionsIn(channel).has([PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.AttachFiles])) {
      await interaction.editReply({content: `I do not have permission to send messages and attach files in the configured avatar channel (${channel}). Please check my permissions.`, ephemeral: true});
      return null;
    }
    return channel;
  } catch (error) {
    console.error("Error fetching avatar upload channel:", error);
    await interaction.editReply({content: "The configured avatar upload channel could not be found or is invalid. An administrator may need to set a new one.", ephemeral: true});
    return null;
  }
}

module.exports = {getAvatarUploadChannel};