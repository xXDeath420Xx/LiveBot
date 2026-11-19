/*
 * /creator — one home for creator-support integrations: Ko-fi, Buy Me a Coffee, Throne, Creator Showcase and
 * stream analytics. It has no subcommands of its own; core/command-mounts.js folds those five commands in at
 * deploy time and routes each interaction back to the command's own file before dispatch, so execute below
 * only runs if a mount is missing.
 */
import { SlashCommandBuilder, MessageFlags } from 'discord.js';

export default {
    category: 'community',
    data: new SlashCommandBuilder()
        .setName('creator')
        .setDescription('Creator tools: Ko-fi, Buy Me a Coffee, Throne, Showcase and stream analytics'),

    async execute(interaction) {
        await interaction.reply({ content: 'That creator tool is not available right now.', flags: MessageFlags.Ephemeral });
    },
};
