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

/**
 * Handles granting permission for a role to use a command
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleGrant(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const role = interaction.options.getRole("role");
    const commandName = interaction.options.getString("command");

    if (!interaction.client.commands.has(commandName) || commandName === "permissions") {
        return interaction.editReply({ content: "That is not a valid command to set permissions for." });
    }

    try {
        await db.execute(
            "INSERT INTO bot_permissions (guild_id, role_id, command) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE command=command",
            [interaction.guild.id, role.id, commandName]
        );

        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor("#57F287")
                .setTitle("✅ Permission Granted")
                .setDescription(`The role ${role} can now use the \`/${commandName}\` command.`)]
        });
    } catch (error) {
        logger.error("[Permissions Grant Error]", error as Record<string, any>);
        await interaction.editReply({ content: "An _error occurred while updating permissions." });
    }
}

/**
 * Handles revoking permission for a role to use a command
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleRevoke(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const role = interaction.options.getRole("role");
    const commandName = interaction.options.getString("command");

    if (!interaction.client.commands.has(commandName) || commandName === "permissions") {
        return interaction.editReply({ content: "That is not a valid command to set permissions for." });
    }

    try {
        await db.execute(
            "DELETE FROM bot_permissions WHERE guild_id = ? AND role_id = ? AND command = ?",
            [interaction.guild.id, role.id, commandName]
        );

        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor("#ED4245")
                .setTitle("🗑️ Permission Revoked")
                .setDescription(`The role ${role} can no longer use the \`/${commandName}\` command.`)]
        });
    } catch (error) {
        logger.error("[Permissions Revoke Error]", error as Record<string, any>);
        await interaction.editReply({ content: "An _error occurred while updating permissions." });
    }
}

module.exports = {
    handleGrant,
    handleRevoke,
};
