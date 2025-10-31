import { BaseExtractor, Track, SearchOptions, ExtractorStreamable } from 'discord-player';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Readable } from 'stream';
import logger from '../utils/logger';

interface VideoInfo {
    title: string;
    videoId: string;
    url: string;
    duration: string;
    thumbnail: string | null;
    author: string;
}

interface ExtractorInfo {
    url: string;
    title: string;
    [key: string]: any;
}

/**
 * yt-dlp-based YouTube extractor with local file caching
 * Downloads audio to local storage for reliable playback
 */
class YtdlpExtractor extends BaseExtractor {
    static identifier = 'com.certifried.ytdlp';
    private logger: any;
    private cacheDir: string;
    private maxCacheSize: number;
    private maxCacheAge: number;
    private ytdlpPath: string;
    private cookiesPath: string;
    private downloadsInProgress: Map<string, Promise<string>>;

    constructor(context: any, options?: any) {
        super(context, options);
        this.logger = logger;

        // Configure cache directory
        this.cacheDir = process.env.YTDLP_CACHE_DIR || path.join(__dirname, '../audio_cache');
        this.maxCacheSize = parseInt(process.env.YTDLP_MAX_CACHE_MB || '1000') * 1024 * 1024; // Default 1GB
        this.maxCacheAge = parseInt(process.env.YTDLP_MAX_CACHE_HOURS || '24') * 60 * 60 * 1000; // Default 24h

        // yt-dlp configuration
        this.ytdlpPath = process.env.YTDLP_PATH || 'yt-dlp';
        this.cookiesPath = process.env.YTDLP_COOKIES || path.join(__dirname, '../cookies.txt');

        // Ensure cache directory exists
        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
            this.logger.info(`[YtdlpExtractor] Created cache directory: ${this.cacheDir}`);
        }

        // Track downloads in progress to prevent duplicates
        this.downloadsInProgress = new Map();
    }

    async activate(): Promise<void> {
        this.protocols = ['ytsearch', 'youtube'];
        this.logger.info('[YtdlpExtractor] Extractor activated');

        // Clean old cache files on startup
        await this.cleanCache();
    }

    async deactivate(): Promise<void> {
        // Cancel any in-progress downloads
        for (const [id, controller] of this.downloadsInProgress) {
            // Downloads are promises, can't directly cancel
        }
        this.downloadsInProgress.clear();

        this.logger.info('[YtdlpExtractor] Extractor deactivated');
    }

    async validate(query: string, searchOptions?: SearchOptions): Promise<boolean> {
        // Don't validate local file paths
        if (query.startsWith('/') || query.startsWith('.') || query.includes('\\') ||
            query.match(/\.(opus|mp3|wav|ogg|m4a|flac|webm)$/i)) {
            return false;
        }

        // Accept YouTube URLs or search queries
        return query.includes('youtube.com') || query.includes('youtu.be') || !query.startsWith('http');
    }

    async handle(query: string, searchOptions: SearchOptions): Promise<ExtractorStreamable> {
        this.logger.info(`[YtdlpExtractor] Handle called for query: ${query}`);

        try {
            const isUrl = query.includes('youtube.com') || query.includes('youtu.be');

            if (isUrl) {
                // Direct URL
                const videoInfo = await this.getVideoInfo(query);
                const track = this.buildTrack(videoInfo, searchOptions);
                return { playlist: null, tracks: track ? [track] : [] };
            } else {
                // Search query
                const videoInfo = await this.searchYouTube(query);
                if (!videoInfo) {
                    return { playlist: null, tracks: [] };
                }

                const track = this.buildTrack(videoInfo, searchOptions);
                return { playlist: null, tracks: track ? [track] : [] };
            }
        } catch (error) {
            const err = _error as Error;
            this.logger.error(`[YtdlpExtractor] Handle _error: ${err.message}`);
            throw _error;
        }
    }

    async searchYouTube(query: string): Promise<VideoInfo | null> {
        this.logger.info(`[YtdlpExtractor] Searching YouTube for: ${query}`);

        return new Promise((resolve, reject) => {
            const args = [
                'ytsearch1:' + query,
                '--get-id',
                '--get-title',
                '--get-duration',
                '--get-thumbnail',
                '--skip-download',
                '--no-playlist'
            ];

            // Add cookies for age-restricted content
            if (fs.existsSync(this.cookiesPath)) {
                args.push('--cookies', this.cookiesPath);
            } else if (process.env.YTDLP_COOKIES_FROM_BROWSER) {
                args.push('--cookies-from-browser', process.env.YTDLP_COOKIES_FROM_BROWSER);
            }

            const ytdlp = spawn(this.ytdlpPath, args);
            let stdout = '';
            let stderr = '';

            ytdlp.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            ytdlp.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            ytdlp.on('close', (code) => {
                if (code !== 0) {
                    this.logger.error(`[YtdlpExtractor] Search failed: ${stderr}`);
                    return reject(new Error(`yt-dlp search failed: ${stderr}`));
                }

                const lines = stdout.trim().split('\n');
                if (lines.length < 3) {
                    return resolve(null);
                }

                const title = lines[0];
                const videoId = lines[1];
                const duration = lines[2];
                const thumbnail = lines[3] || null;

                resolve({
                    title,
                    videoId,
                    url: `https://www.youtube.com/watch?v=${videoId}`,
                    duration,
                    thumbnail,
                    author: 'YouTube'
                });
            });
        });
    }

    async getVideoInfo(url: string): Promise<VideoInfo> {
        this.logger.info(`[YtdlpExtractor] Getting video info for: ${url}`);

        return new Promise((resolve, reject) => {
            const args = [
                url,
                '--get-id',
                '--get-title',
                '--get-duration',
                '--get-thumbnail',
                '--get-uploader',
                '--skip-download',
                '--no-playlist'
            ];

            if (fs.existsSync(this.cookiesPath)) {
                args.push('--cookies', this.cookiesPath);
            } else if (process.env.YTDLP_COOKIES_FROM_BROWSER) {
                args.push('--cookies-from-browser', process.env.YTDLP_COOKIES_FROM_BROWSER);
            }

            const ytdlp = spawn(this.ytdlpPath, args);
            let stdout = '';
            let stderr = '';

            ytdlp.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            ytdlp.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            ytdlp.on('close', (code) => {
                if (code !== 0) {
                    this.logger.error(`[YtdlpExtractor] Info fetch failed: ${stderr}`);
                    return reject(new Error(`yt-dlp info fetch failed: ${stderr}`));
                }

                const lines = stdout.trim().split('\n');
                if (lines.length < 3) {
                    return reject(new Error('Invalid yt-dlp output'));
                }

                const videoId = lines[0];
                const title = lines[1];
                const duration = lines[2];
                const thumbnail = lines[3] || null;
                const author = lines[4] || 'YouTube';

                resolve({
                    title,
                    videoId,
                    url: `https://www.youtube.com/watch?v=${videoId}`,
                    duration,
                    thumbnail,
                    author
                });
            });
        });
    }

    buildTrack(info: VideoInfo | null, searchOptions: SearchOptions): Track | null {
        if (!info || !info.url || !info.title) return null;

        const track = new Track(this.context.player, {
            title: info.title,
            url: info.url,
            duration: info.duration || '0:00',
            thumbnail: info.thumbnail || null,
            author: info.author || 'YouTube',
            source: 'com.certifried.ytdlp',
            requestedBy: searchOptions.requestedBy,
            metadata: {
                ...(searchOptions.metadata || {}),
                videoId: info.videoId
            }
        });

        track.extractor = this;
        return track;
    }

    /**
     * Generate cache filename from video URL
     */
    getCacheFilename(url: string): string {
        const hash = crypto.createHash('md5').update(url).digest('hex');
        return path.join(this.cacheDir, `${hash}.opus`);
    }

    /**
     * Check if file is in cache and still valid
     */
    async isCached(url: string): Promise<boolean> {
        const cacheFile = this.getCacheFilename(url);

        if (!fs.existsSync(cacheFile)) {
            return false;
        }

        // Check age
        const stats = fs.statSync(cacheFile);
        const age = Date.now() - stats.mtimeMs;

        if (age > this.maxCacheAge) {
            // Cache expired, delete it
            try {
                fs.unlinkSync(cacheFile);
                this.logger.info(`[YtdlpExtractor] Deleted expired cache file: ${cacheFile}`);
            } catch (err) {
                const error = err as Error;
                this.logger.error(`[YtdlpExtractor] Failed to delete expired cache: ${error.message}`);
            }
            return false;
        }

        // Check file size (ensure it's not empty or corrupted)
        if (stats.size < 1000) {
            try {
                fs.unlinkSync(cacheFile);
                this.logger.warn(`[YtdlpExtractor] Deleted corrupted cache file (too small): ${cacheFile}`);
            } catch (err) {
                const error = err as Error;
                this.logger.error(`[YtdlpExtractor] Failed to delete corrupted cache: ${error.message}`);
            }
            return false;
        }

        return true;
    }

    /**
     * Download audio using yt-dlp
     */
    async downloadAudio(url: string): Promise<string> {
        const cacheFile = this.getCacheFilename(url);

        // Check if already being downloaded
        if (this.downloadsInProgress.has(url)) {
            this.logger.info(`[YtdlpExtractor] Download already in progress for ${url}, waiting...`);
            return this.downloadsInProgress.get(url)!;
        }

        const downloadPromise = new Promise<string>((resolve, reject) => {
            this.logger.info(`[YtdlpExtractor] Downloading audio: ${url}`);

            const args = [
                url,
                '--format', 'bestaudio/best',
                '--extract-audio',
                '--audio-format', 'opus',
                '--audio-quality', '0',  // Best quality
                '--output', cacheFile,
                '--no-playlist',
                '--no-warnings',
                '--no-cache-dir',  // Don't use yt-dlp's cache
                '--socket-timeout', '30'  // 30 second socket timeout
            ];

            // Try cookies file first, then fall back to browser cookies
            if (fs.existsSync(this.cookiesPath)) {
                args.push('--cookies', this.cookiesPath);
                this.logger.info(`[YtdlpExtractor] Using cookies from: ${this.cookiesPath}`);
            } else if (process.env.YTDLP_COOKIES_FROM_BROWSER) {
                args.push('--cookies-from-browser', process.env.YTDLP_COOKIES_FROM_BROWSER);
                this.logger.info(`[YtdlpExtractor] Using cookies from browser: ${process.env.YTDLP_COOKIES_FROM_BROWSER}`);
            } else {
                this.logger.warn(`[YtdlpExtractor] No cookies configured - age-restricted videos will fail`);
            }

            const ytdlp = spawn(this.ytdlpPath, args);
            let stderr = '';
            let lastProgressTime = Date.now();

            // Set a 2-minute timeout for the entire download
            const downloadTimeout = setTimeout(() => {
                this.logger.error(`[YtdlpExtractor] Download timeout (2 minutes) for ${url}`);
                ytdlp.kill('SIGKILL');
                this.downloadsInProgress.delete(url);
                reject(new Error('Download timeout after 2 minutes'));
            }, 120000);

            // Set a stall timeout (no progress for 30 seconds)
            const stallCheckInterval = setInterval(() => {
                const timeSinceProgress = Date.now() - lastProgressTime;
                if (timeSinceProgress > 30000) {
                    this.logger.error(`[YtdlpExtractor] Download stalled (no progress for 30s) for ${url}`);
                    clearTimeout(downloadTimeout);
                    clearInterval(stallCheckInterval);
                    ytdlp.kill('SIGKILL');
                    this.downloadsInProgress.delete(url);
                    reject(new Error('Download stalled'));
                }
            }, 5000);

            ytdlp.stderr.on('data', (data) => {
                const output = data.toString();
                stderr += output;
                lastProgressTime = Date.now(); // Update progress time on any output

                // Log progress
                if (output.includes('[download]')) {
                    const match = output.match(/(\d+\.?\d*)%/);
                    if (match) {
                        this.logger.info(`[YtdlpExtractor] Download progress: ${match[1]}%`);
                    }
                }
            });

            ytdlp.stdout.on('data', (data) => {
                lastProgressTime = Date.now(); // Update progress time on stdout too
            });

            ytdlp.on('close', (code) => {
                clearTimeout(downloadTimeout);
                clearInterval(stallCheckInterval);
                this.downloadsInProgress.delete(url);

                if (code !== 0) {
                    this.logger.error(`[YtdlpExtractor] Download failed with code ${code}: ${stderr}`);
                    return reject(new Error(`yt-dlp download failed with code ${code}: ${stderr.slice(0, 500)}`));
                }

                // Verify file was created
                if (!fs.existsSync(cacheFile)) {
                    return reject(new Error('Download completed but file not found'));
                }

                this.logger.info(`[YtdlpExtractor] Download complete: ${cacheFile}`);
                resolve(cacheFile);
            });

            ytdlp.on('error', (err) => {
                clearTimeout(downloadTimeout);
                clearInterval(stallCheckInterval);
                this.downloadsInProgress.delete(url);
                this.logger.error(`[YtdlpExtractor] Spawn error: ${err.message}`);
                reject(err);
            });
        });

        this.downloadsInProgress.set(url, downloadPromise);
        return downloadPromise;
    }

    /**
     * Stream audio (download if not cached, then stream from file)
     */
    async stream(info: ExtractorInfo): Promise<Readable> {
        const url = info.url;
        this.logger.info(`[YtdlpExtractor] Stream requested for: ${info.title}`);

        try {
            // Check cache first
            const cached = await this.isCached(url);
            let cacheFile = this.getCacheFilename(url);

            if (cached) {
                this.logger.info(`[YtdlpExtractor] Using cached file: ${cacheFile}`);
            } else {
                // Download to cache
                cacheFile = await this.downloadAudio(url);

                // Clean cache after download
                await this.cleanCache();
            }

            // Return file stream
            return fs.createReadStream(cacheFile);

        } catch (error) {
            const err = _error as Error;
            this.logger.error(`[YtdlpExtractor] Stream _error: ${err.message}`);
            throw _error;
        }
    }

    /**
     * Clean old cache files to stay within size limits
     */
    async cleanCache(): Promise<void> {
        try {
            const files = fs.readdirSync(this.cacheDir);
            if (files.length === 0) return;

            // Get file stats
            const fileStats: Array<{ path: string; size: number; mtime: number }> = [];
            let totalSize = 0;

            for (const file of files) {
                const filePath = path.join(this.cacheDir, file);
                try {
                    const stats = fs.statSync(filePath);
                    fileStats.push({
                        path: filePath,
                        size: stats.size,
                        mtime: stats.mtimeMs
                    });
                    totalSize += stats.size;
                } catch (err) {
                    // File might have been deleted, skip
                }
            }

            this.logger.info(`[YtdlpExtractor] Cache: ${fileStats.length} files, ${(totalSize / 1024 / 1024).toFixed(2)} MB`);

            // Sort by modification time (oldest first)
            fileStats.sort((a, b) => a.mtime - b.mtime);

            // Delete old files if cache is too large
            while (totalSize > this.maxCacheSize && fileStats.length > 0) {
                const oldestFile = fileStats.shift()!;
                try {
                    fs.unlinkSync(oldestFile.path);
                    totalSize -= oldestFile.size;
                    this.logger.info(`[YtdlpExtractor] Deleted old cache file: ${path.basename(oldestFile.path)} (freed ${(oldestFile.size / 1024 / 1024).toFixed(2)} MB)`);
                } catch (err) {
                    const error = err as Error;
                    this.logger.error(`[YtdlpExtractor] Failed to delete cache file: ${error.message}`);
                }
            }

        } catch (error) {
            const err = _error as Error;
            this.logger.error(`[YtdlpExtractor] Cache cleanup _error: ${err.message}`);
        }
    }
}

export { YtdlpExtractor };
