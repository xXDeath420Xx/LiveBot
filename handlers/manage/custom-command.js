"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleCreate = handleCreate;
exports.handleRemove = handleRemove;
exports.handleList = handleList;
const discord_js_1 = require("discord.js");
const db_1 = __importDefault(require("../../utils/db"));
const logger_1 = __importDefault(require("../../utils/logger"));
const { invalidateCommandCache } = require("../../core/custom-command-handler");
/**
 * Handles creating a new custom command
 * @param {Interaction} interaction - Discord interaction object
 */
async function handleCreate(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const name = interaction.options.getString("name").toLowerCase();
    const actionType = interaction.options.getString("action-type");
    const actionContent = interaction.options.getString("response-or-role-id");
    const requiredRoles = interaction.options.getString("required-roles")?.split(",").map(id => id.trim());
    const allowedChannels = interaction.options.getString("allowed-channels")?.split(",").map(id => id.trim());
    const guild = interaction.guild;
    try {
        await db_1.default.execute(`INSERT INTO custom_commands (guild_id, command_name, action_type, action_content, required_roles, allowed_channels)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE action_type=VALUES(action_type), action_content=VALUES(action_content), required_roles=VALUES(required_roles), allowed_channels=VALUES(allowed_channels)`, [guild.id, name, actionType, actionContent, JSON.stringify(requiredRoles || []), JSON.stringify(allowedChannels || [])]);
        invalidateCommandCache(guild.id, name);
        await interaction.editReply(`✅ Advanced custom command \`${name}\` has been created/updated.`);
    }
    catch (error) {
        if (error.code === "ER_BAD_FIELD_ERROR" || error.code === "ER_NO_SUCH_TABLE") {
            await interaction.editReply("The database tables for this feature have not been fully updated yet. Please ask the bot owner to update the schema.");
        }
        else {
            logger_1.default.error("[Custom Command Create Error]", error);
            await interaction.editReply({ content: "An error occurred while creating the custom command." });
        }
    }
}
/**
 * Handles removing a custom command
 * @param {Interaction} interaction - Discord interaction object
 */
async function handleRemove(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const name = interaction.options.getString("name").toLowerCase();
    const guild = interaction.guild;
    try {
        const [result] = await db_1.default.execute("DELETE FROM custom_commands WHERE guild_id = ? AND command_name = ?", [guild.id, name]);
        if (result.affectedRows > 0) {
            invalidateCommandCache(guild.id, name);
            await interaction.editReply(`🗑️ Custom command \`${name}\` has been deleted.`);
        }
        else {
            await interaction.editReply(`❌ No custom command found with the name \`${name}\`.`);
        }
    }
    catch (error) {
        logger_1.default.error("[Custom Command Remove Error]", error);
        await interaction.editReply({ content: "An error occurred while removing the custom command." });
    }
}
/**
 * Handles listing all custom commands
 * @param {Interaction} interaction - Discord interaction object
 */
async function handleList(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const guild = interaction.guild;
    try {
        const [commands] = await db_1.default.execute("SELECT command_name, action_type FROM custom_commands WHERE guild_id = ? ORDER BY command_name", [guild.id]);
        if (commands.length === 0) {
            return interaction.editReply("There are no custom commands on this server.");
        }
        const embed = new discord_js_1.EmbedBuilder()
            .setColor("#5865F2")
            .setTitle(`Custom Commands for ${guild.name}`)
            .setDescription(commands.map(cmd => `\`${cmd.command_name}\` (*${cmd.action_type}*)`).join("\n"));
        await interaction.editReply({ embeds: [embed] });
    }
    catch (error) {
        if (error.code === "ER_BAD_FIELD_ERROR" || error.code === "ER_NO_SUCH_TABLE") {
            await interaction.editReply("The database tables for this feature have not been fully updated yet. Please ask the bot owner to update the schema.");
        }
        else {
            logger_1.default.error("[Custom Command List Error]", error);
            await interaction.editReply({ content: "An error occurred while listing custom commands." });
        }
    }
}
module.exports = {
    handleCreate,
    handleRemove,
    handleList,
};
