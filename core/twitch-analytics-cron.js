/**
 * Twitch analytics cron — in-process scheduler for three periodic jobs:
 *
 *   1. Nightly backfill  — refresh every connected broadcaster's lifetime stats + VODs +
 *                          clips + rewards at 04:00 UTC. Removes dependency on the owner
 *                          clicking "Refresh backfill".
 *   2. Weekly digest     — Monday 09:00 UTC embed to the configured channel (or DM user)
 *                          with last-7d stats, biggest session, and top clip.
 *   3. Milestones scan   — Every 6 hours, recompute the `twitch_milestones` table so the
 *                          "best stream" / "longest streak" callouts stay cheap at page load.
 *
 * Follows the same self-starting setInterval pattern as other managers in this codebase
 * (core/schedule-manager.js, core/leveling-manager.js, …). Startup is deferred to T+30s so
 * the bot is fully up before we start making Helix calls.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { sqlNotBot } from '../utils/twitch-chat-bots.js';
import { runBackfill } from './twitch-backfill.js';
import encryption from '../utils/encryption.js';
import { getBroadcasterAccessToken } from './twitch-broadcaster-auth.js';

const LOG = '[TwitchAnalyticsCron]';

const INTERVALS = {
    // Minute-of-the-hour aligned, UTC. The checker runs hourly and compares the current UTC
    // hour against these targets; this avoids drift from the exact process start time.
    nightlyBackfillHourUtc: 4,
    weeklyDigestHourUtc: 9,
    weeklyDigestDayUtc: 1, // Monday (0=Sunday)
    milestonesHours: 6,
};

let bootstrapped = false;
let lastBackfillRunAt = 0;
let lastDigestRunAt = 0;
let lastMilestonesAt = 0;
let lastChurnAt = 0;
let lastClipDeltaAt = 0;
let lastSentimentAt = 0;
let lastBigMomentAt = 0;

async function runNightlyBackfill() {
    const nowKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    if (lastBackfillRunAt === nowKey) return;
    lastBackfillRunAt = nowKey;

    logger.info(`${LOG} nightly backfill sweep starting`);
    const [configs] = await pool.query(
        `SELECT guild_id, broadcaster_twitch_id, broadcaster_twitch_username, broadcaster_token, token_scopes
           FROM twitch_role_sync_config
          WHERE enabled = 1 AND broadcaster_token IS NOT NULL`,
    );
    let okCount = 0, failCount = 0;
    for (const cfg of configs) {
        const token = await getBroadcasterAccessToken({ broadcasterId: cfg.broadcaster_twitch_id, guildId: cfg.guild_id });
        if (!token) { failCount++; continue; }
        const scopes = String(cfg.token_scopes || '').split(/[\s,]+/).filter(Boolean);
        try {
            const r = await runBackfill({
                broadcasterId: cfg.broadcaster_twitch_id,
                accessToken: token, scopes, login: cfg.broadcaster_twitch_username,
                triggerSource: 'cron',
            });
            if (r?.ok) okCount++; else failCount++;
        } catch (e) {
            logger.warn(`${LOG} nightly backfill failed for ${cfg.broadcaster_twitch_username}: ${e.message}`);
            failCount++;
        }
        // 500ms spacing between broadcasters — gentle on Twitch rate limits.
        await new Promise(r => setTimeout(r, 500));
    }
    logger.info(`${LOG} nightly backfill sweep done — ${okCount} ok, ${failCount} failed, ${configs.length} total`);
}

async function recomputeMilestones() {
    const nowSlot = Math.floor(Date.now() / (INTERVALS.milestonesHours * 60 * 60 * 1000));
    if (lastMilestonesAt === nowSlot) return;
    lastMilestonesAt = nowSlot;

    logger.info(`${LOG} milestone recompute starting`);
    const [configs] = await pool.query(
        `SELECT broadcaster_twitch_id FROM twitch_role_sync_config WHERE enabled = 1 AND broadcaster_token IS NOT NULL`,
    );
    for (const cfg of configs) {
        const bid = String(cfg.broadcaster_twitch_id);
        try {
            // 1. Biggest session by peak viewers
            const [[bigPeak]] = await pool.query(
                `SELECT started_at, peak_viewers, duration_minutes, primary_category_name, title_at_start
                   FROM twitch_stream_sessions WHERE broadcaster_id = ? ORDER BY peak_viewers DESC LIMIT 1`, [bid]);
            if (bigPeak?.peak_viewers) {
                await pool.query(
                    `INSERT INTO twitch_milestones (broadcaster_id, milestone_type, milestone_value, label, achieved_at, evidence_json)
                     VALUES (?, 'biggest_peak', ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE milestone_value = VALUES(milestone_value), label = VALUES(label), achieved_at = VALUES(achieved_at), evidence_json = VALUES(evidence_json)`,
                    [bid, bigPeak.peak_viewers, bigPeak.title_at_start || bigPeak.primary_category_name || 'stream', bigPeak.started_at, JSON.stringify(bigPeak)],
                );
            }
            // 2. Longest session
            const [[longest]] = await pool.query(
                `SELECT started_at, duration_minutes, title_at_start, primary_category_name
                   FROM twitch_stream_sessions WHERE broadcaster_id = ? AND duration_minutes IS NOT NULL
                  ORDER BY duration_minutes DESC LIMIT 1`, [bid]);
            if (longest?.duration_minutes) {
                await pool.query(
                    `INSERT INTO twitch_milestones (broadcaster_id, milestone_type, milestone_value, label, achieved_at, evidence_json)
                     VALUES (?, 'longest_stream', ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE milestone_value = VALUES(milestone_value), label = VALUES(label), achieved_at = VALUES(achieved_at), evidence_json = VALUES(evidence_json)`,
                    [bid, longest.duration_minutes, longest.title_at_start || longest.primary_category_name || 'stream', longest.started_at, JSON.stringify(longest)],
                );
            }
            // 3. Longest consecutive streaming streak (days)
            const [sessions] = await pool.query(
                `SELECT DATE(started_at) AS d FROM twitch_stream_sessions WHERE broadcaster_id = ?
                  GROUP BY DATE(started_at) ORDER BY d ASC`, [bid]);
            let best = 0, run = 0, lastDay = null;
            for (const s of sessions) {
                const day = new Date(s.d).getTime() / 86400000;
                if (lastDay !== null && Math.round(day - lastDay) === 1) run++;
                else run = 1;
                if (run > best) best = run;
                lastDay = day;
            }
            if (best > 0) {
                await pool.query(
                    `INSERT INTO twitch_milestones (broadcaster_id, milestone_type, milestone_value, label)
                     VALUES (?, 'longest_streak', ?, ?)
                     ON DUPLICATE KEY UPDATE milestone_value = VALUES(milestone_value), label = VALUES(label)`,
                    [bid, best, `${best} consecutive day${best === 1 ? '' : 's'}`],
                );
            }
            // 4. Most chats in one session
            const [[chattiest]] = await pool.query(
                `SELECT started_at, total_msgs, unique_chatters FROM twitch_stream_sessions
                  WHERE broadcaster_id = ? ORDER BY total_msgs DESC LIMIT 1`, [bid]);
            if (chattiest?.total_msgs) {
                await pool.query(
                    `INSERT INTO twitch_milestones (broadcaster_id, milestone_type, milestone_value, label, achieved_at, evidence_json)
                     VALUES (?, 'most_chat', ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE milestone_value = VALUES(milestone_value), label = VALUES(label), achieved_at = VALUES(achieved_at), evidence_json = VALUES(evidence_json)`,
                    [bid, chattiest.total_msgs, `${chattiest.total_msgs.toLocaleString()} msgs`, chattiest.started_at, JSON.stringify(chattiest)],
                );
            }
        } catch (e) {
            logger.warn(`${LOG} milestones for ${bid} failed: ${e.message}`);
        }
    }
    logger.info(`${LOG} milestone recompute done for ${configs.length} broadcasters`);
}

async function runWeeklyDigest() {
    // Dynamic import to avoid circular dependency at module load.
    const { sendDigest } = await import('./twitch-digest.js');
    const nowKey = new Date().toISOString().slice(0, 10);
    if (lastDigestRunAt === nowKey) return;
    lastDigestRunAt = nowKey;

    logger.info(`${LOG} weekly digest sweep starting`);
    const [configs] = await pool.query(
        `SELECT c.guild_id, c.broadcaster_id, c.alert_channel_id, c.weekly_digest_enabled,
                c.weekly_digest_dm_user_id, c.last_digest_sent_at,
                r.broadcaster_twitch_username AS login
           FROM twitch_analytics_alerts_config c
           LEFT JOIN twitch_role_sync_config r
                 ON r.guild_id = c.guild_id COLLATE utf8mb4_unicode_ci
          WHERE c.weekly_digest_enabled = 1`,
    );
    let sent = 0;
    for (const cfg of configs) {
        try {
            const ok = await sendDigest(cfg);
            if (ok) {
                sent++;
                await pool.query(
                    `UPDATE twitch_analytics_alerts_config SET last_digest_sent_at = NOW() WHERE guild_id = ?`,
                    [cfg.guild_id]);
            }
        } catch (e) {
            logger.warn(`${LOG} digest for guild ${cfg.guild_id} failed: ${e.message}`);
        }
    }
    logger.info(`${LOG} weekly digest sweep done — ${sent}/${configs.length} sent`);
}

/**
 * Follower churn — hourly full follower snapshot + diff vs previous. New follower ids go in
 * twitch_follower_changes as 'add', missing ids as 'remove'. Twitch has no unfollow event, so
 * this diff is the only source; an unfollow is known to within the hour, never to the minute.
 *
 * A paged list can drop an id between pages, so every apparent unfollow is re-checked with a
 * direct follower lookup before it is recorded or posted. A list that hit the page cap is
 * incomplete, so removes are not computed from it at all.
 * Unfollows are posted to twitch_analytics_alerts_config.unfollow_channel_id when set.
 */
const CHURN_MAX_PAGES = 50;      // 5,000 followers
const CHURN_MAX_VERIFY = 300;    // direct re-checks per channel per run
async function runFollowerChurn() {
    const nowKey = new Date().toISOString().slice(0, 13);
    if (lastChurnAt === nowKey) return;
    lastChurnAt = nowKey;

    logger.info(`${LOG} follower churn sweep starting`);
    const [configs] = await pool.query(
        `SELECT broadcaster_twitch_id, broadcaster_twitch_username, broadcaster_token, token_scopes
           FROM twitch_role_sync_config
          WHERE enabled = 1 AND broadcaster_token IS NOT NULL
            AND token_scopes LIKE '%moderator:read:followers%'`);
    const axios = (await import('axios')).default;
    const seen = new Set();

    for (const cfg of configs) {
        const bid = String(cfg.broadcaster_twitch_id);
        if (seen.has(bid)) continue;   // one broadcaster linked in several servers: sweep once
        seen.add(bid);
        const token = await getBroadcasterAccessToken({ broadcasterId: cfg.broadcaster_twitch_id });
        if (!token) continue;
        const headers = { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` };
        const now = new Date();
        const observedAtSql = now.toISOString().slice(0, 19).replace('T', ' ');
        try {
            const current = new Map();
            let cursor = null, complete = false;
            for (let page = 0; page < CHURN_MAX_PAGES; page++) {
                const r = await axios.get('https://api.twitch.tv/helix/channels/followers', {
                    headers, params: { broadcaster_id: bid, first: 100, ...(cursor ? { after: cursor } : {}) },
                    timeout: 10_000,
                });
                for (const f of r.data?.data || []) {
                    current.set(String(f.user_id), { user_login: f.user_login, user_name: f.user_name, followed_at: f.followed_at });
                }
                cursor = r.data?.pagination?.cursor;
                if (!cursor || !(r.data?.data || []).length) { complete = true; break; }
            }

            // Diff vs previous snapshot.
            const [[prev]] = await pool.query(
                `SELECT follower_ids_json, snapshot_at FROM twitch_follower_snapshot WHERE broadcaster_id = ?`, [bid]);
            const prevSet = new Set(JSON.parse(prev?.follower_ids_json || '[]'));

            // New followers (adds) — in current but not prev. On first run, prevSet is empty
            // so EVERY current follower would log as 'add'; skip in that case to avoid noise.
            if (prevSet.size > 0) {
                for (const [id, info] of current) {
                    if (!prevSet.has(id)) {
                        await pool.query(
                            `INSERT INTO twitch_follower_changes (broadcaster_id, user_id, user_login, user_name, change_type, observed_at, followed_at)
                             VALUES (?, ?, ?, ?, 'add', ?, ?)`,
                            [bid, id, info.user_login, info.user_name, observedAtSql,
                             info.followed_at ? new Date(info.followed_at).toISOString().slice(0, 19).replace('T', ' ') : null]);
                    }
                }

                if (!complete) {
                    logger.warn(`${LOG} churn for ${cfg.broadcaster_twitch_username}: over ${CHURN_MAX_PAGES * 100} followers, unfollows not computed`);
                } else {
                    const candidates = [...prevSet].filter((id) => !current.has(id));
                    const removed = await confirmUnfollows(axios, headers, bid, candidates, current);
                    if (removed.length) {
                        const names = await lookupUsers(axios, headers, removed);
                        const sinceMap = await followedSince(bid, removed);
                        const list = [];
                        for (const id of removed) {
                            const u = names.get(id) || null;
                            await pool.query(
                                `INSERT INTO twitch_follower_changes (broadcaster_id, user_id, user_login, user_name, change_type, observed_at)
                                 VALUES (?, ?, ?, ?, 'remove', ?)`,
                                [bid, id, u?.login || null, u?.display_name || null, observedAtSql]);
                            list.push({ user_id: id, login: u?.login || null, name: u?.display_name || null, followed_at: sinceMap.get(id) || null });
                        }
                        const { dispatchUnfollows } = await import('./twitch-analytics-alerts.js');
                        await dispatchUnfollows(bid, list, { since: prev?.snapshot_at || null, until: now })
                            .catch((e) => logger.warn(`${LOG} unfollow post for ${cfg.broadcaster_twitch_username} failed: ${e.message}`));
                    }
                }
            }

            const currentIds = Array.from(current.keys());
            await pool.query(
                `INSERT INTO twitch_follower_snapshot (broadcaster_id, follower_ids_json, total_count, snapshot_at)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                     follower_ids_json = VALUES(follower_ids_json),
                     total_count = VALUES(total_count),
                     snapshot_at = VALUES(snapshot_at)`,
                [bid, JSON.stringify(currentIds), currentIds.length, observedAtSql]);
        } catch (e) {
            logger.warn(`${LOG} churn for ${cfg.broadcaster_twitch_username} failed: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 500));
    }
    logger.info(`${LOG} follower churn sweep done`);
}

/**
 * Re-check each id missing from the paged list with a direct lookup. Ids still following go
 * back into `current` (so the snapshot keeps them); the rest are real unfollows. Past the
 * verify cap, ids are kept as followers this run and re-checked next hour rather than guessed.
 */
async function confirmUnfollows(axios, headers, bid, candidates, current) {
    const removed = [];
    for (let i = 0; i < candidates.length; i++) {
        const id = candidates[i];
        if (i >= CHURN_MAX_VERIFY) { current.set(id, {}); continue; }
        try {
            const r = await axios.get('https://api.twitch.tv/helix/channels/followers', {
                headers, params: { broadcaster_id: bid, user_id: id }, timeout: 10_000,
            });
            if ((r.data?.data || []).length) current.set(id, {});
            else removed.push(id);
        } catch {
            current.set(id, {});   // lookup failed: unknown, so not an unfollow yet
        }
    }
    return removed;
}

/** Login + display name for ids; a deleted or suspended account is simply absent. */
async function lookupUsers(axios, headers, ids) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += 100) {
        const params = new URLSearchParams();
        for (const id of ids.slice(i, i + 100)) params.append('id', id);
        try {
            const r = await axios.get(`https://api.twitch.tv/helix/users?${params}`, { headers, timeout: 10_000 });
            for (const u of r.data?.data || []) out.set(String(u.id), { login: u.login, display_name: u.display_name });
        } catch { /* names are optional */ }
    }
    return out;
}

/** When each id first followed, from our own add rows (only known for follows we saw happen). */
async function followedSince(bid, ids) {
    const out = new Map();
    if (!ids.length) return out;
    const [rows] = await pool.query(
        `SELECT user_id, MAX(COALESCE(followed_at, observed_at)) AS at FROM twitch_follower_changes
          WHERE broadcaster_id = ? AND change_type = 'add' AND user_id IN (?) GROUP BY user_id`, [bid, ids]);
    for (const r of rows) out.set(String(r.user_id), r.at);
    return out;
}

/**
 * Clip view-count delta — snapshot every clip's current view count daily. The resulting
 * table lets us plot "clip gaining traction right now" vs "clip plateau'd long ago".
 */
async function runClipViewDelta() {
    const nowKey = new Date().toISOString().slice(0, 10);
    if (lastClipDeltaAt === nowKey) return;
    lastClipDeltaAt = nowKey;

    logger.info(`${LOG} clip view-count snapshot starting`);
    const [configs] = await pool.query(
        `SELECT broadcaster_twitch_id FROM twitch_role_sync_config WHERE enabled = 1`);
    const axios = (await import('axios')).default;
    // Use the app token here — clips endpoint is public, no user scope needed.
    const { getAccessToken } = await import('../utils/platforms/twitch-api.js');
    let appToken; try { appToken = await getAccessToken(); } catch { return; }
    if (!appToken) return;

    const observedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
    for (const cfg of configs) {
        const bid = String(cfg.broadcaster_twitch_id);
        try {
            // Pull clips we already know about; refresh view count only.
            const [known] = await pool.query(
                `SELECT clip_id FROM twitch_clips_catalog WHERE broadcaster_id = ? ORDER BY created_at_twitch DESC LIMIT 500`, [bid]);
            if (!known.length) continue;
            const chunks = [];
            for (let i = 0; i < known.length; i += 100) chunks.push(known.slice(i, i + 100));
            for (const chunk of chunks) {
                const params = new URLSearchParams();
                for (const c of chunk) params.append('id', c.clip_id);
                const r = await axios.get(`https://api.twitch.tv/helix/clips?${params}`, {
                    headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${appToken}` },
                    timeout: 10_000,
                });
                for (const c of r.data?.data || []) {
                    await pool.query(
                        `INSERT INTO twitch_clip_view_snapshots (clip_id, broadcaster_id, view_count, snapshot_at)
                         VALUES (?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE view_count = VALUES(view_count)`,
                        [c.id, bid, c.view_count || 0, observedAt]);
                    // Also update the catalog so Top Clips chart stays fresh.
                    await pool.query(
                        `UPDATE twitch_clips_catalog SET view_count = ? WHERE clip_id = ?`,
                        [c.view_count || 0, c.id]).catch(() => {});
                }
                await new Promise(r => setTimeout(r, 200));
            }
        } catch (e) {
            logger.warn(`${LOG} clip view snapshot for ${bid} failed: ${e.message}`);
        }
    }
    logger.info(`${LOG} clip view-count snapshot done`);
}

/**
 * Hourly chat sentiment batch. Scores up to 50 unscored chat samples per broadcaster per
 * hour. Opt-in via ai_auto_sentiment. Bounded by ai_daily_call_cap in the AI module.
 */
async function runSentimentBatch() {
    const slot = Math.floor(Date.now() / (60 * 60 * 1000));
    if (lastSentimentAt === slot) return;
    lastSentimentAt = slot;

    logger.info(`${LOG} sentiment batch starting`);
    const { scoreSentimentBatch } = await import('./twitch-ai.js').catch(() => ({}));
    if (!scoreSentimentBatch) return;

    const [configs] = await pool.query(
        `SELECT broadcaster_id FROM twitch_analytics_alerts_config
          WHERE ai_enabled = 1 AND ai_auto_sentiment = 1 AND broadcaster_id IS NOT NULL`);
    for (const cfg of configs) {
        const bid = String(cfg.broadcaster_id);
        try {
            // Pull up to 50 recent samples that haven't been scored yet.
            const [samples] = await pool.query(
                `SELECT m.id, m.message_text
                   FROM twitch_chat_message_samples m
                   LEFT JOIN twitch_ai_message_sentiments s ON s.sample_id = m.id
                  WHERE m.broadcaster_id = ? AND s.sample_id IS NULL
                    AND m.occurred_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
                    AND ${sqlNotBot('m.chatter_user_login')}
                  ORDER BY m.id DESC LIMIT 50`, [bid]);
            if (!samples.length) continue;
            await scoreSentimentBatch(bid, samples);
        } catch (e) {
            logger.warn(`${LOG} sentiment batch for ${bid} failed: ${e.message}`);
        }
    }
    // Also run AI chat moderation for broadcasters who've opted in.
    const { moderateChat } = await import('./twitch-ai.js').catch(() => ({}));
    if (moderateChat) {
        const [modCfgs] = await pool.query(
            `SELECT broadcaster_id FROM twitch_analytics_alerts_config
              WHERE ai_enabled = 1 AND ai_chat_mod_enabled = 1 AND broadcaster_id IS NOT NULL`);
        for (const cfg of modCfgs) {
            try { await moderateChat(cfg.broadcaster_id); }
            catch (e) { logger.warn(`${LOG} chat mod for ${cfg.broadcaster_id} failed: ${e.message}`); }
        }
    }
    logger.info(`${LOG} sentiment+mod batch done`);
}

/**
 * Big-moment live-stream watcher. Runs every 5 min; iterates currently-live broadcasters
 * who have AI enabled, calls detectBigMoments, DMs the configured alert channel on hits.
 */
async function runBigMomentScan() {
    const slot = Math.floor(Date.now() / (5 * 60 * 1000));
    if (lastBigMomentAt === slot) return;
    lastBigMomentAt = slot;

    const { detectBigMoments } = await import('./twitch-ai.js').catch(() => ({}));
    if (!detectBigMoments) return;
    const [configs] = await pool.query(
        `SELECT c.broadcaster_id, c.guild_id, c.alert_channel_id FROM twitch_analytics_alerts_config c
          WHERE c.ai_enabled = 1 AND c.broadcaster_id IS NOT NULL AND c.alert_channel_id IS NOT NULL`);
    for (const cfg of configs) {
        try {
            const r = await detectBigMoments(cfg.broadcaster_id);
            if (r?.worth_alerting && r?.message) {
                // Dispatch to the alert channel via botManager.
                const client = globalThis.botManager?.getClientForGuild?.(cfg.guild_id);
                if (!client) continue;
                const ch = client.channels.cache.get(cfg.alert_channel_id)
                    || await client.channels.fetch(cfg.alert_channel_id).catch(() => null);
                if (ch?.isTextBased?.()) {
                    const { EmbedBuilder } = await import('discord.js');
                    const embed = new EmbedBuilder()
                        .setTitle('⚡ Live big-moment alert')
                        .setColor(0x22d3ee)
                        .setDescription(r.message)
                        .setFooter({ text: `z-score ${r.zScore?.toFixed(2) || '?'} · AI watcher` })
                        .setTimestamp();
                    await ch.send({ embeds: [embed] });
                }
            }
        } catch (e) { logger.warn(`${LOG} big-moment for ${cfg.broadcaster_id}: ${e.message}`); }
    }
}

function tick() {

    // Daily, weekly and 6-hourly jobs run from runDueJobs(), not here.
    // Sentiment batch every hour.
    runSentimentBatch().catch(e => logger.error(`${LOG} sentiment tick failed: ${e.message}`));
    import('./twitch-extra-capture.js').then(m => m.runStreamMarkers()).catch(e => logger.warn(`${LOG} stream markers: ${e.message}`));
    // Big-moment watcher — ticks every hour but it has its own 5-min slot dedup internally,
    // so we drive it from an explicit setInterval below rather than the hourly tick.
}

// Separate 5-min interval for big-moment scanner so the hourly tick doesn't gate it.
setInterval(() => {
    try { import('./twitch-analytics-cron.js').then(() => {}); } catch {}
    try { if (bootstrapped) runBigMomentScan().catch(e => logger.warn(`${LOG} big-moment tick: ${e.message}`)); } catch {}
    if (bootstrapped) import('./twitch-extra-capture.js').then(m => m.runCategoryRank()).catch(e => logger.warn(`${LOG} category rank: ${e.message}`));
}, 5 * 60 * 1000);

// Scheduled jobs run once their slot has passed and record each run in cron_job_runs, so
// frequent pm2 restarts neither skip a day (the old hourly timer restarted with the process
// and rarely landed in the target hour) nor repeat one.
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
function lastDailyAt(now, hour) {
    const t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour);
    return t <= now.getTime() ? t : t - DAY_MS;
}
function lastWeeklyAt(now, dow, hour) {
    let t = lastDailyAt(now, hour);
    while (new Date(t).getUTCDay() !== dow) t -= DAY_MS;
    return t;
}
const SCHEDULED_JOBS = [
    { key: 'twitch.nightly_backfill', due: (n) => lastDailyAt(n, INTERVALS.nightlyBackfillHourUtc), run: () => runNightlyBackfill() },
    { key: 'twitch.follower_churn', due: (n) => Math.floor(n.getTime() / HOUR_MS) * HOUR_MS, run: () => runFollowerChurn() },
    { key: 'twitch.clip_view_delta', due: (n) => lastDailyAt(n, 5), run: () => runClipViewDelta() },
    { key: 'twitch.channel_assets', due: (n) => lastDailyAt(n, 5),
      run: () => import('./twitch-extra-capture.js').then(m => m.runChannelAssets()) },
    { key: 'twitch.peer_buckets', due: (n) => lastDailyAt(n, 5),
      run: () => import('./twitch-peer-insights.js').then(m => m.rebuildPeerBuckets()) },
    // A digest more than a day late is skipped rather than sent mid-week.
    { key: 'twitch.weekly_digest', graceMs: DAY_MS,
      due: (n) => lastWeeklyAt(n, INTERVALS.weeklyDigestDayUtc, INTERVALS.weeklyDigestHourUtc), run: () => runWeeklyDigest() },
    // New chat accounts get checked against the known-bot list within the hour; bounded per run.
    { key: 'twitch.known_bot_sweep', due: (n) => Math.floor(n.getTime() / HOUR_MS) * HOUR_MS,
      run: () => import('./twitch-known-bots.js').then(m => m.runKnownBotSweep()) },
    // Our own "last seen live" for tracked accounts (Twitch's API has no last-live field).
    { key: 'twitch.tracked_live_poll', due: (n) => Math.floor(n.getTime() / (10 * 60 * 1000)) * 10 * 60 * 1000,
      run: () => import('./twitch-known-bots.js').then(m => m.pollTrackedLive()) },
    { key: 'twitch.milestones',
      due: (n) => Math.floor(n.getTime() / (INTERVALS.milestonesHours * HOUR_MS)) * INTERVALS.milestonesHours * HOUR_MS,
      run: () => recomputeMilestones() },
    // Each channel's 30-day mark is checked per channel inside the job; this just runs it every scan.
    { key: 'twitch.integrity_snapshots', due: (n) => Math.floor(n.getTime() / (10 * 60 * 1000)) * 10 * 60 * 1000,
      run: () => import('./twitch-integrity-snapshots.js').then(m => m.runIntegritySnapshots()) },
];
let dueJobsRunning = false;
async function runDueJobs() {
    if (dueJobsRunning) return;
    dueJobsRunning = true;
    try {
        const now = new Date();
        const [rows] = await pool.query('SELECT job_key, last_started_at FROM cron_job_runs');
        const lastRun = new Map(rows.map(r => [r.job_key, r.last_started_at ? new Date(r.last_started_at).getTime() : 0]));
        for (const job of SCHEDULED_JOBS) {
            const dueAt = job.due(now);
            if ((lastRun.get(job.key) || 0) >= dueAt) continue;
            if (job.graceMs && now.getTime() - dueAt > job.graceMs) continue;
            await pool.query(
                `INSERT INTO cron_job_runs (job_key, last_started_at) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE last_started_at = VALUES(last_started_at)`, [job.key, now]);
            let ok = 1, error = null;
            try { await job.run(); }
            catch (e) { ok = 0; error = String(e.message).slice(0, 500); logger.error(`${LOG} ${job.key} failed: ${e.message}`); }
            await pool.query(
                'UPDATE cron_job_runs SET last_finished_at = ?, last_ok = ?, last_error = ? WHERE job_key = ?',
                [new Date(), ok, error, job.key]);
        }
    } catch (e) {
        logger.warn(`${LOG} due-job scan failed: ${e.message}`);
    } finally {
        dueJobsRunning = false;
    }
}

export function init() {
    if (bootstrapped) return;
    bootstrapped = true;
    // 30s after import, do a milestone recompute so brand-new deployments get populated once.
    setTimeout(() => recomputeMilestones().catch(e => logger.warn(`${LOG} initial milestones: ${e.message}`)), 30_000);
    // Hourly ticker.
    setTimeout(() => {
        import('./twitch-extra-capture.js').then(m => m.runChannelAssets()).catch(e => logger.warn(`${LOG} initial channel assets: ${e.message}`));
        import('./twitch-extra-capture.js').then(m => m.runStreamMarkers()).catch(e => logger.warn(`${LOG} initial stream markers: ${e.message}`));
    }, 90_000);
    setInterval(tick, 60 * 60 * 1000);
    setTimeout(() => runDueJobs(), 120_000);
    setInterval(() => runDueJobs(), 10 * 60 * 1000);
    logger.info(`${LOG} initialized — nightly backfill ${INTERVALS.nightlyBackfillHourUtc}:00 UTC, weekly digest Mon ${INTERVALS.weeklyDigestHourUtc}:00 UTC, milestones every ${INTERVALS.milestonesHours}h`);
}

export const _test = { confirmUnfollows, runDueJobs, lastDailyAt, lastWeeklyAt, runNightlyBackfill, recomputeMilestones, runWeeklyDigest, runFollowerChurn, runClipViewDelta, runSentimentBatch, runBigMomentScan };
