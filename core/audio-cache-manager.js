"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AudioCacheManager = void 0;
const fs_1 = require("fs");
const path = __importStar(require("path"));
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
const AUDIO_DIR = path.join(__dirname, '../temp_audio');
const MAX_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
class AudioCacheManager {
    constructor(client) {
        this.client = client;
        logger_1.default.info('[Cache Manager] Initializing...');
        this.cleanupInterval = setInterval(() => this.runCleanup(), 3600 * 1000);
        this.runCleanup();
    }
    getYouTubeVideoId(url) {
        if (!url)
            return null;
        try {
            const urlObj = new URL(url);
            if (urlObj.hostname === 'youtu.be') {
                return urlObj.pathname.slice(1);
            }
            if (urlObj.hostname.includes('youtube.com')) {
                const videoId = urlObj.searchParams.get('v');
                if (videoId)
                    return videoId;
            }
            const shortsMatch = urlObj.pathname.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
            if (shortsMatch) {
                return shortsMatch[1];
            }
        }
        catch (e) {
            logger_1.default.warn(`[Cache Manager] Could not parse URL for video ID: ${url}`, { error: e instanceof Error ? e.message : String(e) });
        }
        return null;
    }
    async getDirectorySize(dirPath) {
        let totalSize = 0;
        try {
            const files = await fs_1.promises.readdir(dirPath);
            for (const file of files) {
                try {
                    const filePath = path.join(dirPath, file);
                    const stats = await fs_1.promises.stat(filePath);
                    totalSize += stats.size;
                }
                catch (statError) {
                    logger_1.default.warn(`[Cache Manager] Could not stat file ${file}, skipping.`, { error: statError instanceof Error ? statError.message : String(statError) });
                }
            }
        }
        catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
                await fs_1.promises.mkdir(dirPath, { recursive: true });
            }
            else {
                logger_1.default.error('[Cache Manager] Error getting directory size:', { error: error instanceof Error ? error.stack : error });
            }
        }
        return totalSize;
    }
    async deleteAudioFile(songIdentifier) {
        const videoId = this.getYouTubeVideoId(songIdentifier);
        if (!videoId)
            return;
        const filePath = path.join(AUDIO_DIR, `${videoId}.opus`);
        try {
            await fs_1.promises.unlink(filePath);
            logger_1.default.info(`[Cache Cleanup] Deleted cached file: ${filePath}`);
        }
        catch (error) {
            if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
                logger_1.default.error(`[Cache Cleanup] Error deleting file ${filePath}:`, { error: error instanceof Error ? error.stack : error });
            }
        }
    }
    async runCleanup() {
        logger_1.default.info('[Cache Cleanup] Starting audio cache cleanup cycle...');
        let connection = null;
        try {
            connection = await db_1.default.getConnection();
            await connection.beginTransaction();
            const [metrics] = await connection.query(`
                SELECT song_id, song_identifier, total_plays, total_skips
                FROM music_song_metrics
            `);
            const alwaysSkipped = metrics.filter(m => m.total_plays === 0 && m.total_skips > 0);
            if (alwaysSkipped.length > 0) {
                logger_1.default.info(`[Cache Cleanup] Found ${alwaysSkipped.length} tracks that are always skipped.`);
                for (const song of alwaysSkipped) {
                    await this.deleteAudioFile(song.song_identifier);
                    await connection.query('DELETE FROM music_user_metrics WHERE song_id = ?', [song.song_id]);
                    await connection.query('DELETE FROM music_song_metrics WHERE song_id = ?', [song.song_id]);
                }
            }
            let currentSize = await this.getDirectorySize(AUDIO_DIR);
            if (currentSize < MAX_SIZE_BYTES) {
                logger_1.default.info(`[Cache Cleanup] Cache size (${(currentSize / (1024 * 1024)).toFixed(2)} MB) is within the 2GB limit.`);
                await connection.commit();
                return;
            }
            logger_1.default.info(`[Cache Cleanup] Cache size (${(currentSize / (1024 * 1024)).toFixed(2)} MB) exceeds 2GB limit. Starting cleanup...`);
            const allFiles = await fs_1.promises.readdir(AUDIO_DIR);
            let fileDetails = await Promise.all(allFiles.map(async (file) => {
                const videoId = path.parse(file).name;
                const filePath = path.join(AUDIO_DIR, file);
                try {
                    const stats = await fs_1.promises.stat(filePath);
                    const songMetrics = metrics.find(m => m.song_identifier && m.song_identifier.includes(videoId)) || { total_plays: 0, song_id: null };
                    return {
                        path: filePath,
                        song_id: songMetrics.song_id,
                        size: stats.size,
                        mtime: stats.mtime,
                        plays: parseInt(String(songMetrics.total_plays), 10),
                    };
                }
                catch (statError) {
                    logger_1.default.warn(`[Cache Cleanup] Could not process file ${file}, it might have been deleted during cleanup.`, { error: statError instanceof Error ? statError.message : String(statError) });
                    return null;
                }
            }));
            const filteredFileDetails = fileDetails.filter((f) => f !== null);
            let deletionCandidates = filteredFileDetails.filter(f => f.plays === 1).sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
            for (const file of deletionCandidates) {
                if (currentSize < MAX_SIZE_BYTES)
                    break;
                await fs_1.promises.unlink(file.path);
                currentSize -= file.size;
                if (file.song_id) {
                    await connection.query('DELETE FROM music_user_metrics WHERE song_id = ?', [file.song_id]);
                    await connection.query('DELETE FROM music_song_metrics WHERE song_id = ?', [file.song_id]);
                }
                logger_1.default.info(`[Cache Cleanup] Deleted (played once): ${file.path}`);
            }
            if (currentSize < MAX_SIZE_BYTES) {
                logger_1.default.info(`[Cache Cleanup] Cleanup complete. Final size: ${(currentSize / (1024 * 1024)).toFixed(2)} MB`);
                await connection.commit();
                return;
            }
            deletionCandidates = filteredFileDetails.sort((a, b) => {
                if (a.plays !== b.plays)
                    return a.plays - b.plays;
                return a.mtime.getTime() - b.mtime.getTime();
            });
            for (const file of deletionCandidates) {
                if (currentSize < MAX_SIZE_BYTES)
                    break;
                await fs_1.promises.unlink(file.path);
                currentSize -= file.size;
                if (file.song_id) {
                    await connection.query('DELETE FROM music_user_metrics WHERE song_id = ?', [file.song_id]);
                    await connection.query('DELETE FROM music_song_metrics WHERE song_id = ?', [file.song_id]);
                }
                logger_1.default.info(`[Cache Cleanup] Deleted (least played/oldest): ${file.path}`);
            }
            await connection.commit();
            logger_1.default.info(`[Cache Cleanup] Cleanup complete. Final size: ${(currentSize / (1024 * 1024)).toFixed(2)} MB`);
        }
        catch (error) {
            if (connection)
                await connection.rollback();
            logger_1.default.error('[Cache Cleanup] An error occurred during the cleanup cycle:', { error: error instanceof Error ? error.stack : error });
        }
        finally {
            if (connection)
                connection.release();
        }
    }
}
exports.AudioCacheManager = AudioCacheManager;
