const {EmbedBuilder, ActionRowBuilder, RoleSelectMenuBuilder} = require("discord.js");
const db = require("../../../utils/db");
const {logAuditEvent} = require("../../../utils/audit-log.js");

module.exports = {
  customId: /^setup_channel_/,
  async execute(interaction) {
    if (interaction.user.id !== interaction.customId.split("_")[2]) {
      return interaction.reply({content: "This is not your setup session.", ephemeral: true});
    }

    const channelId = interaction.values[0];
    const channel = await interaction.guild.channels.fetch(channelId);

    await db.execute("INSERT INTO guilds (guild_id, announcement_channel_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE announcement_channel_id = VALUES(announcement_channel_id)", [interaction.guild.id, channelId]);
    await logAuditEvent(interaction, "Setup: Default Channel Set", `The default announcement channel was set to ${channel}.`);

    const embed = new EmbedBuilder()
      .setColor("#5865F2")
      .setTitle("Step 2: Live Role (Optional)")
      .setDescription("You can have the bot assign a specific role to users when they go live. Select a role below, or skip this step if you don\\'t need this feature.");

    const roleSelect = new RoleSelectMenuBuilder()
      .setCustomId(`setup_role_${interaction.user.id}`)
      .setPlaceholder("Select a live role (or skip)");

    const row = new ActionRowBuilder().addComponents(roleSelect);

    await interaction.update({embeds: [embed], components: [row]});
  },
};