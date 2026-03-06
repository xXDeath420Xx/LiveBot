import { EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import { checkMusicPermissions, useMainPlayer } from '../../utils/music_helpers.js';
import axios from 'axios';

/**
 * Handles fetching lyrics for the currently playing song
 */
export async function handleLyrics(interaction) {
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
            return interaction.editReply({ content: `No lyrics found for **${track.title}**.` });
        }

        const embed = new EmbedBuilder()
            .setColor("#3498DB")
            .setAuthor({ name: `Lyrics for ${track.title}` })
            .setDescription(lyrics.length > 4096 ? lyrics.substring(0, 4093) + "..." : lyrics);

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        if (error.response && error.response.status === 404) {
            return interaction.editReply({ content: `No lyrics found for **${track.title}**.` });
        }
        console.error("[Lyrics Command Error]", error.message);
        await interaction.editReply({ content: `An error occurred: ${error.message}` });
    }
}

/**
 * Handles searching for songs and letting users choose from results
 */
export async function handleSearch(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const query = interaction.options.getString("query");
    const { member } = interaction;

    if (!member.voice.channel) {
        return interaction.reply({ content: "You must be in a voice channel to search for music!", ephemeral: true });
    }

    await interaction.deferReply();

    try {
        const results = await interaction.client.player.search(query, { requestedBy: interaction.user });
        if (!results || !results.hasTracks()) {
            return interaction.editReply({ content: "No results found for your query." });
        }

        const tracks = results.tracks.slice(0, 10).filter(track => !track.url.includes('youtube.com/shorts'));
        if (tracks.length === 0) {
            return interaction.editReply({ content: "No valid results found (only YouTube Shorts, which are not supported)." });
        }

        const embed = new EmbedBuilder()
            .setColor("#3498DB")
            .setAuthor({ name: `Top ${tracks.length} Search Results for "${query}"` })
            .setDescription(tracks.map((track, i) => `**${i + 1}.** ${track.title} - \`${track.duration}\``).join("\n"))
            .setFooter({ text: "Type the number of the song you want to play. You have 30 seconds." });

        await interaction.editReply({ embeds: [embed] });

        const filter = m => m.author.id === interaction.user.id && parseInt(m.content) >= 1 && parseInt(m.content) <= tracks.length;
        const collector = interaction.channel.createMessageCollector({ filter, time: 30000, max: 1 });

        collector.on("collect", async m => {
            const choice = parseInt(m.content) - 1;
            const track = tracks[choice];
            await interaction.client.player.play(member.voice.channel, track, {
                nodeOptions: { metadata: { channelId: interaction.channel.id } }
            });
            m.delete().catch(() => {});
            interaction.editReply({ content: `Added **${track.title}** to the queue.` });
        });

        collector.on("end", (collected, reason) => {
            if (reason === "time") {
                interaction.editReply({ content: "You did not make a selection in time." });
            }
        });
    } catch (error) {
        console.error("[Search Command Error]", error.message);
        return interaction.editReply({ content: `An error occurred: ${error.message}` });
    }
}

/**
 * Handles starting an AI DJ session
 * NOTE: This is a simplified version. Full AI features require:
 * - Gemini AI API setup
 * - Piper TTS installation
 * - FFmpeg for audio processing
 */
export async function handleDJ(interaction) {
    const { member, guild, client } = interaction;
    const prompt = interaction.options.getString('prompt');
    const inputSong = interaction.options.getString('song');
    const inputArtist = interaction.options.getString('artist');
    const inputGenre = interaction.options.getString('genre');
    const playlistLink = interaction.options.getString('playlist_link');

    if (!member.voice.channel) {
        return interaction.reply({ content: "You must be in a voice channel to start a DJ session.", ephemeral: true });
    }

    const [musicConfigRows] = await pool.execute("SELECT * FROM ai_dj_config WHERE guild_id = ?", [guild.id]);
    const musicConfig = musicConfigRows[0];

    if (!musicConfig || !musicConfig.enabled) {
        return interaction.reply({ content: "The AI DJ is not enabled on this server. An admin can enable it in the dashboard.", ephemeral: true });
    }

    await interaction.deferReply();

    try {
        const player = useMainPlayer(interaction);

        // If a playlist link is provided, handle it as a playlist
        if (playlistLink) {
            const searchResult = await player.search(playlistLink, { requestedBy: member.user });
            if (!searchResult.hasTracks()) {
                return interaction.editReply({ content: "Could not find that playlist. Please check the link and try again." });
            }

            // Create queue with DJ mode metadata
            const { queue } = await player.play(member.voice.channel, searchResult, {
                nodeOptions: {
                    metadata: {
                        channelId: interaction.channelId,
                        djMode: true,
                        inputSong: inputSong || null,
                        inputArtist: inputArtist || null,
                        inputGenre: inputGenre || null,
                        playedTracks: [],
                        djInitiatorId: member.user.id,
                        prompt: prompt || null,
                        isGenerating: false
                    },
                    leaveOnEmpty: false,
                    leaveOnEnd: false,
                    leaveOnEmptyCooldown: 300000, // 5 minutes
                    selfDeaf: true,
                    volume: 80
                },
                requestedBy: member.user
            });

            return interaction.editReply({
                content: `🎧 **AI DJ session started!**\n\nPlaying playlist with ${searchResult.tracks.length} tracks.\nThe DJ will generate more recommendations when the queue runs low.`
            });
        }

        // No playlist link - we need to generate recommendations based on prompt/song/artist/genre
        // First, join the voice channel with a dummy search to initialize the queue
        const dummyUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"; // Rickroll as placeholder
        const dummyResult = await player.search(dummyUrl, { requestedBy: member.user });

        if (!dummyResult.hasTracks()) {
            return interaction.editReply({ content: "Failed to start AI DJ session: Could not initialize the music player. Please try again." });
        }

        // Create queue with DJ mode enabled
        const { queue } = await player.play(member.voice.channel, dummyResult.tracks[0], {
            nodeOptions: {
                metadata: {
                    channelId: interaction.channelId,
                    djMode: true,
                    inputSong: inputSong || null,
                    inputArtist: inputArtist || null,
                    inputGenre: inputGenre || null,
                    playedTracks: [],
                    djInitiatorId: member.user.id,
                    prompt: prompt || null,
                    isGenerating: false
                },
                leaveOnEmpty: false,
                leaveOnEnd: false,
                leaveOnEmptyCooldown: 300000, // 5 minutes
                selfDeaf: true,
                volume: 80
            },
            requestedBy: member.user
        });

        // Build description of what DJ is based on
        let djDescription = "";
        if (prompt) {
            djDescription = `Based on: "${prompt}"`;
        } else if (inputSong && inputArtist) {
            djDescription = `Based on: "${inputSong}" by ${inputArtist}`;
        } else if (inputSong) {
            djDescription = `Based on: "${inputSong}"`;
        } else if (inputArtist) {
            djDescription = `Based on artists like: ${inputArtist}`;
        } else if (inputGenre) {
            djDescription = `Genre: ${inputGenre}`;
        } else {
            djDescription = "Playing a mix of popular tracks";
        }

        return interaction.editReply({
            content: `🎧 **AI DJ session started!**\n\n${djDescription}\n\nThe DJ will generate playlists and keep the music flowing. Use \`/music stop\` to end the session.`
        });

    } catch (error) {
        console.error("[DJ Command Error]", error.message, error.stack);
        return interaction.editReply({ content: `An error occurred starting the DJ session: ${error.message}` });
    }
}

/**
 * Handles recording audio in a voice channel
 * NOTE: This requires additional voice recording setup
 */
export async function handleRecord(interaction) {
    return interaction.reply({
        content: "Voice recording feature is not yet implemented. This requires additional setup for audio capture.",
        ephemeral: true
    });
}
