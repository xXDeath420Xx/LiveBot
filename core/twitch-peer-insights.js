/**
 * Twitch peer insights — cross-tenant comparison with privacy constraints.
 *
 * NEVER returns another broadcaster's identifying data to a caller. The only data a
 * broadcaster sees about their peers is:
 *   - Aggregates (median, p25, p75)
 *   - Their own percentile within the bucket
 *   - "based on N peer channels" where N ≥ 5 (otherwise returns `hidden`)
 *
 * This module is callable only when the broadcaster has `ai_peer_pool_optin = 1`
 * (reciprocal rule — contribute to see).
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const LOG = '[PeerInsights]';
const MIN_BUCKET_SIZE = 5;

/** Compute the follower-count bucket for a broadcaster. */
export function bucketForFollowers(count) {
    const n = Number(count) || 0;
    if (n < 100) return 'small';
    if (n < 1000) return 'mid';
    if (n < 10000) return 'big';
    return 'mega';
}

/** Daily cron: snapshot aggregate stats per bucket. Called from twitch-analytics-cron.js. */
export async function rebuildPeerBuckets() {
    const day = new Date().toISOString().slice(0, 10);
    logger.info(`${LOG} rebuild peer buckets for ${day}`);

    // Pull the set of broadcasters currently opted in.
    const [opted] = await pool.query(
        `SELECT c.broadcaster_id,
                b.follower_count, b.subscriber_count, b.bits_total_period,
                (SELECT COALESCE(SUM(duration_minutes), 0) FROM twitch_stream_sessions s
                  WHERE s.broadcaster_id = c.broadcaster_id COLLATE utf8mb4_unicode_ci AND s.started_at > DATE_SUB(NOW(), INTERVAL 7 DAY)) AS mins_7d,
                (SELECT COALESCE(MAX(peak_viewers), 0) FROM twitch_stream_sessions s
                  WHERE s.broadcaster_id = c.broadcaster_id COLLATE utf8mb4_unicode_ci AND s.started_at > DATE_SUB(NOW(), INTERVAL 7 DAY)) AS peak_7d,
                (SELECT COALESCE(SUM(total_msgs), 0) FROM twitch_stream_sessions s
                  WHERE s.broadcaster_id = c.broadcaster_id COLLATE utf8mb4_unicode_ci AND s.started_at > DATE_SUB(NOW(), INTERVAL 7 DAY)) AS msgs_7d
           FROM twitch_analytics_alerts_config c
           LEFT JOIN twitch_broadcaster_backfill b
                 ON b.broadcaster_id = c.broadcaster_id COLLATE utf8mb4_unicode_ci
          WHERE c.ai_peer_pool_optin = 1 AND c.broadcaster_id IS NOT NULL`);

    // Group by bucket.
    const buckets = { small: [], mid: [], big: [], mega: [] };
    for (const b of opted) {
        const bk = bucketForFollowers(b.follower_count);
        buckets[bk].push(b);
    }

    const quantile = (arr, p) => {
        if (!arr.length) return null;
        const sorted = arr.slice().sort((a, b) => a - b);
        const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * p)));
        return sorted[idx];
    };
    const median = (arr) => quantile(arr, 0.5);

    for (const [name, members] of Object.entries(buckets)) {
        const followers = members.map(m => Number(m.follower_count) || 0);
        const subs = members.map(m => Number(m.subscriber_count) || 0);
        const hours = members.map(m => (Number(m.mins_7d) || 0) / 60);
        const peaks = members.map(m => Number(m.peak_7d) || 0);
        const msgs = members.map(m => Number(m.msgs_7d) || 0);
        const bits = members.map(m => Number(m.bits_total_period) || 0);
        await pool.execute(
            `INSERT INTO twitch_peer_bucket_snapshots
             (bucket, day, member_count, median_follower_count, median_sub_count, median_hours_live_7d,
              median_peak_viewers_7d, median_msgs_7d, median_bits_total,
              p25_peak_viewers_7d, p75_peak_viewers_7d, p25_follower_count, p75_follower_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                 member_count = VALUES(member_count),
                 median_follower_count = VALUES(median_follower_count),
                 median_sub_count = VALUES(median_sub_count),
                 median_hours_live_7d = VALUES(median_hours_live_7d),
                 median_peak_viewers_7d = VALUES(median_peak_viewers_7d),
                 median_msgs_7d = VALUES(median_msgs_7d),
                 median_bits_total = VALUES(median_bits_total),
                 p25_peak_viewers_7d = VALUES(p25_peak_viewers_7d),
                 p75_peak_viewers_7d = VALUES(p75_peak_viewers_7d),
                 p25_follower_count = VALUES(p25_follower_count),
                 p75_follower_count = VALUES(p75_follower_count)`,
            [name, day, members.length,
             median(followers), median(subs), median(hours),
             median(peaks), median(msgs), median(bits),
             quantile(peaks, 0.25), quantile(peaks, 0.75),
             quantile(followers, 0.25), quantile(followers, 0.75)]);

        // Per-broadcaster percentile log — reveals their own rank, not peers'.
        for (const m of members) {
            const pct = (vals, mine) => {
                if (!vals.length) return null;
                const below = vals.filter(v => v < mine).length;
                return Math.round((below / vals.length) * 1000) / 10;
            };
            await pool.execute(
                `INSERT INTO twitch_peer_bucket_log
                 (broadcaster_id, bucket, day, follower_percentile, sub_percentile,
                  hours_live_percentile, peak_viewers_percentile, msgs_percentile, bits_percentile)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                     bucket = VALUES(bucket),
                     follower_percentile = VALUES(follower_percentile),
                     sub_percentile = VALUES(sub_percentile),
                     hours_live_percentile = VALUES(hours_live_percentile),
                     peak_viewers_percentile = VALUES(peak_viewers_percentile),
                     msgs_percentile = VALUES(msgs_percentile),
                     bits_percentile = VALUES(bits_percentile)`,
                [m.broadcaster_id, name, day,
                 pct(followers, Number(m.follower_count) || 0),
                 pct(subs, Number(m.subscriber_count) || 0),
                 pct(hours, (Number(m.mins_7d) || 0) / 60),
                 pct(peaks, Number(m.peak_7d) || 0),
                 pct(msgs, Number(m.msgs_7d) || 0),
                 pct(bits, Number(m.bits_total_period) || 0)]);
        }
    }
    logger.info(`${LOG} buckets rebuilt`);
}

/**
 * Fetch peer context for a broadcaster. Returns null if not opted in OR bucket < k.
 * Shape: { bucket, member_count, medians: {...}, percentiles: {...} }
 */
export async function getPeerContext(broadcasterId) {
    const [[cfg]] = await pool.execute(
        `SELECT ai_peer_pool_optin FROM twitch_analytics_alerts_config WHERE broadcaster_id = ? LIMIT 1`,
        [String(broadcasterId)]);
    if (!cfg?.ai_peer_pool_optin) return null;

    const day = new Date().toISOString().slice(0, 10);
    const [[log]] = await pool.execute(
        `SELECT * FROM twitch_peer_bucket_log WHERE broadcaster_id = ? AND day = ? LIMIT 1`,
        [String(broadcasterId), day]);
    if (!log) return null;

    const [[bucket]] = await pool.execute(
        `SELECT * FROM twitch_peer_bucket_snapshots WHERE bucket = ? AND day = ? LIMIT 1`,
        [log.bucket, day]);
    if (!bucket) return null;

    if (Number(bucket.member_count) < MIN_BUCKET_SIZE) {
        return { hidden: true, reason: 'bucket < k', k: MIN_BUCKET_SIZE, your_bucket: log.bucket };
    }

    return {
        bucket: log.bucket,
        member_count: bucket.member_count,
        medians: {
            follower: bucket.median_follower_count,
            sub: bucket.median_sub_count,
            hours_live_7d: Number(bucket.median_hours_live_7d),
            peak_viewers_7d: bucket.median_peak_viewers_7d,
            msgs_7d: bucket.median_msgs_7d,
            bits_total: bucket.median_bits_total,
        },
        p25: { peak_viewers_7d: bucket.p25_peak_viewers_7d, follower: bucket.p25_follower_count },
        p75: { peak_viewers_7d: bucket.p75_peak_viewers_7d, follower: bucket.p75_follower_count },
        your_percentiles: {
            follower: Number(log.follower_percentile),
            sub: Number(log.sub_percentile),
            hours_live: Number(log.hours_live_percentile),
            peak_viewers: Number(log.peak_viewers_percentile),
            msgs: Number(log.msgs_percentile),
            bits: Number(log.bits_percentile),
        },
    };
}

/**
 * Opt in or out of the peer pool.
 */
export async function setOptIn(broadcasterId, enabled) {
    await pool.execute(
        `UPDATE twitch_analytics_alerts_config
            SET ai_peer_pool_optin = ?,
                ai_peer_pool_optin_at = IF(? = 1, NOW(), ai_peer_pool_optin_at)
          WHERE broadcaster_id = ?`,
        [enabled ? 1 : 0, enabled ? 1 : 0, String(broadcasterId)]);
    if (!enabled) {
        // Delete per-broadcaster percentile log on opt-out. Bucket aggregates stay (they
        // already contained their contribution anonymously); their row is removed from
        // future buckets by the opt-out flag at next cron run.
        await pool.execute(`DELETE FROM twitch_peer_bucket_log WHERE broadcaster_id = ?`, [String(broadcasterId)]);
    }
}
