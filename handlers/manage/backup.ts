import { 
    EmbedBuilder, 
    ChatInputCommandInteraction, 
    Message, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    StringSelectMenuBuilder,
    User,
    TextChannel,
    Client,
    Guild,
    GuildMember,
    PermissionsBitField,
    Role,
    Collection,
    ChannelType,
    VoiceChannel,
    CategoryChannel
} from "discord.js";
import db from "../../utils/db";
import logger from "../../utils/logger";

const { createSnapshot } = require("../../core/backup-manager");
/**
 * Handles creating a new server backup
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleCreate(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const name = interaction.options.getString("name");
    const guild = interaction.guild;

    let snapshot;
    try {
        snapshot = await createSnapshot(guild);
    } catch (snapshotError) {
        logger.error(`[Backup Create] Error creating snapshot for guild ${guild.id}:`, { error: snapshotError });
        return interaction.editReply({ content: "❌ Failed to create backup snapshot. Please check bot permissions and try again." });
    }

    try {
        await db.execute(
            "INSERT INTO server_backups (guild_id, snapshot_name, snapshot_json, created_by_id) VALUES (?, ?, ?, ?)",
            [guild.id, name, JSON.stringify(snapshot), interaction.user.id]
        );

        await interaction.editReply(`✅ Successfully created backup named **${name}**.`);
    } catch (error) {
        logger.error("[Backup Create Error]", error as Record<string, any>);
        await interaction.editReply("An _error occurred while saving the backup to the database.");
    }
}

/**
 * Handles listing all server backups
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleList(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const guild = interaction.guild;

    try {
        const [backups] = await db.execute(
            "SELECT id, snapshot_name, created_at, created_by_id FROM server_backups WHERE guild_id = ? ORDER BY created_at DESC",
            [guild.id]
        );

        if (backups.length === 0) {
            return interaction.editReply("No backups found for this server.");
        }

        const description = backups.map(b =>
            `**ID:** \`${b.id}\`\n**Name:** ${b.snapshot_name}\n**Date:** ${new Date(b.created_at).toLocaleString()}`
        ).join("\n\n");

        const embed = new EmbedBuilder()
            .setTitle(`Backups for ${guild.name}`)
            .setColor("#5865F2")
            .setDescription(description);

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error("[Backup List Error]", error as Record<string, any>);
        await interaction.editReply("An _error occurred while fetching backups.");
    }
}

/**
 * Handles loading a server backup (requires confirmation)
 * NOTE: This handler only shows the confirmation dialog.
 * The actual restoration is handled by a button interaction in index.js
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleLoad(interaction: ChatInputCommandInteraction): Promise<void> {
    const backupId = interaction.options.getString("backup_id");
    const guild = interaction.guild;

    try {
        const [[backup]] = await db.execute(
            "SELECT * FROM server_backups WHERE id = ? AND guild_id = ?",
            [backupId, guild.id]
        );

        if (!backup) {
            return interaction.reply({ content: "Backup not found.", ephemeral: true });
        }

        const confirmationEmbed = new EmbedBuilder()
            .setTitle("⚠️ FINAL CONFIRMATION REQUIRED ⚠️")
            .setDescription(
                `You are about to restore the server to the state from **${new Date(backup.created_at).toLocaleString()}** named **"${backup.snapshot_name}"**.\n\n` +
                `**THIS WILL DELETE ALL CURRENT ROLES AND CHANNELS** and replace them with the ones from the backup. This action is irreversible.\n\n` +
                `Only the server owner can confirm this action.`
            )
            .setColor("Red");

        const confirmButton = new ButtonBuilder()
            .setCustomId(`backup_confirm_${backupId}`)
            .setLabel("Confirm & Restore Server")
            .setStyle(ButtonStyle.Danger);

        const cancelButton = new ButtonBuilder()
            .setCustomId("backup_cancel")
            .setLabel("Cancel")
            .setStyle(ButtonStyle.Secondary);

        const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

        await interaction.reply({ embeds: [confirmationEmbed], components: [row], ephemeral: true });
    } catch (error) {
        logger.error("[Backup Load Error]", error as Record<string, any>);
        await interaction.reply({ content: "An _error occurred while loading the backup.", ephemeral: true });
    }
}

/**
 * Handles deleting a server backup
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleDelete(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const backupId = interaction.options.getString("backup_id");
    const guild = interaction.guild;

    try {
        const [result] = await db.execute(
            "DELETE FROM server_backups WHERE id = ? AND guild_id = ?",
            [backupId, guild.id]
        );

        if (result.affectedRows > 0) {
            await interaction.editReply(`✅ Successfully deleted backup with ID \`${backupId}\`.`);
        } else {
            await interaction.editReply(`❌ No backup found with ID \`${backupId}\` for this server.`);
        }
    } catch (error) {
        logger.error("[Backup Delete Error]", error as Record<string, any>);
        await interaction.editReply("An _error occurred while deleting the backup.");
    }
}

module.exports = {
    handleCreate,
    handleList,
    handleLoad,
    handleDelete,
};
