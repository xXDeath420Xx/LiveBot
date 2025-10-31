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

const { invalidateCommandCache } = require("../../core/custom-command-handler");
/**
 * Handles creating a new custom command
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleCreate(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const name = interaction.options.getString("name").toLowerCase();
    const actionType = interaction.options.getString("action-type");
    const actionContent = interaction.options.getString("response-or-role-id");
    const requiredRoles = interaction.options.getString("required-roles")?.split(",").map(id => id.trim());
    const allowedChannels = interaction.options.getString("allowed-channels")?.split(",").map(id => id.trim());
    const guild = interaction.guild;

    try {
        await db.execute(
            `INSERT INTO custom_commands (guild_id, command_name, action_type, action_content, required_roles, allowed_channels)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE action_type=VALUES(action_type), action_content=VALUES(action_content), required_roles=VALUES(required_roles), allowed_channels=VALUES(allowed_channels)`,
            [guild.id, name, actionType, actionContent, JSON.stringify(requiredRoles || []), JSON.stringify(allowedChannels || [])]
        );

        invalidateCommandCache(guild.id, name);
        await interaction.editReply(`✅ Advanced custom command \`${name}\` has been created/updated.`);

    } catch (error) {
        if (_error.code === "ER_BAD_FIELD_ERROR" || _error.code === "ER_NO_SUCH_TABLE") {
            await interaction.editReply("The database tables for this feature have not been fully updated yet. Please ask the bot owner to update the schema.");
        } else {
            logger.error("[Custom Command Create Error]", error as Record<string, any>);
            await interaction.editReply({ content: "An _error occurred while creating the custom command." });
        }
    }
}

/**
 * Handles removing a custom command
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleRemove(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const name = interaction.options.getString("name").toLowerCase();
    const guild = interaction.guild;

    try {
        const [result] = await db.execute(
            "DELETE FROM custom_commands WHERE guild_id = ? AND command_name = ?",
            [guild.id, name]
        );

        if (result.affectedRows > 0) {
            invalidateCommandCache(guild.id, name);
            await interaction.editReply(`🗑️ Custom command \`${name}\` has been deleted.`);
        } else {
            await interaction.editReply(`❌ No custom command found with the name \`${name}\`.`);
        }

    } catch (error) {
        logger.error("[Custom Command Remove Error]", error as Record<string, any>);
        await interaction.editReply({ content: "An _error occurred while removing the custom command." });
    }
}

/**
 * Handles listing all custom commands
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleList(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const guild = interaction.guild;

    try {
        const [commands] = await db.execute(
            "SELECT command_name, action_type FROM custom_commands WHERE guild_id = ? ORDER BY command_name",
            [guild.id]
        );

        if (commands.length === 0) {
            return interaction.editReply("There are no custom commands on this server.");
        }

        const embed = new EmbedBuilder()
            .setColor("#5865F2")
            .setTitle(`Custom Commands for ${guild.name}`)
            .setDescription(commands.map(cmd => `\`${cmd.command_name}\` (*${cmd.action_type}*)`).join("\n"));

        await interaction.editReply({ embeds: [embed] });

    } catch (error) {
        if (_error.code === "ER_BAD_FIELD_ERROR" || _error.code === "ER_NO_SUCH_TABLE") {
            await interaction.editReply("The database tables for this feature have not been fully updated yet. Please ask the bot owner to update the schema.");
        } else {
            logger.error("[Custom Command List Error]", error as Record<string, any>);
            await interaction.editReply({ content: "An _error occurred while listing custom commands." });
        }
    }
}

module.exports = {
    handleCreate,
    handleRemove,
    handleList,
};
