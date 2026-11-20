/*
 * /owoify: turn text into its owo form with the MIT-licensed @zuzak/owo package (core/text-owoify.js).
 * Mounted as /fun owoify (core/command-mounts.js). Works anywhere; mentions in the result never ping.
 */
import { SlashCommandBuilder } from 'discord.js';
import { runAction } from '../../handlers/critters-actions.js';
import { OWOIFY_INPUT_MAX } from '../../core/text-owoify.js';

export default {
    category: 'fun',
    data: new SlashCommandBuilder()
        .setName('owoify')
        .setDescription('Say it, but owo')
        .addStringOption(o => o.setName('text').setDescription('What to transform').setRequired(true).setMaxLength(OWOIFY_INPUT_MAX)),
    async execute(interaction) {
        await runAction(interaction, 'owoify', { text: interaction.options.getString('text') });
    },
};
