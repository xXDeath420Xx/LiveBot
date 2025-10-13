const {SlashCommandBuilder, PermissionsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle} = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");
const {createSnapshot} = require("../core/backup-manager");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("backup")
    .setDescription("Manage server structure backups (roles & channels).")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addSubcommand(subcommand =>
      subcommand
        .setName("create")
        .setDescription("Creates a new backup of the server's roles and channels.")
        .addStringOption(option => option.setName("name").setDescription("A descriptive name for this backup.").setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName("list")
        .setDescription("Lists all available backups for this server."))
    .addSubcommand(subcommand =>
      subcommand
        .setName("load")
        .setDescription("Restores the server structure from a backup. THIS IS DESTRUCTIVE.")
        .addStringOption(option => option.setName("backup_id").setDescription("The ID of the backup to load.").setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName("delete")
        .setDescription("Deletes a server backup.")
        .addStringOption(option => option.setName("backup_id").setDescription("The ID of the backup to delete.").setRequired(true))),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const guild = interaction.guild;

    try {
      if (subcommand === "create") {
        await interaction.deferReply({ephemeral: true});
        const name = interaction.options.getString("name");

        let snapshot;
        try {
          snapshot = await createSnapshot(guild);
        } catch (snapshotError) {
          logger.error(`[Backup Command] Error creating snapshot for guild ${guild.id}:`, {error: snapshotError});
          return interaction.editReply({content: "❌ Failed to create backup snapshot. Please check bot permissions and try again."});
        }

        await db.execute(
          "INSERT INTO server_backups (guild_id, snapshot_name, snapshot_json, created_by_id) VALUES (?, ?, ?, ?)",
          [guild.id, name, JSON.stringify(snapshot), interaction.user.id]
        );

        await interaction.editReply(`✅ Successfully created backup named **${name}**.`);

      } else if (subcommand === "list") {
        await interaction.deferReply({ephemeral: true});
        const [backups] = await db.execute("SELECT id, snapshot_name, created_at, created_by_id FROM server_backups WHERE guild_id = ? ORDER BY created_at DESC", [guild.id]);

        if (backups.length === 0) {
          return interaction.editReply("No backups found for this server.");
        }

        const description = backups.map(b => `**ID:** \`${b.id}\`\n**Name:** ${b.snapshot_name}\n**Date:** ${new Date(b.created_at).toLocaleString()}`).join("\n\n");
        const embed = new EmbedBuilder()
          .setTitle(`Backups for ${guild.name}`)
          .setColor("#5865F2")
          .setDescription(description);

        await interaction.editReply({embeds: [embed]});

      } else if (subcommand === "load") {
        const backupId = interaction.options.getString("backup_id");
        const [[backup]] = await db.execute("SELECT * FROM server_backups WHERE id = ? AND guild_id = ?", [backupId, guild.id]);

        if (!backup) {
          return interaction.reply({content: "Backup not found.", ephemeral: true});
        }

        const confirmationEmbed = new EmbedBuilder()
          .setTitle("⚠️ FINAL CONFIRMATION REQUIRED ⚠️")
          .setDescription(`You are about to restore the server to the state from **${new Date(backup.created_at).toLocaleString()}** named **"${backup.snapshot_name}"**.\n\n**THIS WILL DELETE ALL CURRENT ROLES AND CHANNELS** and replace them with the ones from the backup. This action is irreversible.\n\nOnly the server owner can confirm this action.`)
          .setColor("Red");

        const confirmButton = new ButtonBuilder().setCustomId(`backup_confirm_${backupId}`).setLabel("Confirm & Restore Server").setStyle(ButtonStyle.Danger);
        const cancelButton = new ButtonBuilder().setCustomId("backup_cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary);
        const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

        await interaction.reply({embeds: [confirmationEmbed], components: [row], ephemeral: true});

      } else if (subcommand === "delete") {
        await interaction.deferReply({ephemeral: true});
        const backupId = interaction.options.getString("backup_id");
        const [result] = await db.execute("DELETE FROM server_backups WHERE id = ? AND guild_id = ?", [backupId, guild.id]);
        if (result.affectedRows > 0) {
          await interaction.editReply(`✅ Successfully deleted backup with ID \`${backupId}\`.`);
        } else {
          await interaction.editReply(`❌ No backup found with ID \`${backupId}\` for this server.`);
        }
      }
    } catch (error) {
      logger.error(`[Backup Command Error] Subcommand: ${subcommand}`, {error});
      // Since deferReply is always called, we can always use editReply
      await interaction.editReply({content: "An error occurred while executing this command."});
    }
  },
};