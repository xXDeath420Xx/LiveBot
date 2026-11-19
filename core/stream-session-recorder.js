/*
 * Stream session history: one stream_uptime row per broadcast (start, end, duration, peak
 * viewers, last title/game), fed by core/stream-manager.js's live/offline observations.
 *
 * A session is per channel (platform + username), not per guild or per bot: the stream check runs
 * once per bot client and several clients can see the same streamer in one cycle. The open row is
 * keyed by stream_uptime.open_key (UNIQUE while open, NULL once closed), so concurrent sightings
 * collapse into one row, and an in-memory map keeps the offline path free of queries for the
 * hundreds of streamers who are not live.
 *
 * Restart-safe: open sessions are reloaded from the table on first use, a stream that is still
 * live simply keeps its row, and closeStaleSessions() closes anything no longer seen (bot was
 * down, streamer untracked mid-stream). The recorded end is always the last LIVE sighting, so a
 * late close does not inflate the duration.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import {
    OFFLINE_CLOSE_MS, STALE_SESSION_MS, REOPEN_MATCH_MS, WRITE_THROTTLE_MS,
    sessionKey, parseStartedAt, isNewBroadcast, shouldClose, viewerCount, clampText,
} from './stream-session-logic.js';

/** open_key -> { id, startMs, lastSeenMs, lastWriteMs, peak, title, game } */
const openSessions = new Map();
let loaded = false;
let loading = null;

function toMs(v) {
    if (v == null) return NaN;
    const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
    return Number.isFinite(t) ? t : NaN;
}

async function ensureLoaded() {
    if (loaded) return;
    if (!loading) {
        loading = (async () => {
            const [rows] = await pool.execute(
                'SELECT id, open_key, stream_start, last_seen_at, peak_viewers, title, game FROM stream_uptime WHERE open_key IS NOT NULL'
            );
            for (const r of rows) {
                openSessions.set(r.open_key, {
                    id: r.id,
                    startMs: toMs(r.stream_start),
                    lastSeenMs: Number.isFinite(toMs(r.last_seen_at)) ? toMs(r.last_seen_at) : toMs(r.stream_start),
                    lastWriteMs: 0,
                    peak: r.peak_viewers,
                    title: r.title,
                    game: r.game,
                });
            }
            loaded = true;
        })().finally(() => { loading = null; });
    }
    await loading;
}

async function closeSession(key, state, endMs = null) {
    const end = Number.isFinite(endMs) ? new Date(endMs) : null;
    await pool.execute(
        `UPDATE stream_uptime
            SET stream_end = COALESCE(?, last_seen_at, stream_start),
                duration_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, stream_start, COALESCE(?, last_seen_at, stream_start))),
                open_key = NULL
          WHERE id = ? AND open_key = ?`,
        [end, end, state.id, key]
    );
    openSessions.delete(key);
}

/**
 * A closed session of the same broadcast (same channel, start within REOPEN_MATCH_MS, ended in the
 * last few hours) is reopened instead of starting a duplicate — that is what a long platform outage
 * or the stale sweep looks like when the stream turns out to still be running.
 */
async function reopenIfSameBroadcast(key, platform, username, reportedStartMs) {
    if (!Number.isFinite(reportedStartMs)) return null;
    const [rows] = await pool.execute(
        `SELECT id, stream_start, peak_viewers, title, game FROM stream_uptime
          WHERE platform = ? AND username = ? AND open_key IS NULL
            AND stream_start BETWEEN ? AND ?
            AND stream_end >= DATE_SUB(NOW(), INTERVAL 6 HOUR)
          ORDER BY stream_start DESC LIMIT 1`,
        [platform, username, new Date(reportedStartMs - REOPEN_MATCH_MS), new Date(reportedStartMs + REOPEN_MATCH_MS)]
    );
    const row = rows[0];
    if (!row) return null;
    const [result] = await pool.execute(
        'UPDATE stream_uptime SET open_key = ?, stream_end = NULL, duration_seconds = NULL, last_seen_at = NOW() WHERE id = ? AND open_key IS NULL',
        [key, row.id]
    ).catch((err) => {
        if (err.code === 'ER_DUP_ENTRY') return [{ affectedRows: 0 }]; // another sighting opened one first
        throw err;
    });
    if (!result.affectedRows) return null;
    return { id: row.id, startMs: toMs(row.stream_start), peak: row.peak_viewers, title: row.title, game: row.game };
}

/**
 * Record one live/offline observation of a streamer. Never throws into the stream check.
 * @param {{ streamer_id, platform, username }} streamer
 * @param {boolean} isLive
 * @param {object|null} streamData  platform details (started_at, viewer_count, title, game_name)
 */
export async function recordObservation(streamer, isLive, streamData = null) {
    try {
        if (!streamer?.platform || !streamer?.username) return;
        await ensureLoaded();

        const key = sessionKey(streamer.platform, streamer.username);
        const now = Date.now();
        let state = openSessions.get(key);

        if (!isLive) {
            if (state && shouldClose({ lastSeenMs: state.lastSeenMs, nowMs: now })) {
                await closeSession(key, state);
                logger.info(`[StreamHistory] Session closed for ${streamer.username} (${streamer.platform})`, { category: 'streams' });
            }
            return;
        }

        const reported = parseStartedAt(streamData?.started_at, now);
        if (state && reported != null && isNewBroadcast({ openStartMs: state.startMs, reportedStartMs: reported })) {
            // Ended and restarted between two checks: close the old one at its last sighting.
            await closeSession(key, state, Math.min(state.lastSeenMs, reported));
            state = null;
        }

        const viewers = viewerCount(streamData);
        const title = clampText(streamData?.title);
        const game = clampText(streamData?.game_name ?? streamData?.game);

        if (state) {
            state.lastSeenMs = now;
            const changed = (viewers != null && viewers > (state.peak ?? -1)) || title !== state.title || game !== state.game;
            if (!changed && now - state.lastWriteMs < WRITE_THROTTLE_MS) return;
        } else {
            const reopened = await reopenIfSameBroadcast(key, streamer.platform, streamer.username, reported);
            if (reopened) {
                state = { ...reopened, lastSeenMs: now, lastWriteMs: 0 };
                openSessions.set(key, state);
            }
        }

        const startMs = state?.startMs ?? reported ?? now;
        const [result] = await pool.execute(
            `INSERT INTO stream_uptime
                (streamer_id, platform, username, stream_start, last_seen_at, peak_viewers, title, game, open_key)
             VALUES (?, ?, ?, ?, NOW(), ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                id = LAST_INSERT_ID(id),
                last_seen_at = NOW(),
                peak_viewers = CASE WHEN VALUES(peak_viewers) IS NULL THEN peak_viewers
                                    ELSE GREATEST(COALESCE(peak_viewers, 0), VALUES(peak_viewers)) END,
                title = COALESCE(VALUES(title), title),
                game = COALESCE(VALUES(game), game)`,
            [streamer.streamer_id, streamer.platform, streamer.username, new Date(startMs), viewers, title, game, key]
        );

        const isNew = !state;
        state = {
            id: result.insertId || state?.id,
            startMs,
            lastSeenMs: now,
            lastWriteMs: now,
            peak: viewers != null ? Math.max(viewers, state?.peak ?? 0) : (state?.peak ?? null),
            title: title ?? state?.title ?? null,
            game: game ?? state?.game ?? null,
        };
        openSessions.set(key, state);
        if (isNew) {
            logger.info(`[StreamHistory] Session opened for ${streamer.username} (${streamer.platform})`, {
                category: 'streams', startedAt: new Date(startMs).toISOString(),
            });
        }
    } catch (err) {
        logger.error(`[StreamHistory] Failed to record observation for ${streamer?.username}: ${err.message}`, {
            category: 'streams', platform: streamer?.platform,
        });
    }
}

/** Close sessions with no live sighting for STALE_SESSION_MS. Called from the stream cycle setup. */
export async function closeStaleSessions() {
    try {
        await ensureLoaded();
        const [result] = await pool.execute(
            `UPDATE stream_uptime
                SET stream_end = COALESCE(last_seen_at, stream_start),
                    duration_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, stream_start, COALESCE(last_seen_at, stream_start))),
                    open_key = NULL
              WHERE open_key IS NOT NULL
                AND COALESCE(last_seen_at, stream_start) < DATE_SUB(NOW(), INTERVAL ${Math.round(STALE_SESSION_MS / 60_000)} MINUTE)`
        );
        const cutoff = Date.now() - STALE_SESSION_MS;
        for (const [key, state] of openSessions) {
            if (state.lastSeenMs < cutoff) openSessions.delete(key);
        }
        if (result.affectedRows) {
            logger.info(`[StreamHistory] Closed ${result.affectedRows} stale session(s)`, { category: 'streams' });
        }
    } catch (err) {
        logger.error(`[StreamHistory] Stale session sweep failed: ${err.message}`, { category: 'streams' });
    }
}

export { OFFLINE_CLOSE_MS };
export default { recordObservation, closeStaleSessions };
