const {EmbedBuilder, EmbedFooterOptions} = require("discord.js");
const db = require("./db");
const logger = require("./logger");

async function logAuditEvent(interaction, title, description) {
  try {
    const [[guildSettings]] = await db.execute("SELECT audit_log_channel_id FROM guilds WHERE guild_id = ?", [interaction.guild.id]);
    const channelId = guildSettings?.audit_log_channel_id;

    if (!channelId) {
      return; // This guild has not configured an audit log channel.
    }

    const auditChannel = await interaction.client.channels.fetch(channelId).catch(() => null);
    if (!auditChannel || !auditChannel.isTextBased()) {
      logger.warn(`[Audit Log] Guild ${interaction.guild.id} has an invalid audit channel ID: ${channelId}`);
      return;
    }
    const footer = { text: `Action performed by: ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL().toString() };
    const embed = new EmbedBuilder()
      .setColor("#FEE75C")
      .setTitle(title)
      .setDescription(description)
      .setTimestamp()
      .setFooter(footer);

    await auditChannel.send({embeds: [embed]});

  } catch (error) {
    logger.error(`[Audit Log] Failed to send audit log for guild ${interaction.guild.id}:`, {error});
  }
}

module.exports = {logAuditEvent};