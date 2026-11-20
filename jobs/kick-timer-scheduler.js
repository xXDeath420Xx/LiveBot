/**
 * Timer (scheduled) messages: the Kick channel page timers and, since migration 456, the stream bot timers.
 * The minute cycle is core/stream-bot/timer-job.js runDueTimers (rotation, only while live, chat lines,
 * automations, Twitch through the CertiFried bot account). What follows is the original Kick description.
 *
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
import { kickBotProblem, kickBotRejectedMessage } from '../core/stream-bot/kick-scopes.js';

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
    // Same words as Stream bot > Connections ("Send chat messages and timers: needs permission") with the sign-in link.
    const problem = kickBotProblem(ch, 'chat:write');
    if (problem) { logger.warn('[KickTimers] Kick chat not sent', { channelId: String(channelId), problem: problem.message }); return false; }
    if (!ch.broadcasterId) return false;
    const res = await fetchImpl(`${KICK_API_BASE}/chat`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ch.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            broadcaster_user_id: parseInt(ch.broadcasterId, 10),
            content: String(content).slice(0, 500),
            type: 'bot'
        })
    });
    if (res?.status === 401) logger.warn('[KickTimers] Kick chat not sent', { channelId: String(channelId), problem: kickBotRejectedMessage() });
    return !!res?.ok;
}

async function runDueTimers() {
    try {
        const { runDueTimers: run } = await import('../core/stream-bot/timer-job.js');
        const r = await run({ pool, logger, sendKick: (channelId, text) => sendChannelMessage(String(channelId), text) });
        if (r?.sent) logger.info(`[KickTimers] Sent ${r.sent}/${r.due} due timer(s)`);
    } catch (error) {
        logger.error('[KickTimers] Cycle error', { error: error.message });
    }
}

/** The pre-456 cycle, kept for reference; timer-job.js falls back to the same query when the migration is missing. */
// eslint-disable-next-line no-unused-vars
async function runDueTimersLegacy() {
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
                const text = String(t.message || '').replace(/\{\{channel_name\}\}/g, () => t.channel_name || '');
                const ok = await sendChannelMessage(t.kick_channel_id, text);
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
