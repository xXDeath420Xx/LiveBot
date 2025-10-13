const {SlashCommandBuilder, PermissionsBitField, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle} = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("verification")
    .setDescription("Manages the server verification gate.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .addSubcommand(subcommand =>
      subcommand
        .setName("setup")
        .setDescription("Creates the verification panel in a channel.")
        .addChannelOption(option =>
          option.setName("channel")
            .setDescription("The channel where users will verify.")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
        .addRoleOption(option =>
          option.setName("role")
            .setDescription("The role to grant to users upon verification.")
            .setRequired(true)
        )
    ),

  async execute(interaction) {
    if (interaction.options.getSubcommand() === "setup") {
      await interaction.deferReply({ephemeral: true});

      const channel = interaction.options.getChannel("channel");
      const role = interaction.options.getRole("role");

      if (!role.editable) {
        return interaction.editReply("I cannot assign this role. Please make sure my role is higher than the verification role.");
      }

      try {
        // Update database
        await db.execute(
          `INSERT INTO join_gate_config (guild_id, verification_enabled, verification_role_id, verification_channel_id) 
                     VALUES (?, 1, ?, ?)
                     ON DUPLICATE KEY UPDATE 
                        verification_enabled = 1,
                        verification_role_id = VALUES(verification_role_id),
                        verification_channel_id = VALUES(verification_channel_id)`,
          [interaction.guild.id, role.id, channel.id]
        );

        // Create the panel
        const embed = new EmbedBuilder()
          .setColor("#2ECC71")
          .setTitle(`Welcome to ${interaction.guild.name}!`)
          .setDescription("To gain access to the rest of the server, please click the button below to verify that you are human.")
          .setFooter({text: "This helps protect our community from raids and bots."});

        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId("verify_member")
              .setLabel("Verify")
              .setStyle(ButtonStyle.Success)
              .setEmoji("✅")
          );

        await channel.send({embeds: [embed], components: [row]});
        await interaction.editReply(`✅ Verification panel has been created in ${channel}.`);

      } catch (error) {
        logger.error("[Verification Setup Error]", error);
        await interaction.editReply("An error occurred. I may be missing permissions to send messages in that channel.");
      }
    }
  },
  category: "Super Admin",
};