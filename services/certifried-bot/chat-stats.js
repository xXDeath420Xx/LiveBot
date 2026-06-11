/**
 * Buffered per-channel daily chat counters. countMessage() is a pure in-memory
 * increment (zero DB cost per message); a 60s flusher upserts the buffered
 * counts into tokes_chat_daily. Losing ≤60s of counts on a crash is acceptable
 * for engagement analytics.
 */
import realPool from '../../utils/db.js';
import logger from '../../utils/logger.js';

const buffer = new Map(); // channelPk -> count
let flushTimer = null;

export function countMessage(channelPk) {
    if (channelPk == null) return;
    const key = Number(channelPk);
    buffer.set(key, (buffer.get(key) || 0) + 1);
    if (!flushTimer) {
        flushTimer = setInterval(flushChatCounts, 60_000);
        if (flushTimer.unref) flushTimer.unref(); // never keep the process alive
    }
}

export async function flushChatCounts(pool = realPool) {
    if (!buffer.size) return;
    const entries = [...buffer.entries()];
    buffer.clear();
    for (const [channelPk, count] of entries) {
        try {
            await pool.execute(
                `INSERT INTO tokes_chat_daily (channel_id, date, messages) VALUES (?, CURDATE(), ?)
                 ON DUPLICATE KEY UPDATE messages = messages + VALUES(messages)`,
                [channelPk, count]
            );
        } catch (err) {
            logger.warn('[ChatStats] flush failed', { channelPk, error: err.message });
        }
    }
}

/** 14-day (default) zero-filled messages-per-day series for a channel PK. */
export function makeChatTrend({ pool }) {
    return async function chatTrend(channelPk, days = 14, todayIso) {
        const n = Math.min(Math.max(parseInt(days, 10) || 14, 1), 90);
        const [rows] = await pool.execute(
            `SELECT date, messages FROM tokes_chat_daily
             WHERE channel_id = ? AND date >= (CURDATE() - INTERVAL ? DAY)`,
            [Number(channelPk), n - 1]
        );
        const byDate = new Map(rows.map(r => [
            (r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10)),
            Number(r.messages)
        ]));
        const end = new Date((todayIso || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z');
        const out = [];
        for (let i = n - 1; i >= 0; i--) {
            const d = new Date(end);
            d.setUTCDate(d.getUTCDate() - i);
            const iso = d.toISOString().slice(0, 10);
            out.push({ date: iso, messages: byDate.get(iso) || 0 });
        }
        return out;
    };
}

export const chatTrend = makeChatTrend({ pool: realPool });
