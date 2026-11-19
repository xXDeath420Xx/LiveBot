import { EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import { checkMusicPermissions, useMainPlayer, getLeaveOptions } from '../../utils/music_helpers.js';
import axios from 'axios';
import logger from '../../utils/logger.js';
import djLibrary from '../../core/dj-blocklist.cjs';
import { loadPreset, markPresetUsed, loadBlocklist, loadFavorites, stripBlockedFromResult } from './dj-library.js';
import { handleRecord as handleRecordCommand } from './recording.js';

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
        const response = await axios.get(`https://api.lyrics.ovh/v1/${encodeURIComponent(track.author)}/${encodeURIComponent(trackTitle)}`);
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

    let query = interaction.options.getString("query");
    const { member } = interaction;

    if (!member.voice.channel) {
        return interaction.reply({ content: "You must be in a voice channel to search for music!", ephemeral: true });
    }

    await interaction.deferReply();

    // Strip Spotify share-flow params (flow_ctx, etc.) that break auto-routing
    if (query && (query.includes('open.spotify.com/') || query.startsWith('spotify:'))) {
        try {
            const url = new URL(query);
            for (const key of [...url.searchParams.keys()]) url.searchParams.delete(key);
            query = url.toString();
        } catch { /* not a parseable URL — pass through as-is */ }
    }

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
            m.delete().catch(() => {});
            try {
                await interaction.client.player.play(member.voice.channel, track, {
                    nodeOptions: {
                        metadata: { channelId: interaction.channel.id },
                        ...(await getLeaveOptions(interaction.guildId))
                    }
                });
                await interaction.editReply({ content: `Added **${track.title}** to the queue.`, embeds: [] });
            } catch (e) {
                console.error("[Search Select Error]", e.message);
                await interaction.editReply({ content: `Couldn't play **${track.title}**: ${e.message}`, embeds: [] }).catch(() => {});
            }
        });

        collector.on("end", (collected, reason) => {
            if (reason === "time") {
                interaction.editReply({ content: "You did not make a selection in time.", embeds: [] }).catch(() => {});
            }
        });
    } catch (error) {
        console.error("[Search Command Error]", error.message);
        return interaction.editReply({ content: `An error occurred: ${error.message}` });
    }
}

/** A dashboard list field: saved as comma-separated text, but the column default is a JSON array. */
function settingList(value) {
    const text = String(value ?? '').trim();
    if (!text) return [];
    if (text.startsWith('[')) {
        try { return JSON.parse(text).map(s => String(s).trim()).filter(Boolean); } catch { /* fall through */ }
    }
    return text.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * The dashboard's AI DJ settings (ai_dj_config) applied to a session request. With no seed in the
 * command they become the request; with a seed, the standing instructions (mood, activity, era,
 * clean-only, variety, extra instructions) still apply. Returns the prompt for the DJ engine, or
 * null to let it use the seed fields as-is.
 */
export function djPromptFromSettings(config, { prompt, inputSong, inputArtist, inputGenre }) {
    const standing = [];
    if (config.mood) standing.push(`mood: ${config.mood}`);
    if (config.activity_type) standing.push(`good for ${config.activity_type}`);
    const start = Number(config.year_range_start) || null;
    const end = Number(config.year_range_end) || null;
    if (start || end) standing.push(`released ${start || 'any year'} to ${end || 'now'}`);
    if (Number(config.filter_explicit)) standing.push('clean (non-explicit) songs only');
    const variety = Number(config.randomness_level);
    if (Number.isFinite(variety) && config.randomness_level !== null && variety !== 5) {
        standing.push(`variety ${variety}/10 (0 = stay very close to the seeds, 10 = very adventurous)`);
    }
    if (config.ai_prompt && String(config.ai_prompt).trim()) standing.push(String(config.ai_prompt).trim());

    if (prompt) return [prompt, ...standing].join('. ');
    if (inputSong || inputArtist || inputGenre) {
        if (!standing.length) return null;
        const seed = inputSong && inputArtist ? `similar to "${inputSong}" by ${inputArtist}`
            : inputSong ? `similar to "${inputSong}"`
            : inputArtist ? `by artists similar to ${inputArtist}` : '';
        return [[seed, inputGenre ? `in the genre ${inputGenre}` : ''].filter(Boolean).join(', '), ...standing].join('. ');
    }
    const seeds = [];
    const genres = settingList(config.genres), artists = settingList(config.artists), songs = settingList(config.songs);
    if (genres.length) seeds.push(`genres: ${genres.join(', ')}`);
    if (artists.length) seeds.push(`artists like ${artists.join(', ')}`);
    if (songs.length) seeds.push(`songs like ${songs.join(', ')}`);
    const all = [...seeds, ...standing];
    return all.length ? all.join('. ') : null;
}

/**
 * Handles starting an AI DJ session.
 *
 * Seeds, in order: the command's own options; a saved preset (`preset:` — options given alongside it
 * override its fields); with neither, a few of the server's favourite songs picked by weight (re-picked
 * for every batch by the DJ manager); and the dashboard's AI DJ settings on top of all of them. The
 * server's DJ blocklist is enforced by the DJ manager for generated batches, and here for a playlist link.
 */
export async function handleDJ(interaction) {
    const { member, guild, client } = interaction;
    // Same gate as every other music command: the Music switch, the music channels and the DJ role (H-667).
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }
    let commandPrompt = interaction.options.getString('prompt');
    let inputSong = interaction.options.getString('song');
    let inputArtist = interaction.options.getString('artist');
    let inputGenre = interaction.options.getString('genre');
    let playlistLink = interaction.options.getString('playlist_link');
    const presetName = interaction.options.getString('preset');

    const [musicConfigRows] = await pool.execute("SELECT * FROM ai_dj_config WHERE guild_id = ?", [guild.id]);
    const musicConfig = musicConfigRows[0];

    if (!musicConfig || !musicConfig.enabled) {
        return interaction.reply({ content: "The AI DJ is not enabled on this server. An admin can enable it in the dashboard.", ephemeral: true });
    }

    let preset = null;
    if (presetName) {
        preset = await loadPreset(guild.id, presetName);
        if (!preset) {
            return interaction.reply({ content: `There's no AI DJ preset called **${presetName.slice(0, 100)}** here. \`/music settings djpreset action:List\` shows the saved ones.`, ephemeral: true });
        }
        commandPrompt ??= preset.cfg.prompt || null;
        inputSong ??= preset.cfg.song || null;
        inputArtist ??= preset.cfg.artist || null;
        inputGenre ??= preset.cfg.genre || null;
        playlistLink ??= preset.cfg.playlistLink || null;
    }

    // Dashboard settings: voice channel (used when the caller isn't in one), announcement channel, volume.
    const configuredVoice = musicConfig.voice_channel_id ? guild.channels.cache.get(String(musicConfig.voice_channel_id)) : null;
    const voiceChannel = member.voice.channel || (configuredVoice?.isVoiceBased?.() ? configuredVoice : null);
    if (!voiceChannel) {
        return interaction.reply({ content: "You must be in a voice channel to start a DJ session.", ephemeral: true });
    }
    const configuredText = musicConfig.announcement_channel_id ? guild.channels.cache.get(String(musicConfig.announcement_channel_id)) : null;
    const announceChannelId = configuredText?.isTextBased?.() ? configuredText.id : interaction.channelId;
    const volume = Number(musicConfig.volume) >= 1 && Number(musicConfig.volume) <= 100 ? Number(musicConfig.volume) : 80;
    const basePrompt = djPromptFromSettings(musicConfig, { prompt: commandPrompt, inputSong, inputArtist, inputGenre });
    let prompt = basePrompt;

    // No seed at all: the server's favourites (weighted) become the seed — re-picked for every batch.
    let favoritePicks = [];
    if (!commandPrompt && !inputSong && !inputArtist && !inputGenre && !playlistLink) {
        const favorites = await loadFavorites(guild.id).catch(e => {
            logger.error(`[DJ] Could not load favourites for guild ${guild.id}: ${e.message}`);
            return [];
        });
        favoritePicks = djLibrary.pickWeighted(favorites, 3);
        if (favoritePicks.length) prompt = djLibrary.joinPrompt(basePrompt, djLibrary.favoritesSeedText(favoritePicks));
    }
    // Remembered on the session so `/music settings djpreset action:Save` can save a running session.
    const presetInputs = { prompt: commandPrompt, song: inputSong, artist: inputArtist, genre: inputGenre, playlistLink };
    const libraryMetadata = {
        presetName: preset?.name || null,
        presetInputs,
        favoritesSeed: favoritePicks.length > 0,
        basePrompt: basePrompt || null,
    };

    await interaction.deferReply();
    if (preset) markPresetUsed(preset.id);

    try {
        const player = useMainPlayer(interaction);

        // If a playlist link is provided, handle it as a playlist
        if (playlistLink) {
            const searchResult = await player.search(playlistLink, { requestedBy: member.user });
            if (!searchResult.hasTracks()) {
                return interaction.editReply({ content: "Could not find that playlist. Please check the link and try again." });
            }
            // The server's DJ blocklist applies to a DJ playlist too.
            const blocklist = await loadBlocklist(guild.id).catch(e => {
                logger.error(`[DJ] Could not load the blocklist for guild ${guild.id}: ${e.message}`);
                return [];
            });
            const blockedCount = stripBlockedFromResult(searchResult, blocklist);
            if (!searchResult.tracks.length) {
                return interaction.editReply({ content: "Every track in that playlist is on this server's AI DJ blocklist." });
            }

            // Create queue with DJ mode metadata
            const { queue } = await player.play(voiceChannel, searchResult, {
                nodeOptions: {
                    metadata: {
                        channelId: announceChannelId,
                        djMode: true,
                        inputSong: inputSong || null,
                        inputArtist: inputArtist || null,
                        inputGenre: inputGenre || null,
                        playedTracks: [],
                        djInitiatorId: member.user.id,
                        prompt: prompt || null,
                        isGenerating: false,
                        ...libraryMetadata
                    },
                    leaveOnEmpty: false,
                    leaveOnEnd: false,
                    leaveOnEmptyCooldown: 300000, // 5 minutes
                    selfDeaf: true,
                    volume
                },
                requestedBy: member.user
            });

            return interaction.editReply({
                content: `🎧 **AI DJ session started!**${preset ? ` (preset **${preset.name}**)` : ''}\n\nPlaying playlist with ${searchResult.tracks.length} tracks.`
                    + `${blockedCount ? ` Skipped ${blockedCount} on this server's DJ blocklist.` : ''}\nThe DJ will generate more recommendations when the queue runs low.`
            });
        }

        // No playlist link - generate recommendations based on prompt/song/artist/genre.
        // Create the DJ queue and join directly, then kick off generation. (This used to queue a
        // Rickroll "placeholder" that nothing removed — it actually played, and when YouTube
        // was blocked the placeholder search failed and the DJ couldn't start at all.)
        const djManager = interaction.client.djManager || global.djManager;
        if (!djManager) {
            return interaction.editReply({ content: "Failed to start AI DJ session: the DJ system isn't loaded. Please try again shortly." });
        }
        const djQueueOptions = {
            metadata: {
                channelId: announceChannelId,
                djMode: true,
                inputSong: inputSong || null,
                inputArtist: inputArtist || null,
                inputGenre: inputGenre || null,
                playedTracks: [],
                djInitiatorId: member.user.id,
                prompt: prompt || null,
                isGenerating: false,
                ...libraryMetadata
            },
            leaveOnEmpty: false,
            leaveOnEnd: false,
            leaveOnEmptyCooldown: 300000, // 5 minutes
            selfDeaf: true,
            volume
        };
        const queue = player.nodes.create(voiceChannel.guild, djQueueOptions);
        // An existing queue (voice camp etc.) ignores create() options — switch it into DJ mode.
        if (!queue.metadata?.djMode) queue.setMetadata({ ...(queue.metadata || {}), ...djQueueOptions.metadata });
        // Already a DJ session: the new request (another preset, prompt or seed) takes over from the next
        // batch on, keeping the session's play history and any batch already being generated.
        else queue.setMetadata({
            ...queue.metadata,
            ...djQueueOptions.metadata,
            playedTracks: queue.metadata.playedTracks || [],
            isGenerating: !!queue.metadata.isGenerating,
        });
        if (!queue.connection) await queue.connect(voiceChannel);
        djManager.onQueueEnd(queue).catch(e => console.error("[DJ] Initial generation failed:", e.message));

        // Build description of what DJ is based on
        let djDescription = "";
        if (commandPrompt) {
            djDescription = `Based on: "${commandPrompt}"`;
        } else if (inputSong && inputArtist) {
            djDescription = `Based on: "${inputSong}" by ${inputArtist}`;
        } else if (inputSong) {
            djDescription = `Based on: "${inputSong}"`;
        } else if (inputArtist) {
            djDescription = `Based on artists like: ${inputArtist}`;
        } else if (inputGenre) {
            djDescription = `Genre: ${inputGenre}`;
        } else if (favoritePicks.length) {
            djDescription = `Seeded by this server's favourites: ${favoritePicks.map(f => `"${f.song_title}" by ${f.artist}`).join(', ')}`;
        } else if (prompt) {
            djDescription = "Based on this server's AI DJ settings";
        } else {
            djDescription = "Playing a mix of popular tracks";
        }
        if (preset) djDescription = `Preset **${preset.name}** — ${djDescription}`;

        return interaction.editReply({
            content: `🎧 **AI DJ session started!**\n\n${djDescription}\n\nThe DJ will generate playlists and keep the music flowing. Use \`/music stop\` to end the session.`
        });

    } catch (error) {
        console.error("[DJ Command Error]", error.message, error.stack);
        return interaction.editReply({ content: `An error occurred starting the DJ session: ${error.message}` });
    }
}

/**
 * /music record — voice channel recording (handlers/music/recording.js, core/voice-recorder.js).
 */
export async function handleRecord(interaction) {
    return handleRecordCommand(interaction);
}
