const { SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { useMainPlayer, QueueRepeatMode, QueryType } = require("discord-player");
const { checkMusicPermissions } = require("../utils/music_helpers");
const db = require("../utils/db");
const axios = require("axios");
const path = require("path");
const spotifyApiModule = require("../utils/spotify-api.js");
const geminiApi = require("../utils/gemini-api.js");
const { joinVoiceChannel, createAudioReceiver, EndBehaviorType } = require("@discordjs/voice");
const fs = require("fs");
const prism = require("prism-media");

function toMilliseconds(timeString) {
    const timeRegex = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/;
    const matches = timeString.match(timeRegex);
    if (!matches) {
        return 0;
    }
    const hours = parseInt(matches[1], 10) || 0;
    const minutes = parseInt(matches[2], 10) || 0;
    const seconds = parseInt(matches[3], 10) || 0;

    return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('music')
        .setDescription('Music commands')
        .addSubcommand(subcommand =>
            subcommand
                .setName('play')
                .setDescription('Play a song')
                .addStringOption(option => option.setName('query').setDescription('The song to play').setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('skip')
                .setDescription('Skips the current song'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('stop')
                .setDescription('Stops the music and clears the queue'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('pause')
                .setDescription('Pause the music'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('resume')
                .setDescription('Resume the music'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('queue')
                .setDescription('Displays the current music queue'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('nowplaying')
                .setDescription('Displays information about the currently playing song'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('loop')
                .setDescription('Sets the loop mode for the music player')
                .addIntegerOption(option =>
                    option.setName("mode")
                        .setDescription("The loop mode to set")
                        .setRequired(true)
                        .addChoices(
                            { name: "Off", value: QueueRepeatMode.OFF },
                            { name: "Track", value: QueueRepeatMode.TRACK },
                            { name: "Queue", value: QueueRepeatMode.QUEUE },
                            { name: "Autoplay", value: QueueRepeatMode.AUTOPLAY },
                        )))
        .addSubcommand(subcommand =>
            subcommand
                .setName('lyrics')
                .setDescription('Gets the lyrics for the currently playing song'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('volume')
                .setDescription('Adjusts the playback volume')
                .addIntegerOption(option =>
                    option.setName("level")
                        .setDescription("The volume level (0-100)")
                        .setRequired(true)
                        .setMinValue(0)
                        .setMaxValue(100)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('shuffle')
                .setDescription('Shuffles the current queue'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('remove')
                .setDescription('Removes a song from the queue')
                .addIntegerOption(option =>
                    option.setName("track")
                        .setDescription("The track number to remove")
                        .setRequired(true)
                        .setMinValue(1)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('search')
                .setDescription('Searches for a song and lets you choose from the top results')
                .addStringOption(option =>
                    option.setName("query")
                        .setDescription("The song to search for")
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('clear')
                .setDescription('Clears all songs from the queue'))
        .addSubcommand(subcommand =>
            subcommand
                .setName("filter")
                .setDescription("Applies an audio filter to the music")
                .addStringOption(option =>
                    option.setName("filter")
                        .setDescription("The filter to apply or remove")
                        .setRequired(true)
                        .addChoices(
                            { name: "Bassboost", value: "bassboost" },
                            { name: "Nightcore", value: "nightcore" },
                            { name: "Vaporwave", value: "vaporwave" },
                            { name: "8D", value: "8D" },
                            { name: "Treble", value: "treble" },
                            { name: "Normalizer", value: "normalizer" }
                        )
                )
                .addStringOption(option =>
                    option.setName("action")
                        .setDescription("Whether to enable or disable the filter")
                        .setRequired(true)
                        .addChoices(
                            { name: "Enable", value: "enable" },
                            { name: "Disable", value: "disable" }
                        )
                )
        )
        .addSubcommandGroup(group =>
            group
                .setName('playlist')
                .setDescription('Manages your custom playlists')
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('create')
                        .setDescription('Creates a new playlist')
                        .addStringOption(option => option.setName('name').setDescription('The name of the playlist').setRequired(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('delete')
                        .setDescription('Deletes a playlist')
                        .addStringOption(option => option.setName('name').setDescription('The name of the playlist to delete').setRequired(true).setAutocomplete(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('add')
                        .setDescription('Adds the current song to a playlist')
                        .addStringOption(option => option.setName('name').setDescription('The name of the playlist').setRequired(true).setAutocomplete(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('remove')
                        .setDescription('Removes a song from a playlist')
                        .addIntegerOption(option => option.setName('position').setDescription('The position of the song to remove').setRequired(true).setMinValue(1)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('list')
                        .setDescription('Lists all of your playlists'))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('show')
                        .setDescription('Shows the songs in a playlist')
                        .addStringOption(option => option.setName('name').setDescription('The name of the playlist').setRequired(true).setAutocomplete(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('play')
                        .setDescription('Plays a playlist')
                        .addStringOption(option => option.setName('name').setDescription('The name of the playlist').setRequired(true).setAutocomplete(true))))
        .addSubcommand(subcommand =>
            subcommand
                .setName('dj')
                .setDescription('Starts an AI DJ session in your voice channel')
                .addStringOption(option => option.setName('song').setDescription('A song title to influence the DJ').setRequired(false))
                .addStringOption(option => option.setName('artist').setDescription('An artist to influence the DJ').setRequired(false))
                .addStringOption(option => option.setName('genre').setDescription('A genre to influence the DJ').setRequired(false))
                .addStringOption(option => option.setName('playlist_link').setDescription('A link to a Spotify or YouTube playlist to play').setRequired(false)))
        .addSubcommand(
            subcommand => subcommand
                .setName('record')
                .setDescription('Records the audio in a voice channel'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('seek')
                .setDescription('Seeks to a specific time in the current song')
                .addStringOption(option =>
                    option.setName("time")
                        .setDescription("The time to seek to (e.g., 1m30s, 2h, 45s)")
                        .setRequired(true))),

    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);
        if (focusedOption.name === "name") {
            const focusedValue = interaction.options.getString('name');
            try {
                const [playlists] = await db.execute("SELECT name FROM user_playlists WHERE guild_id = ? AND user_id = ? AND name LIKE ? LIMIT 25", [interaction.guild.id, interaction.user.id, `${focusedValue}%`]);
                await interaction.respond(playlists.map(p => ({ name: p.name, value: p.name })));
            } catch (error) {
                console.error("[Playlist Autocomplete Error]", error.message);
                await interaction.respond();
            }
        }
    },

    async execute(interaction) {
        const subcommandGroup = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();

        if (subcommandGroup === 'playlist') {
            const name = interaction.options.getString("name");
            const guildId = interaction.guild.id;
            const userId = interaction.user.id;

            try {
                switch (subcommand) {
                    case "create": {
                        await db.execute("INSERT INTO user_playlists (guild_id, user_id, name, songs) VALUES (?,?,?,?)", [guildId, userId, name, "[]"]);
                        return interaction.reply({ content: `✅ Playlist **${name}** created.`, ephemeral: true });
                    }
                    case "delete": {
                        const [result] = await db.execute("DELETE FROM user_playlists WHERE guild_id = ? AND user_id = ? AND name = ?", [guildId, userId, name]);
                        if (result.affectedRows > 0) {
                            return interaction.reply({ content: `🗑️ Playlist **${name}** deleted.`, ephemeral: true });
                        }
                        else {
                            return interaction.reply({ content: `❌ You don\'t have a playlist named **${name}**.`, ephemeral: true });
                        }
                    }
                    case "add": {
                        const queue = interaction.client.player.nodes.get(guildId);
                        if (!queue || !queue.isPlaying()) {
                            return interaction.reply({ content: "There is nothing playing to add!", ephemeral: true });
                        }
                        const currentTrack = queue.currentTrack;

                        const [[playlist]] = await db.execute("SELECT * FROM user_playlists WHERE guild_id = ? AND user_id = ? AND name = ?", [guildId, userId, name]);
                        if (!playlist) {
                            return interaction.reply({ content: `❌ You don\'t have a playlist named **${name}**.`, ephemeral: true });
                        }

                        const songs = JSON.parse(playlist.songs);
                        songs.push({ title: currentTrack.title, url: currentTrack.url });
                        await db.execute("UPDATE user_playlists SET songs = ? WHERE playlist_id = ?", [JSON.stringify(songs), playlist.playlist_id]);

                        return interaction.reply({ content: `✅ Added **${currentTrack.title}** to the **${name}** playlist.`, ephemeral: true });
                    }
                    case "remove": {
                        const position = interaction.options.getInteger("position") - 1;
                        const [[playlist]] = await db.execute("SELECT * FROM user_playlists WHERE guild_id = ? AND user_id = ? AND name = ?", [guildId, userId, name]);
                        if (!playlist) {
                            return interaction.reply({ content: `❌ You don\'t have a playlist named **${name}**.`, ephemeral: true });
                        }

                        const songs = JSON.parse(playlist.songs);
                        if (position < 0 || position >= songs.length) {
                            return interaction.reply({ content: "❌ Invalid song position.", ephemeral: true });
                        }

                        const removedSong = songs.splice(position, 1)[0];
                        await db.execute("UPDATE user_playlists SET songs = ? WHERE playlist_id = ?", [JSON.stringify(songs), playlist.playlist_id]);

                        return interaction.reply({ content: `🗑️ Removed **${removedSong.title}** from the **${name}** playlist.`, ephemeral: true });
                    }
                    case "list": {
                        const [playlists] = await db.execute("SELECT name FROM user_playlists WHERE guild_id = ? AND user_id = ?", [guildId, userId]);
                        if (playlists.length === 0) {
                            return interaction.reply({ content: "You don\'t have any playlists yet.", ephemeral: true });
                        }

                        const embed = new EmbedBuilder()
                            .setColor("#3498DB")
                            .setAuthor({ name: "Server Queue" })
                            .setDescription(playlists.map(p => `• ${p.name}`).join("\n"));

                        return interaction.reply({ embeds: [embed], ephemeral: true });
                    }
                    case "show": {
                        const [[playlist]] = await db.execute("SELECT * FROM user_playlists WHERE guild_id = ? AND user_id = ? AND name = ?", [guildId, userId, name]);
                        if (!playlist) {
                            return interaction.reply({ content: `❌ You don\'t have a playlist named **${name}**.`, ephemeral: true });
                        }

                        const songs = JSON.parse(playlist.songs);
                        const embed = new EmbedBuilder()
                            .setColor("#3498DB")
                            .setAuthor({ name: `Playlist: ${name}` })
                            .setDescription(songs.length > 0 ? songs.map((s, i) => `**${i + 1}.** [${s.title}](${s.url})`).join("\n") : "This playlist is empty.");

                        return interaction.reply({ embeds: [embed], ephemeral: true });
                    }
                    case "play": {
                        const permissionCheck = await checkMusicPermissions(interaction);
                        if (!permissionCheck.permitted) {
                            return interaction.reply({ content: permissionCheck.message, ephemeral: true });
                        }

                        if (!interaction.member.voice.channel) {
                            return interaction.reply({ content: "You must be in a voice channel to play music!", ephemeral: true });
                        }

                        const [[playlist]] = await db.execute("SELECT * FROM user_playlists WHERE guild_id = ? AND user_id = ? AND name = ?", [guildId, userId, name]);
                        if (!playlist) {
                            return interaction.reply({ content: `❌ You don\'t have a playlist named **${name}**.`, ephemeral: true });
                        }

                        const songs = JSON.parse(playlist.songs);
                        if (songs.length === 0) {
                            return interaction.reply({ content: `The **${name}** playlist is empty.`, ephemeral: true });
                        }

                        await interaction.deferReply();

                        try {
                            await interaction.client.player.play(interaction.member.voice.channel.id, songs.map(s => s.url).join("\n"), {
                                nodeOptions: {
                                    metadata: {
                                        channelId: interaction.channel.id,
                                        requesterId: interaction.user.id
                                    }
                                }
                            });

                            return interaction.followUp({ content: `▶️ Now playing the **${name}** playlist.` });

                        } catch (e) {
                            console.error("[Playlist Play Error]", e.message);
                            return interaction.followUp({ content: `❌ An error occurred while trying to play the playlist: ${e.message}` });
                        }
                    }
                }
            } catch (error) {
                console.error("[Playlist Command Error]", error.message);
                if (error.code === "ER_DUP_ENTRY") {
                    return interaction.reply({ content: `❌ You already have a playlist named **${name}**.`, ephemeral: true });
                }
                return interaction.reply({ content: "❌ An error occurred while executing this command.", ephemeral: true });
            }
        }
        else {
            switch (subcommand) {
                case 'play': {
                    const permissionCheck = await checkMusicPermissions(interaction);
                    if (!permissionCheck.permitted) {
                        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
                    }

                    if (!interaction.member.voice.channel) {
                        return interaction.reply({ content: "You must be in a voice channel to play music!", ephemeral: true });
                    }

                    await interaction.deferReply();

                    const player = useMainPlayer();
                    const query = interaction.options.getString("query");
                    let queue = player.nodes.get(interaction.guild.id);

                    try {
                        const searchResult = await player.search(query, {
                            searchEngine: 'com.livebot.ytdlp',
                            metadata: { requesterId: interaction.user.id }
                        });

                        if (!searchResult || !searchResult.tracks.length) {
                            return interaction.editReply({ content: `❌ | No results found for your query: ${query}` });
                        }
                        const requestedTrack = searchResult.tracks[0];

                        if (!queue) {
                            queue = player.nodes.create(interaction.guild.id, {
                                metadata: {
                                    channelId: interaction.channel.id,
                                    djMode: false,
                                    voiceChannelId: interaction.member.voice.channel.id
                                },
                                selfDeaf: true,
                                volume: 80,
                                leaveOnEmpty: true,
                                leaveOnEmptyCooldown: 300000,
                                leaveOnEnd: true,
                                leaveOnEndCooldown: 300000,
                            });
                        }

                        if (!queue.connection) {
                            await queue.connect(interaction.member.voice.channel.id);
                        }

                        queue.addTrack(requestedTrack);

                        if (!queue.isPlaying()) {
                            await queue.node.play();
                        }

                        return interaction.editReply({ content: `✅ | Added **${requestedTrack.title}** to the queue.` });

                    } catch (e) {
                        console.error("[Play Command Error]", e.message);
                        return interaction.editReply({ content: `An error occurred: ${e.message}` });
                    }
                    break;
                }
                case 'pause': {
                    const permissionCheck = await checkMusicPermissions(interaction);
                    if (!permissionCheck.permitted) {
                        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
                    }

                    const queue = interaction.client.player.nodes.get(interaction.guildId);
                    if (!queue || !queue.isPlaying()) {
                        return interaction.reply({ content: "There is nothing playing right now!", ephemeral: true });
                    }

                    if (queue.node.isPaused()) {
                        return interaction.reply({ content: "The music is already paused!", ephemeral: true });
                    }

                    try {
                        queue.node.setPaused(true);
                        await interaction.reply({ content: "⏸️ Paused the music." });
                    }
                    catch (e) {
                        await interaction.reply({ content: `❌ Error: ${e.message}` });
                    }
                    break;
                }
                case 'resume': {
                    const permissionCheck = await checkMusicPermissions(interaction);
                    if (!permissionCheck.permitted) {
                        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
                    }

                    const queue = interaction.client.player.nodes.get(interaction.guildId);
                    if (!queue || !queue.isPlaying()) {
                        return interaction.reply({ content: "There is nothing playing right now!", ephemeral: true });
                    }

                    if (!queue.node.isPaused()) {
                        return interaction.reply({ content: "The music is not paused!", ephemeral: true });
                    }

                    try {
                        queue.node.setPaused(false);
                        await interaction.reply({ content: "▶️ Resumed the music." });
                    }
                    catch (e) {
                        await interaction.reply({ content: `❌ Error: ${e.message}` });
                    }
                    break;
                }
                case 'queue': {
                    const permissionCheck = await checkMusicPermissions(interaction);
                    if (!permissionCheck.permitted) {
                        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
                    }

                    const queue = interaction.client.player.nodes.get(interaction.guildId);
                    if (!queue || !queue.isPlaying()) {
                        return interaction.reply({ content: "There is nothing in the queue right now!", ephemeral: true });
                    }

                    const tracks = queue.tracks.toArray();
                    const currentTrack = queue.currentTrack;

                    if (!currentTrack && tracks.length === 0) {
                        return interaction.reply({ content: "The queue is empty.", ephemeral: true });
                    }

                    const trackStrings = await Promise.all(tracks.slice(0, 10).map(async (track, i) => {
                        let requesterTag = 'DJ Bot';
                        const requesterId = track.metadata?.requesterId || track.requestedBy?.id;
                        if (requesterId) {
                            try {
                                const requester = await interaction.client.users.fetch(requesterId);
                                requesterTag = requester.tag;
                            } catch {
                                requesterTag = 'Unknown User';
                            }
                        }
                        return `**${i + 1}.** \`${track.title}\` - ${requesterTag}`;
                    }));

                    const queueString = trackStrings.join("\n");

                    let currentTrackRequesterTag = 'DJ Bot';
                    const currentRequesterId = currentTrack?.metadata?.requesterId || currentTrack?.requestedBy?.id;
                    if (currentTrack && currentRequesterId) {
                        try {
                            const currentRequester = await interaction.client.users.fetch(currentRequesterId);
                            currentTrackRequesterTag = currentRequester.tag;
                        } catch {
                            currentTrackRequesterTag = 'Unknown User';
                        }
                    }

                    const embed = new EmbedBuilder()
                        .setColor("#3498DB")
                        .setAuthor({ name: "Server Queue" })
                        .setDescription(
                            currentTrack
                                ? `**Currently Playing:**\\n\`${currentTrack.title}\` - ${currentTrackRequesterTag}\\n\\n**Up Next:**\\n${queueString || "Nothing"}`
                                : `**Currently Playing:**\\nNothing\\n\\n**Up Next:**\\n${queueString || "Nothing"}`
                        )
                        .setFooter({ text: `Total songs in queue: ${tracks.length}` });

                    await interaction.reply({ embeds: [embed] });
                    break;
                }
                case 'skip': {
                    const permissionCheck = await checkMusicPermissions(interaction);
                    if (!permissionCheck.permitted) {
                        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
                    }

                    const queue = interaction.client.player.nodes.get(interaction.guildId);
                    if (!queue || !queue.isPlaying()) {
                        return interaction.reply({ content: "There is nothing playing to skip!", ephemeral: true });
                    }

                    try {
                        const success = queue.node.skip();
                        await interaction.reply({ content: success ? "⏭️ Skipped! Now playing the next song." : "❌ Something went wrong while skipping." });
                    }
                    catch (e) {
                        await interaction.reply({ content: `❌ Error: ${e.message}` });
                    }
                    break;
                }
                case 'loop': {
                    const permissionCheck = await checkMusicPermissions(interaction);
                    if (!permissionCheck.permitted) {
                        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
                    }

                    const queue = interaction.client.player.nodes.get(interaction.guildId);
                    if (!queue || !queue.isPlaying()) {
                        return interaction.reply({ content: "There is nothing playing right now!", ephemeral: true });
                    }

                    const loopMode = interaction.options.getInteger("mode");

                    try {
                        queue.setRepeatMode(loopMode);
                        const modeName = Object.keys(QueueRepeatMode).find(key => QueueRepeatMode[key] === loopMode);
                        await interaction.reply({ content: `🔄 Loop mode set to **${modeName}**.` });
                    }
                    catch (e) {
                        await interaction.reply({ content: `❌ Error: ${e.message}` });
                    }
                    break;
                }
                case 'lyrics': {
                    const permissionCheck = await checkMusicPermissions(interaction);
                    if (!permissionCheck.permitted) {
                        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
                    }

                    const queue = interaction.client.player.nodes.get(interaction.guildId);
                    if (!queue || !queue.isPlaying()) {
                        return interaction.reply({ content: "There is nothing playing right now!", ephemeral: true });
                    }

                    await interaction.deferReply();

                    const track = queue.currentTrack;
                    const trackTitle = track.title.replace(/\(official.*?\)/i, "").replace(/\(feat.*?\)/i, "").trim();

                    try {
                        const response = await axios.get(`https://api.lyrics.ovh/v1/${track.author}/${trackTitle}`);
                        const lyrics = response.data.lyrics;

                        if (!lyrics) {
                            return interaction.editReply({ content: `❌ No lyrics found for **${track.title}**.` });
                        }

                        const embed = new EmbedBuilder()
                            .setColor("#3498DB")
                            .setAuthor({ name: `Lyrics for ${track.title}` })
                            .setDescription(lyrics.length > 4096 ? lyrics.substring(0, 4093) + "..." : lyrics);

                        await interaction.editReply({ embeds: [embed] });

                    }
                    catch (error) {
                        if (error.response && error.response.status === 404) {
                            return interaction.editReply({ content: `❌ No lyrics found for **${track.title}**.` });
                        }
                        console.error("[Lyrics Command Error]", error.message);
                        await interaction.editReply({ content: `An error occurred: ${error.message}` });
                    }
                    break;
                }
                case 'nowplaying': {
                    const permissionCheck = await checkMusicPermissions(interaction);
                    if (!permissionCheck.permitted) {
                        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
                    }

                    const queue = interaction.client.player.nodes.get(interaction.guildId);
                    if (!queue || !queue.isPlaying()) {
                        return interaction.reply({ content: "There is nothing playing right now!", ephemeral: true });
                    }

                    const track = queue.currentTrack;

                    if (!track) {
                        return interaction.reply({ content: "There is nothing playing right now!", ephemeral: true });
                    }

                    const progress = queue.node.createProgressBar();
                    
                    let requesterTag = 'DJ Bot';
                    const requesterId = track.metadata?.requesterId || track.requestedBy?.id;
                    if (requesterId) {
                        try {
                            const requester = await interaction.client.users.fetch(requesterId);
                            requesterTag = requester.tag;
                        } catch {
                            requesterTag = 'Unknown User';
                        }
                    }

                    const embed = new EmbedBuilder()
                        .setColor("#57F287")
                        .setAuthor({ name: "Now Playing" })
                        .setTitle(track.title || "Unknown Title")
                        .setURL(track.url || null)
                        .setThumbnail(track.thumbnail || null)
                        .addFields(
                            { name: "Artist", value: track.author || "N/A", inline: true },
                            { name: "Duration", value: track.duration || "0:00", inline: true },
                            { name: "Requested by", value: requesterTag, inline: true },
                            { name: "Progress", value: progress, inline: false }
                        );

                    await interaction.reply({ embeds: [embed] });
                    break;
                }
                case 'stop': {
                    const permissionCheck = await checkMusicPermissions(interaction);
                    if (!permissionCheck.permitted) {
                        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
                    }

                    const queue = interaction.client.player.nodes.get(interaction.guildId);
                    if (!queue || !queue.isPlaying()) {
                        return interaction.reply({ content: "There is nothing playing right now!", ephemeral: true });
                    }

                    try {
                        queue.delete();
                        await interaction.reply({ content: "⏹️ Music stopped and queue cleared." });
                    }
                    catch (e) {
                        await interaction.reply({ content: `❌ Error: ${e.message}` });
                    }
                    break;
                }
                case 'volume': {
                    const permissionCheck = await checkMusicPermissions(interaction);
                    if (!permissionCheck.permitted) {
                        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
                    }

                    const queue = interaction.client.player.nodes.get(interaction.guildId);
                    if (!queue || !queue.isPlaying()) {
                        return interaction.reply({ content: "There is nothing playing right now!", ephemeral: true });
                    }

                    const volume = interaction.options.getInteger("level");

                    try {
                        queue.node.setVolume(volume);
                        await interaction.reply({ content: `🔊 Volume set to **${volume}%**.` });
                    }
                    catch (e) {
                        await interaction.reply({ content: `❌ Error: ${e.message}` });
                    }
                    break;
                }
                case 'shuffle': {
                    const permissionCheck = await checkMusicPermissions(interaction);
                    if (!permissionCheck.permitted) {
                        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
                    }

                    const queue = interaction.client.player.nodes.get(interaction.guildId);
                    if (!queue || !queue.isPlaying() || queue.tracks.size < 2) {
                        return interaction.reply({ content: "There are not enough songs in the queue to shuffle!", ephemeral: true });
                    }

                    try {
                        queue.tracks.shuffle();
                        await interaction.reply({ content: "🔀 The queue has been shuffled." });
                    }
                    catch (e) {
                        await interaction.reply({ content: `❌ Error: ${e.message}` });
                    }
                    break;
                }
                case 'remove': {
                    const permissionCheck = await checkMusicPermissions(interaction);
                    if (!permissionCheck.permitted) {
                        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
                    }

                    const queue = interaction.client.player.nodes.get(interaction.guildId);
                    if (!queue || !queue.isPlaying()) {
                        return interaction.reply({ content: "There is nothing in the queue right now!", ephemeral: true });
                    }

                    const position = interaction.options.getInteger("track") - 1;
                    const tracks = queue.tracks.toArray();

                    if (position >= tracks.length) {
                        return interaction.reply({ content: "❌ Invalid song position.", ephemeral: true });
                    }

                    try {
                        const removedTrack = queue.node.remove(tracks[position]);
                        await interaction.reply({ content: `🗑️ Removed **${removedTrack.title}** from the queue.` });
                    }
                    catch (e) {
                        await interaction.reply({ content: `❌ Error: ${e.message}` });
                    }
                    break;
                }
                case 'search': {
                    const permissionCheck = await checkMusicPermissions(interaction);
                    if (!permissionCheck.permitted) {
                        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
                    }

                    const query = interaction.options.getString("query");
                    const { member, guild } = interaction;

                    if (!member.voice.channel) {
                        return interaction.reply({ content: "You must be in a voice channel to search for music!", ephemeral: true });
                    }

                    await interaction.deferReply();

                    try {
                        const results = await interaction.client.player.search(query, {
                            metadata: { requesterId: interaction.user.id },
                        });

                        if (!results || !results.hasTracks()) {
                            return interaction.editReply({ content: "No results found for your query." });
                        }

                        const tracks = results.tracks.slice(0, 10);

                        const embed = new EmbedBuilder()
                            .setColor("#3498DB")
                            .setAuthor({ name: `Top 10 Search Results for "${query}"` })
                            .setDescription(tracks.map((track, i) => `**${i + 1}.** ${track.title} - \`${track.duration}\``).join("\n"))
                            .setFooter({ text: "Type the number of the song you want to play. You have 30 seconds." });

                        await interaction.editReply({ embeds: [embed] });

                        const filter = m => m.author.id === interaction.user.id && parseInt(m.content) >= 1 && parseInt(m.content) <= tracks.length;
                        const collector = interaction.channel.createMessageCollector({ filter, time: 30000, max: 1 });

                        collector.on("collect", async m => {
                            const choice = parseInt(m.content) - 1;
                            const track = tracks[choice];

                            await interaction.client.player.play(member.voice.channel.id, track, {
                                nodeOptions: {
                                    metadata: {
                                        channelId: interaction.channel.id,
                                        requesterId: interaction.user.id
                                    }
                                }
                            });

                            m.delete().catch(() => {
                            });
                            interaction.editReply({ content: `✅ | Added **${track.title}** to the queue.` });
                        });

                        collector.on("end", (collected, reason) => {
                            if (reason === "time") {
                                interaction.editReply({ content: "❌ | You did not make a selection in time." });
                            }
                        });
                    }
                    catch (error) {
                        console.error("[Search Command Error]", error.message);
                        return interaction.editReply({ content: `An error occurred: ${error.message}` });
                    }
                    break;
                }
                case 'dj': {
                    const { member, guild, client } = interaction;
                    const inputSong = interaction.options.getString('song');
                    const inputArtist = interaction.options.getString('artist');
                    const inputGenre = interaction.options.getString('genre');
                    const playlistLink = interaction.options.getString('playlist_link');

                    console.log(`[DJ Command] Initial inputs: song=${inputSong}, artist=${inputArtist}, genre=${inputGenre}`);

                    if (!member.voice.channel) {
                        return interaction.reply({ content: "You must be in a voice channel to start a DJ session.", ephemeral: true });
                    }

                    const [musicConfigRows] = await db.execute("SELECT * FROM music_config WHERE guild_id = ?", [guild.id]);
                    const musicConfig = musicConfigRows[0];

                    if (!musicConfig || !musicConfig.dj_enabled) {
                        return interaction.reply({ content: "The AI DJ is not enabled on this server. An admin can enable it in the dashboard.", ephemeral: true });
                    }

                    await interaction.deferReply();

                    try {
                        let queue = client.player.nodes.get(guild.id);
                        if (!queue) {
                            queue = client.player.nodes.create(guild.id, {
                                metadata: {
                                    channelId: interaction.channel.id,
                                    djMode: true,
                                    voiceChannelId: member.voice.channel.id,
                                    playedTracks: []
                                },
                                selfDeaf: true,
                                volume: 80,
                                leaveOnEmpty: true,
                                leaveOnEmptyCooldown: 300000,
                                leaveOnEnd: false,
                                leaveOnEndCooldown: 300000,
                            });
                        }


                        if (!queue.connection) {
                            await queue.connect(member.voice.channel.id);
                        }

                        let allPlaylistTracks = [];

                        if (playlistLink) {
                            try {
                                const searchResult = await client.player.search(playlistLink, {
                                    metadata: { requesterId: interaction.user.id },
                                });

                                if (!searchResult.hasTracks()) {
                                    return interaction.followUp({ content: `❌ | No tracks found for the provided playlist link.` });
                                }

                                allPlaylistTracks = searchResult.tracks;

                            } catch (e) {
                                console.error("[DJ Playlist Play Error]", e.message);
                                return interaction.followUp({ content: `❌ An error occurred while trying to play the playlist: ${e.message}` });
                            }
                        }
                        else {
                            console.log(`[DJ Command] Generating playlist with Gemini AI based on: song=${inputSong}, artist=${inputArtist}, genre=${inputGenre}`);
                            const geminiRecommendedTracks = await geminiApi.generatePlaylistRecommendations(inputSong, inputArtist, inputGenre, queue.metadata.playedTracks);

                            if (!geminiRecommendedTracks || geminiRecommendedTracks.length === 0) {
                                return interaction.followUp({ content: `❌ | Gemini AI could not generate a playlist based on your request. Please try again with different inputs.` });
                            }

                            const trackPromises = geminiRecommendedTracks.map(async (recTrack) => {
                                const query = `${recTrack.title} ${recTrack.artist}`;
                                const searchResult = await client.player.search(query, {
                                    searchEngine: 'com.livebot.ytdlp',
                                    metadata: { requesterId: interaction.user.id, artist: recTrack.artist }
                                });
                                if (searchResult.hasTracks()) {
                                    return searchResult.tracks[0];
                                }
                                return null;
                            });

                            const resolvedTracks = await Promise.all(trackPromises);
                            allPlaylistTracks = resolvedTracks.filter(track => track !== null);
                        }

                        if (allPlaylistTracks.length === 0) {
                            return interaction.followUp({ content: `❌ | Could not find any playable tracks for the generated playlist.` });
                        }

                        queue.metadata.playedTracks.push(...allPlaylistTracks.map(t => t.title));


                        try {
                            console.log('[DJ Command] Attempting to call client.djManager.playPlaylistIntro...');
                            await client.djManager.playPlaylistIntro(queue, allPlaylistTracks);
                            console.log('[DJ Command] client.djManager.playPlaylistIntro call completed.');
                        } catch (introError) {
                            console.error('[DJ Command] Error calling playPlaylistIntro:', introError.message);
                            queue.addTrack(allPlaylistTracks);
                            return interaction.followUp({ content: `❌ | An error occurred while generating DJ intro: ${introError.message}. Playing playlist without intro.` });
                        }

                        console.log(`[DJ Command] Checking queue.isPlaying(): ${queue.isPlaying()}`);
                        if (!queue.isPlaying()) {
                            console.log('[DJ Command] Queue not playing, initiating playback...');
                            try {
                                await queue.node.play();
                                console.log('[DJ Command] Playback initiated successfully.');
                            } catch (playError) {
                                console.error('[DJ Command] Error initiating playback:', playError.message);
                                return interaction.followUp({ content: `❌ | An error occurred while starting playback: ${playError.message}` });
                            }
                        }

                        return interaction.followUp({ content: `🎧 | Gemini AI DJ session started! An introductory commentary will play, followed by ${allPlaylistTracks.length} songs based on your preferences.` });

                    } catch (e) {
                        console.error("[DJ Command Error]", e.message);
                        return interaction.followUp({ content: `An error occurred: ${e.message}` });
                    }
                    break;
                }
                case 'record': {
                    await interaction.deferReply({ ephemeral: true });

                    const guildId = interaction.guild.id;
                    const member = interaction.member;

                    const [[recordConfig]] = await db.execute("SELECT is_enabled, allowed_role_ids, output_channel_id FROM record_config WHERE guild_id = ?", [guildId]);

                    if (!recordConfig || !recordConfig.is_enabled) {
                        return interaction.editReply({ content: "Voice recording is not enabled for this server." });
                    }

                    const allowedRoleIds = recordConfig.allowed_role_ids ? JSON.parse(recordConfig.allowed_role_ids) : [];
                    const outputChannelId = recordConfig.output_channel_id;

                    const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);
                    const hasAllowedRole = allowedRoleIds.some(roleId => member.roles.cache.has(roleId));

                    if (!isAdmin && !hasAllowedRole) {
                        return interaction.editReply({ content: "You do not have permission to use this command." });
                    }

                    const voiceChannel = member.voice.channel;
                    if (!voiceChannel) {
                        return interaction.editReply({ content: "You must be in a voice channel to use this command." });
                    }

                    let outputChannel = null;
                    if (outputChannelId) {
                        try {
                            outputChannel = await interaction.client.channels.fetch(outputChannelId);
                        }
                        catch (e) {
                            console.error(`[Record Command] Could not fetch output channel ${outputChannelId} for guild ${guildId}:`, e.message);
                        }
                    }

                    try {
                        const connection = joinVoiceChannel({
                            channelId: voiceChannel.id,
                            guildId: guildId,
                            adapterCreator: interaction.guild.voiceAdapterCreator,
                            selfDeaf: false,
                        });

                        const receiver = connection.receiver;
                        const audioStream = receiver.subscribe(member.id, {
                            end: {
                                behavior: EndBehaviorType.AfterSilence,
                                duration: 1000,
                            },
                        });

                        const recordingsDir = "./temp_audio";
                        if (!fs.existsSync(recordingsDir)) {
                            fs.mkdirSync(recordingsDir);
                        }

                        const filename = `${recordingsDir}/${Date.now()}-${member.user.username}.pcm`;
                        const fileStream = fs.createWriteStream(filename);
                        const pcmStream = audioStream.pipe(new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 }));

                        pcmStream.pipe(fileStream);

                        let recordingStartTime = Date.now();

                        const startEmbed = new EmbedBuilder()
                            .setColor("#00FF00")
                            .setDescription(`🎙️ Recording started in ${voiceChannel.name} by ${member.user.tag}.`);

                        if (outputChannel) {
                            try {
                                await outputChannel.send({ embeds: [startEmbed] });
                            }
                            catch (sendError) {
                                console.error(`[Record Command] Failed to send start embed to output channel ${outputChannel.id}:`, sendError.message);
                            }
                        }
                        await interaction.editReply({ content: `✅ Recording started. The recording will be saved.`, ephemeral: true });

                        fileStream.on("finish", async () => {
                            const durationSeconds = Math.floor((Date.now() - recordingStartTime) / 1000);
                            const endEmbed = new EmbedBuilder()
                                .setColor("#FF0000")
                                .setDescription(`🔴 Recording stopped in ${voiceChannel.name}. Duration: ${durationSeconds} seconds.`);

                            if (outputChannel) {
                                try {
                                    await outputChannel.send({ embeds: [endEmbed] });
                                }
                                catch (sendError) {
                                    console.error(`[Record Command] Failed to send end embed to output channel ${outputChannel.id}:`, sendError.message);
                                }
                            }
                            console.log(` Recording for ${member.user.tag} in ${voiceChannel.name} finished. Saved to ${filename}`);
                        });

                        connection.on("stateChange", (oldState, newState) => {
                            if (newState.status === "disconnected") {
                                fileStream.end();
                                console.log(` Voice connection disconnected for ${member.user.tag}.`);
                            }
                        });

                    } catch (error) {
                        console.error("[Record Command Error]", error.message);
                        return interaction.editReply({ content: "An error occurred while trying to start the recording." });
                    }
                    break;
                }
                case 'seek': {
                    const permissionCheck = await checkMusicPermissions(interaction);
                    if (!permissionCheck.permitted) {
                        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
                    }

                    const queue = interaction.client.player.nodes.get(interaction.guildId);
                    if (!queue || !queue.isPlaying()) {
                        return interaction.reply({ content: "There is nothing playing right now!", ephemeral: true });
                    }

                    const timeString = interaction.options.getString("time");
                    const timeMs = toMilliseconds(timeString);

                    if (timeMs <= 0) {
                        return interaction.reply({ content: "❌ Invalid time format. Use format like `1m30s`, `2h`, `45s`.", ephemeral: true });
                    }

                    try {
                        await queue.node.seek(timeMs);
                        await interaction.reply({ content: `⏩ Seeked to **${timeString}**.` });
                    }
                    catch (e) {
                        await interaction.reply({ content: `❌ Error: ${e.message}` });
                    }
                    break;
                }
                case 'clear': {
                    const permissionCheck = await checkMusicPermissions(interaction);
                    if (!permissionCheck.permitted) {
                        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
                    }

                    const queue = interaction.client.player.nodes.get(interaction.guildId);
                    if (!queue || !queue.isPlaying()) {
                        return interaction.reply({ content: "There is nothing in the queue to clear!", ephemeral: true });
                    }

                    if (queue.tracks.size < 1) {
                        return interaction.reply({ content: "The queue is already empty.", ephemeral: true });
                    }

                    try {
                        queue.tracks.clear();
                        await interaction.reply({ content: "🗑️ The queue has been cleared." });
                    }
                    catch (e) {
                        await interaction.reply({ content: `❌ Error: ${e.message}` });
                    }
                    break;
                }
                case 'filter': {
                    const permissionCheck = await checkMusicPermissions(interaction);
                    if (!permissionCheck.permitted) {
                        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
                    }

                    const queue = interaction.client.player.nodes.get(interaction.guildId);
                    if (!queue || !queue.isPlaying()) {
                        return interaction.reply({ content: "There is nothing playing right now!", ephemeral: true });
                    }

                    const filterName = interaction.options.getString("filter");
                    const action = interaction.options.getString("action");

                    try {
                        if (action === "enable") {
                            queue.filters.ffmpeg.toggle(filterName);
                            await interaction.reply({ content: `✅ **${filterName}** filter enabled.` });
                        }
                        else {
                            queue.filters.ffmpeg.toggle(filterName);
                            await interaction.reply({ content: `❌ **${filterName}** filter disabled.` });
                        }
                    }
                    catch (e) {
                        await interaction.reply({ content: `❌ Error: ${e.message}` });
                    }
                    break;
                }
                default:
                    await interaction.reply({ content: 'Invalid music subcommand.', ephemeral: true });
                    break;
            }
        }
    },
};
