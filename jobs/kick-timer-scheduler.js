/**
 * Per-channel timer (scheduled) messages for the Kick bot.
 *
 * Every minute, find enabled timers whose interval has elapsed for a channel
 * whose defender/bot is active, and post the message to Kick chat using the
 * channel owner's token (resolveChannel → broadcasterId + token). Sending by
 * broadcaster id via the official /chat endpoint does NOT require the bot to be
 * actively joined, so timers work regardless of websocket state.
 */
import cron from 'node-cron';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { resolveChannel } from '../services/certifried-bot/defender/channel-tokens.js';

const KICK_API_BASE = 'https://api.kick.com/public/v1';
let task = null;

/**
 * Post a message to a Kick channel as the bot, using the owner's token.
 * Returns true on success. Pure-ish: takes the resolveChannel + fetch as deps
 * for testability.
 */
export async function sendChannelMessage(channelId, content, deps = {}) {
    const resolve = deps.resolveChannel || resolveChannel;
    const fetchImpl = deps.fetchImpl || fetch;
    const ch = await resolve(channelId);
    if (!ch || !ch.token || !ch.broadcasterId) return false;
    const res = await fetchImpl(`${KICK_API_BASE}/chat`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ch.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            broadcaster_user_id: parseInt(ch.broadcasterId, 10),
            content: String(content).slice(0, 500),
            type: 'bot'
        })
    });
    return !!res?.ok;
}

async function runDueTimers() {
    try {
        // Due = enabled timer whose interval has elapsed (or never sent), on a
        // channel that is enrolled (defender_enabled) and enabled. We compare in
        // SQL against last_sent_at so a restart doesn't reset the clock.
        const [rows] = await pool.execute(`
            SELECT t.id, t.channel_id, t.message, t.interval_min, c.channel_id AS kick_channel_id, c.channel_name
            FROM tokes_timers t
            JOIN tokes_channels c ON c.id = t.channel_id
            WHERE t.is_enabled = 1
              AND c.platform = 'kick'
              AND c.is_enabled = 1
              AND c.defender_enabled = 1
              AND (t.last_sent_at IS NULL
                   OR t.last_sent_at <= (NOW() - INTERVAL t.interval_min MINUTE))
        `);
        if (!rows.length) return;

        let sent = 0;
        for (const t of rows) {
            try {
                const ok = await sendChannelMessage(t.kick_channel_id, t.message);
                if (ok) {
                    await pool.execute(
                        'UPDATE tokes_timers SET last_sent_at = NOW(), send_count = send_count + 1 WHERE id = ?',
                        [t.id]
                    );
                    sent++;
                } else {
                    logger.warn('[KickTimers] Send failed', { timerId: t.id, channel: t.channel_name });
                }
            } catch (err) {
                logger.warn('[KickTimers] Timer error', { timerId: t.id, error: err.message });
            }
        }
        if (sent) logger.info(`[KickTimers] Sent ${sent}/${rows.length} due timer message(s)`);
    } catch (error) {
        logger.error('[KickTimers] Cycle error', { error: error.message });
    }
}

export function startKickTimerScheduler() {
    if (task) { logger.warn('[KickTimers] Scheduler already running'); return; }
    task = cron.schedule('* * * * *', () => { runDueTimers(); }); // every minute
    logger.info('[KickTimers] Scheduler started (every minute)');
}

export function stopKickTimerScheduler() {
    if (task) { task.stop(); task = null; logger.info('[KickTimers] Scheduler stopped'); }
}

export default { startKickTimerScheduler, stopKickTimerScheduler };
