/*
 * /luck: the once-a-day critters luck roll (acorns or weapon crates). Mounted as /fun luck (core/command-mounts.js).
 */
import { SlashCommandBuilder } from 'discord.js';
import { runAction } from '../../handlers/critters-actions.js';

export default {
    category: 'fun',
    data: new SlashCommandBuilder()
        .setName('luck')
        .setDescription('Roll for a critters prize once a day')
        .setDMPermission(false),
    async execute(interaction) {
        await runAction(interaction, 'luck', {});
    },
};
