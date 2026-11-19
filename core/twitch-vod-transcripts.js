/**
 * VOD transcript pipeline — unblocked by the local whisper.cpp servers on 8178 (fast,
 * ggml-base.en) and 8179 (accurate, ggml-small.en). yt-dlp pulls the VOD audio, ffmpeg
 * normalises to 16kHz mono WAV, we POST to the whisper endpoint, and the result is cached
 * in twitch_vod_transcripts.
 *
 * No external API cost. No GPU required — whisper.cpp runs on CPU with reasonable speed
 * on the small/base models. Disk footprint: ~1-5MB per hour of VOD audio, deleted after
 * transcription.
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import { createReadStream, promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import FormData from 'form-data';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const execAsync = promisify(exec);
const LOG = '[VODTranscript]';
const WHISPER_FAST = 'http://127.0.0.1:8178/inference';
const WHISPER_ACCURATE = 'http://127.0.0.1:8179/inference';
const SCRATCH_DIR = process.env.TWITCH_VOD_SCRATCH || '/tmp/certifried-vod';

async function ensureScratch() {
    await fs.mkdir(SCRATCH_DIR, { recursive: true });
}

/**
 * Transcribe a VOD. Called with the twitch_vods_catalog.video_id. Downloads audio only via
 * yt-dlp, normalises with ffmpeg, posts to the local whisper server. Writes to the
 * transcript table incrementally so the UI can show progress.
 */
export async function transcribeVOD(videoId, { model = 'fast', requestedBy = null } = {}) {
    const vid = String(videoId).replace(/[^\d]/g, '');
    if (!vid) return { ok: false, error: 'invalid video id' };

    // Fetch the VOD row for broadcaster + duration bound.
    const [[vod]] = await pool.execute(`SELECT video_id, broadcaster_id, duration_seconds FROM twitch_vods_catalog WHERE video_id = ?`, [vid]);
    if (!vod) return { ok: false, error: 'VOD not found in catalog' };

    // Cap at 4 hours to avoid runaway jobs on marathon streams. The 10-hour sessions WolfGangz
    // has would blow out the box if we tried to transcribe them all.
    if (vod.duration_seconds > 4 * 3600) {
        return { ok: false, error: `VOD exceeds 4-hour transcription cap (${Math.round(vod.duration_seconds / 60)} min)` };
    }

    // Mark pending → running.
    await pool.execute(
        `INSERT INTO twitch_vod_transcripts (video_id, broadcaster_id, status, whisper_model, requested_by_discord_id)
         VALUES (?, ?, 'running', ?, ?)
         ON DUPLICATE KEY UPDATE status = 'running', whisper_model = VALUES(whisper_model),
             requested_by_discord_id = VALUES(requested_by_discord_id), error_message = NULL`,
        [vid, vod.broadcaster_id, model, requestedBy]);

    await ensureScratch();
    const outAudio = path.join(SCRATCH_DIR, `vod-${vid}.wav`);
    const started = Date.now();

    try {
        // Step 1: yt-dlp to extract audio to a temp mp3 (then ffmpeg → 16kHz WAV).
        const twitchUrl = `https://www.twitch.tv/videos/${vid}`;
        logger.info(`${LOG} downloading audio for ${vid}`);
        await execAsync(
            `yt-dlp -f bestaudio -x --audio-format mp3 -o "${SCRATCH_DIR}/vod-${vid}.%(ext)s" "${twitchUrl}"`,
            { timeout: 25 * 60_000, maxBuffer: 1024 * 1024 * 32 });

        const inMp3 = path.join(SCRATCH_DIR, `vod-${vid}.mp3`);
        logger.info(`${LOG} normalising to 16kHz WAV`);
        await execAsync(
            `ffmpeg -y -i "${inMp3}" -ar 16000 -ac 1 -c:a pcm_s16le "${outAudio}"`,
            { timeout: 15 * 60_000 });
        await fs.unlink(inMp3).catch(() => {});

        // Step 2: POST to whisper (multipart). whisper.cpp /inference accepts file field.
        const endpoint = model === 'accurate' ? WHISPER_ACCURATE : WHISPER_FAST;
        logger.info(`${LOG} transcribing via ${endpoint}`);
        const form = new FormData();
        form.append('file', createReadStream(outAudio));
        form.append('response_format', 'json');
        form.append('temperature', '0');
        const res = await axios.post(endpoint, form, {
            headers: form.getHeaders(),
            timeout: 30 * 60_000,
            maxContentLength: 100 * 1024 * 1024,
            maxBodyLength: 100 * 1024 * 1024,
        });
        const transcriptText = res.data?.text || '';
        const segments = res.data?.segments || [];

        await pool.execute(
            `UPDATE twitch_vod_transcripts
                SET status = 'done',
                    transcript_text = ?, segments_json = ?,
                    audio_duration_seconds = ?, processing_duration_ms = ?,
                    completed_at = NOW(), error_message = NULL
              WHERE video_id = ?`,
            [transcriptText, JSON.stringify(segments),
             vod.duration_seconds, Date.now() - started, vid]);

        // Clean up audio file.
        await fs.unlink(outAudio).catch(() => {});

        logger.info(`${LOG} ${vid} transcribed (${transcriptText.length} chars, ${Date.now() - started}ms)`);
        return { ok: true, video_id: vid, text_length: transcriptText.length, duration_ms: Date.now() - started };
    } catch (err) {
        logger.error(`${LOG} ${vid} failed: ${err.message}`);
        await pool.execute(
            `UPDATE twitch_vod_transcripts SET status = 'failed', error_message = ? WHERE video_id = ?`,
            [err.message.slice(0, 500), vid]);
        await fs.unlink(outAudio).catch(() => {});
        return { ok: false, error: err.message };
    }
}

/** Return a cached transcript or null if not yet transcribed. */
export async function getTranscript(videoId) {
    const [[row]] = await pool.execute(`SELECT * FROM twitch_vod_transcripts WHERE video_id = ?`, [String(videoId).replace(/[^\d]/g, '')]);
    return row || null;
}

/** Full-text search over transcripts for a broadcaster. Returns matching VOD segments. */
export async function searchTranscripts(broadcasterId, query, { limit = 20 } = {}) {
    const q = String(query || '').trim();
    if (!q || q.length < 3) return { ok: false, error: 'query too short' };
    const [rows] = await pool.execute(
        `SELECT video_id, transcript_text FROM twitch_vod_transcripts
          WHERE broadcaster_id = ? AND status = 'done' AND transcript_text LIKE ? LIMIT ?`,
        [String(broadcasterId), `%${q}%`, limit * 3]);
    const results = [];
    for (const r of rows) {
        const text = r.transcript_text || '';
        const needleIdx = text.toLowerCase().indexOf(q.toLowerCase());
        if (needleIdx === -1) continue;
        const start = Math.max(0, needleIdx - 60);
        const end = Math.min(text.length, needleIdx + q.length + 60);
        results.push({
            video_id: r.video_id,
            snippet: (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : ''),
            match_offset: needleIdx,
        });
        if (results.length >= limit) break;
    }
    return { ok: true, results };
}
