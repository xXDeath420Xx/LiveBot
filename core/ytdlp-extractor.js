import { BaseExtractor, Track, Playlist } from 'discord-player';
import { existsSync, copyFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';
import ytdlpPool from '../utils/processPool.js';
import { notifyCookieRotation } from '../utils/cookie-health-monitor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COOKIES_PATH = join(__dirname, '..', 'cookies.txt');

// yt-dlp REWRITES the file passed to `--cookies` after every request. When YouTube
// serves a "confirm you're not a bot" challenge, its response strips the auth cookies,
// and yt-dlp persists that logged-out jar back over the file — permanently gutting it.
// So we NEVER hand the master cookies.txt to yt-dlp. Each run gets a throwaway copy;
// yt-dlp mangles the copy, the master stays pristine. Returns ['--cookies', tmpPath]
// or [] when no cookie jar exists. The temp dir self-deletes after 2 min (well past
// the 30s yt-dlp timeout); the timer is unref'd so it never holds the process open.
function cookieArgs() {
    if (!existsSync(COOKIES_PATH)) return [];
    try {
        const dir = mkdtempSync(join(tmpdir(), 'cfx-ck-'));
        const copy = join(dir, 'cookies.txt');
        copyFileSync(COOKIES_PATH, copy);
        setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} }, 120000).unref();
        return ['--cookies', copy];
    } catch (e) {
        logger.warn(`[YtDlp] cookie copy failed (${e.message}); skipping cookies this run to protect the master jar`);
        return [];
    }
}

function looksLikeCookieRotation(stderr) {
    if (!stderr) return false;
    return stderr.includes('cookies are no longer valid')
        || stderr.includes("confirm you're not a bot")
        || stderr.includes("confirm you’re not a bot")
        || stderr.includes('Sign in to confirm');
}

/**
 * Universal extractor using yt-dlp for ALL sources
 * Supports YouTube, SoundCloud, Spotify, and 1000+ other sites
 * Supports playlists from YouTube and Spotify
 */
class YtDlpExtractor extends BaseExtractor {
    static identifier = 'com.certifried.ytdlp-universal';

    async validate(query, type) {
        if (typeof query !== 'string' || query.length === 0) {
            return false;
        }

        // yt-dlp cannot extract Spotify (DRM-protected). SpotifyExtractor owns
        // Spotify metadata; we provide the audio via bridge() at stream time.
        if (query.includes('spotify.com/')) {
            return false;
        }

        logger.info(`[YtDlp] validate() accepting query: ${query.substring(0, 50)}..., type: ${type}`);
        return true;
    }

    /**
     * Detect the source platform from a URL or query
     * @returns {{ platform: string, type: string, id: string|null }}
     */
    detectQuerySource(query) {
        // Spotify patterns
        const spotifyMatch = query.match(/spotify\.com\/(track|playlist|album|artist)\/([a-zA-Z0-9]+)/);
        if (spotifyMatch) {
            return { platform: 'spotify', type: spotifyMatch[1], id: spotifyMatch[2] };
        }

        // YouTube patterns
        if (query.includes('youtube.com') || query.includes('youtu.be')) {
            if (query.includes('/playlist') || query.match(/[?&]list=PL/)) {
                return { platform: 'youtube', type: 'playlist', id: null };
            }
            if (query.match(/[?&]list=RD/)) {
                return { platform: 'youtube', type: 'mix', id: null };
            }
            if (query.includes('/shorts/')) {
                return { platform: 'youtube', type: 'short', id: null };
            }
            return { platform: 'youtube', type: 'video', id: null };
        }

        // SoundCloud patterns
        if (query.includes('soundcloud.com')) {
            if (query.includes('/sets/')) {
                return { platform: 'soundcloud', type: 'playlist', id: null };
            }
            return { platform: 'soundcloud', type: 'track', id: null };
        }

        // Not a URL - it's a search query
        return { platform: 'search', type: 'query', id: null };
    }

    isPlaylistUrl(query) {
        const source = this.detectQuerySource(query);
        // Playlists, albums, and mixes are multi-track
        return ['playlist', 'album', 'artist', 'mix'].includes(source.type);
    }

    isYouTubeMixPlaylist(query) {
        // YouTube Mix/Radio playlists have list IDs starting with RD
        const match = query.match(/[?&]list=(RD[A-Za-z0-9_-]+)/);
        return match !== null;
    }

    sanitizeUrl(url) {
        // Remove tracking parameters that can cause issues
        try {
            const urlObj = new URL(url);
            urlObj.searchParams.delete('si'); // YouTube tracking
            urlObj.searchParams.delete('playnext');
            urlObj.searchParams.delete('start_radio');
            return urlObj.toString();
        } catch {
            return url;
        }
    }

    async handle(query, context) {
        logger.info(`[YtDlp] handle() called with query: ${query}`);

        // Detect source and type from the query
        const source = this.detectQuerySource(query);
        logger.info(`[YtDlp] Detected source: ${source.platform}, type: ${source.type}${source.id ? `, id: ${source.id}` : ''}`);

        const isPlaylist = this.isPlaylistUrl(query);
        const isMixPlaylist = this.isYouTubeMixPlaylist(query);

        // Handle YouTube Shorts early - they don't play properly
        if (source.type === 'short') {
            logger.warn(`[YtDlp] YouTube Short detected - not supported`);
            return this.createResponse();
        }

        // Sanitize URL to remove problematic parameters
        const sanitizedQuery = this.sanitizeUrl(query);
        if (sanitizedQuery !== query) {
            logger.info(`[YtDlp] Sanitized URL: ${sanitizedQuery}`);
        }

        const isUrl = sanitizedQuery.match(/^https?:\/\//);

        // Handle YouTube Mix/Radio playlists - try as playlist first, fall back to single video
        if (isMixPlaylist) {
            logger.info(`[YtDlp] YouTube Mix/Radio playlist detected, attempting playlist extraction`);
            const mixResult = await this.searchWithSource(sanitizedQuery, context, sanitizedQuery, true);
            if (mixResult?.tracks?.length > 1) {
                logger.info(`[YtDlp] Mix playlist extracted successfully: ${mixResult.tracks.length} tracks`);
                return mixResult;
            }
            // Fallback: extract just the single video by stripping the list param
            logger.info(`[YtDlp] Mix playlist extraction returned ${mixResult?.tracks?.length || 0} tracks, falling back to single video`);
            try {
                const fallbackUrl = new URL(sanitizedQuery);
                fallbackUrl.searchParams.delete('list');
                fallbackUrl.searchParams.delete('index');
                const fallbackResult = await this.searchWithSource(fallbackUrl.toString(), context, fallbackUrl.toString(), false);
                if (fallbackResult?.tracks?.length > 0) {
                    logger.info(`[YtDlp] Fallback single video extracted: ${fallbackResult.tracks[0].title}`);
                    return fallbackResult;
                }
            } catch (fallbackErr) {
                logger.error(`[YtDlp] Mix fallback failed: ${fallbackErr.message}`);
            }
            return mixResult || this.createResponse();
        }

        // Spotify URLs never reach here — validate() rejects them so SpotifyExtractor
        // can fetch metadata via the Spotify Web API. We bridge audio in bridge().

        if (source.platform === 'soundcloud') {
            logger.info(`[YtDlp] Processing SoundCloud ${source.type}: ${sanitizedQuery}`);
            const result = await this.searchWithSource(sanitizedQuery, context, sanitizedQuery, isPlaylist);
            if (result?.tracks?.length > 0) {
                logger.info(`[YtDlp] SoundCloud ${source.type}: found ${result.tracks.length} track(s)`);
                return result;
            }
        }

        // YouTube URLs or search queries
        if (isUrl) {
            logger.info(`[YtDlp] Processing URL directly: ${sanitizedQuery}`);
            const result = await this.searchWithSource(sanitizedQuery, context, sanitizedQuery, isPlaylist);
            logger.info(`[YtDlp] URL result: tracks=${result?.tracks?.length || 0}, playlist=${!!result?.playlist}`);
            return result;
        }

        // Search query - try YouTube first, retry once on bot detection, then SoundCloud fallback
        logger.info(`[YtDlp] Search query: trying YouTube first`);
        let result = await this.searchWithSource(sanitizedQuery, context, `ytsearch:${sanitizedQuery}`, false);
        logger.info(`[YtDlp] YouTube search result: tracks=${result?.tracks?.length || 0}`);

        // Retry once after delay if YouTube returned nothing (often bot detection)
        if ((!result?.tracks || result.tracks.length === 0)) {
            logger.warn(`[YtDlp] YouTube search returned 0 tracks, retrying in 3s...`);
            await new Promise(r => setTimeout(r, 3000));
            result = await this.searchWithSource(sanitizedQuery, context, `ytsearch:${sanitizedQuery}`, false);
            logger.info(`[YtDlp] YouTube search retry result: tracks=${result?.tracks?.length || 0}`);
        }

        // If YouTube still failed, try SoundCloud
        if (!result?.tracks || result.tracks.length === 0) {
            logger.info(`[YtDlp] YouTube search failed, trying SoundCloud fallback`);
            result = await this.searchWithSource(sanitizedQuery, context, `scsearch:${sanitizedQuery}`, false);
            logger.info(`[YtDlp] SoundCloud search result: tracks=${result?.tracks?.length || 0}`);
        }

        return result;
    }

    async searchWithSource(originalQuery, context, searchQuery, isPlaylist) {
        // Build yt-dlp arguments. Routed through ytdlpPool so metadata extraction uses
        // the SAME venv yt-dlp as streaming — the one that loads the bgutil PO-token
        // plugin. Spawning /home/death/.local/bin/yt-dlp directly (as this used to)
        // meant every search hit YouTube with NO PO token, which is the first and most
        // bot-detection-prone request of every play.
        const args = [
            '--dump-json',
            '--ignore-errors',
            '--no-check-formats',
            '--extractor-args', 'youtube:player_client=default'
        ];

        args.push(...cookieArgs());

        if (!isPlaylist) {
            args.push('--no-playlist');
        } else {
            args.push('--flat-playlist');
        }

        args.push(searchQuery);

        let result;
        try {
            // Playlists can take a while to enumerate; give metadata more headroom.
            result = await ytdlpPool.execute(args, { timeout: isPlaylist ? 60000 : 35000 });
        } catch (err) {
            logger.error(`[YtDlp] searchWithSource pool error: ${err.message}`);
            return this.createResponse();
        }

        const jsonData = result.stdout || '';
        const errorOutput = result.stderr || '';

        if (looksLikeCookieRotation(errorOutput)) {
            notifyCookieRotation({ source: 'searchWithSource', query: searchQuery }).catch(() => {});
        }

        // With --ignore-errors yt-dlp can exit non-zero yet still emit good entries
        // (e.g. one dead track in a 100-song playlist). Parse whatever we got; only
        // bail when stdout is genuinely empty.
        if (!jsonData.trim()) {
            logger.error(`[YtDlp] Search failed (code ${result.code}): ${errorOutput.substring(0, 300)}`);
            return this.createResponse();
        }

        return new Promise((resolve) => {
            {
                try {
                    // For playlists, yt-dlp outputs one JSON object per line
                    const lines = jsonData.trim().split('\n').filter(line => line.trim());
                    logger.info(`[YtDlp] Got ${lines.length} result lines, isPlaylist: ${isPlaylist}`);

                    if (isPlaylist && lines.length >= 1) {
                        // Handle as playlist - even with 1 entry it might be playlist metadata
                        const tracks = [];
                        let playlistTitle = 'Unknown Playlist';

                        for (const line of lines) {
                            try {
                                const info = JSON.parse(line);

                                // Check for playlist metadata
                                if (info._type === 'playlist' && !info.id) {
                                    playlistTitle = info.title || playlistTitle;
                                    continue;
                                }

                                // Get playlist title from first entry if available
                                if (info.playlist_title && playlistTitle === 'Unknown Playlist') {
                                    playlistTitle = info.playlist_title;
                                }

                                // Build track URL
                                let trackUrl = info.webpage_url || info.url;
                                if (!trackUrl && info.id) {
                                    // Flat playlist entries only have id
                                    trackUrl = `https://www.youtube.com/watch?v=${info.id}`;
                                }

                                if (!trackUrl) continue;

                                const source = this.detectSource(trackUrl, info);

                                const track = new Track(this.context.player, {
                                    title: info.title || 'Unknown',
                                    description: info.description || '',
                                    author: info.uploader || info.channel || info.artist || 'Unknown',
                                    url: trackUrl,
                                    thumbnail: info.thumbnail || info.thumbnails?.[0]?.url,
                                    duration: this.formatDuration(info.duration),
                                    views: info.view_count || 0,
                                    requestedBy: context.requestedBy,
                                    source: source,
                                    metadata: context.metadata
                                });

                                tracks.push(track);
                            } catch (parseErr) {
                                logger.warn(`[YtDlp] Failed to parse line: ${parseErr.message}`);
                                continue;
                            }
                        }

                        if (tracks.length > 0) {
                            logger.info(`[YtDlp] Found playlist "${playlistTitle}" with ${tracks.length} tracks`);

                            const playlist = new Playlist(this.context.player, {
                                title: playlistTitle,
                                thumbnail: tracks[0]?.thumbnail,
                                description: `Playlist with ${tracks.length} tracks`,
                                type: 'playlist',
                                source: this.detectSource(originalQuery, {}),
                                author: {
                                    name: tracks[0]?.author || 'Unknown',
                                    url: originalQuery
                                },
                                tracks: tracks,
                                id: originalQuery,
                                url: originalQuery,
                                rawPlaylist: null
                            });

                            // Link tracks to playlist
                            tracks.forEach(track => {
                                track.playlist = playlist;
                            });

                            resolve(this.createResponse(playlist, tracks));
                        } else {
                            logger.warn('[YtDlp] Playlist detected but no tracks could be parsed');
                            resolve(this.createResponse());
                        }
                    } else if (lines.length > 0) {
                        // Single track
                        const info = JSON.parse(lines[0]);
                        const source = this.detectSource(info.webpage_url || info.url || '', info);

                        const track = new Track(this.context.player, {
                            title: info.title || 'Unknown',
                            description: info.description || '',
                            author: info.uploader || info.channel || 'Unknown',
                            url: info.webpage_url || info.url,
                            thumbnail: info.thumbnail,
                            duration: this.formatDuration(info.duration),
                            views: info.view_count || 0,
                            requestedBy: context.requestedBy,
                            source: source,
                            metadata: context.metadata
                        });

                        logger.info(`[YtDlp] Found: ${track.title}`);
                        resolve(this.createResponse(null, [track]));
                    } else {
                        logger.warn('[YtDlp] No results found');
                        resolve(this.createResponse());
                    }
                } catch (error) {
                    logger.error(`[YtDlp] Parse error: ${error.message}`);
                    resolve(this.createResponse());
                }
            }
        });
    }

    detectSource(url, info) {
        if (url.includes('youtube.com') || url.includes('youtu.be') || info.extractor?.toLowerCase().includes('youtube')) {
            return 'youtube';
        } else if (url.includes('soundcloud.com') || info.extractor?.toLowerCase().includes('soundcloud')) {
            return 'soundcloud';
        } else if (url.includes('spotify.com') || info.extractor?.toLowerCase().includes('spotify')) {
            return 'spotify';
        }
        return 'arbitrary';
    }

    async stream(info) {
        logger.info(`[YtDlp] Streaming: ${info.title} from ${info.url}`);

        try {
            // Defensive: if a Spotify URL ever reaches stream() directly, search YouTube
            const isSpotifyUrl = info.url?.includes('spotify.com');

            if (isSpotifyUrl) {
                const customQuery = info?.metadata?.bridgeQuery;
                const searchQuery = (typeof customQuery === 'string' && customQuery.trim())
                    ? customQuery.trim()
                    : `${info.title} ${info.author || ''}`.trim();
                logger.info(`[YtDlp] Spotify URL detected, searching YouTube for: ${searchQuery}`);
                return await this.getAudioUrlFromSearch(searchQuery);
            }

            // Try direct URL first
            try {
                return await this.getAudioUrlDirect(info.url);
            } catch (directErr) {
                // Try with title + author first, then title only as last resort
                const fullQuery = `${info.title || ''} ${info.author || ''}`.replace(/\[Deleted video\]/gi, '').trim();
                const titleOnly = (info.title || '').replace(/\[Deleted video\]/gi, '').trim();
                const searchQuery = fullQuery.length >= 3 ? fullQuery : titleOnly;
                if (!searchQuery || searchQuery.length < 3) {
                    throw new Error(`Cannot search for deleted/unavailable video: ${info.url}`);
                }
                logger.warn(`[YtDlp] Direct URL failed (${directErr.message}), searching YouTube for: ${searchQuery}`);
                return await this.getAudioUrlFromSearch(searchQuery);
            }
        } catch (err) {
            logger.error(`[YtDlp] Stream completely failed for "${info.title}": ${err.message}`);
            throw err; // Let discord-player handle via playerError event
        }
    }

    /**
     * Bridge a track from another extractor (e.g. SpotifyExtractor) to a playable
     * audio stream by searching YouTube for "title author" and returning the URL.
     * discord-player's requestBridge() iterates registered extractors and calls
     * bridge() on each one; BaseExtractor's default returns null, so extractors
     * that want to serve as a bridge MUST override this.
     */
    async bridge(track, sourceExtractor) {
        if (sourceExtractor?.identifier === this.identifier) {
            return this.stream(track);
        }

        // An explicit-aware query set by core/spotify-resolver.js wins over the source
        // extractor's createBridgeQuery (which appends "official audio" → clean uploads).
        const customQuery = track?.metadata?.bridgeQuery;
        const bridgeQuery = (typeof customQuery === 'string' && customQuery.trim())
            ? customQuery
            : (typeof sourceExtractor?.createBridgeQuery === 'function'
                ? sourceExtractor.createBridgeQuery(track)
                : null);
        const query = (bridgeQuery && bridgeQuery.trim())
            || `${track.title || ''} ${track.author || ''}`.trim();

        if (!query || query.length < 2) {
            logger.error(`[YtDlp] bridge() got empty query for "${track.title}"`);
            return null;
        }

        const expectedDurationSec = this._resolveExpectedDurationSec(track);

        try {
            logger.info(`[YtDlp] Bridging "${track.title}" via YouTube search: ${query} (expected ${expectedDurationSec ?? 'unknown'}s)`);
            const audioUrl = await this.getAudioUrlFromSearch(query, expectedDurationSec);
            return audioUrl;
        } catch (err) {
            logger.error(`[YtDlp] bridge() failed for "${track.title}": ${err.message}`);
            return null;
        }
    }

    _resolveExpectedDurationSec(track) {
        if (typeof track?.durationMS === 'number' && track.durationMS > 0) {
            return Math.floor(track.durationMS / 1000);
        }
        if (typeof track?.duration === 'string' && track.duration.includes(':')) {
            const parts = track.duration.split(':').map(p => parseInt(p, 10));
            if (parts.every(n => Number.isFinite(n))) {
                if (parts.length === 2) return parts[0] * 60 + parts[1];
                if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
            }
        }
        return null;
    }

    /**
     * Rank duration-matched candidates for a query on a given search engine, BEST first.
     * Returns an ordered array (not just one) so the caller can fall through to the next
     * candidate when the top pick is blocked (age-gate / bot-detection / DRM). `engine`
     * is a yt-dlp search prefix: 'ytsearch10' (YouTube) or 'scsearch10' (SoundCloud).
     */
    async _rankDurationMatches(searchQuery, expectedDurationSec, engine = 'ytsearch10') {
        const isYoutube = engine.startsWith('yt');
        const args = [
            '--no-warnings',
            '--no-playlist',
            '--flat-playlist',
            '--print', '%(duration)s|%(webpage_url)s|%(title)s|%(channel,uploader)s',
        ];
        if (isYoutube) args.push('--extractor-args', 'youtube:player_client=default');
        args.push(...cookieArgs());
        // Search wider so the exact official cut (often ranked below remixes/covers/
        // lyric videos) is actually in the candidate set.
        args.push(`${engine}:${searchQuery}`);

        const result = await ytdlpPool.execute(args, { timeout: 30000 });
        const stderr = result.stderr || '';

        if (isYoutube && looksLikeCookieRotation(stderr)) {
            notifyCookieRotation({ source: '_rankDurationMatches', query: searchQuery }).catch(() => {});
        }

        if (!result.stdout?.trim()) {
            logger.error(`[YtDlp] Duration-aware ${engine} search failed: ${stderr.substring(0, 200)}`);
            return [];
        }

        const candidates = result.stdout.trim().split('\n').map(line => {
            const parts = line.split('|');
            if (parts.length < 3) return null;
            const duration = parseInt(parts[0], 10);
            const webpage_url = parts[1];
            const title = parts[2] || '';
            const channel = parts[3] || '';
            if (!Number.isFinite(duration) || duration <= 0 || !webpage_url) return null;
            return { duration, webpage_url, title, channel, delta: Math.abs(duration - expectedDurationSec) };
        }).filter(Boolean);

        if (candidates.length === 0) {
            logger.warn(`[YtDlp] No usable candidates from ${engine} for "${searchQuery}"`);
            return [];
        }

        // Official auto-generated "Art Track" uploads live on "<Artist> - Topic" channels
        // and mirror the exact album release (correct length + explicit preserved). Prefer
        // them, then prefer the CLOSEST duration — never just the first within a window.
        const isOfficial = (c) => /-\s*topic$/i.test(c.channel) || /provided to youtube|official audio/i.test(c.title);
        const rank = (a, b) => (Number(isOfficial(b)) - Number(isOfficial(a))) || (a.delta - b.delta);

        // EXACT cut first (within max(3s, 2%)), then anything within ±15%, each block
        // internally ranked official-then-closest. Concatenating the blocks gives a
        // single best-first list to walk.
        const exactThresh = Math.max(3, expectedDurationSec * 0.02);
        const exact = candidates.filter(c => c.delta <= exactThresh).sort(rank);
        const near = candidates.filter(c => c.delta > exactThresh && c.delta <= expectedDurationSec * 0.15).sort(rank);
        const ordered = [...exact, ...near];

        if (ordered.length === 0) {
            const summary = candidates.map(c => `${c.duration}s`).join(', ');
            logger.warn(`[YtDlp] No duration match for "${searchQuery}" (expected ${expectedDurationSec}s). Candidates: ${summary}`);
        } else {
            const m = ordered[0];
            logger.info(`[YtDlp] ${engine} best: "${m.title}" [${m.channel}] (${m.duration}s vs ${expectedDurationSec}s, Δ${m.delta}s${isOfficial(m) ? ', official' : ''}) — ${ordered.length} candidate(s)`);
        }
        return ordered;
    }

    /**
     * Walk a ranked candidate list and return the audio URL of the FIRST one that
     * actually resolves. Skips age-gated / DRM / bot-blocked uploads (one attempt each
     * so we move on fast) instead of dying on the top pick.
     */
    async _firstPlayable(candidates, max = 4) {
        for (const c of candidates.slice(0, max)) {
            try {
                const url = await this.getAudioUrlDirect(c.webpage_url, 1);
                if (url) return url;
            } catch (err) {
                logger.warn(`[YtDlp] Candidate blocked (${err.message}), trying next: ${c.title}`);
            }
        }
        return null;
    }

    _buildStreamArgs(url) {
        const isYoutube = url && (url.includes('youtube.com') || url.includes('youtu.be'));
        const args = [
            // Prefer audio-only formats: 140 (m4a 128k) and 251 (webm Opus 128k)
            // have long URL TTLs and don't suffer the format-18 mid-stream cutoff
            // that plagues YouTube's combined-stream fallback. Format 18 stays
            // as a last-resort safety net.
            '-f', isYoutube ? 'bestaudio[ext=m4a]/bestaudio/140/251/18/b' : 'bestaudio/best/b',
            '-g',
            '--no-playlist',
            '--no-warnings',
            '--no-check-formats',
        ];
        // Use yt-dlp's `default` client chain — it tries multiple clients and
        // picks the one that returns audio-only formats. Single-client choices
        // (web, android) often miss formats 140/251 entirely.
        if (isYoutube) {
            args.push('--extractor-args', 'youtube:player_client=default');
        }
        args.push(...cookieArgs());
        return args;
    }

    async getAudioUrlDirect(url, maxAttempts = 3) {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const args = this._buildStreamArgs(url);
            args.push(url);

            const result = await ytdlpPool.execute(args, { timeout: 30000 });

            if (result.code === 0 && result.stdout.trim()) {
                // --print urls can return multiple lines (video + audio), take first
                const resultUrl = result.stdout.trim().split('\n')[0].trim();
                logger.info(`[YtDlp] Got audio URL (attempt ${attempt + 1})`);
                return resultUrl;
            }

            const stderrFull = result.stderr || '';
            const stderr = stderrFull.substring(0, 200);
            // Don't retry on permanent / per-video failures — the caller (bridge /
            // _firstPlayable) should move to the next candidate, not hammer this one.
            if (stderr.includes('Video unavailable') || stderr.includes('terminated') || stderr.includes('removed') || stderr.includes('Private video')) {
                logger.error(`[YtDlp] Permanent failure: ${stderr}`);
                throw new Error('Video unavailable');
            }
            if (stderr.includes('confirm your age') || stderr.includes('age-restricted')) {
                throw new Error('Video is age-restricted');
            }
            if (stderr.includes('DRM')) {
                throw new Error('DRM protected');
            }

            if (looksLikeCookieRotation(stderrFull)) {
                notifyCookieRotation({ source: 'getAudioUrlDirect', query: url }).catch(() => {});
            }

            if (attempt < maxAttempts - 1) {
                const isBotDetect = looksLikeCookieRotation(stderrFull);
                const delay = isBotDetect ? 4000 : 2000;
                logger.warn(`[YtDlp] Attempt ${attempt + 1} failed (${isBotDetect ? 'bot detection' : stderr.substring(0, 80)}), retrying in ${delay / 1000}s...`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                if (looksLikeCookieRotation(stderrFull)) throw new Error("Sign in to confirm you're not a bot");
                logger.error(`[YtDlp] All ${maxAttempts} attempt(s) failed: ${stderr}`);
                throw new Error('Failed to get audio URL');
            }
        }
    }

    /**
     * Resolve a playable audio URL for a free-text query. Tries, in order:
     *   1. YouTube duration-matched candidates (when we know the expected length),
     *      walking down the list so an age-gated/blocked top result doesn't kill it;
     *   2. SoundCloud duration-matched candidates (full-length, skips DRM uploads);
     *   3. plain ytsearch then scsearch when no duration hint is available.
     * This is the "if YouTube wants to be a cunt, fall back" path.
     */
    async getAudioUrlFromSearch(searchQuery, expectedDurationSec = null) {
        // Duration-aware path: prefer the exact official cut, but try every close
        // candidate (YouTube then SoundCloud) before giving up. Prevents 30s preview
        // clips from masquerading as full tracks when bridging Spotify.
        if (expectedDurationSec && expectedDurationSec > 0) {
            const ytCandidates = await this._rankDurationMatches(searchQuery, expectedDurationSec, 'ytsearch10');
            const ytUrl = await this._firstPlayable(ytCandidates);
            if (ytUrl) return ytUrl;

            logger.warn(`[YtDlp] YouTube blocked/empty for "${searchQuery}" — falling back to SoundCloud`);
            const scCandidates = await this._rankDurationMatches(searchQuery, expectedDurationSec, 'scsearch10');
            const scUrl = await this._firstPlayable(scCandidates);
            if (scUrl) return scUrl;

            throw new Error(`Bridge duration mismatch — no full-length match on YouTube or SoundCloud for "${searchQuery}" (expected ${expectedDurationSec}s)`);
        }

        // No duration hint: plain search. Try YouTube (with one bot-detection retry),
        // then fall back to SoundCloud.
        for (const engine of ['ytsearch', 'scsearch']) {
            for (let attempt = 0; attempt < 2; attempt++) {
                const args = this._buildStreamArgs(engine === 'ytsearch' ? 'https://youtube.com' : 'https://soundcloud.com');
                args.push(`${engine}:${searchQuery}`);

                const result = await ytdlpPool.execute(args, { timeout: 30000 });

                logger.info(`[YtDlp] ${engine} stream (attempt ${attempt + 1}): code=${result.code}, stdout=${result.stdout?.length || 0} bytes, stderr=${(result.stderr || '').substring(0, 120)}`);

                if (result.code === 0 && result.stdout.trim()) {
                    const resultUrl = result.stdout.trim().split('\n')[0].trim();
                    logger.info(`[YtDlp] Got audio URL from ${engine}`);
                    return resultUrl;
                }

                const stderr = result.stderr || '';
                if (engine === 'ytsearch' && looksLikeCookieRotation(stderr)) {
                    notifyCookieRotation({ source: 'getAudioUrlFromSearch', query: searchQuery }).catch(() => {});
                    if (attempt === 0) {
                        logger.warn(`[YtDlp] YouTube bot detection on search, retrying in 3s...`);
                        await new Promise(r => setTimeout(r, 3000));
                        continue;
                    }
                }
                // This engine failed for a non-retryable reason — move to the next one.
                logger.error(`[YtDlp] ${engine} stream failed (code ${result.code}): ${stderr.substring(0, 200)}`);
                break;
            }
        }

        throw new Error(`Failed to find audio for: ${searchQuery}`);
    }

    formatDuration(seconds) {
        if (!seconds) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
}

export { YtDlpExtractor };
