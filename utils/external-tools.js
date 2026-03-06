import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import logger from './logger.js';

const execFileAsync = promisify(execFile);

// Minimum supported yt-dlp version
const MIN_YTDLP_VERSION = '2023.01.01';

// TTS file cleanup settings
const TTS_TEMP_DIR = '/tmp';
const TTS_FILE_PREFIX = 'dj_intro_';
const TTS_FILE_MAX_AGE = 3600000; // 1 hour in ms

// Track yt-dlp status
let ytdlpStatus = {
    available: false,
    version: null,
    path: null,
    lastCheck: 0
};

/**
 * Parse yt-dlp version string into comparable format
 */
function parseVersion(versionStr) {
    // yt-dlp versions are like "2024.01.15" or "2023.11.16.post1"
    const match = versionStr.match(/(\d{4})\.(\d{2})\.(\d{2})/);
    if (!match) return null;
    return {
        year: parseInt(match[1]),
        month: parseInt(match[2]),
        day: parseInt(match[3]),
        raw: versionStr
    };
}

/**
 * Compare two version objects
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
function compareVersions(a, b) {
    if (a.year !== b.year) return a.year < b.year ? -1 : 1;
    if (a.month !== b.month) return a.month < b.month ? -1 : 1;
    if (a.day !== b.day) return a.day < b.day ? -1 : 1;
    return 0;
}

/**
 * Check if yt-dlp is available and meets minimum version
 */
export async function checkYtdlp() {
    // Cache check results for 5 minutes
    if (ytdlpStatus.lastCheck && Date.now() - ytdlpStatus.lastCheck < 300000) {
        return ytdlpStatus;
    }

    try {
        // Use execFile instead of execSync for safety (no shell interpretation)
        const { stdout } = await execFileAsync('yt-dlp', ['--version'], { timeout: 5000 });
        const versionStr = stdout.trim();
        const version = parseVersion(versionStr);

        if (!version) {
            ytdlpStatus = {
                available: false,
                version: versionStr,
                path: null,
                lastCheck: Date.now(),
                error: 'Could not parse version'
            };
            logger.warn('[yt-dlp] Could not parse version string', { version: versionStr });
            return ytdlpStatus;
        }

        const minVersion = parseVersion(MIN_YTDLP_VERSION);
        const isSupported = compareVersions(version, minVersion) >= 0;

        // Get path using which command (safe as no user input)
        let ytdlpPath = 'yt-dlp';
        try {
            const { stdout: whichOut } = await execFileAsync('which', ['yt-dlp'], { timeout: 2000 });
            ytdlpPath = whichOut.trim();
        } catch {
            // Fall back to just 'yt-dlp'
        }

        ytdlpStatus = {
            available: isSupported,
            version: versionStr,
            parsedVersion: version,
            path: ytdlpPath,
            lastCheck: Date.now(),
            meetsMinimum: isSupported,
            minimumRequired: MIN_YTDLP_VERSION
        };

        if (!isSupported) {
            logger.warn('[yt-dlp] Version is below minimum', {
                current: versionStr,
                minimum: MIN_YTDLP_VERSION
            });
        } else {
            logger.info('[yt-dlp] Version check passed', { version: versionStr });
        }

        return ytdlpStatus;
    } catch (error) {
        ytdlpStatus = {
            available: false,
            version: null,
            path: null,
            lastCheck: Date.now(),
            error: error.message
        };
        logger.error('[yt-dlp] Not available or not installed', { error: error.message });
        return ytdlpStatus;
    }
}

/**
 * Get yt-dlp status (cached)
 */
export function getYtdlpStatus() {
    return ytdlpStatus;
}

/**
 * Validate and sanitize search query for yt-dlp
 * This is NOT for shell escaping (we use spawn which doesn't use shell)
 * This is for preventing malformed searches
 */
export function sanitizeSearchQuery(input) {
    if (typeof input !== 'string') return '';

    return input
        // Remove null bytes
        .replace(/\0/g, '')
        // Remove control characters
        .replace(/[\x00-\x1F\x7F]/g, '')
        // Limit length to prevent abuse
        .substring(0, 500)
        .trim();
}

/**
 * Execute yt-dlp search with timeout and safe argument passing
 * Uses spawn (not shell) so arguments are passed directly without shell interpretation
 */
export function ytdlpSearch(query, options = {}) {
    return new Promise((resolve) => {
        const timeout = options.timeout || 15000;
        const sanitizedQuery = sanitizeSearchQuery(query);

        if (!sanitizedQuery) {
            resolve(null);
            return;
        }

        // Arguments passed directly to yt-dlp (no shell involved)
        const args = [
            '--flat-playlist',
            '--dump-json',
            '--no-warnings',
            '--no-playlist',
            `ytsearch1:${sanitizedQuery}`
        ];

        // spawn does NOT use a shell, so no command injection is possible
        const ytdlp = spawn('yt-dlp', args, {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        ytdlp.stdout.on('data', (data) => {
            stdout += data;
            // Limit buffer size to prevent memory issues
            if (stdout.length > 100000) {
                ytdlp.kill();
            }
        });

        ytdlp.stderr.on('data', (data) => {
            stderr += data;
        });

        const timeoutId = setTimeout(() => {
            ytdlp.kill('SIGTERM');
            resolve(null);
        }, timeout);

        ytdlp.on('close', (code) => {
            clearTimeout(timeoutId);

            if (code === 0 && stdout.trim()) {
                try {
                    resolve(JSON.parse(stdout.trim()));
                } catch (e) {
                    logger.warn('[yt-dlp] Failed to parse JSON output', { error: e.message });
                    resolve(null);
                }
            } else {
                if (stderr && code !== 0) {
                    logger.debug('[yt-dlp] Search failed', { code, stderr: stderr.substring(0, 200) });
                }
                resolve(null);
            }
        });

        ytdlp.on('error', (err) => {
            clearTimeout(timeoutId);
            logger.error('[yt-dlp] Spawn error', { error: err.message });
            resolve(null);
        });
    });
}

/**
 * Clean up old TTS files from temp directory
 */
export function cleanupTTSFiles() {
    try {
        const files = fs.readdirSync(TTS_TEMP_DIR);
        const now = Date.now();
        let cleanedCount = 0;

        for (const file of files) {
            if (!file.startsWith(TTS_FILE_PREFIX)) continue;
            if (!file.endsWith('.wav')) continue;

            const filePath = path.join(TTS_TEMP_DIR, file);

            try {
                const stats = fs.statSync(filePath);
                const age = now - stats.mtimeMs;

                if (age > TTS_FILE_MAX_AGE) {
                    fs.unlinkSync(filePath);
                    cleanedCount++;
                    logger.debug('[TTS Cleanup] Deleted old file', { file, age: Math.round(age / 1000) + 's' });
                }
            } catch (err) {
                // File may have been deleted by another process
                if (err.code !== 'ENOENT') {
                    logger.warn('[TTS Cleanup] Error checking file', { file, error: err.message });
                }
            }
        }

        if (cleanedCount > 0) {
            logger.info('[TTS Cleanup] Cleaned up old files', { count: cleanedCount });
        }

        return cleanedCount;
    } catch (error) {
        logger.error('[TTS Cleanup] Error during cleanup', { error: error.message });
        return 0;
    }
}

/**
 * Delete a specific TTS file (call after playback)
 */
export function deleteTTSFile(filePath) {
    if (!filePath) return false;

    try {
        // Verify it's a TTS file in temp directory
        const fileName = path.basename(filePath);
        if (!fileName.startsWith(TTS_FILE_PREFIX) || !filePath.startsWith(TTS_TEMP_DIR)) {
            logger.warn('[TTS Cleanup] Refusing to delete non-TTS file', { path: filePath });
            return false;
        }

        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            logger.debug('[TTS Cleanup] Deleted file', { path: filePath });
            return true;
        }
    } catch (error) {
        logger.warn('[TTS Cleanup] Error deleting file', { path: filePath, error: error.message });
    }

    return false;
}

/**
 * Schedule TTS file for deletion after delay
 */
export function scheduleTTSCleanup(filePath, delayMs = 300000) {
    // Default 5 minute delay to ensure playback is complete
    setTimeout(() => {
        deleteTTSFile(filePath);
    }, delayMs);
}

/**
 * Start periodic TTS cleanup
 */
let ttsCleanupInterval = null;

export function startTTSCleanupScheduler(intervalMs = 600000) {
    // Run every 10 minutes by default
    if (ttsCleanupInterval) {
        clearInterval(ttsCleanupInterval);
    }

    // Initial cleanup
    cleanupTTSFiles();

    ttsCleanupInterval = setInterval(cleanupTTSFiles, intervalMs);
    logger.info('[TTS Cleanup] Scheduler started', { interval: intervalMs / 1000 + 's' });

    return ttsCleanupInterval;
}

export function stopTTSCleanupScheduler() {
    if (ttsCleanupInterval) {
        clearInterval(ttsCleanupInterval);
        ttsCleanupInterval = null;
        logger.info('[TTS Cleanup] Scheduler stopped');
    }
}

/**
 * Batch track queuing with partial failure handling
 * Returns results object with successful/failed arrays for each track
 */
export async function batchQueueTracks(tracks, player, queueOrChannel, options = {}) {
    const results = {
        successful: [],
        failed: [],
        total: tracks.length
    };

    const requestedBy = options.requestedBy || null;
    const searchEngine = options.searchEngine || 'ext:com.certifried.ytdlp-universal';
    const delayBetween = options.delayBetween || 100;
    const maxRetries = options.maxRetries || 2;

    for (const track of tracks) {
        let lastError = null;
        let success = false;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Search for the track
                const searchResult = await player.search(track.url || `${track.title} ${track.artist || ''}`, {
                    requestedBy,
                    searchEngine
                });

                if (searchResult?.tracks?.length > 0) {
                    const foundTrack = searchResult.tracks[0];

                    // Add to queue
                    if (typeof queueOrChannel.addTrack === 'function') {
                        queueOrChannel.addTrack(foundTrack);
                    } else {
                        // It's a channel, need to play
                        await player.play(queueOrChannel, searchResult, {
                            nodeOptions: options.nodeOptions
                        });
                    }

                    results.successful.push({
                        track: {
                            title: foundTrack.title,
                            url: foundTrack.url,
                            requestedTitle: track.title
                        },
                        attempts: attempt
                    });
                    success = true;
                    break;
                } else {
                    lastError = new Error('No results found');
                }
            } catch (error) {
                lastError = error;
                logger.debug('[BatchQueue] Attempt failed', {
                    track: track.title,
                    attempt,
                    error: error.message
                });

                // Add delay before retry
                if (attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, delayBetween * attempt));
                }
            }
        }

        if (!success) {
            results.failed.push({
                track: {
                    title: track.title,
                    url: track.url,
                    artist: track.artist
                },
                error: lastError?.message || 'Unknown error'
            });
        }

        // Add delay between tracks
        if (delayBetween > 0) {
            await new Promise(r => setTimeout(r, delayBetween));
        }
    }

    // Log summary
    logger.info('[BatchQueue] Track queuing complete', {
        successful: results.successful.length,
        failed: results.failed.length,
        total: results.total
    });

    return results;
}

export default {
    checkYtdlp,
    getYtdlpStatus,
    sanitizeSearchQuery,
    ytdlpSearch,
    cleanupTTSFiles,
    deleteTTSFile,
    scheduleTTSCleanup,
    startTTSCleanupScheduler,
    stopTTSCleanupScheduler,
    batchQueueTracks
};
