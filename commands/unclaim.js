const {SlashCommandBuilder, PermissionsBitField, EmbedBuilder} = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("unclaim")
    .setDescription("Releases the current ticket, making it available for others."),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});
    const guildId = interaction.guild.id;
    const channelId = interaction.channel.id;
    const staffMember = interaction.member;

    try {
      const [[ticket]] = await db.execute("SELECT * FROM tickets WHERE guild_id = ? AND channel_id = ?", [guildId, channelId]);
      if (!ticket) {
        return interaction.editReply("This command can only be used in an active ticket channel.");
      }

      if (ticket.status === "closed") {
        return interaction.editReply("This ticket has already been closed.");
      }

      const [[config]] = await db.execute("SELECT support_role_id FROM ticket_config WHERE guild_id = ?", [guildId]);
      const isSupportStaff = staffMember.roles.cache.has(config?.support_role_id);
      const isAdmin = staffMember.permissions.has(PermissionsBitField.Flags.Administrator);

      if (!isSupportStaff) {
        return interaction.editReply("You do not have the required support role to manage tickets.");
      }

      if (!ticket.claimed_by_id) {
        return interaction.editReply("This ticket is not currently claimed.");
      }

      // Allow admins to unclaim any ticket, but staff can only unclaim their own.
      if (ticket.claimed_by_id !== staffMember.id && !isAdmin) {
        return interaction.editReply("You can only unclaim a ticket that you have claimed yourself.");
      }

      await db.execute("UPDATE tickets SET claimed_by_id = NULL WHERE id = ?", [ticket.id]);

      const unclaimEmbed = new EmbedBuilder()
        .setColor("#E67E22")
        .setDescription(`🎟️ This ticket has been unclaimed by ${staffMember} and is now open for anyone to handle.`);

      await interaction.channel.send({embeds: [unclaimEmbed]});
      await interaction.editReply("You have successfully unclaimed this ticket.");

      logger.info(`Ticket #${ticket.id} unclaimed by ${staffMember.user.tag}`, {guildId, category: "tickets"});

    } catch (error) {
      if (error.code === "ER_NO_SUCH_TABLE" || error.code === "ER_BAD_FIELD_ERROR") {
        await interaction.editReply("The database tables for this feature have not been fully updated yet. Please ask the bot owner to update the schema.");
      } else {
        logger.error("[Unclaim Command Error]", error);
        await interaction.editReply("An error occurred while trying to unclaim this ticket.");
      }
    }
  },
};