
const fs = require('fs/promises');
const path = require('path');
const db = require('../utils/db');
const logger = require('../utils/logger');

const AUDIO_DIR = path.join(__dirname, '../temp_audio');
const MAX_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

class AudioCacheManager {
    constructor(client) {
        this.client = client;
        logger.info('[Cache Manager] Initializing...');
        this.cleanupInterval = setInterval(() => this.runCleanup(), 3600 * 1000);
        this.runCleanup();
    }

    getYouTubeVideoId(url) {
        if (!url) return null;
        try {
            const urlObj = new URL(url);
            if (urlObj.hostname === 'youtu.be') {
                return urlObj.pathname.slice(1);
            }
            if (urlObj.hostname.includes('youtube.com')) {
                const videoId = urlObj.searchParams.get('v');
                if (videoId) return videoId;
            }
            const shortsMatch = urlObj.pathname.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
            if (shortsMatch) {
                return shortsMatch[1];
            }
        } catch (e) {
            logger.warn(`[Cache Manager] Could not parse URL for video ID: ${url}`, e.message);
        }
        return null;
    }

    async getDirectorySize(dirPath) {
        let totalSize = 0;
        try {
            const files = await fs.readdir(dirPath);
            for (const file of files) {
                try {
                    const filePath = path.join(dirPath, file);
                    const stats = await fs.stat(filePath);
                    totalSize += stats.size;
                } catch (statError) {
                    logger.warn(`[Cache Manager] Could not stat file ${file}, skipping.`, statError.message);
                }
            }
        } catch (error) {
            if (error.code === 'ENOENT') {
                await fs.mkdir(dirPath, { recursive: true });
            } else {
                logger.error('[Cache Manager] Error getting directory size:', error);
            }
        }
        return totalSize;
    }

    async deleteAudioFile(songIdentifier) {
        const videoId = this.getYouTubeVideoId(songIdentifier);
        if (!videoId) return;

        const filePath = path.join(AUDIO_DIR, `${videoId}.opus`);
        try {
            await fs.unlink(filePath);
            logger.info(`[Cache Cleanup] Deleted cached file: ${filePath}`);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                logger.error(`[Cache Cleanup] Error deleting file ${filePath}:`, error);
            }
        }
    }

    async runCleanup() {
        logger.info('[Cache Cleanup] Starting audio cache cleanup cycle...');
        let connection;
        try {
            connection = await db.getConnection();
            await connection.beginTransaction();

            const [metrics] = await connection.query(`
                SELECT song_id, song_identifier, total_plays, total_skips
                FROM music_song_metrics
            `);

            const alwaysSkipped = metrics.filter(m => m.total_plays === 0 && m.total_skips > 0);
            if (alwaysSkipped.length > 0) {
                logger.info(`[Cache Cleanup] Found ${alwaysSkipped.length} tracks that are always skipped.`);
                for (const song of alwaysSkipped) {
                    await this.deleteAudioFile(song.song_identifier);
                    await connection.query('DELETE FROM music_user_metrics WHERE song_id = ?', [song.song_id]);
                    await connection.query('DELETE FROM music_song_metrics WHERE song_id = ?', [song.song_id]);
                }
            }

            let currentSize = await this.getDirectorySize(AUDIO_DIR);
            if (currentSize < MAX_SIZE_BYTES) {
                logger.info(`[Cache Cleanup] Cache size (${(currentSize / (1024*1024)).toFixed(2)} MB) is within the 2GB limit.`);
                await connection.commit();
                return;
            }

            logger.info(`[Cache Cleanup] Cache size (${(currentSize / (1024*1024)).toFixed(2)} MB) exceeds 2GB limit. Starting cleanup...`);

            const allFiles = await fs.readdir(AUDIO_DIR);
            let fileDetails = await Promise.all(allFiles.map(async file => {
                const videoId = path.parse(file).name;
                const filePath = path.join(AUDIO_DIR, file);
                try {
                    const stats = await fs.stat(filePath);
                    const songMetrics = metrics.find(m => m.song_identifier && m.song_identifier.includes(videoId)) || { total_plays: 0, song_id: null };
                    return {
                        path: filePath,
                        song_id: songMetrics.song_id,
                        size: stats.size,
                        mtime: stats.mtime,
                        plays: parseInt(songMetrics.total_plays, 10),
                    };
                } catch (statError) {
                    logger.warn(`[Cache Cleanup] Could not process file ${file}, it might have been deleted during cleanup.`, statError.message);
                    return null;
                }
            }));
            
            fileDetails = fileDetails.filter(f => f !== null);

            let deletionCandidates = fileDetails.filter(f => f.plays === 1).sort((a, b) => a.mtime - b.mtime);

            for (const file of deletionCandidates) {
                if (currentSize < MAX_SIZE_BYTES) break;
                await fs.unlink(file.path);
                currentSize -= file.size;
                if (file.song_id) {
                    await connection.query('DELETE FROM music_user_metrics WHERE song_id = ?', [file.song_id]);
                    await connection.query('DELETE FROM music_song_metrics WHERE song_id = ?', [file.song_id]);
                }
                logger.info(`[Cache Cleanup] Deleted (played once): ${file.path}`);
            }

            if (currentSize < MAX_SIZE_BYTES) {
                 logger.info(`[Cache Cleanup] Cleanup complete. Final size: ${(currentSize / (1024*1024)).toFixed(2)} MB`);
                 await connection.commit();
                 return;
            }

            deletionCandidates = fileDetails.sort((a, b) => {
                if (a.plays !== b.plays) return a.plays - b.plays;
                return a.mtime - b.mtime;
            });

            for (const file of deletionCandidates) {
                if (currentSize < MAX_SIZE_BYTES) break;
                await fs.unlink(file.path);
                currentSize -= file.size;
                if (file.song_id) {
                    await connection.query('DELETE FROM music_user_metrics WHERE song_id = ?', [file.song_id]);
                    await connection.query('DELETE FROM music_song_metrics WHERE song_id = ?', [file.song_id]);
                }
                logger.info(`[Cache Cleanup] Deleted (least played/oldest): ${file.path}`);
            }

            await connection.commit();
            logger.info(`[Cache Cleanup] Cleanup complete. Final size: ${(currentSize / (1024*1024)).toFixed(2)} MB`);

        } catch (error) {
            if (connection) await connection.rollback();
            logger.error('[Cache Cleanup] An error occurred during the cleanup cycle:', error);
        } finally {
            if (connection) connection.release();
        }
    }
}

module.exports = AudioCacheManager;
