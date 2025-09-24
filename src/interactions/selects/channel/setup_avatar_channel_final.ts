const {EmbedBuilder} = require("discord.js");
const db = require("../../../utils/db");
const {logAuditEvent} = require("../../../utils/audit-log.js");

module.exports = {
  customId: /^setup_avatar_channel_final_/,
  async execute(interaction) {
    if (interaction.user.id !== interaction.customId.split("_")[4]) {
      return interaction.reply({content: "This is not your setup session.", ephemeral: true});
    }

    const channelId = interaction.values[0];
    const channel = await interaction.guild.channels.fetch(channelId);

    await db.execute("INSERT INTO guilds (guild_id, avatar_upload_channel_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE avatar_upload_channel_id = VALUES(avatar_upload_channel_id)", [interaction.guild.id, channelId]);
    await logAuditEvent(interaction, "Setup: Avatar Channel Set", `The avatar upload channel was set to ${channel}.`);

    const embed = new EmbedBuilder()
      .setColor("#57F287")
      .setTitle("✅ Essential Setup Complete!")
      .setDescription("You have completed the essential setup for LiveBot!\n\nYou can always run `/config` to change these settings later or to explore more advanced customization options.");

    await interaction.update({embeds: [embed], components: []});
  },
};