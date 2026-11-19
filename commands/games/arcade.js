import { SlashCommandBuilder, ChannelType } from 'discord.js';
import logger from '../../utils/logger.js';
import * as greenhouseHandler from './arcade-greenhouse-handler.js';
import * as emojihuntHandler from './arcade-emojihunt-handler.js';
import * as goalsHandler from './arcade-goals-handler.js';
import * as countingHandler from './arcade-counting-handler.js';
import * as serversHandler from './arcade-servers-handler.js';
import * as hangmanHandler from './arcade-hangman-handler.js';
import * as lfgHandler from './arcade-lfg-handler.js';
import * as musicquizHandler from './arcade-musicquiz-handler.js';
import * as triviaHandler from './arcade-trivia-handler.js';

export default {
    category: 'games',
    data: new SlashCommandBuilder()
        .setName('arcade')
        .setDescription('Games and activities — Greenhouse, counting, emoji hunts, goals, hangman, LFG, music quiz, trivia')

        // The cfx group (CertiFried Tycoon) was removed (H-650): `/arcade cfx …` answers with where the game
        // went, from core/retired-commands.js.
        // ─── greenhouse group (Greenhouse Tycoon, the v2 game; 3 subcmds) ───
        .addSubcommandGroup(group =>
            group
                .setName('greenhouse')
                .setDescription('Greenhouse Tycoon: your greenhouse, the daily reward and account linking')
                .addSubcommand(sub => sub.setName('status').setDescription('Your greenhouse at a glance: level, benches, quests and the season'))
                .addSubcommand(sub => sub.setName('daily').setDescription('Collect the daily reward (one a day across Discord, the website and Twitch)'))
                .addSubcommand(sub =>
                    sub.setName('link').setDescription('Make a link code, or enter one to join the greenhouse you play elsewhere')
                        .addStringOption(opt => opt.setName('code').setDescription('A link code from the website (leave out to make one)').setMaxLength(32))
                )
        )

        // ─── counting group (5 subcmds) ───
        .addSubcommandGroup(group =>
            group
                .setName('counting')
                .setDescription('Manage counting game channels')
                .addSubcommand(sub =>
                    sub.setName('setup').setDescription('Set up a counting channel')
                        .addChannelOption(opt => opt.setName('channel').setDescription('Channel to use for counting').setRequired(true))
                        .addIntegerOption(opt => opt.setName('start').setDescription('Starting number (default: 1)').setMinValue(0))
                )
                .addSubcommand(sub =>
                    sub.setName('disable').setDescription('Disable counting in a channel')
                        .addChannelOption(opt => opt.setName('channel').setDescription('Channel to disable counting in').setRequired(true))
                )
                .addSubcommand(sub =>
                    sub.setName('reset').setDescription('Reset the count to 0')
                        .addChannelOption(opt => opt.setName('channel').setDescription('Channel to reset (defaults to current channel)'))
                )
                .addSubcommand(sub =>
                    sub.setName('stats').setDescription('View counting statistics')
                        .addChannelOption(opt => opt.setName('channel').setDescription('Channel to view stats for (defaults to current channel)'))
                )
                .addSubcommand(sub =>
                    sub.setName('leaderboard').setDescription('View the counting leaderboard')
                        .addChannelOption(opt => opt.setName('channel').setDescription('Channel to view leaderboard for (defaults to current channel)'))
                )
                .addSubcommand(sub =>
                    sub.setName('setcount').setDescription('Set the count without resetting stats (e.g. taking over from another bot)')
                        .addIntegerOption(opt => opt.setName('last-number').setDescription('The last number successfully posted').setRequired(true).setMinValue(0))
                        .addChannelOption(opt => opt.setName('channel').setDescription('Channel (defaults to current channel)'))
                )
                .addSubcommand(sub =>
                    sub.setName('mode').setDescription('Change how a counting channel behaves')
                        .addStringOption(opt => opt.setName('on-wrong-number').setDescription('What happens when someone gets it wrong')
                            .addChoices(
                                { name: 'Reset the count to 0', value: 'reset' },
                                { name: 'Delete the message, never reset (infinite attempts)', value: 'delete' }))
                        .addBooleanOption(opt => opt.setName('react-on-valid').setDescription('React ✅ on every valid count'))
                        .addBooleanOption(opt => opt.setName('announce-milestones').setDescription('Announce milestones and pay economy coins'))
                        .addBooleanOption(opt => opt.setName('delete-chatter').setDescription('Delete non-numeric messages (delete mode only)'))
                        .addChannelOption(opt => opt.setName('channel').setDescription('Channel (defaults to current channel)'))
                )
        )

        // ─── servers group (3 subcmds) ───
        .addSubcommandGroup(group =>
            group
                .setName('servers')
                .setDescription('Check game server status')
                .addSubcommand(sub =>
                    sub.setName('minecraft').setDescription('Check Minecraft server status')
                        .addStringOption(opt => opt.setName('ip').setDescription('Server IP address').setRequired(true))
                )
                .addSubcommand(sub =>
                    sub.setName('add').setDescription('Add a server to track')
                        .addStringOption(opt => opt.setName('name').setDescription('Server name').setRequired(true))
                        .addStringOption(opt =>
                            opt.setName('type').setDescription('Server type').setRequired(true)
                                .addChoices(
                                    { name: 'Minecraft', value: 'minecraft' },
                                    { name: 'Valheim', value: 'valheim' },
                                    { name: 'Rust', value: 'rust' },
                                    { name: 'Other', value: 'other' }
                                ))
                        .addStringOption(opt => opt.setName('ip').setDescription('Server IP:Port').setRequired(true))
                )
                .addSubcommand(sub => sub.setName('list').setDescription('List tracked servers'))
        )

        // ─── hangman group (4 subcmds) ───
        .addSubcommandGroup(group =>
            group
                .setName('hangman')
                .setDescription('Word guessing game')
                .addSubcommand(sub =>
                    sub.setName('start').setDescription('Start a new hangman game')
                        .addStringOption(opt =>
                            opt.setName('difficulty').setDescription('Difficulty level')
                                .addChoices(
                                    { name: '🌱 Easy (4-5 letters)', value: 'easy' },
                                    { name: '⚡ Medium (6-8 letters)', value: 'medium' },
                                    { name: '🔥 Hard (9+ letters)', value: 'hard' }
                                ))
                        .addStringOption(opt =>
                            opt.setName('category').setDescription('Word category')
                                .addChoices(
                                    { name: '🎲 Random', value: 'random' },
                                    { name: '🍎 Food', value: 'food' },
                                    { name: '🌳 Nature', value: 'nature' },
                                    { name: '🎵 Music', value: 'music' },
                                    { name: '⚽ Sports', value: 'sports' },
                                    { name: '🐘 Animals', value: 'animals' },
                                    { name: '💻 Technology', value: 'technology' },
                                    { name: '📦 General', value: 'general' }
                                ))
                )
                .addSubcommand(sub =>
                    sub.setName('guess').setDescription('Guess a letter or the full word')
                        .addStringOption(opt => opt.setName('guess').setDescription('Letter or full word to guess').setRequired(true).setMaxLength(20))
                )
                .addSubcommand(sub => sub.setName('give-up').setDescription('Give up and reveal the answer'))
                .addSubcommand(sub =>
                    sub.setName('stats').setDescription('View hangman statistics')
                        .addUserOption(opt => opt.setName('user').setDescription('User to view stats for (defaults to you)'))
                )
        )

        // ─── lfg group (3 subcmds) ───
        .addSubcommandGroup(group =>
            group
                .setName('lfg')
                .setDescription('Looking for Group - Find players for games')
                .addSubcommand(sub =>
                    sub.setName('create').setDescription('Create a new LFG post')
                        .addStringOption(opt => opt.setName('game').setDescription('Game name').setRequired(true))
                        .addStringOption(opt =>
                            opt.setName('activity').setDescription('Activity type').setRequired(true)
                                .addChoices(
                                    { name: 'Raid', value: 'raid' },
                                    { name: 'Dungeon', value: 'dungeon' },
                                    { name: 'PvP', value: 'pvp' },
                                    { name: 'Casual', value: 'casual' },
                                    { name: 'Competitive', value: 'competitive' },
                                    { name: 'Quest/Mission', value: 'quest' },
                                    { name: 'Other', value: 'other' }
                                ))
                        .addIntegerOption(opt => opt.setName('players').setDescription('Max players needed (including you)').setRequired(true).setMinValue(2).setMaxValue(25))
                        .addStringOption(opt => opt.setName('description').setDescription('Additional details').setRequired(false))
                        .addStringOption(opt => opt.setName('time').setDescription('Start time (e.g., "in 30 minutes", "8pm EST")').setRequired(false))
                )
                .addSubcommand(sub => sub.setName('list').setDescription('View active LFG posts'))
                .addSubcommand(sub => sub.setName('close').setDescription('Close your LFG post'))
        )

        // ─── musicquiz group (2 subcmds) ───
        .addSubcommandGroup(group =>
            group
                .setName('musicquiz')
                .setDescription('Music trivia quiz game')
                .addSubcommand(sub =>
                    sub.setName('start').setDescription('Start a music quiz session')
                        .addIntegerOption(opt => opt.setName('rounds').setDescription('Number of rounds (default: set on the dashboard, else 5)').setRequired(false).setMinValue(1).setMaxValue(10))
                )
                .addSubcommand(sub => sub.setName('leaderboard').setDescription('View music quiz leaderboard'))
        )

        // ─── trivia group (3 subcmds) ───
        .addSubcommandGroup(group =>
            group
                .setName('trivia')
                .setDescription('Play trivia games')
                .addSubcommand(sub =>
                    sub.setName('start').setDescription('Start a trivia game')
                        .addStringOption(opt =>
                            opt.setName('category').setDescription('Category of questions')
                                .addChoices(
                                    { name: '🎲 Random', value: 'random' },
                                    { name: '🧠 General Knowledge', value: 'general' },
                                    { name: '🔬 Science & Nature', value: 'science' },
                                    { name: '📜 History', value: 'history' },
                                    { name: '🌍 Geography', value: 'geography' },
                                    { name: '🎬 Entertainment', value: 'entertainment' },
                                    { name: '⚽ Sports', value: 'sports' },
                                    { name: '💻 Technology', value: 'technology' },
                                    { name: '🎵 Music', value: 'music' },
                                    { name: '🎨 Art & Literature', value: 'art' },
                                    { name: '🎮 Video Games', value: 'gaming' }
                                ))
                        .addStringOption(opt =>
                            opt.setName('difficulty').setDescription('Difficulty level')
                                .addChoices(
                                    { name: '🌱 Easy', value: 'easy' },
                                    { name: '⚡ Medium', value: 'medium' },
                                    { name: '🔥 Hard', value: 'hard' }
                                ))
                        .addIntegerOption(opt => opt.setName('questions').setDescription('Number of questions (1-10)').setMinValue(1).setMaxValue(10))
                )
                .addSubcommand(sub =>
                    sub.setName('stats').setDescription('View trivia statistics')
                        .addUserOption(opt => opt.setName('user').setDescription('User to view stats for (defaults to you)'))
                )
                .addSubcommand(sub => sub.setName('leaderboard').setDescription('View the trivia leaderboard'))
        )

        // ─── emojihunt group (5 subcmds) ───
        .addSubcommandGroup(group =>
            group
                .setName('emojihunt')
                .setDescription('Find emoji the bot hides on recent messages')
                .addSubcommand(sub =>
                    sub.setName('start').setDescription('Start a hunt (staff)')
                        .addStringOption(opt => opt.setName('emoji').setDescription('Emoji to hide').setMaxLength(64))
                        .addIntegerOption(opt => opt.setName('count').setDescription('How many to hide').setMinValue(1).setMaxValue(25))
                        .addIntegerOption(opt => opt.setName('minutes').setDescription('How long it runs').setMinValue(5).setMaxValue(1440))
                        .addChannelOption(opt => opt.setName('channel').setDescription('Hide only in this channel')
                            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
                )
                .addSubcommand(sub => sub.setName('stop').setDescription('End the running hunt now (staff)'))
                .addSubcommand(sub => sub.setName('status').setDescription('How the current hunt is going'))
                .addSubcommand(sub => sub.setName('leaderboard').setDescription('All-time best hunters'))
                .addSubcommand(sub =>
                    sub.setName('config').setDescription('Hunt settings (Manage Server)')
                        .addBooleanOption(opt => opt.setName('enabled').setDescription('Allow emoji hunts'))
                        .addStringOption(opt => opt.setName('hunt-channels').setDescription('Channels to hide in, e.g. #general #memes ("none" clears)'))
                        .addChannelOption(opt => opt.setName('announce-channel').setDescription('Where start/results are posted')
                            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
                        .addRoleOption(opt => opt.setName('ping-role').setDescription('Role pinged when a hunt starts'))
                        .addBooleanOption(opt => opt.setName('clear-ping-role').setDescription('Stop pinging a role'))
                        .addStringOption(opt => opt.setName('emoji').setDescription('Default emoji').setMaxLength(64))
                        .addIntegerOption(opt => opt.setName('count').setDescription('Default number hidden').setMinValue(1).setMaxValue(25))
                        .addIntegerOption(opt => opt.setName('minutes').setDescription('Default length').setMinValue(5).setMaxValue(1440))
                        .addIntegerOption(opt => opt.setName('finders').setDescription('Finders per emoji').setMinValue(1).setMaxValue(10))
                        .addIntegerOption(opt => opt.setName('points').setDescription('Points per find').setMinValue(0).setMaxValue(10000))
                        .addIntegerOption(opt => opt.setName('coins').setDescription('Coins per find').setMinValue(0).setMaxValue(100000))
                        .addIntegerOption(opt => opt.setName('xp').setDescription('XP per find').setMinValue(0).setMaxValue(10000))
                        .addIntegerOption(opt => opt.setName('max-age-minutes').setDescription('Only hide on messages newer than this').setMinValue(10).setMaxValue(10080))
                        .addBooleanOption(opt => opt.setName('cleanup').setDescription('Remove unfound emoji when it ends'))
                        .addBooleanOption(opt => opt.setName('auto').setDescription('Run hunts automatically'))
                        .addIntegerOption(opt => opt.setName('auto-hours').setDescription('Hours between automatic hunts').setMinValue(1).setMaxValue(168))
                )
        )

        // ─── goals group (6 subcmds) ───
        .addSubcommandGroup(group =>
            group
                .setName('goals')
                .setDescription('Server-wide community goals')
                .addSubcommand(sub =>
                    sub.setName('create').setDescription('Set a community goal (Manage Server)')
                        .addStringOption(opt => opt.setName('title').setDescription('Goal name').setRequired(true).setMaxLength(100))
                        .addStringOption(opt => opt.setName('type').setDescription('What counts').setRequired(true)
                            .addChoices(
                                { name: 'Messages sent', value: 'messages' },
                                { name: 'Voice minutes', value: 'voice_minutes' },
                                { name: 'Members', value: 'members' },
                                { name: 'Boosts', value: 'boosts' },
                                { name: 'Custom (staff count)', value: 'custom' }
                            ))
                        .addIntegerOption(opt => opt.setName('target').setDescription('Target number').setRequired(true).setMinValue(1).setMaxValue(2000000000))
                        .addIntegerOption(opt => opt.setName('days').setDescription('Deadline in days').setMinValue(1).setMaxValue(365))
                        .addChannelOption(opt => opt.setName('channel').setDescription('Where to post progress')
                            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
                        .addIntegerOption(opt => opt.setName('coins').setDescription('Coins for each contributor').setMinValue(0).setMaxValue(1000000))
                        .addIntegerOption(opt => opt.setName('xp').setDescription('XP for each contributor').setMinValue(0).setMaxValue(100000))
                        .addRoleOption(opt => opt.setName('role').setDescription('Role for each contributor'))
                        .addStringOption(opt => opt.setName('description').setDescription('Details').setMaxLength(500))
                )
                .addSubcommand(sub => sub.setName('list').setDescription('Current and past goals'))
                .addSubcommand(sub =>
                    sub.setName('view').setDescription('One goal in detail')
                        .addIntegerOption(opt => opt.setName('goal').setDescription('Goal').setRequired(true).setAutocomplete(true))
                )
                .addSubcommand(sub =>
                    sub.setName('add').setDescription('Move a custom goal (Manage Server)')
                        .addIntegerOption(opt => opt.setName('goal').setDescription('Goal').setRequired(true).setAutocomplete(true))
                        .addIntegerOption(opt => opt.setName('amount').setDescription('Amount (negative subtracts)').setRequired(true))
                        .addBooleanOption(opt => opt.setName('set').setDescription('Set to this amount instead of adding'))
                )
                .addSubcommand(sub =>
                    sub.setName('cancel').setDescription('Cancel a goal (Manage Server)')
                        .addIntegerOption(opt => opt.setName('goal').setDescription('Goal').setRequired(true).setAutocomplete(true))
                )
                .addSubcommand(sub =>
                    sub.setName('config').setDescription('Goal settings (Manage Server)')
                        .addBooleanOption(opt => opt.setName('enabled').setDescription('Allow community goals'))
                        .addChannelOption(opt => opt.setName('announce-channel').setDescription('Default progress channel')
                            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
                        .addRoleOption(opt => opt.setName('ping-role').setDescription('Role pinged for new goals'))
                        .addBooleanOption(opt => opt.setName('clear-ping-role').setDescription('Stop pinging a role'))
                        .addBooleanOption(opt => opt.setName('milestones').setDescription('Announce 25/50/75%'))
                )
        ),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();

        switch (group) {

            // ─── greenhouse (v2) ───
            case 'greenhouse':
                switch (subcommand) {
                    case 'status': return greenhouseHandler.handleStatus(interaction);
                    case 'daily': return greenhouseHandler.handleDaily(interaction);
                    case 'link': return greenhouseHandler.handleLink(interaction);
                }
                break;

            // ─── counting ───
            case 'counting':
                switch (subcommand) {
                    case 'setup': return countingHandler.handleSetup(interaction);
                    case 'disable': return countingHandler.handleDisable(interaction);
                    case 'reset': return countingHandler.handleReset(interaction);
                    case 'stats': return countingHandler.handleStats(interaction);
                    case 'leaderboard': return countingHandler.handleLeaderboard(interaction);
                    case 'setcount': return countingHandler.handleSetCount(interaction);
                    case 'mode': return countingHandler.handleMode(interaction);
                }
                break;

            // ─── servers ───
            case 'servers':
                switch (subcommand) {
                    case 'minecraft': return serversHandler.handleMinecraft(interaction);
                    case 'add': return serversHandler.handleAdd(interaction);
                    case 'list': return serversHandler.handleListServers(interaction);
                }
                break;

            // ─── hangman ───
            case 'hangman':
                switch (subcommand) {
                    case 'start': return hangmanHandler.handleStart(interaction);
                    case 'guess': return hangmanHandler.handleGuess(interaction);
                    case 'give-up': return hangmanHandler.handleGiveUp(interaction);
                    case 'stats': return hangmanHandler.handleStats(interaction);
                }
                break;

            // ─── lfg ───
            case 'lfg':
                switch (subcommand) {
                    case 'create': return lfgHandler.handleCreate(interaction);
                    case 'list': return lfgHandler.handleListLfg(interaction);
                    case 'close': return lfgHandler.handleClose(interaction);
                }
                break;

            // ─── musicquiz ───
            case 'musicquiz':
                switch (subcommand) {
                    case 'start': return musicquizHandler.handleStart(interaction);
                    case 'leaderboard': return musicquizHandler.handleLeaderboard(interaction);
                }
                break;

            // ─── trivia ───
            case 'trivia':
                switch (subcommand) {
                    case 'start': return triviaHandler.handleStart(interaction);
                    case 'stats': return triviaHandler.handleStats(interaction);
                    case 'leaderboard': return triviaHandler.handleLeaderboard(interaction);
                }
                break;

            // ─── emojihunt ───
            case 'emojihunt':
                switch (subcommand) {
                    case 'start': return emojihuntHandler.handleStart(interaction);
                    case 'stop': return emojihuntHandler.handleStop(interaction);
                    case 'status': return emojihuntHandler.handleStatus(interaction);
                    case 'leaderboard': return emojihuntHandler.handleLeaderboard(interaction);
                    case 'config': return emojihuntHandler.handleConfig(interaction);
                }
                break;

            // ─── goals ───
            case 'goals':
                switch (subcommand) {
                    case 'create': return goalsHandler.handleCreate(interaction);
                    case 'list': return goalsHandler.handleList(interaction);
                    case 'view': return goalsHandler.handleView(interaction);
                    case 'add': return goalsHandler.handleAdd(interaction);
                    case 'cancel': return goalsHandler.handleCancel(interaction);
                    case 'config': return goalsHandler.handleConfig(interaction);
                }
                break;
        }
    },

    async autocomplete(interaction) {
        try {
            if (interaction.options.getSubcommandGroup(false) === 'goals') {
                return await goalsHandler.autocompleteGoal(interaction);
            }
            return await interaction.respond([]);
        } catch (err) {
            logger.warn('[Arcade] Autocomplete failed', { error: err.message });
            return interaction.respond([]).catch(() => {});
        }
    },

    async handleButton(interaction) {
        if (interaction.customId.startsWith('lfg_')) {
            return lfgHandler.handleButton(interaction);
        }
        return triviaHandler.handleButton(interaction);
    }
};
