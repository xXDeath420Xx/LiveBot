/*
 * /moderation — the Manage Server moderation filters and reviews: name filter, commission filter, activity
 * audits, the mod highlight feed and image vision. It has no subcommands of its own; core/command-mounts.js
 * folds those five commands in at deploy time and routes each interaction back to the command's own file
 * before dispatch, so execute below only runs if a mount is missing.
 */
import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';

export default {
    category: 'admin',
    data: new SlashCommandBuilder()
        .setName('moderation')
        .setDescription('Moderation filters and reviews: names, commissions, activity, highlights and images')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false),

    async execute(interaction) {
        await interaction.reply({ content: 'That moderation tool is not available right now.', flags: MessageFlags.Ephemeral });
    },
};
