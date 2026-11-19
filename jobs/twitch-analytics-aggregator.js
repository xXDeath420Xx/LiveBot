/**
 * Twitch analytics aggregator + anomaly detector.
 *
 * Runs every minute. In one pass:
 *   1. Drains in-memory ingest buckets from core/twitch-analytics-ingest.js.
 *   2. Fetches current viewer_count for each broadcaster whose stream is online
 *      (via Helix GET /streams, batched up to 100 per request).
 *   3. Writes one row per broadcaster to twitch_stream_snapshots.
 *   4. Flushes mention counters to twitch_mention_targets (harassment detection).
 *   5. Runs the anomaly detectors (view-bot, follow-bot, mod-action spike,
 *      harassment, raid-in) against this minute's snapshot + recent baseline.
 *   6. Posts fresh alerts to the broadcaster's configured Discord channel.
 */
import cron from 'node-cron';
import axios from 'axios';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import { getBroadcasterAccessToken } from '../core/twitch-broadcaster-auth.js';
import logger from '../utils/logger.js';
import botManager from '../core/bot-manager.js';
import { getAccessToken } from '../utils/platforms/twitch-api.js';
import { drainBuckets, drainMentions, mentionTargets } from '../core/twitch-analytics-ingest.js';

const LOG = '[TwitchAnalyticsAgg]';
const HARASSMENT_COOLDOWN_MINUTES = 30;
let task = null;
let running = false;

export function startTwitchAnalyticsAggregator() {
    if (task) { logger.warn(`${LOG} already running`); return; }
    task = cron.schedule('* * * * *', async () => {
        if (running) return;
        running = true;
        try { await runCycle(); }
        catch (e) { logger.error(`${LOG} cycle error`, { err: e.message }); }
        finally { running = false; }
    });
    logger.info(`${LOG} started (every minute)`);
}
export function stopTwitchAnalyticsAggregator() {
    if (task) { task.stop(); task = null; }
    running = false;
    logger.info(`${LOG} stopped`);
}

async function helixHeaders() {
    const token = await getAccessToken();
    return { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` };
}

/** Batch look up viewer counts for up to 100 broadcasters at a time. Returns a Map<bid, {viewer_count, started_at}>. */
async function fetchStreamStates(broadcasterIds) {
    const out = new Map();
    if (!broadcasterIds.length) return out;
    const headers = await helixHeaders();
    for (let i = 0; i < broadcasterIds.length; i += 100) {
        const batch = broadcasterIds.slice(i, i + 100);
        const url = 'https://api.twitch.tv/helix/streams?' + batch.map(b => `user_id=${encodeURIComponent(b)}`).join('&');
        try {
            const r = await axios.get(url, { headers, timeout: 10000 });
            for (const s of r.data?.data || []) {
                out.set(String(s.user_id), {
                    viewer_count: Number(s.viewer_count) || 0,
                    started_at: s.started_at || null,
                    login: s.user_login || null,
                });
            }
        } catch (err) {
            logger.warn(`${LOG} streams fetch failed for batch`, { err: err.message });
        }
    }
    return out;
}

function minuteAlignedNow() {
    const d = new Date();
    d.setSeconds(0, 0);
    return d;
}

async function runCycle() {
    const recordedAt = minuteAlignedNow();
    const buckets = drainBuckets();
    const mentions = drainMentions();

    // Every broadcaster we might want a snapshot for = union of (buckets this minute, every
    // broadcaster we have an active EventSub subscription for).
    const [eventSubRows] = await pool.execute(
        `SELECT DISTINCT broadcaster_id, broadcaster_login FROM twitch_eventsub_subscriptions
          WHERE sub_type IN ('stream.online', 'stream.offline')`);
    const allBids = new Set(eventSubRows.map(r => r.broadcaster_id));
    for (const b of buckets) allBids.add(b.broadcaster_id);
    if (!allBids.size) return;

    const streamStates = await fetchStreamStates(Array.from(allBids));

    const bucketByBid = new Map(buckets.map(b => [b.broadcaster_id, b]));
    const loginByBid = new Map(eventSubRows.map(r => [r.broadcaster_id, r.broadcaster_login]));

    // Write snapshots.
    for (const bid of allBids) {
        const b = bucketByBid.get(bid);
        const stream = streamStates.get(bid);
        const isLive = !!stream;
        const viewerCount = stream?.viewer_count ?? null;
        const login = stream?.login || loginByBid.get(bid) || null;
        // Only persist a snapshot if there's something to say: live OR had events this minute.
        if (!isLive && !b) continue;
        try {
            await pool.execute(
                `INSERT INTO twitch_stream_snapshots
                 (broadcaster_id, broadcaster_login, recorded_at, viewer_count, chatter_count,
                  msg_count, follow_count, sub_count, gift_sub_count, bit_count, raid_in_count,
                  mod_action_count, deleted_msg_count, is_live)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE viewer_count = VALUES(viewer_count), is_live = VALUES(is_live)`,
                [bid, login, recordedAt, viewerCount, b?.chatter_count || 0,
                 b?.msg_count || 0, b?.follow_count || 0, b?.sub_count || 0, b?.gift_sub_count || 0,
                 b?.bit_count || 0, b?.raid_in_count || 0, b?.mod_action_count || 0,
                 b?.deleted_msg_count || 0, isLive ? 1 : 0]);
        } catch (err) {
            logger.warn(`${LOG} snapshot write failed`, { bid, err: err.message });
        }
    }

    // Mention rollup (harassment target detection).
    for (const m of mentions) {
        try {
            await pool.execute(
                `INSERT INTO twitch_mention_targets
                 (broadcaster_id, target_login, mention_count, unique_senders, window_start)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                   mention_count = mention_count + VALUES(mention_count),
                   unique_senders = GREATEST(unique_senders, VALUES(unique_senders))`,
                [m.broadcaster_id, String(m.target_login).slice(0, 100), m.mention_count, m.unique_senders, recordedAt]);
        } catch { /* ignore */ }
    }

    // Anomaly detection — only for currently-live streams.
    for (const bid of allBids) {
        const stream = streamStates.get(bid);
        if (!stream) continue;
        try { await detectAnomalies(bid, stream, bucketByBid.get(bid), recordedAt); }
        catch (err) { logger.warn(`${LOG} anomaly detect failed`, { bid, err: err.message }); }
    }

    // Post any pending alerts to Discord.
    try { await postPendingAlerts(); }
    catch (err) { logger.warn(`${LOG} post alerts failed`, { err: err.message }); }

    // v2 — session stitching + chatters polling.
    try { await stitchSessions(recordedAt, streamStates); }
    catch (err) { logger.warn(`${LOG} session stitch failed`, { err: err.message }); }
    try { await pollChatters(streamStates); }
    catch (err) { logger.warn(`${LOG} chatters poll failed`, { err: err.message }); }
}

// ─── Session stitching (v2) ─────────────────────────────────────────────────
//
// Every minute, convert the stream of twitch_stream_snapshots into materialized
// twitch_stream_sessions rows. A session is a run of consecutive is_live=1 snapshots
// from one broadcaster; we open it on the first live snapshot and close it when we
// see an offline snapshot. On close we aggregate the whole run (peak, avg, totals).
const SESSION_RESTART_SLACK_MS = 2 * 60_000;

async function stitchSessions(recordedAt, streamStates) {
    const [openSessions] = await pool.execute(
        `SELECT broadcaster_id, id, started_at
           FROM twitch_stream_sessions
          WHERE ended_at IS NULL`);
    const openBy = new Map(openSessions.map(s => [s.broadcaster_id, s]));

    // Who's live right now? streamStates comes from this cycle's Helix call.
    const liveBids = new Set(Array.from(streamStates.keys()).map(String));

    // 0) A stream restarted between two polls never produces an offline snapshot, so the old
    //    session would stay open across both streams. Twitch's started_at moving later than
    //    the open session's start means the previous stream ended: close it so step 1 opens
    //    a fresh session at the new start.
    for (const bid of liveBids) {
        const open = openBy.get(bid);
        const twitchStart = streamStates.get(bid)?.started_at;
        if (!open || !twitchStart) continue;
        const newStartMs = new Date(twitchStart).getTime();
        if (newStartMs - new Date(open.started_at).getTime() <= SESSION_RESTART_SLACK_MS) continue;
        try {
            await closeSession(bid, open.id, open.started_at, new Date(newStartMs - 1000));
            openBy.delete(bid);
            logger.info(`${LOG} closed session ${open.id} for ${bid}: stream restarted at ${twitchStart}`);
        } catch (err) {
            logger.warn(`${LOG} restart close failed`, { bid, err: err.message });
        }
    }

    // 1) OPEN new sessions for broadcasters who are live and have no open row.
    for (const bid of liveBids) {
        if (openBy.has(bid)) continue;
        const stream = streamStates.get(bid);
        // Use Twitch's `started_at` if available (truer start), else this minute.
        const sql = stream?.started_at
            ? new Date(stream.started_at).toISOString().slice(0, 19).replace('T', ' ')
            : recordedAt.toISOString().slice(0, 19).replace('T', ' ');
        try {
            await pool.execute(
                `INSERT INTO twitch_stream_sessions
                 (broadcaster_id, broadcaster_login, started_at, peak_viewers, avg_viewers)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE id = id`,
                [bid, stream?.login || null, sql, stream?.viewer_count || 0, stream?.viewer_count || 0]);
        } catch (err) {
            logger.warn(`${LOG} session open insert failed`, { bid, err: err.message });
        }
    }

    // 2) CLOSE sessions where the broadcaster is no longer live.
    for (const [bid, session] of openBy) {
        if (liveBids.has(bid)) continue;
        try { await closeSession(bid, session.id, session.started_at, recordedAt); }
        catch (err) { logger.warn(`${LOG} session close failed`, { bid, err: err.message }); }
    }
}

async function closeSession(broadcasterId, sessionId, startedAt, endedAt) {
    // Aggregate all snapshots between started_at and endedAt for this broadcaster.
    const [agg] = await pool.execute(
        `SELECT COUNT(*)                                   AS snapshot_count,
                MAX(viewer_count)                          AS peak_viewers,
                AVG(NULLIF(viewer_count, 0))               AS avg_viewers,
                SUM(msg_count)                             AS total_msgs,
                SUM(follow_count)                          AS total_follows,
                SUM(sub_count)                             AS total_subs,
                SUM(gift_sub_count)                        AS total_gift_subs,
                SUM(bit_count)                             AS total_bits,
                SUM(raid_in_count)                         AS total_raids_in,
                SUM(mod_action_count)                      AS total_mod_actions,
                SUM(deleted_msg_count)                     AS total_deleted_msgs,
                MAX(broadcaster_login)                     AS login
           FROM twitch_stream_snapshots
          WHERE broadcaster_id = ?
            AND recorded_at >= ?
            AND recorded_at <= ?`,
        [broadcasterId, startedAt, endedAt]);
    const row = agg[0] || {};

    // Unique chatters across the session: union all chatter_logins_json arrays. We flatten in
    // Node rather than SQL — the arrays can be up to 1000 logins each and MySQL JSON set-ops
    // are ergonomically painful.
    let uniqueChatters = 0;
    try {
        const [chatRows] = await pool.execute(
            `SELECT chatter_logins_json FROM twitch_chatters_snapshots
              WHERE broadcaster_id = ? AND recorded_at BETWEEN ? AND ?`,
            [broadcasterId, startedAt, endedAt]);
        const seen = new Set();
        for (const r of chatRows) {
            try {
                const arr = JSON.parse(r.chatter_logins_json || '[]');
                if (Array.isArray(arr)) for (const l of arr) if (l) seen.add(String(l).toLowerCase());
            } catch { /* ignore malformed row */ }
        }
        uniqueChatters = seen.size;
    } catch { /* older sessions pre-v2 scope have no chatters rows — leave at 0 */ }

    const durationMin = Math.max(0,
        Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60000));

    // Pull latest category/title at close time if we recorded any channel.update rows.
    const [catRow] = await pool.execute(
        `SELECT category_id, category_name, title FROM twitch_category_history
          WHERE broadcaster_id = ? AND changed_at BETWEEN ? AND ?
          ORDER BY changed_at DESC LIMIT 1`,
        [broadcasterId, startedAt, endedAt]);
    const cat = catRow[0] || {};

    const [catChanges] = await pool.execute(
        `SELECT COUNT(DISTINCT title) AS tc, COUNT(DISTINCT category_id) AS cc
           FROM twitch_category_history
          WHERE broadcaster_id = ? AND changed_at BETWEEN ? AND ?`,
        [broadcasterId, startedAt, endedAt]);
    const changes = catChanges[0] || { tc: 0, cc: 0 };

    await pool.execute(
        `UPDATE twitch_stream_sessions
            SET ended_at = ?, duration_minutes = ?, peak_viewers = ?, avg_viewers = ?,
                total_msgs = ?, unique_chatters = ?, total_follows = ?, total_subs = ?,
                total_gift_subs = ?, total_bits = ?, total_raids_in = ?,
                total_mod_actions = ?, total_deleted_msgs = ?,
                primary_category_id = ?, primary_category_name = ?,
                title_at_start = COALESCE(title_at_start, ?),
                title_change_count = GREATEST(0, ? - 1),
                category_change_count = GREATEST(0, ? - 1),
                broadcaster_login = COALESCE(broadcaster_login, ?)
          WHERE id = ?`,
        [endedAt, durationMin,
         Number(row.peak_viewers) || 0, Number(row.avg_viewers) || 0,
         Number(row.total_msgs) || 0, uniqueChatters,
         Number(row.total_follows) || 0, Number(row.total_subs) || 0,
         Number(row.total_gift_subs) || 0, Number(row.total_bits) || 0,
         Number(row.total_raids_in) || 0, Number(row.total_mod_actions) || 0,
         Number(row.total_deleted_msgs) || 0,
         cat.category_id || null, cat.category_name || null, cat.title || null,
         Number(changes.tc) || 0, Number(changes.cc) || 0,
         row.login || null,
         sessionId]);

    // Wave 372 — fire-and-forget AI session recap on close. Opt-in per guild via
    // ai_auto_recap flag; the AI module itself gates on ai_enabled + daily call cap.
    try {
        const [[cfg]] = await pool.execute(
            `SELECT ai_auto_recap FROM twitch_analytics_alerts_config WHERE broadcaster_id = ? LIMIT 1`,
            [String(broadcasterId)]);
        if (cfg?.ai_auto_recap) {
            import('../core/twitch-ai.js').then(({ generateSessionRecap }) => {
                generateSessionRecap(sessionId).catch(err =>
                    logger.warn(`[Aggregator] AI recap failed for session ${sessionId}: ${err.message}`));
            }).catch(err => logger.warn(`[Aggregator] AI import failed: ${err.message}`));
        }
    } catch (e) { /* non-fatal — recap can be triggered manually from the UI */ }
}

// ─── Chatters polling (v2) ───────────────────────────────────────────────────
//
// Helix GET /chat/chatters requires a broadcaster user token with moderator:read:chatters.
// We call this once per minute per live broadcaster who granted that scope.
const chatterGapLogged = new Map();
function noteChatterGap(bid, why) {
    const last = chatterGapLogged.get(bid) || 0;
    if (Date.now() - last < 60 * 60 * 1000) return;
    chatterGapLogged.set(bid, Date.now());
    logger.warn(`${LOG} chatter list not captured for ${bid} (${why}); minutes missed while live cannot be recovered`);
}

async function pollChatters(streamStates) {
    if (!streamStates.size) return;

    // Pull user tokens for live broadcasters who granted moderator:read:chatters.
    const liveBids = Array.from(streamStates.keys()).map(String);
    if (!liveBids.length) return;

    const placeholders = liveBids.map(() => '?').join(',');
    const [rows] = await pool.execute(
        `SELECT broadcaster_twitch_id, broadcaster_token, token_scopes
           FROM twitch_role_sync_config
          WHERE enabled = 1
            AND broadcaster_token IS NOT NULL
            AND broadcaster_twitch_id IN (${placeholders})`,
        liveBids);

    const nowSql = new Date().toISOString().slice(0, 19).replace('T', ' ');

    for (const r of rows) {
        const scopes = String(r.token_scopes || '').split(/[\s,]+/).filter(Boolean);
        if (!scopes.includes('moderator:read:chatters')) continue;
        const accessToken = await getBroadcasterAccessToken({ broadcasterId: r.broadcaster_twitch_id });
        if (!accessToken) { noteChatterGap(String(r.broadcaster_twitch_id), 'no usable token'); continue; }

        const bid = String(r.broadcaster_twitch_id);
        try {
            // Twitch paginates; usually one page covers most streams, but loop for safety.
            const logins = [];
            const identities = []; // Wave 369 — capture full {id, login, name} for twitch_chatter_sightings.
            let cursor = null;
            do {
                const url = `https://api.twitch.tv/helix/chat/chatters?broadcaster_id=${encodeURIComponent(bid)}&moderator_id=${encodeURIComponent(bid)}&first=1000${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
                const res = await axios.get(url, {
                    headers: {
                        'Client-ID': process.env.TWITCH_CLIENT_ID,
                        'Authorization': `Bearer ${accessToken}`,
                    },
                    timeout: 10000,
                });
                for (const c of res.data?.data || []) {
                    if (c.user_login) logins.push(c.user_login.toLowerCase());
                    if (c.user_id) identities.push({ id: String(c.user_id), login: c.user_login, name: c.user_name });
                }
                cursor = res.data?.pagination?.cursor || null;
                // Safety stop at 10 pages = 10K chatters (any stream pulling that many is tracked).
            } while (cursor && logins.length < 10000);

            await pool.execute(
                `INSERT INTO twitch_chatters_snapshots
                 (broadcaster_id, recorded_at, total_count, chatter_logins_json)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE total_count = VALUES(total_count),
                                         chatter_logins_json = VALUES(chatter_logins_json)`,
                [bid, nowSql, logins.length, JSON.stringify(logins)]);

            // Wave 369 — upsert chatter identities into the aggregate sightings table so we
            // can run queries like "top chatters all-time" and "new vs repeat chatter" without
            // scanning the per-minute JSON blobs. Only runs if the guild has
            // `chatter_identities_enabled = 1` (default: on, per migration 369).
            if (identities.length) {
                const [cfgRows] = await pool.execute(
                    `SELECT chatter_identities_enabled FROM twitch_analytics_alerts_config
                      WHERE broadcaster_id = ? LIMIT 1`, [bid]);
                // Note: no explicit opt-in needed because the column defaults to 1 in migration
                // 369 but a broadcaster with no alerts_config row yet won't persist until they
                // save alerts for the first time. The pre-config bootstrap below creates one.
                // No config row yet = the column default (on). Only an explicit 0 opts out.
                const identityEnabled = !cfgRows.length || Number(cfgRows[0].chatter_identities_enabled) === 1;
                if (identityEnabled) {
                    // Chunk inserts to avoid oversized queries on big streams (1K chatters each).
                    for (let i = 0; i < identities.length; i += 500) {
                        const batch = identities.slice(i, i + 500);
                        const values = batch.map(() => '(?, ?, ?, ?, NOW(), NOW(), 1, 1)').join(',');
                        const params = [];
                        for (const c of batch) {
                            params.push(bid, c.id, c.login || null, c.name || null);
                        }
                        await pool.query(
                            `INSERT INTO twitch_chatter_sightings
                             (broadcaster_id, chatter_user_id, chatter_user_login, chatter_display_name,
                              first_seen_at, last_seen_at, sightings, sessions_seen)
                             VALUES ${values}
                             ON DUPLICATE KEY UPDATE
                                 chatter_user_login = VALUES(chatter_user_login),
                                 chatter_display_name = VALUES(chatter_display_name),
                                 last_seen_at = VALUES(last_seen_at),
                                 sightings = sightings + 1`,
                            params);
                    }
                }
            }
            // Ban on sight (off unless the channel turned it on). Runs in the background so list
            // lookups never delay the next channel's chatter poll.
            if (identities.length) {
                import('../core/twitch-known-bot-bans.js')
                    .then(m => m.banKnownBotsOnSight(bid, identities))
                    .catch(e => logger.warn(`${LOG} known-bot ban ${bid}: ${e.message}`));
            }
        } catch (err) {
            // A lost minute of chatter list can never be recovered, so auth failures are logged too
            // (throttled to one line per broadcaster per hour).
            if ([401, 403].includes(err.response?.status)) noteChatterGap(bid, `HTTP ${err.response.status}`);
            else {
                logger.warn(`${LOG} chatters poll ${bid}: ${err.response?.status || err.message}`);
            }
        }
    }
}

async function detectAnomalies(bid, stream, bucket, recordedAt) {
    // Gate: skip detection if we have no user-scope EventSub subscriptions for this broadcaster.
    // Without chat.message / follow / etc., our msg_count/follow_count/mod_action_count are 0
    // by definition — any threshold check would false-positive on every live stream.
    const [subRows] = await pool.execute(
        `SELECT 1 FROM twitch_eventsub_subscriptions WHERE broadcaster_id = ?
          AND sub_type IN ('channel.chat.message', 'channel.follow', 'channel.ban') LIMIT 1`,
        [bid]);
    if (!subRows.length) return;   // nothing to analyze until the broadcaster grants user scopes

    const [cfgRows] = await pool.execute(
        `SELECT * FROM twitch_analytics_config WHERE broadcaster_id = ?`, [bid]);
    const cfg = cfgRows[0] || {
        enabled: 1, viewbot_threshold: 0.020, viewbot_min_viewers: 50,
        followbot_threshold: 10, mod_spike_threshold: 5, harassment_threshold: 5, raid_alert: 1,
    };
    if (!cfg.enabled) return;

    const alerts = [];
    const viewers = stream.viewer_count || 0;
    const msgs = bucket?.msg_count || 0;
    const chatters = bucket?.chatter_count || 0;

    // View-bot: too many viewers for too little chat.
    //
    // Classify first, relay second: a single minute of 0 msgs/viewer is NORMAL
    // (lurkers), not a view-bot. We require sustained anomaly over a window AND a
    // Helix /chat/chatters cross-check before firing.
    //
    // DEFENSES:
    //   1. Helix /chat/chatters snapshot: if ≥10 people are *connected* to chat
    //      (not just the ones who typed this minute), we have active chat. Suppress.
    //      This is the critical fix — the previous defense #1 looked at distinct
    //      message senders this minute, which trivially goes to 0 whenever chat lulls.
    //   2. Grace period: within 15 min of OAuth, suppress (webhook handshake settling).
    //   3. Sub churn: if channel.chat.message sub updated < 5 min ago, suppress
    //      (we may have dropped webhooks during a restart).
    //   4. Sustained anomaly: require 10 consecutive minutes below threshold before
    //      firing. One quiet minute is lurking, not botting.
    //   5. Dedupe: no new view_bot alert within 60 min of an existing one for this
    //      broadcaster. Stream-session granularity, not per-minute.
    if (viewers >= cfg.viewbot_min_viewers) {
        const ratio = msgs / viewers;
        if (ratio < Number(cfg.viewbot_threshold)) {
            // Defense 1 — Helix /chat/chatters: how many are *connected* to chat right now.
            const [[snap]] = await pool.execute(
                `SELECT total_count FROM twitch_chatters_snapshots
                  WHERE broadcaster_id = ? AND recorded_at > DATE_SUB(NOW(), INTERVAL 3 MINUTE)
                  ORDER BY recorded_at DESC LIMIT 1`, [bid]);
            const chatConnected = Number(snap?.total_count || 0);

            if (chatConnected >= 10) {
                // Chat is populated — lurker behavior, not view-botting.
            } else {
                // Defense 2 — grace period after OAuth.
                const [[cfgRow]] = await pool.execute(
                    `SELECT created_at FROM twitch_role_sync_config WHERE broadcaster_twitch_id = ? LIMIT 1`, [bid]);
                const oauthAgeMs = cfgRow?.created_at ? (Date.now() - new Date(cfgRow.created_at).getTime()) : Infinity;
                const inGracePeriod = oauthAgeMs < 15 * 60 * 1000;

                // Defense 3 — recent sub restart / webhook churn.
                const [[sub]] = await pool.execute(
                    `SELECT updated_at FROM twitch_eventsub_subscriptions WHERE broadcaster_id = ? AND sub_type = 'channel.chat.message' LIMIT 1`, [bid]);
                const subChurn = sub?.updated_at && (Date.now() - new Date(sub.updated_at).getTime()) < 5 * 60 * 1000;

                // Defense 4 — sustained anomaly. Require 10 consecutive minutes below
                // threshold before firing.
                // Per-minute snapshots live in twitch_stream_snapshots. This read
                // twitch_viewer_minute_buckets, a table that never existed: the first real view-bot
                // pattern would have thrown into "anomaly detect failed" and sent no alert (fixed 2026-11-18).
                const [recentBuckets] = await pool.execute(
                    `SELECT viewer_count, msg_count FROM twitch_stream_snapshots
                      WHERE broadcaster_id = ? AND is_live = 1 AND recorded_at > DATE_SUB(NOW(), INTERVAL 10 MINUTE)
                      ORDER BY recorded_at DESC LIMIT 10`, [bid]);
                const sustained = recentBuckets.length >= 10 && recentBuckets.every(b => {
                    const v = Number(b.viewer_count || 0);
                    const m = Number(b.msg_count || 0);
                    return v >= cfg.viewbot_min_viewers && (m / Math.max(1, v)) < Number(cfg.viewbot_threshold);
                });

                // Defense 5 — dedupe within a 60-min window.
                const [[recentAlert]] = await pool.execute(
                    `SELECT 1 AS found FROM twitch_anomaly_alerts
                      WHERE broadcaster_id = ? AND alert_type = 'view_bot'
                        AND created_at > DATE_SUB(NOW(), INTERVAL 60 MINUTE) LIMIT 1`, [bid]);
                const recentlyAlerted = !!recentAlert?.found;

                if (!inGracePeriod && !subChurn && sustained && !recentlyAlerted) {
                    alerts.push({
                        type: 'view_bot', severity: ratio < 0.005 ? 'critical' : 'warning',
                        score: Number(ratio.toFixed(4)),
                        evidence: { viewers, msgs_this_minute: msgs, chatters, chat_connected: chatConnected,
                                    threshold: Number(cfg.viewbot_threshold),
                                    sustained_minutes: recentBuckets.length,
                                    interpretation: `${msgs} chat msg/min with ${viewers} viewers (${ratio.toFixed(4)} msgs/viewer) — sustained ${recentBuckets.length}+ min, ${chatConnected} connected to chat` },
                    });
                }
            }
        }
    }

    // Follow-bot: follow velocity spike.
    const follows = bucket?.follow_count || 0;
    if (follows >= cfg.followbot_threshold) {
        alerts.push({
            type: 'follow_bot', severity: follows >= cfg.followbot_threshold * 3 ? 'critical' : 'warning',
            score: follows,
            evidence: { follows_this_minute: follows, threshold: cfg.followbot_threshold,
                        interpretation: `${follows} new follows in one minute (threshold ${cfg.followbot_threshold})` },
        });
    }

    // Mod action spike.
    const modActions = bucket?.mod_action_count || 0;
    if (modActions >= cfg.mod_spike_threshold) {
        alerts.push({
            type: 'mod_action_spike', severity: modActions >= cfg.mod_spike_threshold * 3 ? 'critical' : 'warning',
            score: modActions,
            evidence: { mod_actions_this_minute: modActions, threshold: cfg.mod_spike_threshold,
                        interpretation: `${modActions} moderator actions in one minute — possible brigade or chat spam attack` },
        });
    }

    // Raids are NOT anomalies — they're a normal, usually-positive event.
    // The Discord ping lives in core/twitch-analytics-alerts.js (notify_raid_in
    // → channel.raid EventSub). We used to push a 'raid_in' row into
    // twitch_anomaly_alerts here too, which surfaced raids under the
    // "anti-abuse detectors" header. Removed 2026-10-30. The enum value
    // stays in schema for history; the raid_alert config key is now a no-op.

    // Harassment: one target @-mentioned by many different people who got no reply, in the last
    // 5 minutes. One alert per target per cooldown, however long the pile-on lasts.
    for (const h of mentionTargets(bid, cfg.harassment_threshold || Infinity)) {
        const [recent] = await pool.execute(
            `SELECT 1 FROM twitch_anomaly_alerts
              WHERE broadcaster_id = ? AND alert_type = 'harassment'
                AND created_at > DATE_SUB(?, INTERVAL ? MINUTE)
                AND JSON_VALUE(evidence_json, '$.target') = ? LIMIT 1`,
            [bid, recordedAt, HARASSMENT_COOLDOWN_MINUTES, h.target]);
        if (recent.length) continue;
        const count = h.senders.length;
        alerts.push({
            type: 'harassment', severity: count >= cfg.harassment_threshold * 2 ? 'critical' : 'warning',
            score: count,
            evidence: { target: h.target, unique_senders_5min: count, senders: h.senders,
                        conversing_excluded: h.conversing,
                        interpretation: `@${h.target} mentioned by ${count} different users in 5 minutes without replying to them` },
        });
    }

    for (const a of alerts) {
        try {
            await pool.execute(
                `INSERT INTO twitch_anomaly_alerts (broadcaster_id, alert_type, severity, score, evidence_json)
                 VALUES (?, ?, ?, ?, ?)`,
                [bid, a.type, a.severity, a.score, JSON.stringify(a.evidence)]);
        } catch { /* ignore */ }
    }
}

async function postPendingAlerts() {
    const [rows] = await pool.execute(
        `SELECT a.id, a.broadcaster_id, a.alert_type, a.severity, a.score, a.evidence_json,
                c.alert_discord_guild_id, c.alert_discord_channel_id,
                s.broadcaster_login
           FROM twitch_anomaly_alerts a
           LEFT JOIN twitch_analytics_config c ON c.broadcaster_id = a.broadcaster_id
           LEFT JOIN twitch_eventsub_subscriptions s ON s.broadcaster_id = a.broadcaster_id
          WHERE a.posted_to_discord = 0 AND c.alert_discord_channel_id IS NOT NULL
          ORDER BY a.created_at ASC LIMIT 50`);
    const seen = new Set();
    for (const row of rows) {
        if (!row.alert_discord_guild_id || !row.alert_discord_channel_id) continue;
        try {
            const client = botManager.getClientForGuild(row.alert_discord_guild_id);
            if (!client) continue;
            const channel = await client.channels.fetch(row.alert_discord_channel_id).catch(() => null);
            if (!channel) continue;
            const evidence = JSON.parse(row.evidence_json || '{}');
            const color = row.severity === 'critical' ? 0xE35858 : (row.severity === 'warning' ? 0xE2B23A : 0x5865F2);
            const titleByType = {
                view_bot: 'Possible view-bot activity',
                follow_bot: 'Follow spike',
                raid_in: 'Incoming raid',
                harassment: 'Possible targeted harassment',
                mod_action_spike: 'Moderator action spike',
            };
            const title = titleByType[row.alert_type] || 'Twitch alert';
            const login = row.broadcaster_login || row.broadcaster_id;
            await channel.send({
                embeds: [{
                    title: `${title} · ${login}`,
                    color,
                    description: evidence.interpretation || `Score: ${row.score}`,
                    fields: Object.entries(evidence).filter(([k]) => k !== 'interpretation').slice(0, 8)
                        .map(([k, v]) => ({ name: k, value: String(v).slice(0, 200), inline: true })),
                    timestamp: new Date().toISOString(),
                    footer: { text: `CertiFried Twitch analytics` },
                }],
            });
            await pool.execute(
                `UPDATE twitch_anomaly_alerts SET posted_to_discord = 1, posted_at = NOW() WHERE id = ?`,
                [row.id]);
            seen.add(row.id);
        } catch (err) {
            logger.warn(`${LOG} alert post failed`, { id: row.id, err: err.message });
        }
    }
    if (seen.size) logger.info(`${LOG} posted ${seen.size} alert(s)`);
}

export default { startTwitchAnalyticsAggregator, stopTwitchAnalyticsAggregator };
