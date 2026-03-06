import { SlashCommandBuilder } from 'discord.js';
import { QueueRepeatMode } from 'discord-player';
import pool from '../../utils/db.js';

// Import all handler modules
import * as playlistHandlers from '../../handlers/music/playlist.js';
import * as playerHandlers from '../../handlers/music/player.js';
import * as queueHandlers from '../../handlers/music/queue.js';
import * as controlsHandlers from '../../handlers/music/controls.js';
import * as featuresHandlers from '../../handlers/music/features.js';
import * as lastfmHandlers from '../../handlers/music/lastfm.js';
import * as panelHandlers from '../../handlers/music/panel.js';

export default {
    data: new SlashCommandBuilder()
        .setName('music')
        .setDescription('Music commands')
        .addSubcommand(subcommand =>
            subcommand
                .setName('play')
                .setDescription('Play a song, playlist, or album from YouTube, Spotify, or SoundCloud')
                .addStringOption(option => option.setName('query').setDescription('Song name, artist, or URL (Spotify/YouTube/SoundCloud)').setRequired(true)))
        .addSubcommand(subcommand => subcommand.setName('skip').setDescription('Skips the current song'))
        .addSubcommand(subcommand => subcommand.setName('stop').setDescription('Stops the music and clears the queue'))
        .addSubcommand(subcommand => subcommand.setName('pause').setDescription('Pause the music'))
        .addSubcommand(subcommand => subcommand.setName('resume').setDescription('Resume the music'))
        .addSubcommand(subcommand => subcommand.setName('queue').setDescription('Displays the current music queue'))
        .addSubcommand(subcommand => subcommand.setName('nowplaying').setDescription('Displays information about the currently playing song'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('loop')
                .setDescription('Sets the loop mode for the music player')
                .addIntegerOption(option =>
                    option.setName("mode").setDescription("The loop mode to set").setRequired(true)
                        .addChoices(
                            { name: "Off", value: QueueRepeatMode.OFF },
                            { name: "Track", value: QueueRepeatMode.TRACK },
                            { name: "Queue", value: QueueRepeatMode.QUEUE },
                            { name: "Autoplay", value: QueueRepeatMode.AUTOPLAY },
                        )))
        .addSubcommand(subcommand => subcommand.setName('lyrics').setDescription('Gets the lyrics for the currently playing song'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('volume')
                .setDescription('Adjusts the playback volume')
                .addIntegerOption(option => option.setName("level").setDescription("The volume level (0-100)").setRequired(true).setMinValue(0).setMaxValue(100)))
        .addSubcommand(subcommand => subcommand.setName('shuffle').setDescription('Shuffles the current queue'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('remove')
                .setDescription('Removes a song from the queue')
                .addIntegerOption(option => option.setName("track").setDescription("The track number to remove").setRequired(true).setMinValue(1)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('search')
                .setDescription('Search for a song and choose from results')
                .addStringOption(option => option.setName("query").setDescription("Song name, artist, or search term").setRequired(true)))
        .addSubcommand(subcommand => subcommand.setName('clear').setDescription('Clears all songs from the queue'))
        .addSubcommand(subcommand =>
            subcommand
                .setName("filter").setDescription("Applies an audio filter to the music")
                .addStringOption(option =>
                    option.setName("filter").setDescription("The filter to apply or remove").setRequired(true)
                        .addChoices(
                            { name: "Bassboost", value: "bassboost" }, { name: "Nightcore", value: "nightcore" },
                            { name: "Vaporwave", value: "vaporwave" }, { name: "8D", value: "8D" },
                            { name: "Treble", value: "treble" }, { name: "Normalizer", value: "normalizer" }
                        ))
                .addStringOption(option =>
                    option.setName("action").setDescription("Whether to enable or disable the filter").setRequired(true)
                        .addChoices({ name: "Enable", value: "enable" }, { name: "Disable", value: "disable" })))
        .addSubcommandGroup(group =>
            group.setName('playlist').setDescription('Manages your custom playlists')
                .addSubcommand(subcommand => subcommand.setName('create').setDescription('Creates a new playlist').addStringOption(option => option.setName('name').setDescription('The name of the playlist').setRequired(true)))
                .addSubcommand(subcommand => subcommand.setName('delete').setDescription('Deletes a playlist').addStringOption(option => option.setName('name').setDescription('The name of the playlist to delete').setRequired(true).setAutocomplete(true)))
                .addSubcommand(subcommand => subcommand.setName('add').setDescription('Adds the current song to a playlist').addStringOption(option => option.setName('name').setDescription('The name of the playlist').setRequired(true).setAutocomplete(true)))
                .addSubcommand(subcommand => subcommand.setName('remove').setDescription('Removes a song from a playlist').addIntegerOption(option => option.setName('position').setDescription('The position of the song to remove').setRequired(true).setMinValue(1)).addStringOption(option => option.setName('name').setDescription('The name of the playlist').setRequired(true).setAutocomplete(true)))
                .addSubcommand(subcommand => subcommand.setName('list').setDescription('Lists all of your playlists'))
                .addSubcommand(subcommand => subcommand.setName('show').setDescription('Shows the songs in a playlist').addStringOption(option => option.setName('name').setDescription('The name of the playlist').setRequired(true).setAutocomplete(true)))
                .addSubcommand(subcommand => subcommand.setName('play').setDescription('Plays a playlist').addStringOption(option => option.setName('name').setDescription('The name of the playlist').setRequired(true).setAutocomplete(true))))
        .addSubcommand(subcommand =>
            subcommand.setName('dj').setDescription('Starts an AI DJ session in your voice channel')
                .addStringOption(option => option.setName('prompt').setDescription('A direct prompt to influence the DJ').setRequired(false))
                .addStringOption(option => option.setName('song').setDescription('A song title to influence the DJ').setRequired(false))
                .addStringOption(option => option.setName('artist').setDescription('An artist to influence the DJ').setRequired(false))
                .addStringOption(option => option.setName('genre').setDescription('A genre to influence the DJ').setRequired(false))
                .addStringOption(option => option.setName('playlist_link').setDescription('A link to a Spotify or YouTube playlist to play').setRequired(false)))
        .addSubcommand(subcommand => subcommand.setName('record').setDescription('Records the audio in a voice channel'))
        .addSubcommand(subcommand =>
            subcommand.setName('seek').setDescription('Seeks to a specific time in the current song')
                .addStringOption(option => option.setName("time").setDescription("The time to seek to (e.g., 1m30s, 2h, 45s)").setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand.setName('voteskip').setDescription('Start a vote to skip the current song'))
        .addSubcommand(subcommand =>
            subcommand.setName('forceskip').setDescription('Force skip the current song (DJ/Admin only)'))
        .addSubcommand(subcommand =>
            subcommand.setName('eq').setDescription('Apply an equalizer preset')
                .addStringOption(option =>
                    option.setName('preset').setDescription('The equalizer preset').setRequired(true)
                        .addChoices(
                            { name: 'Flat (Reset)', value: 'flat' },
                            { name: 'Bass Boost', value: 'bass' },
                            { name: 'Treble Boost', value: 'treble' },
                            { name: 'Pop', value: 'pop' },
                            { name: 'Rock', value: 'rock' },
                            { name: 'Electronic', value: 'electronic' },
                            { name: 'Soft', value: 'soft' },
                            { name: 'Karaoke (Vocal Remove)', value: 'karaoke' }
                        )))
        .addSubcommandGroup(group =>
            group.setName('settings').setDescription('Configure music settings (Admin only)')
                .addSubcommand(subcommand =>
                    subcommand.setName('247').setDescription('Toggle 24/7 mode (bot stays in voice channel)')
                        .addStringOption(option =>
                            option.setName('toggle').setDescription('Enable or disable 24/7 mode').setRequired(true)
                                .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' })))
                .addSubcommand(subcommand =>
                    subcommand.setName('autoplay').setDescription('Toggle autoplay (automatically play similar songs)')
                        .addStringOption(option =>
                            option.setName('mode').setDescription('Autoplay mode').setRequired(true)
                                .addChoices(
                                    { name: 'On (YouTube)', value: 'youtube' },
                                    { name: 'On (AI Recommendations)', value: 'ai' },
                                    { name: 'Off', value: 'off' }
                                )))
                .addSubcommand(subcommand =>
                    subcommand.setName('requestchannel').setDescription('Set the song request channel')
                        .addChannelOption(option => option.setName('channel').setDescription('Channel for song requests (leave empty to disable)').setRequired(false)))
                .addSubcommand(subcommand =>
                    subcommand.setName('voteskip').setDescription('Configure vote skip settings')
                        .addStringOption(option =>
                            option.setName('enabled').setDescription('Enable or disable vote skip').setRequired(false)
                                .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' }))
                        .addIntegerOption(option =>
                            option.setName('percentage').setDescription('Percentage of listeners required to skip (1-100)').setRequired(false).setMinValue(1).setMaxValue(100))))
        .addSubcommandGroup(group =>
            group.setName('panel').setDescription('Manage the music control panel')
                .addSubcommand(subcommand => subcommand.setName('create').setDescription('Create a music control panel in this channel'))
                .addSubcommand(subcommand => subcommand.setName('delete').setDescription('Delete the music control panel')))
        .addSubcommandGroup(group =>
            group.setName('lastfm').setDescription('Last.fm music statistics and scrobbling')
                .addSubcommand(subcommand =>
                    subcommand.setName('link').setDescription('Link your Last.fm account')
                        .addStringOption(option => option.setName('username').setDescription('Your Last.fm username').setRequired(true)))
                .addSubcommand(subcommand => subcommand.setName('unlink').setDescription('Unlink your Last.fm account'))
                .addSubcommand(subcommand =>
                    subcommand.setName('nowplaying').setDescription('Show what you\'re currently listening to')
                        .addUserOption(option => option.setName('user').setDescription('Discord user (defaults to you)').setRequired(false)))
                .addSubcommand(subcommand =>
                    subcommand.setName('recent').setDescription('Show your recent tracks')
                        .addUserOption(option => option.setName('user').setDescription('Discord user (defaults to you)').setRequired(false)))
                .addSubcommand(subcommand =>
                    subcommand.setName('topartists').setDescription('Show your top artists')
                        .addStringOption(option =>
                            option.setName('period').setDescription('Time period').setRequired(false)
                                .addChoices(
                                    { name: 'Last 7 Days', value: '7day' }, { name: 'Last Month', value: '1month' },
                                    { name: 'Last 3 Months', value: '3month' }, { name: 'Last 6 Months', value: '6month' },
                                    { name: 'Last Year', value: '12month' }, { name: 'All Time', value: 'overall' }))
                        .addUserOption(option => option.setName('user').setDescription('Discord user (defaults to you)').setRequired(false)))
                .addSubcommand(subcommand =>
                    subcommand.setName('toptracks').setDescription('Show your top tracks')
                        .addStringOption(option =>
                            option.setName('period').setDescription('Time period').setRequired(false)
                                .addChoices(
                                    { name: 'Last 7 Days', value: '7day' }, { name: 'Last Month', value: '1month' },
                                    { name: 'Last 3 Months', value: '3month' }, { name: 'Last 6 Months', value: '6month' },
                                    { name: 'Last Year', value: '12month' }, { name: 'All Time', value: 'overall' }))
                        .addUserOption(option => option.setName('user').setDescription('Discord user (defaults to you)').setRequired(false)))
                .addSubcommand(subcommand =>
                    subcommand.setName('topalbums').setDescription('Show your top albums')
                        .addStringOption(option =>
                            option.setName('period').setDescription('Time period').setRequired(false)
                                .addChoices(
                                    { name: 'Last 7 Days', value: '7day' }, { name: 'Last Month', value: '1month' },
                                    { name: 'Last 3 Months', value: '3month' }, { name: 'Last 6 Months', value: '6month' },
                                    { name: 'Last Year', value: '12month' }, { name: 'All Time', value: 'overall' }))
                        .addUserOption(option => option.setName('user').setDescription('Discord user (defaults to you)').setRequired(false)))
                .addSubcommand(subcommand =>
                    subcommand.setName('compare').setDescription('Compare your music taste with another user')
                        .addUserOption(option => option.setName('user').setDescription('Discord user to compare with').setRequired(true)))
                .addSubcommand(subcommand =>
                    subcommand.setName('profile').setDescription('View Last.fm profile')
                        .addUserOption(option => option.setName('user').setDescription('Discord user (defaults to you)').setRequired(false)))),

    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);

        if (focusedOption.name === "name") {
            const focusedValue = interaction.options.getString('name') || '';
            try {
                const [playlists] = await pool.execute(
                    "SELECT name FROM music_playlists WHERE guild_id = ? AND user_id = ? AND name LIKE ? LIMIT 25",
                    [interaction.guild?.id, interaction.user.id, `${focusedValue}%`]
                );
                await interaction.respond(playlists.map(p => ({ name: p.name, value: p.name })));
            } catch (error) {
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
                    case 'create': await playlistHandlers.handleCreate(interaction); break;
                    case 'delete': await playlistHandlers.handleDelete(interaction); break;
                    case 'add': await playlistHandlers.handleAdd(interaction); break;
                    case 'remove': await playlistHandlers.handleRemove(interaction); break;
                    case 'list': await playlistHandlers.handleList(interaction); break;
                    case 'show': await playlistHandlers.handleShow(interaction); break;
                    case 'play': await playlistHandlers.handlePlay(interaction); break;
                    default:
                        await interaction.reply({ content: 'Invalid playlist subcommand.', ephemeral: true });
                }
            } else if (subcommandGroup === 'settings') {
                // Route to settings handlers (Admin features)
                switch (subcommand) {
                    case '247': await controlsHandlers.handle247(interaction); break;
                    case 'autoplay': await controlsHandlers.handleAutoplay(interaction); break;
                    case 'requestchannel': await controlsHandlers.handleRequestChannel(interaction); break;
                    case 'voteskip': await controlsHandlers.handleVoteSkipSettings(interaction); break;
                    default:
                        await interaction.reply({ content: 'Invalid settings subcommand.', ephemeral: true });
                }
            } else if (subcommandGroup === 'panel') {
                // Route to panel handlers
                switch (subcommand) {
                    case 'create': await panelHandlers.handleCreate(interaction); break;
                    case 'delete': await panelHandlers.handleDelete(interaction); break;
                    default:
                        await interaction.reply({ content: 'Invalid panel subcommand.', ephemeral: true });
                }
            } else if (subcommandGroup === 'lastfm') {
                // Route to Last.fm handlers
                switch (subcommand) {
                    case 'link': await lastfmHandlers.handleLink(interaction); break;
                    case 'unlink': await lastfmHandlers.handleUnlink(interaction); break;
                    case 'nowplaying': await lastfmHandlers.handleNowPlaying(interaction); break;
                    case 'recent': await lastfmHandlers.handleRecent(interaction); break;
                    case 'topartists': await lastfmHandlers.handleTopArtists(interaction); break;
                    case 'toptracks': await lastfmHandlers.handleTopTracks(interaction); break;
                    case 'topalbums': await lastfmHandlers.handleTopAlbums(interaction); break;
                    case 'compare': await lastfmHandlers.handleCompare(interaction); break;
                    case 'profile': await lastfmHandlers.handleProfile(interaction); break;
                    default:
                        await interaction.reply({ content: 'Invalid lastfm subcommand.', ephemeral: true });
                }
            } else {
                // Route to other handlers based on subcommand
                switch (subcommand) {
                    // Player handlers
                    case 'play': await playerHandlers.handlePlay(interaction); break;
                    case 'pause': await playerHandlers.handlePause(interaction); break;
                    case 'resume': await playerHandlers.handleResume(interaction); break;
                    case 'skip': await playerHandlers.handleSkip(interaction); break;
                    case 'stop': await playerHandlers.handleStop(interaction); break;
                    case 'nowplaying': await playerHandlers.handleNowPlaying(interaction); break;

                    // Queue handlers
                    case 'queue': await queueHandlers.handleQueue(interaction); break;
                    case 'shuffle': await queueHandlers.handleShuffle(interaction); break;
                    case 'clear': await queueHandlers.handleClear(interaction); break;
                    case 'remove': await queueHandlers.handleRemove(interaction); break;

                    // Control handlers
                    case 'volume': await controlsHandlers.handleVolume(interaction); break;
                    case 'loop': await controlsHandlers.handleLoop(interaction); break;
                    case 'filter': await controlsHandlers.handleFilter(interaction); break;
                    case 'seek': await controlsHandlers.handleSeek(interaction); break;

                    // Feature handlers
                    case 'lyrics': await featuresHandlers.handleLyrics(interaction); break;
                    case 'search': await featuresHandlers.handleSearch(interaction); break;
                    case 'dj': await featuresHandlers.handleDJ(interaction); break;
                    case 'record': await featuresHandlers.handleRecord(interaction); break;

                    // FlaviBot-style handlers (standalone commands)
                    case 'voteskip': await controlsHandlers.handleVoteSkip(interaction); break;
                    case 'forceskip': await controlsHandlers.handleForceSkip(interaction); break;
                    case 'eq': await controlsHandlers.handleEqualizer(interaction); break;

                    default:
                        await interaction.reply({ content: 'Invalid music subcommand.', ephemeral: true });
                }
            }
        } catch (error) {
            console.error(`[Music Command] Error in ${subcommandGroup || 'root'}/${subcommand}:`, error);
            const errorMessage = { content: 'An unexpected error occurred while executing this command.', ephemeral: true };
            if (interaction.deferred) {
                await interaction.editReply(errorMessage);
            } else if (!interaction.replied) {
                await interaction.reply(errorMessage);
            }
        }
    },

    category: 'music'
};
