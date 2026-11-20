/*
 * /autohunt: critters that hunt on their own every 30 minutes while you are away. Members type
 * `/owo autohunt claim` (TEXT_MERGE in core/command-registration.js); `/autohunt claim` works too.
 */
import { SlashCommandBuilder } from 'discord.js';
import { runAction } from '../../handlers/critters-actions.js';

const data = new SlashCommandBuilder()
    .setName('autohunt')
    .setDescription('Let your critters hunt while you are away')
    .setDMPermission(false)
    .addSubcommand(s => s.setName('enable').setDescription('Start autohunting'))
    .addSubcommand(s => s.setName('disable').setDescription('Stop autohunting (anything waiting is lost)'))
    .addSubcommand(s => s.setName('status').setDescription('How many trips are waiting'))
    .addSubcommand(s => s.setName('claim').setDescription('Collect what your critters brought back'));

export default {
    category: 'games',
    data,
    async execute(interaction) {
        await runAction(interaction, 'autohunt', { action: interaction.options.getSubcommand() });
    },
};
