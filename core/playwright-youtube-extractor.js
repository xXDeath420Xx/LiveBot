const { BaseExtractor, Track } = require('discord-player');
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function formatDuration(seconds) {
    if (isNaN(seconds) || seconds < 0) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return [h > 0 ? h : null, m, s]
        .filter(x => x !== null)
        .map(x => x.toString().padStart(2, '0'))
        .join(':');
}

class PlaywrightYouTubeExtractor extends BaseExtractor {
    static identifier = 'com.certifried.playwright-youtube';

    constructor(context, options) {
        super(context, options);
        this.browser = null;
        this.browserContext = null;
        this.logger = require('../utils/logger');
    }

    async activate() {
        this.protocols = ['ytsearch', 'youtube'];
        this.logger.info('[PlaywrightYT] Extractor activated');
    }

    async deactivate() {
        if (this.browserContext) {
            await this.browserContext.close();
        }
        if (this.browser) {
            await this.browser.close();
        }
        this.logger.info('[PlaywrightYT] Extractor deactivated');
    }

    async getBrowser() {
        if (!this.browser) {
            this.logger.info('[PlaywrightYT] Launching Chromium browser...');
            this.browser = await chromium.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled'
                ]
            });

            this.browserContext = await this.browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                viewport: { width: 1920, height: 1080 },
                locale: 'en-US',
                timezoneId: 'America/Los_Angeles'
            });

            this.logger.info('[PlaywrightYT] Browser launched successfully');
        }
        return { browser: this.browser, context: this.browserContext };
    }

    async validate(query, searchOptions) {
        return query.includes('youtube.com') || query.includes('youtu.be') || !query.startsWith('http');
    }

    async handle(query, searchOptions) {
        this.logger.info(`[PlaywrightYT] Handle called for query: ${query}`);

        try {
            const isUrl = query.includes('youtube.com') || query.includes('youtu.be');

            if (isUrl) {
                // Direct URL
                const videoInfo = await this.getVideoInfo(query);
                const track = this.buildTrack(videoInfo, searchOptions);
                return { playlist: null, tracks: track ? [track] : [] };
            } else {
                // Search query
                const searchResults = await this.searchYouTube(query);
                if (searchResults.length === 0) {
                    return { playlist: null, tracks: [] };
                }

                const track = this.buildTrack(searchResults[0], searchOptions);
                return { playlist: null, tracks: track ? [track] : [] };
            }
        } catch (error) {
            this.logger.error(`[PlaywrightYT] Handle error: ${error.message}`);
            throw error;
        }
    }

    async searchYouTube(query) {
        this.logger.info(`[PlaywrightYT] Searching YouTube for: ${query}`);

        const { context } = await this.getBrowser();
        const page = await context.newPage();

        try {
            const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
            await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });

            // Wait for search results
            await page.waitForSelector('ytd-video-renderer', { timeout: 10000 });

            // Extract first result
            const result = await page.evaluate(() => {
                const videoRenderer = document.querySelector('ytd-video-renderer');
                if (!videoRenderer) return null;

                const titleElement = videoRenderer.querySelector('#video-title');
                const durationElement = videoRenderer.querySelector('span.style-scope.ytd-thumbnail-overlay-time-status-renderer');
                const channelElement = videoRenderer.querySelector('#channel-name a');
                const thumbnailElement = videoRenderer.querySelector('img#img');

                return {
                    title: titleElement?.textContent?.trim() || 'Unknown',
                    url: titleElement?.href || '',
                    duration: durationElement?.textContent?.trim() || '0:00',
                    author: channelElement?.textContent?.trim() || 'Unknown',
                    thumbnail: thumbnailElement?.src || null
                };
            });

            await page.close();

            if (!result || !result.url) {
                this.logger.warn(`[PlaywrightYT] No results found for: ${query}`);
                return [];
            }

            // Convert duration to seconds
            const durationParts = result.duration.split(':').map(p => parseInt(p));
            let durationMs = 0;
            if (durationParts.length === 2) {
                durationMs = (durationParts[0] * 60 + durationParts[1]) * 1000;
            } else if (durationParts.length === 3) {
                durationMs = (durationParts[0] * 3600 + durationParts[1] * 60 + durationParts[2]) * 1000;
            }

            this.logger.info(`[PlaywrightYT] Found video: ${result.title}`);
            return [{
                ...result,
                duration: durationMs,
                webpage_url: result.url
            }];

        } catch (error) {
            await page.close();
            throw error;
        }
    }

    async getVideoInfo(url) {
        this.logger.info(`[PlaywrightYT] Getting video info for: ${url}`);

        const { context } = await this.getBrowser();
        const page = await context.newPage();

        try {
            await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

            // Wait for video to be ready
            await page.waitForSelector('h1.ytd-watch-metadata', { timeout: 10000 });

            // Extract video info
            const videoInfo = await page.evaluate(() => {
                const titleElement = document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
                const channelElement = document.querySelector('ytd-channel-name a');
                const thumbnailElement = document.querySelector('link[rel="image_src"]');

                return {
                    title: titleElement?.textContent?.trim() || 'Unknown',
                    author: channelElement?.textContent?.trim() || 'Unknown',
                    thumbnail: thumbnailElement?.href || null,
                    webpage_url: window.location.href
                };
            });

            // Try to get duration from player
            const duration = await page.evaluate(() => {
                const video = document.querySelector('video');
                return video?.duration || 0;
            });

            videoInfo.duration = duration * 1000; // Convert to ms

            await page.close();

            this.logger.info(`[PlaywrightYT] Got video info: ${videoInfo.title}`);
            return videoInfo;

        } catch (error) {
            await page.close();
            throw error;
        }
    }

    buildTrack(info, searchOptions) {
        const trackUrl = info.url || info.webpage_url;
        if (!info || !trackUrl || !info.title) return null;

        // Convert duration from milliseconds to seconds
        const durationSeconds = Math.floor((info.duration || 0) / 1000);

        const track = new Track(this.context.player, {
            title: info.title,
            url: trackUrl,
            duration: formatDuration(durationSeconds),
            thumbnail: info.thumbnail || null,
            author: info.author || 'Unknown',
            source: 'com.certifried.playwright-youtube',
            requestedBy: searchOptions.requestedBy,
            metadata: searchOptions.metadata
        });

        track.extractor = this;
        return track;
    }

    async stream(info) {
        this.logger.info(`[PlaywrightYT] Streaming: ${info.title}`);

        const { context } = await this.getBrowser();
        const page = await context.newPage();

        try {
            const videoUrl = info.webpage_url || info.url;
            this.logger.info(`[PlaywrightYT] Navigating to: ${videoUrl}`);

            // Navigate to video page to establish session
            await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForSelector('video', { timeout: 15000 });

            // Start playback to ensure full session is established
            await page.evaluate(() => {
                const video = document.querySelector('video');
                if (video) {
                    video.muted = true;
                    video.volume = 0;
                    video.play().catch(() => {});
                }
            });

            // Wait for streams to load
            await page.waitForTimeout(3000);

            // Extract cookies from browser session
            this.logger.info(`[PlaywrightYT] Extracting cookies from browser session...`);
            const cookies = await context.cookies();

            // Create temp directory
            const tempDir = path.join(__dirname, '..', 'temp_audio');
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }

            // Save cookies in Netscape format for yt-dlp
            const videoId = videoUrl.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})(?=&|#|$)/)?.[1] || Date.now();
            const cookieFile = path.join(tempDir, `cookies_${videoId}.txt`);

            let cookieContent = '# Netscape HTTP Cookie File\n';
            for (const cookie of cookies) {
                const domain = cookie.domain.startsWith('.') ? cookie.domain : `.${cookie.domain}`;
                const flag = cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE';
                const secure = cookie.secure ? 'TRUE' : 'FALSE';
                const expiry = Math.floor(cookie.expires || 0);
                cookieContent += `${domain}\t${flag}\t${cookie.path}\t${secure}\t${expiry}\t${cookie.name}\t${cookie.value}\n`;
            }

            fs.writeFileSync(cookieFile, cookieContent);
            this.logger.info(`[PlaywrightYT] Saved ${cookies.length} cookies to ${cookieFile}`);

            await page.close();

            // Now use yt-dlp with the cookies
            const outputFile = path.join(tempDir, `${videoId}.webm`);

            this.logger.info(`[PlaywrightYT] Using yt-dlp with browser cookies...`);

            return new Promise((resolve, reject) => {
                const ytdlp = spawn('yt-dlp', [
                    '--cookies', cookieFile,
                    '-f', 'bestaudio[ext=webm]/bestaudio/best',
                    '-o', outputFile,
                    '--no-playlist',
                    '--quiet',
                    '--no-warnings',
                    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    '--referer', 'https://www.youtube.com/',
                    videoUrl
                ]);

                let errorOutput = '';

                ytdlp.stderr.on('data', (data) => {
                    errorOutput += data.toString();
                });

                ytdlp.on('close', (code) => {
                    // Clean up cookie file
                    try {
                        fs.unlinkSync(cookieFile);
                    } catch (err) {
                        // Ignore cleanup errors
                    }

                    if (code === 0) {
                        if (fs.existsSync(outputFile)) {
                            const stats = fs.statSync(outputFile);
                            this.logger.info(`[PlaywrightYT] Downloaded ${stats.size} bytes to ${outputFile}`);

                            if (stats.size < 1000) {
                                this.logger.error(`[PlaywrightYT] File too small: ${stats.size} bytes`);
                                reject(new Error(`Downloaded file too small (${stats.size} bytes)`));
                            } else {
                                resolve(fs.createReadStream(outputFile));
                            }
                        } else {
                            this.logger.error(`[PlaywrightYT] Output file not found: ${outputFile}`);
                            reject(new Error('yt-dlp completed but output file not found'));
                        }
                    } else {
                        this.logger.error(`[PlaywrightYT] yt-dlp failed with code ${code}: ${errorOutput}`);
                        reject(new Error(`yt-dlp failed: ${errorOutput || 'Unknown error'}`));
                    }
                });

                ytdlp.on('error', (err) => {
                    this.logger.error(`[PlaywrightYT] Failed to spawn yt-dlp: ${err.message}`);
                    try {
                        fs.unlinkSync(cookieFile);
                    } catch (cleanupErr) {
                        // Ignore
                    }
                    reject(new Error(`Failed to run yt-dlp: ${err.message}`));
                });
            });

        } catch (error) {
            this.logger.error(`[PlaywrightYT] Stream error: ${error.message}`);
            try {
                await page.close();
            } catch (closeError) {
                // Ignore close errors
            }
            throw error;
        }
    }
}

module.exports = { PlaywrightYouTubeExtractor };
