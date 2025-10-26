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

            // Block YouTube ad domains at the network level
            await this.browserContext.route('**/*', (route) => {
                const url = route.request().url();
                const adDomains = [
                    'doubleclick.net',
                    'googlesyndication.com',
                    'googleadservices.com',
                    'google-analytics.com',
                    'youtube.com/pagead/',
                    'youtube.com/ptracking',
                    'youtube.com/api/stats/ads'
                ];

                // Block known ad domains
                if (adDomains.some(domain => url.includes(domain))) {
                    route.abort();
                } else {
                    route.continue();
                }
            });

            this.logger.info('[PlaywrightYT] Browser launched successfully with ad-blocking');
        }
        return { browser: this.browser, context: this.browserContext };
    }

    async validate(query, searchOptions) {
        // Don't validate local file paths (they should use the default file extractor)
        if (query.startsWith('/') || query.startsWith('.') || query.includes('\\') ||
            query.match(/\.(opus|mp3|wav|ogg|m4a|flac|webm)$/i)) {
            return false;
        }

        // Accept YouTube URLs or search queries
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
        this.logger.info(`[PlaywrightYT] Streaming using MediaRecorder: ${info.title}`);
        const { context } = await this.getBrowser();
        const page = await context.newPage();
        const { PassThrough } = require('stream');
        const audioStream = new PassThrough();
        let recorderStopped = false;

        const cleanup = async (reason = 'unknown') => {
            if (recorderStopped) return;
            recorderStopped = true;
            this.logger.info(`[PlaywrightYT] Cleaning up MediaRecorder stream. Reason: ${reason}`);
            try {
                if (!page.isClosed()) {
                    await page.evaluate(() => {
                        // Clear the ad-skipping interval
                        if (window.adSkipInterval) {
                            clearInterval(window.adSkipInterval);
                        }
                        if (window.mediaRecorder && window.mediaRecorder.state !== 'inactive') {
                            window.mediaRecorder.stop();
                        }
                    });
                    await page.close();
                }
            } catch (error) {
                this.logger.error(`[PlaywrightYT] Error during cleanup: ${error.message}`);
            }
            if (!audioStream.destroyed) {
                audioStream.end();
            }
        };

        audioStream.on('close', () => cleanup('stream closed'));
        audioStream.on('error', (err) => {
            this.logger.error(`[PlaywrightYT] AudioStream error: ${err.message}`);
            cleanup('stream error');
        });
        audioStream.on('end', () => {
            this.logger.info('[PlaywrightYT] AudioStream ended normally');
        });

        try {
            await page.exposeFunction('onAudioChunk', (chunk) => {
                if (chunk && chunk.data) {
                    audioStream.write(Buffer.from(chunk.data));
                }
            });

            await page.exposeFunction('onStreamEnd', () => {
                this.logger.info('[PlaywrightYT] MediaRecorder stream ended from browser.');
                cleanup('browser onStreamEnd callback');
            });

            await page.exposeFunction('onStreamError', (error) => {
                this.logger.error(`[PlaywrightYT] MediaRecorder stream error from browser: ${error}`);
                audioStream.emit('error', new Error(error));
                cleanup('browser onStreamError callback');
            });

            const videoUrl = info.webpage_url || info.url;

            // Listen to browser console logs for debugging
            page.on('console', msg => {
                const text = msg.text();
                if (text.includes('[PlaywrightYT]')) {
                    this.logger.info(`[Browser Console] ${text}`);
                }
            });

            await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

            await page.waitForSelector('video', { timeout: 15000 });

            // Inject ad-skipping script that runs in the browser context
            await page.evaluate(() => {
                // Continuously monitor for and skip ads (more conservatively)
                window.adSkipInterval = setInterval(() => {
                    // Check if we're actually in an ad
                    const adIndicator = document.querySelector('.ytp-ad-player-overlay, .ytp-ad-preview-container, .ytp-ad-text');
                    const video = document.querySelector('video');

                    // Only try to skip if we're definitely in an ad
                    if (adIndicator && video) {
                        // Try to skip ads with skip button
                        const skipButton = document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button');
                        if (skipButton && skipButton.offsetParent !== null && !skipButton.disabled) {
                            skipButton.click();
                            console.log('[PlaywrightYT] Auto-skipped ad');
                        }
                    }
                }, 1000); // Check every second (less aggressive)
            });

            await page.evaluate(() => {
                const video = document.querySelector('video');
                if (!video) {
                    return window.onStreamError('Could not find video element.');
                }

                console.log(`[PlaywrightYT] Video element found. Initial readyState: ${video.readyState}, currentTime: ${video.currentTime}, duration: ${video.duration}`);

                video.muted = true;
                video.volume = 0;

                // Start video playback first
                video.play().then(async () => {
                    console.log(`[PlaywrightYT] Video.play() succeeded. readyState: ${video.readyState}, currentTime: ${video.currentTime}`);
                    try {
                        // Wait for any ads to finish before capturing the main video
                        console.log('[PlaywrightYT] Waiting for ads to complete...');
                        let adWaitAttempts = 0;
                        while (adWaitAttempts < 30) { // Wait up to 30 seconds for ads
                            const adIndicator = document.querySelector('.ytp-ad-player-overlay, .ytp-ad-preview-container, .ytp-ad-text');
                            if (!adIndicator) {
                                console.log('[PlaywrightYT] No ads detected, proceeding with capture');
                                break;
                            }
                            console.log(`[PlaywrightYT] Ad detected, waiting... (${adWaitAttempts + 1}/30)`);
                            await new Promise(resolve => setTimeout(resolve, 1000));
                            adWaitAttempts++;
                        }

                        // Seek back to start if video has progressed (due to ads)
                        if (video.currentTime > 5) {
                            console.log(`[PlaywrightYT] Video at ${video.currentTime}s, seeking back to start`);
                            video.currentTime = 0;
                            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for seek to complete
                        }

                        // Wait for video to be ready and have audio
                        console.log('[PlaywrightYT] Waiting for audio tracks to be available...');

                        let audioTracks = [];
                        let attempts = 0;
                        const maxAttempts = 20; // Try for up to 10 seconds

                        while (audioTracks.length === 0 && attempts < maxAttempts) {
                            // Wait for video to be ready
                            await new Promise(resolve => setTimeout(resolve, 500));

                            // Try to capture the stream
                            const fullStream = video.captureStream();
                            if (!fullStream) {
                                attempts++;
                                continue;
                            }

                            audioTracks = fullStream.getAudioTracks();

                            if (audioTracks.length === 0) {
                                console.log(`[PlaywrightYT] Attempt ${attempts + 1}/${maxAttempts}: No audio tracks yet, waiting... (readyState: ${video.readyState}, currentTime: ${video.currentTime})`);
                                attempts++;
                            } else {
                                console.log(`[PlaywrightYT] Found ${audioTracks.length} audio tracks after ${attempts + 1} attempts`);
                            }
                        }

                        if (audioTracks.length === 0) {
                            return window.onStreamError('No audio tracks available in stream after waiting.');
                        }

                        // Capture the final stream with audio (do it fresh to ensure we get current tracks)
                        const fullStream = video.captureStream();
                        if (!fullStream) {
                            return window.onStreamError('Could not capture video stream.');
                        }

                        const finalAudioTracks = fullStream.getAudioTracks();
                        console.log(`[PlaywrightYT] Successfully capturing ${finalAudioTracks.length} audio tracks`);
                        const audioStream = new MediaStream(finalAudioTracks);

                        if (typeof MediaRecorder === 'undefined') {
                            return window.onStreamError('MediaRecorder API not supported.');
                        }

                        const options = { mimeType: 'audio/webm; codecs=opus' };
                        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                            console.warn(`[PlaywrightYT] ${options.mimeType} not supported, using default.`);
                            delete options.mimeType;
                        }

                        window.mediaRecorder = new MediaRecorder(audioStream, options);

                        let dataChunkCount = 0;
                        window.mediaRecorder.ondataavailable = async (event) => {
                            if (event.data.size > 0) {
                                dataChunkCount++;
                                if (dataChunkCount % 10 === 0) {
                                    console.log(`[PlaywrightYT] Sent ${dataChunkCount} audio chunks (${event.data.size} bytes) - video at ${video.currentTime.toFixed(2)}s / ${video.duration.toFixed(2)}s`);
                                }
                                const arrayBuffer = await event.data.arrayBuffer();
                                window.onAudioChunk({ data: Array.from(new Uint8Array(arrayBuffer)) });
                            }
                        };

                        window.mediaRecorder.onstop = () => {
                            console.log(`[PlaywrightYT] MediaRecorder stopped after sending ${dataChunkCount} chunks. Video state: ended=${video.ended}, currentTime=${video.currentTime.toFixed(2)}s, duration=${video.duration.toFixed(2)}s`);
                            window.onStreamEnd();
                        };
                        window.mediaRecorder.onerror = (event) => {
                            console.log(`[PlaywrightYT] MediaRecorder error: ${event.error.message || 'Unknown error'}`);
                            window.onStreamError(event.error.message || 'Unknown MediaRecorder error');
                        };

                        window.mediaRecorder.start(500); // Collect data every 500ms
                        console.log('[PlaywrightYT] MediaRecorder started.');

                        // Monitor video state to detect actual end
                        let hasEnded = false;
                        let lastLoggedTime = 0;
                        const checkVideoEnd = setInterval(() => {
                            // Log video state periodically
                            if (video.currentTime - lastLoggedTime > 5) {
                                console.log(`[PlaywrightYT] Video progress: ${video.currentTime.toFixed(2)}s / ${video.duration.toFixed(2)}s (playing: ${!video.paused}, ended: ${video.ended}, readyState: ${video.readyState})`);
                                lastLoggedTime = video.currentTime;
                            }

                            // Only stop if video genuinely ended and we're close to the end
                            if (video.ended && !hasEnded && video.currentTime > video.duration - 2) {
                                hasEnded = true;
                                console.log('[PlaywrightYT] Video ended naturally at expected time, stopping recorder');
                                clearInterval(checkVideoEnd);
                                if (window.mediaRecorder && window.mediaRecorder.state === 'recording') {
                                    window.mediaRecorder.stop();
                                }
                            } else if (video.ended && !hasEnded) {
                                console.log(`[PlaywrightYT] WARNING: Video.ended=true but currentTime=${video.currentTime.toFixed(2)}s is not near duration=${video.duration.toFixed(2)}s. Ignoring.`);
                            }
                        }, 2000); // Check every 2 seconds

                        // Cleanup interval if recorder stops for other reasons
                        window.mediaRecorder.addEventListener('stop', () => clearInterval(checkVideoEnd), { once: true });
                    } catch (err) {
                        window.onStreamError(err.message || 'Failed to initialize MediaRecorder');
                    }
                }).catch(err => {
                    window.onStreamError(`Video playback failed: ${err.message}`);
                });
            });

            return audioStream;

        } catch (error) {
            this.logger.error(`[PlaywrightYT] Stream error: ${error.message}`);
            await cleanup();
            throw error;
        }
    }
}

module.exports = { PlaywrightYouTubeExtractor };
