import { SlashCommandBuilder } from 'discord.js';
import * as cfxHandler from './arcade-cfx-handler.js';
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
        .setDescription('Games and activities — CFX, counting, game servers, hangman, LFG, music quiz, trivia')

        // ─── cfx group (6 subcmds) ───
        .addSubcommandGroup(group =>
            group
                .setName('cfx')
                .setDescription('CertiFried Cannabis Tycoon game commands')
                .addSubcommand(sub => sub.setName('stats').setDescription('View your CertiFried garden stats'))
                .addSubcommand(sub => sub.setName('daily').setDescription('Claim your daily CertiFried reward'))
                .addSubcommand(sub =>
                    sub.setName('leaderboard').setDescription('View the CertiFried leaderboard')
                        .addStringOption(opt =>
                            opt.setName('type').setDescription('Leaderboard type')
                                .addChoices(
                                    { name: '📊 Level', value: 'level' },
                                    { name: '💰 Currency', value: 'currency' },
                                    { name: '⭐ Prestige', value: 'prestige' }
                                ))
                )
                .addSubcommand(sub => sub.setName('market').setDescription('View current market prices'))
                .addSubcommand(sub =>
                    sub.setName('sell').setDescription('Quick sell from inventory')
                        .addStringOption(opt => opt.setName('strain').setDescription('Strain name to sell').setRequired(true))
                        .addIntegerOption(opt => opt.setName('quantity').setDescription('Amount to sell (default: 1)').setMinValue(1).setMaxValue(100))
                )
                .addSubcommand(sub => sub.setName('play').setDescription('Get link to play CertiFried'))
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
                        .addIntegerOption(opt => opt.setName('rounds').setDescription('Number of rounds (default: 5)').setRequired(false).setMinValue(1).setMaxValue(10))
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
        ),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();

        switch (group) {
            // ─── cfx ───
            case 'cfx':
                switch (subcommand) {
                    case 'stats': return cfxHandler.handleStats(interaction);
                    case 'daily': return cfxHandler.handleDaily(interaction);
                    case 'leaderboard': return cfxHandler.handleLeaderboard(interaction);
                    case 'market': return cfxHandler.handleMarket(interaction);
                    case 'sell': return cfxHandler.handleSell(interaction);
                    case 'play': return cfxHandler.handlePlay(interaction);
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
        }
    },

    async handleButton(interaction) {
        if (interaction.customId.startsWith('lfg_')) {
            return lfgHandler.handleButton(interaction);
        }
        return triviaHandler.handleButton(interaction);
    }
};
