import { promises as fs } from 'fs';
import * as path from 'path';
import { ExtendedClient } from '../types';
import db from '../utils/db';
import logger from '../utils/logger';
import { PoolConnection, RowDataPacket } from 'mysql2/promise';

const AUDIO_DIR = path.join(__dirname, '../temp_audio');
const MAX_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

interface SongMetrics extends RowDataPacket {
    song_id: number;
    song_identifier: string;
    total_plays: number;
    total_skips: number;
}

interface FileDetail {
    path: string;
    song_id: number | null;
    size: number;
    mtime: Date;
    plays: number;
}

export class AudioCacheManager {
    private client: ExtendedClient;
    private cleanupInterval: NodeJS.Timeout;

    constructor(client: ExtendedClient) {
        this._client = client;
        logger.info('[Cache Manager] Initializing...');
        this.cleanupInterval = setInterval(() => this.runCleanup(), 3600 * 1000);
        this.runCleanup();
    }

    getYouTubeVideoId(url: string | null): string | null {
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
        } catch (e: unknown) {
            logger.warn(`[Cache Manager] Could not parse URL for video ID: ${url}`, { error: e instanceof Error ? e.message : String(e) });
        }
        return null;
    }

    async getDirectorySize(dirPath: string): Promise<number> {
        let totalSize = 0;
        try {
            const files = await fs.readdir(dirPath);
            for (const file of files) {
                try {
                    const filePath = path.join(dirPath, file);
                    const stats = await fs.stat(filePath);
                    totalSize += stats.size;
                } catch (statError: unknown) {
                    logger.warn(`[Cache Manager] Could not stat file ${file}, skipping.`, { error: statError instanceof Error ? statError.message : String(statError) });
                }
            }
        } catch (error: unknown) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
                await fs.mkdir(dirPath, { recursive: true });
            } else {
                logger.error('[Cache Manager] Error getting directory size:', { error: error instanceof Error ? error.stack : error });
            }
        }
        return totalSize;
    }

    async deleteAudioFile(songIdentifier: string): Promise<void> {
        const videoId = this.getYouTubeVideoId(songIdentifier);
        if (!videoId) return;

        const filePath = path.join(AUDIO_DIR, `${videoId}.opus`);
        try {
            await fs.unlink(filePath);
            logger.info(`[Cache Cleanup] Deleted cached file: ${filePath}`);
        } catch (error: unknown) {
            if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
                logger.error(`[Cache Cleanup] Error deleting file ${filePath}:`, { error: error instanceof Error ? error.stack : error });
            }
        }
    }

    async runCleanup(): Promise<void> {
        logger.info('[Cache Cleanup] Starting audio cache cleanup cycle...');
        let connection: PoolConnection | null = null;
        try {
            connection = await db.getConnection();
            await connection.beginTransaction();

            const [metrics] = await connection.query<SongMetrics[]>(`
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
            let fileDetails: (FileDetail | null)[] = await Promise.all(allFiles.map(async (file): Promise<FileDetail | null> => {
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
                        plays: parseInt(String(songMetrics.total_plays), 10),
                    };
                } catch (statError: unknown) {
                    logger.warn(`[Cache Cleanup] Could not process file ${file}, it might have been deleted during cleanup.`, { error: statError instanceof Error ? statError.message : String(statError) });
                    return null;
                }
            }));

            const filteredFileDetails = fileDetails.filter((f): f is FileDetail => f !== null);

            let deletionCandidates = filteredFileDetails.filter(f => f.plays === 1).sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

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

            deletionCandidates = filteredFileDetails.sort((a, b) => {
                if (a.plays !== b.plays) return a.plays - b.plays;
                return a.mtime.getTime() - b.mtime.getTime();
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

        } catch (error: unknown) {
            if (connection) await connection.rollback();
            logger.error('[Cache Cleanup] An error occurred during the cleanup cycle:', { error: error instanceof Error ? error.stack : error });
        } finally {
            if (connection) connection.release();
        }
    }
}
