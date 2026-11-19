import { SlashCommandBuilder, ChannelType } from 'discord.js';
import logger from '../../utils/logger.js';
import * as h from './tournament-handler.js';

// Bracket tournaments. A top-level command rather than an /arcade group: it needs 14
// subcommands, and /arcade would pass Discord's 8000-character per-command limit with them.
const tournamentOpt = opt => opt.setName('tournament').setDescription('Tournament (defaults to the only open one)').setAutocomplete(true);
const matchOpt = opt => opt.setName('match').setDescription('Match').setRequired(true).setAutocomplete(true);

export default {
    category: 'games',
    data: new SlashCommandBuilder()
        .setName('tournament')
        .setDescription('Bracket tournaments — sign up, report results, follow the bracket')
        .setDMPermission(false)
        .addSubcommand(sub => sub.setName('create').setDescription('Open a tournament for sign-ups (staff)')
            .addStringOption(opt => opt.setName('name').setDescription('Tournament name').setRequired(true).setMaxLength(100))
            .addStringOption(opt => opt.setName('format').setDescription('Bracket format')
                .addChoices(
                    { name: 'Single elimination', value: 'single' },
                    { name: 'Double elimination', value: 'double' },
                    { name: 'Round robin', value: 'round_robin' }
                ))
            .addIntegerOption(opt => opt.setName('max-players').setDescription('Player cap (single 64, double 32, round robin 16)').setMinValue(2).setMaxValue(64))
            .addIntegerOption(opt => opt.setName('signup-minutes').setDescription('Sign-up window; 0 = start by hand (default 60)').setMinValue(0).setMaxValue(10080))
            .addStringOption(opt => opt.setName('seeding').setDescription('How players are seeded')
                .addChoices(
                    { name: 'Random', value: 'random' },
                    { name: 'Sign-up order', value: 'signup' },
                    { name: 'Staff order (/tournament seed)', value: 'manual' }
                ))
            .addStringOption(opt => opt.setName('game').setDescription('Game').setMaxLength(100))
            .addIntegerOption(opt => opt.setName('prize-coins').setDescription('Coins paid to the winner').setMinValue(0).setMaxValue(10000000))
            .addStringOption(opt => opt.setName('prize').setDescription('Other prize, shown on the post').setMaxLength(200))
            .addStringOption(opt => opt.setName('rules').setDescription('Rules shown on the post').setMaxLength(1000))
            .addChannelOption(opt => opt.setName('channel').setDescription('Where the bracket is posted')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
        .addSubcommand(sub => sub.setName('join').setDescription('Sign up')
            .addIntegerOption(tournamentOpt)
            .addStringOption(opt => opt.setName('team').setDescription('Team name (optional)').setMaxLength(100)))
        .addSubcommand(sub => sub.setName('leave').setDescription('Withdraw before it starts')
            .addIntegerOption(tournamentOpt))
        .addSubcommand(sub => sub.setName('list').setDescription('Tournaments on this server'))
        .addSubcommand(sub => sub.setName('bracket').setDescription('Show the bracket')
            .addIntegerOption(tournamentOpt))
        .addSubcommand(sub => sub.setName('start').setDescription('Close sign-ups and start now (staff)')
            .addIntegerOption(tournamentOpt))
        .addSubcommand(sub => sub.setName('report').setDescription('Report your match result')
            .addIntegerOption(matchOpt)
            .addStringOption(opt => opt.setName('result').setDescription('Did you win?').setRequired(true)
                .addChoices({ name: 'I won', value: 'won' }, { name: 'I lost', value: 'lost' }))
            .addStringOption(opt => opt.setName('score').setDescription('Score, e.g. 2-1').setMaxLength(50)))
        .addSubcommand(sub => sub.setName('confirm').setDescription("Confirm your opponent's report")
            .addIntegerOption(matchOpt))
        .addSubcommand(sub => sub.setName('dispute').setDescription("Dispute your opponent's report")
            .addIntegerOption(matchOpt)
            .addStringOption(opt => opt.setName('reason').setDescription('What happened').setMaxLength(200)))
        .addSubcommand(sub => sub.setName('setwinner').setDescription('Decide a match (staff)')
            .addIntegerOption(matchOpt)
            .addUserOption(opt => opt.setName('winner').setDescription('Winner').setRequired(true))
            .addStringOption(opt => opt.setName('score').setDescription('Score, e.g. 2-1').setMaxLength(50))
            .addBooleanOption(opt => opt.setName('force').setDescription('Also reset later matches that depended on the old result')))
        .addSubcommand(sub => sub.setName('seed').setDescription('Set seeding order before the start (staff)')
            .addStringOption(opt => opt.setName('order').setDescription('Players best first, e.g. @a @b @c').setRequired(true))
            .addIntegerOption(tournamentOpt))
        .addSubcommand(sub => sub.setName('disqualify').setDescription('Withdraw a player; their matches are forfeits (staff)')
            .addUserOption(opt => opt.setName('user').setDescription('Player').setRequired(true))
            .addIntegerOption(tournamentOpt))
        .addSubcommand(sub => sub.setName('cancel').setDescription('Cancel a tournament (staff)')
            .addIntegerOption(tournamentOpt))
        .addSubcommand(sub => sub.setName('config').setDescription('Tournament settings (Manage Server)')
            .addBooleanOption(opt => opt.setName('enabled').setDescription('Allow tournaments'))
            .addChannelOption(opt => opt.setName('channel').setDescription('Default bracket channel')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
            .addRoleOption(opt => opt.setName('organizer-role').setDescription('Role that can run tournaments'))
            .addRoleOption(opt => opt.setName('ping-role').setDescription('Role pinged when sign-ups open'))
            .addBooleanOption(opt => opt.setName('clear-ping-role').setDescription('Stop pinging a role'))
            .addIntegerOption(opt => opt.setName('auto-confirm-hours').setDescription('Accept unanswered reports after this').setMinValue(1).setMaxValue(168))),

    async execute(interaction) {
        switch (interaction.options.getSubcommand()) {
            case 'create': return h.handleCreate(interaction);
            case 'join': return h.handleJoin(interaction);
            case 'leave': return h.handleLeave(interaction);
            case 'list': return h.handleList(interaction);
            case 'bracket': return h.handleBracket(interaction);
            case 'start': return h.handleStart(interaction);
            case 'report': return h.handleReport(interaction);
            case 'confirm': return h.handleConfirm(interaction);
            case 'dispute': return h.handleDispute(interaction);
            case 'setwinner': return h.handleSetWinner(interaction);
            case 'seed': return h.handleSeed(interaction);
            case 'disqualify': return h.handleDisqualify(interaction);
            case 'cancel': return h.handleCancel(interaction);
            case 'config': return h.handleConfig(interaction);
        }
    },

    async autocomplete(interaction) {
        try {
            return await h.autocomplete(interaction);
        } catch (err) {
            logger.warn('[Tournament] Autocomplete failed', { error: err.message });
            return interaction.respond([]).catch(() => {});
        }
    },

    // Reached through interactions/handlerRegistry.js ('bgt:' prefix).
    handleButton: h.handleTournamentButton,
};
