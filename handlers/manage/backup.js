"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleCreate = handleCreate;
exports.handleList = handleList;
exports.handleLoad = handleLoad;
exports.handleDelete = handleDelete;
const discord_js_1 = require("discord.js");
const db_1 = __importDefault(require("../../utils/db"));
const logger_1 = __importDefault(require("../../utils/logger"));
const { createSnapshot } = require("../../core/backup-manager");
/**
 * Handles creating a new server backup
 * @param {Interaction} interaction - Discord interaction object
 */
async function handleCreate(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const name = interaction.options.getString("name");
    const guild = interaction.guild;
    let snapshot;
    try {
        snapshot = await createSnapshot(guild);
    }
    catch (snapshotError) {
        logger_1.default.error(`[Backup Create] Error creating snapshot for guild ${guild.id}:`, { error: snapshotError });
        return interaction.editReply({ content: "❌ Failed to create backup snapshot. Please check bot permissions and try again." });
    }
    try {
        await db_1.default.execute("INSERT INTO server_backups (guild_id, snapshot_name, snapshot_json, created_by_id) VALUES (?, ?, ?, ?)", [guild.id, name, JSON.stringify(snapshot), interaction.user.id]);
        await interaction.editReply(`✅ Successfully created backup named **${name}**.`);
    }
    catch (error) {
        logger_1.default.error("[Backup Create Error]", error);
        await interaction.editReply("An error occurred while saving the backup to the database.");
    }
}
/**
 * Handles listing all server backups
 * @param {Interaction} interaction - Discord interaction object
 */
async function handleList(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const guild = interaction.guild;
    try {
        const [backups] = await db_1.default.execute("SELECT id, snapshot_name, created_at, created_by_id FROM server_backups WHERE guild_id = ? ORDER BY created_at DESC", [guild.id]);
        if (backups.length === 0) {
            return interaction.editReply("No backups found for this server.");
        }
        const description = backups.map(b => `**ID:** \`${b.id}\`\n**Name:** ${b.snapshot_name}\n**Date:** ${new Date(b.created_at).toLocaleString()}`).join("\n\n");
        const embed = new discord_js_1.EmbedBuilder()
            .setTitle(`Backups for ${guild.name}`)
            .setColor("#5865F2")
            .setDescription(description);
        await interaction.editReply({ embeds: [embed] });
    }
    catch (error) {
        logger_1.default.error("[Backup List Error]", error);
        await interaction.editReply("An error occurred while fetching backups.");
    }
}
/**
 * Handles loading a server backup (requires confirmation)
 * NOTE: This handler only shows the confirmation dialog.
 * The actual restoration is handled by a button interaction in index.js
 * @param {Interaction} interaction - Discord interaction object
 */
async function handleLoad(interaction) {
    const backupId = interaction.options.getString("backup_id");
    const guild = interaction.guild;
    try {
        const [[backup]] = await db_1.default.execute("SELECT * FROM server_backups WHERE id = ? AND guild_id = ?", [backupId, guild.id]);
        if (!backup) {
            return interaction.reply({ content: "Backup not found.", ephemeral: true });
        }
        const confirmationEmbed = new discord_js_1.EmbedBuilder()
            .setTitle("⚠️ FINAL CONFIRMATION REQUIRED ⚠️")
            .setDescription(`You are about to restore the server to the state from **${new Date(backup.created_at).toLocaleString()}** named **"${backup.snapshot_name}"**.\n\n` +
            `**THIS WILL DELETE ALL CURRENT ROLES AND CHANNELS** and replace them with the ones from the backup. This action is irreversible.\n\n` +
            `Only the server owner can confirm this action.`)
            .setColor("Red");
        const confirmButton = new discord_js_1.ButtonBuilder()
            .setCustomId(`backup_confirm_${backupId}`)
            .setLabel("Confirm & Restore Server")
            .setStyle(discord_js_1.ButtonStyle.Danger);
        const cancelButton = new discord_js_1.ButtonBuilder()
            .setCustomId("backup_cancel")
            .setLabel("Cancel")
            .setStyle(discord_js_1.ButtonStyle.Secondary);
        const row = new discord_js_1.ActionRowBuilder().addComponents(confirmButton, cancelButton);
        await interaction.reply({ embeds: [confirmationEmbed], components: [row], ephemeral: true });
    }
    catch (error) {
        logger_1.default.error("[Backup Load Error]", error);
        await interaction.reply({ content: "An error occurred while loading the backup.", ephemeral: true });
    }
}
/**
 * Handles deleting a server backup
 * @param {Interaction} interaction - Discord interaction object
 */
async function handleDelete(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const backupId = interaction.options.getString("backup_id");
    const guild = interaction.guild;
    try {
        const [result] = await db_1.default.execute("DELETE FROM server_backups WHERE id = ? AND guild_id = ?", [backupId, guild.id]);
        if (result.affectedRows > 0) {
            await interaction.editReply(`✅ Successfully deleted backup with ID \`${backupId}\`.`);
        }
        else {
            await interaction.editReply(`❌ No backup found with ID \`${backupId}\` for this server.`);
        }
    }
    catch (error) {
        logger_1.default.error("[Backup Delete Error]", error);
        await interaction.editReply("An error occurred while deleting the backup.");
    }
}
module.exports = {
    handleCreate,
    handleList,
    handleLoad,
    handleDelete,
};
