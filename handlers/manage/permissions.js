"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleGrant = handleGrant;
exports.handleRevoke = handleRevoke;
const discord_js_1 = require("discord.js");
const db_1 = __importDefault(require("../../utils/db"));
const logger_1 = __importDefault(require("../../utils/logger"));
/**
 * Handles granting permission for a role to use a command
 * @param {Interaction} interaction - Discord interaction object
 */
async function handleGrant(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const role = interaction.options.getRole("role");
    const commandName = interaction.options.getString("command");
    if (!interaction.client.commands.has(commandName) || commandName === "permissions") {
        return interaction.editReply({ content: "That is not a valid command to set permissions for." });
    }
    try {
        await db_1.default.execute("INSERT INTO bot_permissions (guild_id, role_id, command) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE command=command", [interaction.guild.id, role.id, commandName]);
        await interaction.editReply({
            embeds: [new discord_js_1.EmbedBuilder()
                    .setColor("#57F287")
                    .setTitle("✅ Permission Granted")
                    .setDescription(`The role ${role} can now use the \`/${commandName}\` command.`)]
        });
    }
    catch (error) {
        logger_1.default.error("[Permissions Grant Error]", error);
        await interaction.editReply({ content: "An error occurred while updating permissions." });
    }
}
/**
 * Handles revoking permission for a role to use a command
 * @param {Interaction} interaction - Discord interaction object
 */
async function handleRevoke(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const role = interaction.options.getRole("role");
    const commandName = interaction.options.getString("command");
    if (!interaction.client.commands.has(commandName) || commandName === "permissions") {
        return interaction.editReply({ content: "That is not a valid command to set permissions for." });
    }
    try {
        await db_1.default.execute("DELETE FROM bot_permissions WHERE guild_id = ? AND role_id = ? AND command = ?", [interaction.guild.id, role.id, commandName]);
        await interaction.editReply({
            embeds: [new discord_js_1.EmbedBuilder()
                    .setColor("#ED4245")
                    .setTitle("🗑️ Permission Revoked")
                    .setDescription(`The role ${role} can no longer use the \`/${commandName}\` command.`)]
        });
    }
    catch (error) {
        logger_1.default.error("[Permissions Revoke Error]", error);
        await interaction.editReply({ content: "An error occurred while updating permissions." });
    }
}
module.exports = {
    handleGrant,
    handleRevoke,
};
