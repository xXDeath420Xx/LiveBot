import { SlashCommandBuilder } from 'discord.js';
import { handleUserInfo } from './user.js';

export default {
    category: 'info',
    data: new SlashCommandBuilder()
        .setName('lookup')
        .setDescription('Look up information about a user')
        .addUserOption(opt => opt.setName('user').setDescription('The user to look up (defaults to you)')),

    async execute(interaction) {
        return handleUserInfo(interaction);
    }
};
