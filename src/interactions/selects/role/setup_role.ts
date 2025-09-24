const {EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle} = require("discord.js");
const db = require("../../../utils/db");
const {logAuditEvent} = require("../../../utils/audit-log.js");

module.exports = {
  customId: /^setup_role_/,
  async execute(interaction) {
    if (interaction.user.id !== interaction.customId.split("_")[2]) {
      return interaction.reply({content: "This is not your setup session.", ephemeral: true});
    }

    const roleId = interaction.values[0];
    const role = await interaction.guild.roles.fetch(roleId);

    await db.execute("INSERT INTO guilds (guild_id, live_role_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE live_role_id = VALUES(live_role_id)", [interaction.guild.id, roleId]);
    await logAuditEvent(interaction, "Setup: Live Role Set", `The live role was set to **${role.name}**.`);

    const embed = new EmbedBuilder()
      .setColor("#5865F2")
      .setTitle("Step 3: Avatar Upload Channel")
      .setDescription("To use custom webhook avatars, the bot needs a private text channel on this server to store the images in. Please select a channel for this purpose.\n\nThis is a **highly recommended** step for customization.");

    const channelSelectButton = new ButtonBuilder()
      .setCustomId(`setup_avatar_channel_select_${interaction.user.id}`)
      .setLabel("Select Avatar Channel")
      .setStyle(ButtonStyle.Primary);

    const skipButton = new ButtonBuilder()
      .setCustomId(`setup_skip_avatar_${interaction.user.id}`)
      .setLabel("Skip For Now")
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(channelSelectButton, skipButton);

    await interaction.update({embeds: [embed], components: [row]});
  },
};