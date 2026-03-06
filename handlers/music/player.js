import { EmbedBuilder } from 'discord.js';
import { checkMusicPermissions, useMainPlayer } from '../../utils/music_helpers.js';
import db from '../../utils/db.js';

// ============================================================================
// DEDUPLICATION SYSTEM
// Prevents duplicate songs from being added to the queue
// ============================================================================

const MAX_SAME_SONG_VERSIONS = 3; // Max covers/versions of same song by different artists

/**
 * Normalize a string for comparison (lowercase, remove special chars, trim)
 */
function normalizeString(str) {
    if (!str) return '';
    return str
        .toLowerCase()
        .replace(/\(.*?\)/g, '')      // Remove parenthetical content (feat., remix, etc.)
        .replace(/\[.*?\]/g, '')      // Remove bracketed content
        .replace(/ft\.?|feat\.?/gi, '') // Remove featuring indicators
        .replace(/[^\w\s]/g, '')      // Remove special characters
        .replace(/\s+/g, ' ')         // Normalize whitespace
        .trim();
}

/**
 * Extract the core song identifier (normalized title)
 */
function getSongKey(title) {
    return normalizeString(title);
}

/**
 * Extract the artist key (normalized artist name)
 */
function getArtistKey(author) {
    return normalizeString(author);
}

/**
 * Check if two tracks are duplicates
 * @returns {string|null} - Reason for duplicate, or null if not a duplicate
 */
function isDuplicate(newTrack, existingTrack) {
    // Check URL match (exact duplicate)
    if (newTrack.url && existingTrack.url) {
        // Normalize URLs by removing tracking params
        const normalizeUrl = (url) => {
            try {
                const u = new URL(url);
                u.searchParams.delete('si');
                u.searchParams.delete('list');
                u.searchParams.delete('index');
                return u.toString();
            } catch {
                return url;
            }
        };
        if (normalizeUrl(newTrack.url) === normalizeUrl(existingTrack.url)) {
            return 'same_url';
        }
    }

    // Check artist + title match
    const newTitle = getSongKey(newTrack.title);
    const existingTitle = getSongKey(existingTrack.title);
    const newArtist = getArtistKey(newTrack.author);
    const existingArtist = getArtistKey(existingTrack.author);

    if (newTitle && existingTitle && newTitle === existingTitle) {
        if (newArtist && existingArtist && newArtist === existingArtist) {
            return 'same_artist_and_title';
        }
    }

    return null;
}

/**
 * Filter out duplicate tracks from incoming tracks
 * @param {Track[]} incomingTracks - Tracks to be added
 * @param {Track[]} queuedTracks - Currently queued tracks (including current track)
 * @returns {{ accepted: Track[], rejected: { track: Track, reason: string }[] }}
 */
function filterDuplicates(incomingTracks, queuedTracks) {
    const accepted = [];
    const rejected = [];

    // Build a map of song titles to count versions (for the "max 3 covers" rule)
    // Include both queued tracks and tracks we're about to accept
    const songVersionCounts = new Map(); // songKey -> Set of artistKeys

    // Count existing versions in queue
    for (const track of queuedTracks) {
        const songKey = getSongKey(track.title);
        const artistKey = getArtistKey(track.author);
        if (songKey) {
            if (!songVersionCounts.has(songKey)) {
                songVersionCounts.set(songKey, new Set());
            }
            if (artistKey) {
                songVersionCounts.get(songKey).add(artistKey);
            }
        }
    }

    for (const newTrack of incomingTracks) {
        let isDupe = false;
        let dupeReason = null;

        // Check against all queued tracks for exact duplicates
        for (const existingTrack of queuedTracks) {
            const reason = isDuplicate(newTrack, existingTrack);
            if (reason) {
                isDupe = true;
                dupeReason = reason;
                break;
            }
        }

        // Also check against tracks we've already accepted in this batch
        if (!isDupe) {
            for (const acceptedTrack of accepted) {
                const reason = isDuplicate(newTrack, acceptedTrack);
                if (reason) {
                    isDupe = true;
                    dupeReason = reason;
                    break;
                }
            }
        }

        // Check the "max 3 versions" rule
        if (!isDupe) {
            const songKey = getSongKey(newTrack.title);
            const artistKey = getArtistKey(newTrack.author);

            if (songKey && songVersionCounts.has(songKey)) {
                const existingArtists = songVersionCounts.get(songKey);
                // If this artist already has this song queued, it's a duplicate
                if (artistKey && existingArtists.has(artistKey)) {
                    isDupe = true;
                    dupeReason = 'same_artist_and_title';
                }
                // If we already have 3+ versions by different artists, reject
                else if (existingArtists.size >= MAX_SAME_SONG_VERSIONS && !existingArtists.has(artistKey)) {
                    isDupe = true;
                    dupeReason = 'too_many_versions';
                }
            }
        }

        if (isDupe) {
            rejected.push({ track: newTrack, reason: dupeReason });
        } else {
            accepted.push(newTrack);
            // Update the version count for accepted tracks
            const songKey = getSongKey(newTrack.title);
            const artistKey = getArtistKey(newTrack.author);
            if (songKey) {
                if (!songVersionCounts.has(songKey)) {
                    songVersionCounts.set(songKey, new Set());
                }
                if (artistKey) {
                    songVersionCounts.get(songKey).add(artistKey);
                }
            }
        }
    }

    return { accepted, rejected };
}

/**
 * Get all tracks currently in queue (including the playing track)
 */
function getQueuedTracks(queue) {
    const tracks = [];

    // Add currently playing track
    if (queue?.currentTrack) {
        tracks.push(queue.currentTrack);
    }

    // Add all queued tracks
    if (queue?.tracks?.data) {
        tracks.push(...queue.tracks.data);
    } else if (queue?.tracks) {
        // Handle if tracks is iterable
        for (const track of queue.tracks) {
            tracks.push(track);
        }
    }

    return tracks;
}

// ============================================================================
// SOURCE DETECTION
// ============================================================================

/**
 * Detect the source platform from a URL or query
 * @param {string} query - The user's input
 * @returns {{ platform: string, type: string, displayName: string }}
 */
function detectQuerySource(query) {
    // Spotify patterns
    const spotifyMatch = query.match(/spotify\.com\/(track|playlist|album|artist)\/([a-zA-Z0-9]+)/);
    if (spotifyMatch) {
        const typeNames = { track: 'track', playlist: 'playlist', album: 'album', artist: 'artist' };
        return { platform: 'spotify', type: spotifyMatch[1], displayName: `Spotify ${typeNames[spotifyMatch[1]]}` };
    }

    // YouTube patterns
    if (query.includes('youtube.com') || query.includes('youtu.be')) {
        if (query.includes('/playlist') || query.match(/[?&]list=PL/)) {
            return { platform: 'youtube', type: 'playlist', displayName: 'YouTube playlist' };
        }
        if (query.match(/[?&]list=RD/)) {
            return { platform: 'youtube', type: 'mix', displayName: 'YouTube Mix' };
        }
        if (query.includes('/shorts/')) {
            return { platform: 'youtube', type: 'short', displayName: 'YouTube Short' };
        }
        return { platform: 'youtube', type: 'video', displayName: 'YouTube' };
    }

    // SoundCloud patterns
    if (query.includes('soundcloud.com')) {
        if (query.includes('/sets/')) {
            return { platform: 'soundcloud', type: 'playlist', displayName: 'SoundCloud playlist' };
        }
        return { platform: 'soundcloud', type: 'track', displayName: 'SoundCloud' };
    }

    // Not a URL - it's a search query
    return { platform: 'search', type: 'query', displayName: 'search' };
}

/**
 * Handles playing a song or playlist
 */
export async function handlePlay(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    if (!interaction.member.voice.channel) {
        return interaction.reply({ content: "You must be in a voice channel to play music!", ephemeral: true });
    }

    await interaction.deferReply();
    const player = useMainPlayer(interaction);
    const query = interaction.options.getString("query");

    // Detect source for better feedback
    const source = detectQuerySource(query);

    // YouTube Mix/Radio URLs are personalized - inform user we'll play the single video
    const isMixUrl = source.type === 'mix';

    try {
        const searchResult = await player.search(query, { requestedBy: interaction.user });
        if (!searchResult.hasTracks()) {
            if (source.platform === 'spotify') {
                return interaction.editReply({
                    content: `Could not fetch the ${source.displayName}. Make sure the link is public and try again.`
                });
            }
            return interaction.editReply({ content: `No results found for: ${query}` });
        }

        // Filter out YouTube Shorts (they don't play properly)
        let validTracks = searchResult.tracks.filter(t => !t.url?.includes('youtube.com/shorts'));

        if (validTracks.length === 0) {
            if (searchResult.playlist) {
                return interaction.editReply({ content: `All tracks in the playlist were YouTube Shorts, which are not supported.` });
            } else {
                return interaction.editReply({ content: `The requested track is a YouTube Short, which is not supported.` });
            }
        }

        // ====================================================================
        // DEDUPLICATION: Filter out tracks already in queue
        // ====================================================================
        const existingQueue = interaction.client.player.nodes.get(interaction.guildId);
        const queuedTracks = getQueuedTracks(existingQueue);

        const { accepted: uniqueTracks, rejected: duplicates } = filterDuplicates(validTracks, queuedTracks);

        // If all tracks were duplicates, inform the user
        if (uniqueTracks.length === 0) {
            const isPlaylist = searchResult.playlist || validTracks.length > 1;
            if (isPlaylist) {
                return interaction.editReply({
                    content: `All ${validTracks.length} tracks from this playlist are already in the queue or are duplicates.`
                });
            } else {
                const track = validTracks[0];
                return interaction.editReply({
                    content: `**${track.title}** by ${track.author || 'Unknown'} is already in the queue.`
                });
            }
        }

        // Update the search result's tracks with only unique ones
        // We need to modify the searchResult to only contain unique tracks
        searchResult.tracks.length = 0;
        searchResult.tracks.push(...uniqueTracks);

        // If it's a playlist, update the playlist's track list too
        if (searchResult.playlist) {
            searchResult.playlist.tracks.length = 0;
            searchResult.playlist.tracks.push(...uniqueTracks);
        }

        const { track } = await player.play(interaction.member.voice.channel, searchResult, {
            nodeOptions: {
                metadata: {
                    channelId: interaction.channel.id,
                    djMode: false,
                    voiceChannelId: interaction.member.voice.channel.id,
                    playedTracks: [],
                    source: source
                },
                selfDeaf: true,
                volume: 80,
                leaveOnEmpty: true,
                leaveOnEmptyCooldown: 300000,
                leaveOnEnd: true,
                leaveOnEndCooldown: 300000,
            }
        });

        // Build informative response message with duplicate info
        let replyMessage;
        const skippedCount = duplicates.length;
        const skippedInfo = skippedCount > 0 ? `\n*(Skipped ${skippedCount} duplicate${skippedCount > 1 ? 's' : ''})*` : '';

        if (track.playlist || uniqueTracks.length > 1) {
            const trackCount = uniqueTracks.length;
            const playlistTitle = track.playlist?.title || 'playlist';
            if (isMixUrl) {
                replyMessage = `Added **${trackCount}** tracks from YouTube Mix **${playlistTitle}** to the queue.${skippedInfo}`;
            } else if (source.platform === 'spotify') {
                replyMessage = `Added **${trackCount}** tracks from Spotify ${source.type} **${playlistTitle}** to the queue.${skippedInfo}`;
            } else if (source.platform === 'youtube') {
                replyMessage = `Added **${trackCount}** tracks from YouTube playlist **${playlistTitle}** to the queue.${skippedInfo}`;
            } else if (source.platform === 'soundcloud') {
                replyMessage = `Added **${trackCount}** tracks from SoundCloud set **${playlistTitle}** to the queue.${skippedInfo}`;
            } else {
                replyMessage = `Added **${trackCount}** tracks from **${playlistTitle}** to the queue.${skippedInfo}`;
            }
        } else {
            // Single track
            const sourceInfo = source.platform !== 'search' ? ` (from ${source.displayName})` : '';
            replyMessage = `Added **${track.title}** by ${track.author || 'Unknown'}${sourceInfo} to the queue.`;
            if (isMixUrl) {
                replyMessage += `\n*(Could not load full YouTube Mix — playing the single video instead. Mix playlists are personalized and may require authentication.)*`;
            }
        }

        return interaction.editReply({ content: replyMessage });
    } catch (e) {
        if (e.message.includes("No results found")) {
            return interaction.editReply({ content: `No results found for: ${query}` });
        }
        console.error("[Play Command Error]", e.message);
        return interaction.editReply({ content: `An error occurred: ${e.message}` });
    }
}

/**
 * Handles pausing the music
 */
export async function handlePause(interaction) {
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
        await interaction.reply({ content: "Paused the music." });
    } catch (e) {
        await interaction.reply({ content: `Error: ${e.message}` });
    }
}

/**
 * Handles resuming the music
 */
export async function handleResume(interaction) {
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
        await interaction.reply({ content: "Resumed the music." });
    } catch (e) {
        await interaction.reply({ content: `Error: ${e.message}` });
    }
}

/**
 * Handles skipping the current song
 */
export async function handleSkip(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
        return interaction.reply({ content: "There is nothing playing to skip!", ephemeral: true });
    }

    const skippedTrack = queue.currentTrack;
    const isLastTrack = queue.tracks.size === 0;

    await interaction.deferReply();

    // Always skip immediately — don't let DJ banter block the skip
    const success = queue.node.skip();
    if (!success) {
        return interaction.editReply({ content: "Something went wrong while skipping." });
    }

    // If DJ mode, fire off banter generation in background (non-blocking)
    if (queue.metadata?.djMode && interaction.client.djManager) {
        if (isLastTrack) {
            setTimeout(() => {
                interaction.client.djManager.onQueueEnd(queue)
                    .catch(err => console.error('[DJ] onQueueEnd error:', err.message));
            }, 500);
        }
        return interaction.editReply({ content: "Skipped! DJ banter incoming..." });
    }

    return interaction.editReply({ content: "Skipped! Now playing the next song." });
}

/**
 * Handles stopping the music and clearing the queue
 */
export async function handleStop(interaction) {
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
        await interaction.reply({ content: "Music stopped and queue cleared." });
    } catch (e) {
        await interaction.reply({ content: `Error: ${e.message}` });
    }
}

/**
 * Handles displaying information about the currently playing song
 */
export async function handleNowPlaying(interaction) {
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

    let requesterTag = 'Unknown User';
    if (track.requestedBy && track.requestedBy.id !== interaction.client.user.id) {
        requesterTag = track.requestedBy.tag;
    } else if (queue.metadata?.djMode && queue.metadata?.djInitiatorId) {
        try {
            const djUser = await interaction.client.users.fetch(queue.metadata.djInitiatorId);
            requesterTag = djUser.tag;
        } catch (error) {
            // Ignore if user fetch fails
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
}

// Export deduplication helpers for use by music panel modal handler
export { filterDuplicates, getQueuedTracks };
