import { BaseExtractor, Track, Playlist } from 'discord-player';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';
import ytdlpPool from '../utils/processPool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COOKIES_PATH = join(__dirname, '..', 'cookies.txt');

/**
 * Universal extractor using yt-dlp for ALL sources
 * Supports YouTube, SoundCloud, Spotify, and 1000+ other sites
 * Supports playlists from YouTube and Spotify
 */
class YtDlpExtractor extends BaseExtractor {
    static identifier = 'com.certifried.ytdlp-universal';

    async validate(query, type) {
        // Skip validation if query is not a string or is empty
        if (typeof query !== 'string' || query.length === 0) {
            return false;
        }

        // Let SpotifyExtractor handle Spotify URLs - it uses the Spotify API properly
        if (query.includes('spotify.com/')) {
            logger.info(`[YtDlp] Skipping Spotify URL, letting SpotifyExtractor handle: ${query.substring(0, 50)}...`);
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

        // Platform-specific handling
        if (source.platform === 'spotify') {
            logger.info(`[YtDlp] Processing Spotify ${source.type}: ${sanitizedQuery}`);
            // yt-dlp handles Spotify URLs directly (fetches metadata, we'll search YouTube for audio at stream time)
            const result = await this.searchWithSource(sanitizedQuery, context, sanitizedQuery, isPlaylist);

            if (result?.tracks?.length > 0) {
                // Mark tracks as from Spotify for better logging
                result.tracks.forEach(t => t.spotifySource = true);
                logger.info(`[YtDlp] Spotify ${source.type}: found ${result.tracks.length} track(s)`);
                return result;
            }

            // Fallback: If direct Spotify fetch fails, try searching YouTube with the URL
            logger.info(`[YtDlp] Direct Spotify fetch failed, attempting YouTube search fallback`);
        }

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

        // Search query - try YouTube first, then SoundCloud fallback
        logger.info(`[YtDlp] Search query: trying YouTube first`);
        let result = await this.searchWithSource(sanitizedQuery, context, `ytsearch:${sanitizedQuery}`, false);
        logger.info(`[YtDlp] YouTube search result: tracks=${result?.tracks?.length || 0}`);

        // If YouTube failed, try SoundCloud
        if (!result?.tracks || result.tracks.length === 0) {
            logger.info(`[YtDlp] YouTube search failed, trying SoundCloud fallback`);
            result = await this.searchWithSource(sanitizedQuery, context, `scsearch:${sanitizedQuery}`, false);
            logger.info(`[YtDlp] SoundCloud search result: tracks=${result?.tracks?.length || 0}`);
        }

        return result;
    }

    async searchWithSource(originalQuery, context, searchQuery, isPlaylist) {
        return new Promise((resolve, reject) => {

            // Build yt-dlp arguments
            const args = [
                '--dump-json',
                '--ignore-errors', // Continue on errors for playlists
                '--no-check-formats', // Don't check format availability during metadata fetch
                '--remote-components', 'ejs:github', // JS challenge solver for YouTube signatures
                '--extractor-args', 'youtube:player_client=android,web' // android gets formats, web handles cookies
            ];

            // Use cookies for YouTube authentication (required for bot detection bypass)
            if (existsSync(COOKIES_PATH)) {
                args.push('--cookies', COOKIES_PATH);
            }

            // Only add --no-playlist for non-playlist URLs (single videos/tracks)
            if (!isPlaylist) {
                args.push('--no-playlist');
            } else {
                // For playlists, use flat-playlist for faster metadata retrieval
                args.push('--flat-playlist');
            }

            args.push(searchQuery);

            const ytdlp = spawn('yt-dlp', args);

            let jsonData = '';
            let errorOutput = '';

            ytdlp.stdout.on('data', (data) => {
                jsonData += data.toString();
            });

            ytdlp.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });

            ytdlp.on('close', (code) => {
                if (code !== 0 || !jsonData.trim()) {
                    logger.error(`[YtDlp] Search failed: ${errorOutput}`);
                    return resolve(this.createResponse());
                }

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
            });

            ytdlp.on('error', (err) => {
                logger.error(`[YtDlp] Spawn error: ${err.message}`);
                resolve(this.createResponse());
            });
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

        // Check if this is a Spotify URL - if so, search YouTube instead
        const isSpotifyUrl = info.url?.includes('spotify.com');

        if (isSpotifyUrl) {
            // For Spotify tracks, search YouTube by title + author
            const searchQuery = `${info.title} ${info.author || ''}`.trim();
            logger.info(`[YtDlp] Spotify URL detected, searching YouTube for: ${searchQuery}`);
            return this.getAudioUrlFromSearch(searchQuery);
        }

        // Try direct URL first
        try {
            return await this.getAudioUrlDirect(info.url);
        } catch (err) {
            // If direct URL fails, try searching by title + author
            const searchQuery = `${info.title} ${info.author || ''}`.trim();
            logger.info(`[YtDlp] Direct URL failed, searching YouTube for: ${searchQuery}`);
            return this.getAudioUrlFromSearch(searchQuery);
        }
    }

    async getAudioUrlDirect(url) {
        const args = [
            '-f', 'bestaudio/best',
            '-g',
            '--no-playlist',
            '--no-check-formats',
            '--remote-components', 'ejs:github',
            '--extractor-args', 'youtube:player_client=android,web',
            '--no-warnings'
        ];

        // Use cookies for YouTube authentication
        if (existsSync(COOKIES_PATH)) {
            args.push('--cookies', COOKIES_PATH);
        }

        args.push(url);

        // Use process pool to limit concurrent yt-dlp processes
        const result = await ytdlpPool.execute(args, { timeout: 15000 });

        if (result.code !== 0 || !result.stdout.trim()) {
            logger.error(`[YtDlp] Stream URL fetch failed: ${result.stderr}`);
            throw new Error('Failed to get audio URL');
        }

        const resultUrl = result.stdout.trim();
        logger.info(`[YtDlp] Got audio URL, returning for discord-player to process`);
        return resultUrl;
    }

    async getAudioUrlFromSearch(searchQuery) {
        const args = [
            '-f', 'bestaudio/best',
            '-g',
            '--no-playlist',
            '--no-check-formats',
            '--remote-components', 'ejs:github',
            '--extractor-args', 'youtube:player_client=android,web',
            '--no-warnings'
        ];

        // Use cookies for YouTube authentication
        if (existsSync(COOKIES_PATH)) {
            args.push('--cookies', COOKIES_PATH);
        }

        args.push(`ytsearch:${searchQuery}`);

        // Use process pool to limit concurrent yt-dlp processes
        const result = await ytdlpPool.execute(args, { timeout: 15000 });

        if (result.code !== 0 || !result.stdout.trim()) {
            logger.error(`[YtDlp] Search stream failed: ${result.stderr}`);
            throw new Error(`Failed to find audio for: ${searchQuery}`);
        }

        const resultUrl = result.stdout.trim();
        logger.info(`[YtDlp] Got audio URL from search, returning for discord-player`);
        return resultUrl;
    }

    formatDuration(seconds) {
        if (!seconds) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
}

export { YtDlpExtractor };
