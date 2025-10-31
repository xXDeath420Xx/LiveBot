"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const discord_player_1 = require("discord-player");
const db_1 = __importDefault(require("../utils/db"));
// Import all handler modules
const playlistHandlers = __importStar(require("../handlers/music/playlist"));
const playerHandlers = __importStar(require("../handlers/music/player"));
const queueHandlers = __importStar(require("../handlers/music/queue"));
const controlsHandlers = __importStar(require("../handlers/music/controls"));
const featuresHandlers = __importStar(require("../handlers/music/features"));
module.exports = {
    data: new discord_js_1.SlashCommandBuilder()
        .setName('music')
        .setDescription('Music commands')
        .addSubcommand(subcommand => subcommand
        .setName('play')
        .setDescription('Play a song')
        .addStringOption(option => option.setName('query').setDescription('The song to play').setRequired(true)))
        .addSubcommand(subcommand => subcommand.setName('skip').setDescription('Skips the current song'))
        .addSubcommand(subcommand => subcommand.setName('stop').setDescription('Stops the music and clears the queue'))
        .addSubcommand(subcommand => subcommand.setName('pause').setDescription('Pause the music'))
        .addSubcommand(subcommand => subcommand.setName('resume').setDescription('Resume the music'))
        .addSubcommand(subcommand => subcommand.setName('queue').setDescription('Displays the current music queue'))
        .addSubcommand(subcommand => subcommand.setName('nowplaying').setDescription('Displays information about the currently playing song'))
        .addSubcommand(subcommand => subcommand
        .setName('loop')
        .setDescription('Sets the loop mode for the music player')
        .addIntegerOption(option => option.setName("mode").setDescription("The loop mode to set").setRequired(true)
        .addChoices({ name: "Off", value: discord_player_1.QueueRepeatMode.OFF }, { name: "Track", value: discord_player_1.QueueRepeatMode.TRACK }, { name: "Queue", value: discord_player_1.QueueRepeatMode.QUEUE }, { name: "Autoplay", value: discord_player_1.QueueRepeatMode.AUTOPLAY })))
        .addSubcommand(subcommand => subcommand.setName('lyrics').setDescription('Gets the lyrics for the currently playing song'))
        .addSubcommand(subcommand => subcommand
        .setName('volume')
        .setDescription('Adjusts the playback volume')
        .addIntegerOption(option => option.setName("level").setDescription("The volume level (0-100)").setRequired(true).setMinValue(0).setMaxValue(100)))
        .addSubcommand(subcommand => subcommand.setName('shuffle').setDescription('Shuffles the current queue'))
        .addSubcommand(subcommand => subcommand
        .setName('remove')
        .setDescription('Removes a song from the queue')
        .addIntegerOption(option => option.setName("track").setDescription("The track number to remove").setRequired(true).setMinValue(1)))
        .addSubcommand(subcommand => subcommand
        .setName('search')
        .setDescription('Searches for a song and lets you choose from the top results')
        .addStringOption(option => option.setName("query").setDescription("The song to search for").setRequired(true)))
        .addSubcommand(subcommand => subcommand.setName('clear').setDescription('Clears all songs from the queue'))
        .addSubcommand(subcommand => subcommand
        .setName("filter").setDescription("Applies an audio filter to the music")
        .addStringOption(option => option.setName("filter").setDescription("The filter to apply or remove").setRequired(true)
        .addChoices({ name: "Bassboost", value: "bassboost" }, { name: "Nightcore", value: "nightcore" }, { name: "Vaporwave", value: "vaporwave" }, { name: "8D", value: "8D" }, { name: "Treble", value: "treble" }, { name: "Normalizer", value: "normalizer" }))
        .addStringOption(option => option.setName("action").setDescription("Whether to enable or disable the filter").setRequired(true)
        .addChoices({ name: "Enable", value: "enable" }, { name: "Disable", value: "disable" })))
        .addSubcommandGroup(group => group.setName('playlist').setDescription('Manages your custom playlists')
        .addSubcommand(subcommand => subcommand.setName('create').setDescription('Creates a new playlist').addStringOption(option => option.setName('name').setDescription('The name of the playlist').setRequired(true)))
        .addSubcommand(subcommand => subcommand.setName('delete').setDescription('Deletes a playlist').addStringOption(option => option.setName('name').setDescription('The name of the playlist to delete').setRequired(true).setAutocomplete(true)))
        .addSubcommand(subcommand => subcommand.setName('add').setDescription('Adds the current song to a playlist').addStringOption(option => option.setName('name').setDescription('The name of the playlist').setRequired(true).setAutocomplete(true)))
        .addSubcommand(subcommand => subcommand.setName('remove').setDescription('Removes a song from a playlist').addIntegerOption(option => option.setName('position').setDescription('The position of the song to remove').setRequired(true).setMinValue(1)).addStringOption(option => option.setName('name').setDescription('The name of the playlist').setRequired(true).setAutocomplete(true)))
        .addSubcommand(subcommand => subcommand.setName('list').setDescription('Lists all of your playlists'))
        .addSubcommand(subcommand => subcommand.setName('show').setDescription('Shows the songs in a playlist').addStringOption(option => option.setName('name').setDescription('The name of the playlist').setRequired(true).setAutocomplete(true)))
        .addSubcommand(subcommand => subcommand.setName('play').setDescription('Plays a playlist').addStringOption(option => option.setName('name').setDescription('The name of the playlist').setRequired(true).setAutocomplete(true))))
        .addSubcommand(subcommand => subcommand.setName('dj').setDescription('Starts an AI DJ session in your voice channel')
        .addStringOption(option => option.setName('prompt').setDescription('A direct prompt to influence the DJ').setRequired(false))
        .addStringOption(option => option.setName('song').setDescription('A song title to influence the DJ').setRequired(false))
        .addStringOption(option => option.setName('artist').setDescription('An artist to influence the DJ').setRequired(false))
        .addStringOption(option => option.setName('genre').setDescription('A genre to influence the DJ').setRequired(false))
        .addStringOption(option => option.setName('playlist_link').setDescription('A link to a Spotify or YouTube playlist to play').setRequired(false)))
        .addSubcommand(subcommand => subcommand.setName('record').setDescription('Records the audio in a voice channel'))
        .addSubcommand(subcommand => subcommand.setName('seek').setDescription('Seeks to a specific time in the current song')
        .addStringOption(option => option.setName("time").setDescription("The time to seek to (e.g., 1m30s, 2h, 45s)").setRequired(true))),
    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);
        const subcommand = interaction.options.getSubcommand(false);
        if (focusedOption.name === "name") {
            const focusedValue = interaction.options.getString('name') || '';
            try {
                const [playlists] = await db_1.default.execute("SELECT name FROM user_playlists WHERE guild_id = ? AND user_id = ? AND name LIKE ? LIMIT 25", [interaction.guild?.id, interaction.user.id, `${focusedValue}%`]);
                await interaction.respond(playlists.map(p => ({ name: p.name, value: p.name })));
            }
            catch (error) {
                console.error("[Playlist Autocomplete Error]", error.message);
                await interaction.respond([]);
            }
        }
    },
    async execute(interaction) {
        const subcommandGroup = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();
        try {
            if (subcommandGroup === 'playlist') {
                // Route to playlist handlers
                switch (subcommand) {
                    case 'create':
                        await playlistHandlers.handleCreate(interaction);
                        break;
                    case 'delete':
                        await playlistHandlers.handleDelete(interaction);
                        break;
                    case 'add':
                        await playlistHandlers.handleAdd(interaction);
                        break;
                    case 'remove':
                        await playlistHandlers.handleRemove(interaction);
                        break;
                    case 'list':
                        await playlistHandlers.handleList(interaction);
                        break;
                    case 'show':
                        await playlistHandlers.handleShow(interaction);
                        break;
                    case 'play':
                        await playlistHandlers.handlePlay(interaction);
                        break;
                    default:
                        await interaction.reply({ content: 'Invalid playlist subcommand.', ephemeral: true });
                }
            }
            else {
                // Route to other handlers based on subcommand
                switch (subcommand) {
                    // Player handlers
                    case 'play':
                        await playerHandlers.handlePlay(interaction);
                        break;
                    case 'pause':
                        await playerHandlers.handlePause(interaction);
                        break;
                    case 'resume':
                        await playerHandlers.handleResume(interaction);
                        break;
                    case 'skip':
                        await playerHandlers.handleSkip(interaction);
                        break;
                    case 'stop':
                        await playerHandlers.handleStop(interaction);
                        break;
                    case 'nowplaying':
                        await playerHandlers.handleNowPlaying(interaction);
                        break;
                    // Queue handlers
                    case 'queue':
                        await queueHandlers.handleQueue(interaction);
                        break;
                    case 'shuffle':
                        await queueHandlers.handleShuffle(interaction);
                        break;
                    case 'clear':
                        await queueHandlers.handleClear(interaction);
                        break;
                    case 'remove':
                        await queueHandlers.handleRemove(interaction);
                        break;
                    // Control handlers
                    case 'volume':
                        await controlsHandlers.handleVolume(interaction);
                        break;
                    case 'loop':
                        await controlsHandlers.handleLoop(interaction);
                        break;
                    case 'filter':
                        await controlsHandlers.handleFilter(interaction);
                        break;
                    case 'seek':
                        await controlsHandlers.handleSeek(interaction);
                        break;
                    // Feature handlers
                    case 'lyrics':
                        await featuresHandlers.handleLyrics(interaction);
                        break;
                    case 'search':
                        await featuresHandlers.handleSearch(interaction);
                        break;
                    case 'dj':
                        await featuresHandlers.handleDJ(interaction);
                        break;
                    case 'record':
                        await featuresHandlers.handleRecord(interaction);
                        break;
                    default:
                        await interaction.reply({ content: 'Invalid music subcommand.', ephemeral: true });
                }
            }
        }
        catch (error) {
            console.error(`[Music Command] Error in ${subcommandGroup || 'root'}/${subcommand}:`, error);
            const errorMessage = { content: 'An unexpected error occurred while executing this command.', ephemeral: true };
            if (interaction.deferred) {
                await interaction.editReply(errorMessage);
            }
            else if (!interaction.replied) {
                await interaction.reply(errorMessage);
            }
        }
    },
    category: 'music'
};
