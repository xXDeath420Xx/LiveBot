import { EmbedBuilder } from 'discord.js';
import { QueueRepeatMode } from 'discord-player';
import { checkMusicPermissions, useMainPlayer, getLeaveOptions } from '../../utils/music_helpers.js';
import { voiceToolHolding } from '../../core/music-leave-policy.js';
import db from '../../utils/db.js';
import {
  getSessionForUser, acquire, release, streamTrack, uriFromUrl, isOwnerUser, isLinked,
} from '../../core/spotify-connect-manager.js';
import logger from '../../utils/logger.js';
import { notePlayback } from '../../core/music-play-log.js';
import { searchSpotifyTrack } from '../../core/spotify-resolver.js';
import { takeExtractionFailure } from '../../core/ytdlp-extractor.js';

/**
 * discord-player onBeforeCreateStream hook: for a Spotify TRACK, play it through
 * go-librespot (real Spotify audio) instead of bridging to YouTube. Returns a stream
 * to use it, or null to fall through to the normal YouTube/SoundCloud extraction —
 * so non-Spotify tracks, and Spotify tracks when every account is busy, still play.
 */
/**
 * The audio path must NEVER block on Spotify.
 *
 * getSessionForUser() can spawn a per-user go-librespot process, and its readiness loop is
 * `24 × (sleep 500ms + isAlive())` where isAlive has its own 10s timeout — up to ~4 MINUTES of
 * blocking. Because discord-player awaits this hook before it can build a stream, a slow or dead
 * go-librespot meant the track sat queued, the bot sat in the voice channel, and NOTHING ever
 * played, with no error emitted anywhere. Since a plain `/music play` search is rewritten to a
 * Spotify track upstream, that stalled every search.
 *
 * So: race the whole hook. If Spotify cannot hand us a stream promptly, return null and let
 * discord-player bridge to YouTube/SoundCloud exactly as it does for non-Spotify tracks.
 */
// Must comfortably exceed streamTrack's own stream-start check (5s) so that check can finish and
// fall back on its own; this is the outer backstop for the paths it cannot cover (above all
// spawnUserSession, whose readiness loop can block for minutes for a non-owner user).
const SPOTIFY_HOOK_TIMEOUT_MS = Number(process.env.SPOTIFY_HOOK_TIMEOUT_MS) || 15000;

async function spotifyConnectStream(track, _queryType, queue) {
  let timer;
  try {
    return await Promise.race([
      spotifyConnectStreamInner(track, _queryType, queue),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          logger.warn(`[SpotifyConnect] no stream from go-librespot within ${SPOTIFY_HOOK_TIMEOUT_MS}ms for `
            + `"${track.title}" — bridging to YouTube/SoundCloud instead`);
          resolve(null);
        }, SPOTIFY_HOOK_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// One "Spotify is busy" notice per guild per 30 min — the hook runs for EVERY track, and a
// notice per song would bury the channel.
const BUSY_NOTICE_COOLDOWN_MS = 30 * 60 * 1000;
const lastBusyNotice = new Map(); // guildId -> timestamp

async function noticeSpotifyBusy(queue, userId) {
  const now = Date.now();
  if (now - (lastBusyNotice.get(queue.guild.id) || 0) < BUSY_NOTICE_COOLDOWN_MS) return;
  lastBusyNotice.set(queue.guild.id, now);
  try {
    const ch = queue.guild.channels.cache.get(queue.metadata?.channelId);
    if (!ch?.isTextBased?.()) return;
    const ownAccount = userId && await isLinked(userId);
    const content = ownAccount
      ? `🎧 Your linked Spotify account is streaming in another server right now, so this is playing from **YouTube** instead. Stop it there (\`/spotify stop\` or \`/music stop\`) to get Spotify audio here.`
      : `🎧 The shared Spotify account is in use in another server, so songs here are playing from **YouTube** for now.\n`
        + `**Want real Spotify audio?** Link your own Premium account — it only takes a minute:\n`
        + `1️⃣ Run \`/spotify link\` and open the link it gives you\n`
        + `2️⃣ Click **Agree** — your browser lands on a \`127.0.0.1\` page that won't load (that's expected)\n`
        + `3️⃣ Copy that page's full address and run \`/spotify finish\` with it\n`
        + `After that, songs **you** queue play through your own account. \`/spotify unlink\` removes it anytime.`;
    await ch.send({ content, allowedMentions: { parse: [] } });
  } catch (e) {
    logger.debug(`[SpotifyConnect] busy notice failed in ${queue.guild.id}: ${e.message}`);
  }
}

async function spotifyConnectStreamInner(track, _queryType, queue) {
  try {
    const uri = track.metadata?.spotifyUri || uriFromUrl(track.url);
    if (!uri || !uri.startsWith('spotify:track:')) return null; // only single tracks
    const session = await getSessionForUser(track.requestedBy?.id);
    if (!session) return null;
    const owner = isOwnerUser(track.requestedBy?.id);
    // owner preempts a non-owner on the shared account; non-owner yields → YouTube fallback
    const stopHolder = async () => {
      try {
        const ch = queue.metadata?.channelId && await queue.guild.client.channels.fetch(queue.metadata.channelId).catch(() => null);
        ch?.send?.('⏸️ The owner started Spotify on the shared account — **`/spotify link`** your own to keep playing here.').catch(() => {});
      } catch {}
      try { queue.delete(); } catch {}
    };
    if (!acquire(session, queue.guild.id, { owner, stopHolder })) {
      logger.info(`[SpotifyConnect] account busy in guild ${session.busyGuildId} — "${track.title}" bridges to YouTube in ${queue.guild.id}`);
      noticeSpotifyBusy(queue, track.requestedBy?.id).catch(() => {});
      return null;
    }
    logger.info(`[SpotifyConnect] /music routing "${track.title}" through go-librespot (${uri})${owner ? ' [owner]' : ''}`);
    const stream = await streamTrack(session, uri);
    if (!stream) {
      // go-librespot accepted the request but never produced audio. Hand the session back, then
      // return null so discord-player bridges this track to YouTube/SoundCloud — otherwise the
      // queue would sit on a silent stream forever.
      try { release(session, queue.guild.id); } catch { /* best effort */ }
      logger.warn(`[SpotifyConnect] falling back to the YouTube/SoundCloud bridge for "${track.title}"`);
      return null;
    }
    notePlayback(track, { path: 'spotify', account: session.id === 'owner' ? 'shared' : 'linked' }); // play log
    return stream;
  } catch (e) {
    logger.error(`[SpotifyConnect] onBeforeCreateStream failed: ${e.message}`);
    return null; // fall back to YouTube bridge
  }
}

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
            return { platform: 'youtube', type: 'video', displayName: 'YouTube' };
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
    let query = interaction.options.getString("query");

    // Convert YouTube Shorts URLs to regular watch URLs
    const shortsMatch = query.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/);
    if (shortsMatch) {
        query = `https://www.youtube.com/watch?v=${shortsMatch[1]}`;
    }

    // Strip tracking params
    if (query.includes('youtube.com') || query.includes('youtu.be')) {
        try {
            const url = new URL(query);
            url.searchParams.delete('si');
            query = url.toString();
        } catch {}
    }

    // Detect source for better feedback
    let source = detectQuerySource(query);

    // Spotify is the default source for a free-text search. Resolving the query to a real
    // Spotify track up front means `onBeforeCreateStream` can stream it through go-librespot
    // (actual Spotify audio). When no linked account is free, discord-player bridges the track
    // out to yt-dlp, and then to SoundCloud — so this only ever adds a source, never removes one.
    // An explicit URL is always honoured as typed.
    if (source.platform === 'search') {
        const hit = await searchSpotifyTrack(query);
        if (hit?.url) {
            logger.info(`[Music] search "${query}" resolved to Spotify: ${hit.artist} - ${hit.title}`);
            query = hit.url;
            source = detectQuerySource(query);
        }
    }

    // YouTube Mix/Radio URLs are personalized - inform user we'll play the single video
    const isMixUrl = source.type === 'mix';

    try {
        const searchResult = await player.search(query, { requestedBy: interaction.user });

        // Spotify: resolve via OUR Spotify Web API so the FULL list comes back complete
        // and explicit-aware. The bundled SpotifyExtractor caps playlists at 100, strips
        // the `explicit` flag (→ radio edits), and can return nothing if its token flow
        // hiccups. So:
        //   • if it returned tracks → enrich (recover 101..N, tag explicit) in place;
        //   • if it returned NOTHING → build the whole list directly from our API.
        // Audio is then bridged (YouTube → SoundCloud fallback), independent of Spotify.
        if (source.platform === 'spotify') {
            try {
                const { enrichSpotifySearchResult, buildSpotifyEntity } = await import('../../core/spotify-resolver.js');
                if (searchResult.hasTracks()) {
                    const r = await enrichSpotifySearchResult(player, searchResult, query, interaction.user);
                    if (r.ok) console.log(`[Spotify] full list: ${r.total} tracks (+${r.added} recovered, ${r.explicit} explicit)`);
                } else {
                    const built = await buildSpotifyEntity(player, query, interaction.user);
                    if (built) {
                        searchResult.setTracks(built.tracks);
                        if (built.playlist) searchResult.setPlaylist(built.playlist);
                        console.log(`[Spotify] built ${built.tracks.length} tracks directly from Spotify API (extractor returned none)`);
                    }
                }
            } catch (e) {
                console.warn(`[Spotify] resolve failed, falling back to extractor result: ${e.message}`);
            }
        }

        if (!searchResult.hasTracks()) {
            if (source.platform === 'spotify') {
                return interaction.editReply({
                    content: `Could not fetch the ${source.displayName}. Make sure the link is public and that the Spotify API keys are valid, then try again.`
                });
            }
            // An empty result is not the same thing as "nothing matched". A YouTube block, an expired
            // cookie jar and a genuinely empty search all reach here identically, and reporting all
            // three as "no results" hides the real cause — so say it when the extractor knows it.
            const why = takeExtractionFailure(query);
            if (why) {
                return interaction.editReply({ content: `Couldn't play that — ${why}` });
            }
            return interaction.editReply({ content: `No results found for: ${query}` });
        }

        // Convert YouTube Shorts URLs to regular watch URLs
        let validTracks = searchResult.tracks.map(t => {
            if (t.url?.includes('youtube.com/shorts/')) {
                const match = t.url.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/);
                if (match) t.url = `https://www.youtube.com/watch?v=${match[1]}`;
            }
            return t;
        });
        // player.play() only queues tracks[0] of a non-playlist result. Trim to match, so the
        // reply doesn't claim N tracks and dedup can't silently swap in search result #2.
        if (!searchResult.playlist) validTracks = validTracks.slice(0, 1);

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

        // nodes.create() returns an EXISTING queue (voice camp, voice tools) as-is and ignores
        // the nodeOptions below — so the Spotify hook and the reply channel never applied.
        if (existingQueue) {
            existingQueue.onBeforeCreateStream = spotifyConnectStream;
            existingQueue.setMetadata({
                ...(existingQueue.metadata || {}),
                channelId: interaction.channel.id,
                voiceChannelId: interaction.member.voice.channel.id,
                playedTracks: existingQueue.metadata?.playedTracks || [],
                source
            });
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
                // Spotify tracks play through go-librespot (real Spotify audio); the hook
                // returns null for everything else → normal YouTube/SoundCloud bridge.
                onBeforeCreateStream: spotifyConnectStream,
                ...(await getLeaveOptions(interaction.guildId)),
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
            // SoundCloud only serves some tracks with DRM or as a 30-second preview; those play from YouTube (H-666).
            if (track.raw?.scBridge) {
                replyMessage += `\n*SoundCloud only offers ${track.raw.scBridge === 'drm' ? 'a DRM-protected version' : 'a 30-second preview'} of this track, so the same song plays from YouTube.*`;
            }
            if (isMixUrl) {
                replyMessage += `\n*(Could not load full YouTube Mix — playing the single video instead. Mix playlists are personalized and may require authentication.)*`;
            }
        }

        return interaction.editReply({ content: replyMessage });
    } catch (e) {
        if (e.message.includes("No results found")) {
            const why = takeExtractionFailure(query);
            return interaction.editReply({
                content: why ? `Couldn't play that — ${why}` : `No results found for: ${query}`,
            });
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
    if (queue.metadata?.djMode && (interaction.client.djManager || global.djManager)) {
        if (isLastTrack) {
            setTimeout(() => {
                (interaction.client.djManager || global.djManager).onQueueEnd(queue)
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

    // Any queue counts, playing or not: after a queue ends the bot may still be connected, and /music stop
    // is how people get it out of the channel.
    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue) {
        return interaction.reply({ content: "Nothing is playing and I'm not in a voice channel.", ephemeral: true });
    }

    try {
        const tool = await voiceToolHolding(interaction.guildId);
        if (tool) {
            // A transcription, the chat reader or a recording still needs the connection: end the music
            // only. No DJ refill, no repeat/autoplay restarting it — node.stop() clears tracks and history.
            if (queue.metadata?.djMode) queue.setMetadata({ ...queue.metadata, djMode: false, favoritesSeed: false });
            queue.setRepeatMode(QueueRepeatMode.OFF);
            queue.node.stop();
            return interaction.reply({ content: `Music stopped and the queue cleared. I'm staying in the voice channel because ${describeVoiceTool(tool)}.` });
        }
        queue.delete();
        return interaction.reply({ content: "Stopped and left the voice channel." });
    } catch (e) {
        logger.error(`[Music] /music stop failed in guild ${interaction.guildId}: ${e.message}`);
        return interaction.reply({ content: `Error: ${e.message}` });
    }
}

/** music-leave-policy's reason ("held by recording", "transcription running", …) as a sentence. */
function describeVoiceTool(reason) {
    const text = String(reason || '');
    if (text.startsWith('held by ')) {
        const keys = text.slice(8).split(', ');
        if (keys.includes('recording')) return 'a voice recording is in progress (`/music record action:Stop` ends it)';
        return `it is still in use (${keys.join(', ')})`;
    }
    if (text === 'transcription running') return 'live transcription is running in this server';
    if (text === 'chat reader active') return 'the chat reader is active';
    return `it is still in use (${text})`;
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
export { filterDuplicates, getQueuedTracks, spotifyConnectStream };
