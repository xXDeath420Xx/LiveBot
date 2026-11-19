import { SlashCommandBuilder, ChannelType } from 'discord.js';
import logger from '../../utils/logger.js';
import * as h from './loyalty-handler.js';

// Its own top-level command because /arcade is close to Discord's 8000-character per-command
// limit once emoji hunts and goals are in it, and loyalty is a server-economy feature, not a game.
export default {
    category: 'community',
    data: new SlashCommandBuilder()
        .setName('loyalty')
        .setDescription('Loyalty points earned for being active — balance, leaderboard and rewards')
        .setDMPermission(false)
        .addSubcommand(sub => sub.setName('balance').setDescription('Your points and streak')
            .addUserOption(opt => opt.setName('user').setDescription('Someone else')))
        .addSubcommand(sub => sub.setName('leaderboard').setDescription('Top members')
            .addStringOption(opt => opt.setName('by').setDescription('Rank by')
                .addChoices(
                    { name: 'Balance', value: 'points' },
                    { name: 'All-time earned', value: 'lifetime' },
                    { name: 'Best streak', value: 'streak' }
                )))
        .addSubcommand(sub => sub.setName('rewards').setDescription('What you can spend points on'))
        .addSubcommand(sub => sub.setName('redeem').setDescription('Spend points on a reward')
            .addIntegerOption(opt => opt.setName('reward').setDescription('Reward').setRequired(true).setAutocomplete(true)))
        .addSubcommand(sub => sub.setName('reward-add').setDescription('Offer a reward (Manage Server)')
            .addStringOption(opt => opt.setName('name').setDescription('Reward name').setRequired(true).setMaxLength(100))
            .addIntegerOption(opt => opt.setName('cost').setDescription('Cost in points').setRequired(true).setMinValue(1).setMaxValue(1000000))
            .addStringOption(opt => opt.setName('type').setDescription('What it gives').setRequired(true)
                .addChoices(
                    { name: 'Role', value: 'role' },
                    { name: 'Coins', value: 'coins' },
                    { name: 'XP', value: 'xp' },
                    { name: 'Custom (staff fulfil)', value: 'custom' }
                ))
            .addRoleOption(opt => opt.setName('role').setDescription('Role to give (type Role)'))
            .addIntegerOption(opt => opt.setName('amount').setDescription('Coins or XP to give').setMinValue(1).setMaxValue(1000000))
            .addIntegerOption(opt => opt.setName('stock').setDescription('How many can be redeemed (blank = unlimited)').setMinValue(0).setMaxValue(100000))
            .addStringOption(opt => opt.setName('description').setDescription('Details shown in the list').setMaxLength(300)))
        .addSubcommand(sub => sub.setName('reward-remove').setDescription('Stop offering a reward (Manage Server)')
            .addIntegerOption(opt => opt.setName('reward').setDescription('Reward').setRequired(true).setAutocomplete(true)))
        .addSubcommand(sub => sub.setName('give').setDescription('Give points (Manage Server)')
            .addUserOption(opt => opt.setName('user').setDescription('Member').setRequired(true))
            .addIntegerOption(opt => opt.setName('amount').setDescription('Points').setRequired(true).setMinValue(1).setMaxValue(1000000)))
        .addSubcommand(sub => sub.setName('take').setDescription('Take points (Manage Server)')
            .addUserOption(opt => opt.setName('user').setDescription('Member').setRequired(true))
            .addIntegerOption(opt => opt.setName('amount').setDescription('Points').setRequired(true).setMinValue(1).setMaxValue(1000000)))
        .addSubcommand(sub => sub.setName('config').setDescription('Loyalty settings (Manage Server)')
            .addBooleanOption(opt => opt.setName('enabled').setDescription('Earn points in this server'))
            .addIntegerOption(opt => opt.setName('daily-points').setDescription('Points for an active day').setMinValue(0).setMaxValue(10000))
            .addIntegerOption(opt => opt.setName('min-messages').setDescription('Messages for an active day').setMinValue(1).setMaxValue(1000))
            .addIntegerOption(opt => opt.setName('min-voice-minutes').setDescription('Or voice minutes for an active day').setMinValue(1).setMaxValue(1440))
            .addIntegerOption(opt => opt.setName('voice-minutes-per-point').setDescription('Voice minutes per point (0 = none)').setMinValue(0).setMaxValue(1440))
            .addIntegerOption(opt => opt.setName('max-voice-points').setDescription('Daily cap on voice points').setMinValue(0).setMaxValue(10000))
            .addIntegerOption(opt => opt.setName('streak-bonus').setDescription('Extra points per streak day').setMinValue(0).setMaxValue(1000))
            .addIntegerOption(opt => opt.setName('max-streak-bonus').setDescription('Cap on the streak bonus').setMinValue(0).setMaxValue(10000))
            .addChannelOption(opt => opt.setName('log-channel').setDescription('Where redemptions are logged')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
            .addStringOption(opt => opt.setName('name').setDescription('What points are called').setMaxLength(40))),

    async execute(interaction) {
        switch (interaction.options.getSubcommand()) {
            case 'balance': return h.handleBalance(interaction);
            case 'leaderboard': return h.handleLeaderboard(interaction);
            case 'rewards': return h.handleRewards(interaction);
            case 'redeem': return h.handleRedeem(interaction);
            case 'reward-add': return h.handleRewardAdd(interaction);
            case 'reward-remove': return h.handleRewardRemove(interaction);
            case 'give': return h.handleAdjust(interaction, 1);
            case 'take': return h.handleAdjust(interaction, -1);
            case 'config': return h.handleConfig(interaction);
        }
    },

    async autocomplete(interaction) {
        try {
            return await h.autocompleteReward(interaction);
        } catch (err) {
            logger.warn('[Loyalty] Autocomplete failed', { error: err.message });
            return interaction.respond([]).catch(() => {});
        }
    },
};
