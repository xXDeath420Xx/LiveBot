const {SlashCommandBuilder, PermissionsBitField, EmbedBuilder} = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("transfer")
    .setDescription("Transfers the current ticket to another staff member.")
    .addUserOption(option =>
      option.setName("member")
        .setDescription("The staff member to transfer the ticket to.")
        .setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});
    const guildId = interaction.guild.id;
    const channelId = interaction.channel.id;
    const currentStaff = interaction.member;
    const newStaff = interaction.options.getMember("member");

    try {
      const [[ticket]] = await db.execute("SELECT * FROM tickets WHERE guild_id = ? AND channel_id = ?", [guildId, channelId]);
      if (!ticket) {
        return interaction.editReply("This command can only be used in an active ticket channel.");
      }

      if (ticket.status === "closed") {
        return interaction.editReply("This ticket has already been closed.");
      }

      const [[config]] = await db.execute("SELECT support_role_id FROM ticket_config WHERE guild_id = ?", [guildId]);
      if (!config || !currentStaff.roles.cache.has(config.support_role_id)) {
        return interaction.editReply("You do not have the required support role to manage tickets.");
      }

      if (!newStaff || !newStaff.roles.cache.has(config.support_role_id)) {
        return interaction.editReply("The selected user is not a valid support staff member.");
      }

      if (ticket.claimed_by_id === newStaff.id) {
        return interaction.editReply("This ticket is already claimed by that staff member.");
      }

      await db.execute("UPDATE tickets SET claimed_by_id = ? WHERE id = ?", [newStaff.id, ticket.id]);

      const transferEmbed = new EmbedBuilder()
        .setColor("#3498DB")
        .setDescription(`🎟️ This ticket has been transferred from ${currentStaff} to ${newStaff}.`);

      await interaction.channel.send({embeds: [transferEmbed]});
      await interaction.editReply(`You have successfully transferred the ticket to ${newStaff.user.tag}.`);

      logger.info(`Ticket #${ticket.id} transferred from ${currentStaff.user.tag} to ${newStaff.user.tag}`, {guildId, category: "tickets"});

    } catch (error) {
      if (error.code === "ER_NO_SUCH_TABLE" || error.code === "ER_BAD_FIELD_ERROR") {
        await interaction.editReply("The database tables for this feature have not been fully updated yet. Please ask the bot owner to update the schema.");
      } else {
        logger.error("[Transfer Command Error]", error);
        await interaction.editReply("An error occurred while trying to transfer this ticket.");
      }
    }
  },
  category: "Moderation",
};