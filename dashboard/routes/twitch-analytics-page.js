/**
 * Dedicated Twitch analytics page (admin-only).
 *
 * Route: GET /manage/:guildId/twitch-analytics?range=24h|7d|30d|90d
 *
 * Guarded by checkAuth + checkGuildAdmin — the standard pair that also grants
 * super-admin access to any guild for debugging (see dashboard/middleware/auth.js).
 *
 * The analytics tab in /manage/<g>?page=streamers is a mix of config + a few
 * compact data lists. This page is pure data, full-page, with charts and the
 * depth needed to actually analyze a stream. Each range re-queries from the
 * raw per-minute snapshots + v2 event tables (migrations 342 + 358).
 */
import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import ejs from 'ejs';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { checkAuth, checkGuildAdmin } from '../middleware/auth.js';
import { isSuperAdmin } from '../../utils/constants.js';
import { sqlNotBot } from '../../utils/twitch-chat-bots.js';
import { getBackfillSummary, runBackfillFromConfig } from '../../core/twitch-backfill.js';
import { init as initAnalyticsCron } from '../../core/twitch-analytics-cron.js';
import * as twitchWrite from '../../core/twitch-write.js';
import * as twitchAI from '../../core/twitch-ai.js';
import * as peerInsights from '../../core/twitch-peer-insights.js';
import * as vodTranscripts from '../../core/twitch-vod-transcripts.js';
import * as twitchVision from '../../core/twitch-vision.js';
import { buildIntegrityReport, buildKnownBotList, renderIntegrityFiles, alertChatMessages, clearIntegrityCache, THRESHOLDS as INTEGRITY_THRESHOLDS } from '../../core/twitch-integrity-report.js';
import { getBrowser, closeBrowser } from '../../utils/browserManager.js';
import { followsOf } from '../../core/twitch-follows-archive.js';

// Self-boot the analytics cron (nightly backfill + weekly digest + milestones) when this
// route module is first imported — same pattern other core managers follow.
initAnalyticsCron();

const router = express.Router();

// A failed section query renders that section empty instead of failing the page — but the
// failure must be visible, or broken queries look like "no data" (as several did).
function emptyOnQueryError(err) {
    const sql = String(err.sql || '').replace(/\s+/g, ' ').slice(0, 140);
    logger.warn(`[TwitchAnalyticsPage] section query failed: ${err.message} — ${sql}`);
    return [[]];
}

const RANGES = {
    '24h': { label: 'Last 24 hours', hours: 24, grainMinutes: 15 },
    '7d':  { label: 'Last 7 days',   hours: 24 * 7,  grainMinutes: 60 },
    '30d': { label: 'Last 30 days',  hours: 24 * 30, grainMinutes: 60 * 6 },
    '90d': { label: 'Last 90 days',  hours: 24 * 90, grainMinutes: 60 * 24 },
};

async function renderAnalytics(req, res, opts = {}) {
    const guildId = req.params.guildId;
    const rangeKey = RANGES[req.query.range] ? req.query.range : '7d';
    const range = RANGES[rangeKey];

    try {
        // Resolve broadcaster for this guild. We pull created_at + role sync columns so the
        // view can show (a) a "just connected" banner on brand-new OAuth links, and (b) a
        // "role sync not configured" prompt when the three Discord role IDs are all null.
        const [cfgRows] = await pool.execute(
            `SELECT broadcaster_twitch_id, broadcaster_twitch_username, token_scopes,
                    created_at AS connected_at, last_synced,
                    vip_role_id, mod_role_id, sub_role_id,
                    tier_b_token IS NOT NULL AS tier_b_granted,
                    tier_b_scopes, tier_b_granted_at,
                    broadcaster_token_status, tier_b_token_status
               FROM twitch_role_sync_config
              WHERE guild_id = ? AND enabled = 1
                AND broadcaster_twitch_id IS NOT NULL
              ORDER BY last_synced DESC LIMIT 1`,
            [guildId]);
        const cfg = cfgRows[0];
        if (!cfg) {
            return res.render('twitch-analytics', {
                user: req.user, guildId, guildName: req.guildObject?.name || guildId,
                range: rangeKey, ranges: RANGES, broadcaster: null, data: null,
                isSuperAdmin: !!req.isSuperAdmin, shareMode: !!opts.shareMode,
            });
        }

        const bid = String(cfg.broadcaster_twitch_id);
        const connectedAt = cfg.connected_at ? new Date(cfg.connected_at) : null;
        const connectionAgeMs = connectedAt ? (Date.now() - connectedAt.getTime()) : null;
        const broadcaster = {
            twitch_id: bid,
            login: cfg.broadcaster_twitch_username,
            scopes: String(cfg.token_scopes || '').split(/[\s,]+/).filter(Boolean),
            connected_at: cfg.connected_at,
            last_synced: cfg.last_synced,
            // "Just connected" banner fires inside the first hour — long enough for the first
            // backfill to land and for EventSub webhooks to start arriving.
            just_connected: connectionAgeMs !== null && connectionAgeMs < 60 * 60 * 1000,
            role_sync_configured: !!(cfg.vip_role_id || cfg.mod_role_id || cfg.sub_role_id),
            // Set by the hourly token check (core/twitch-token-validator.js) when Twitch refuses the token and its refresh.
            needs_reauth: cfg.broadcaster_token_status === 'needs_reauth',
            write_needs_reauth: !!cfg.tier_b_granted && cfg.tier_b_token_status === 'needs_reauth',
            role_sync: {
                vip_role_id: cfg.vip_role_id || null,
                mod_role_id: cfg.mod_role_id || null,
                sub_role_id: cfg.sub_role_id || null,
            },
            tier_b_granted: !!cfg.tier_b_granted,
            tier_b_scopes: String(cfg.tier_b_scopes || '').split(/[\s,]+/).filter(Boolean),
            tier_b_granted_at: cfg.tier_b_granted_at || null,
        };

        // Window: from now going back by `range.hours`.
        const sinceSql = `DATE_SUB(NOW(), INTERVAL ${Number(range.hours)} HOUR)`;

        // Fire all independent queries in parallel.
        const [
            [sessions],
            [headline],
            [timelineRaw],
            [dailyGrowth],
            [liveHoursByDow],
            [topGames],
            [titleChanges],
            [subChurn],
            [newSubs],
            [bitsTotal],
            [charityTotal],
            [adBreaksSum],
            [redemptionsTop],
            [hypeTrains],
            [goals],
            [polls],
            [predictions],
            [shoutouts],
            [resubs],
            [vipMod],
            [recentAlerts],
            [categoryHist],
            [recentChatters],
            [linkedMembers],
            [clipsDaily],
            [clipsRecent],
            [subsList],
            [conduitRow],
            [lastIngest],
        ] = await Promise.all([
            // Sessions in window.
            pool.execute(
                `SELECT id, started_at, ended_at, duration_minutes, peak_viewers,
                        avg_viewers, total_msgs, unique_chatters, total_follows,
                        total_subs, total_gift_subs, total_bits, total_raids_in,
                        total_mod_actions, primary_category_name, title_at_start,
                        title_change_count, category_change_count
                   FROM twitch_stream_sessions
                  WHERE broadcaster_id = ? AND started_at > ${sinceSql}
                  ORDER BY started_at DESC`, [bid]),

            // Headline KPIs — aggregates across the window from snapshots.
            pool.execute(
                `SELECT COUNT(DISTINCT DATE(recorded_at)) AS stream_days,
                        COALESCE(SUM(is_live), 0) AS live_minutes,
                        COALESCE(MAX(viewer_count), 0) AS peak_viewers,
                        COALESCE(AVG(NULLIF(viewer_count, 0)), 0) AS avg_viewers,
                        COALESCE(SUM(msg_count), 0) AS total_msgs,
                        COALESCE(SUM(follow_count), 0) AS total_follows,
                        COALESCE(SUM(sub_count), 0) AS total_subs,
                        COALESCE(SUM(gift_sub_count), 0) AS total_gift_subs,
                        COALESCE(SUM(bit_count), 0) AS total_bits,
                        COALESCE(SUM(raid_in_count), 0) AS total_raids,
                        COALESCE(SUM(mod_action_count), 0) AS total_mod_actions,
                        COALESCE(SUM(deleted_msg_count), 0) AS total_deleted_msgs
                   FROM twitch_stream_snapshots
                  WHERE broadcaster_id = ? AND recorded_at > ${sinceSql}`, [bid]),

            // Viewer timeline (binned by grain minutes) for Chart.js line chart.
            pool.execute(
                `SELECT UNIX_TIMESTAMP(FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(recorded_at) / ${range.grainMinutes * 60}) * ${range.grainMinutes * 60})) AS bucket_ts,
                        COALESCE(AVG(NULLIF(viewer_count, 0)), 0) AS avg_v,
                        COALESCE(MAX(viewer_count), 0) AS peak_v,
                        COALESCE(SUM(msg_count), 0) AS msgs
                   FROM twitch_stream_snapshots
                  WHERE broadcaster_id = ? AND recorded_at > ${sinceSql} AND is_live = 1
                  GROUP BY bucket_ts
                  ORDER BY bucket_ts ASC`, [bid]),

            // Daily growth bars (follows / subs / bits per day).
            pool.execute(
                `SELECT DATE(recorded_at) AS d,
                        COALESCE(SUM(follow_count), 0) AS follows,
                        COALESCE(SUM(sub_count), 0) AS subs,
                        COALESCE(SUM(gift_sub_count), 0) AS gift_subs,
                        COALESCE(SUM(bit_count), 0) AS bits,
                        COALESCE(SUM(is_live), 0) AS live_min
                   FROM twitch_stream_snapshots
                  WHERE broadcaster_id = ? AND recorded_at > ${sinceSql}
                  GROUP BY DATE(recorded_at)
                  ORDER BY d ASC`, [bid]),

            // Live hours by day of week + hour of day.
            pool.execute(
                `SELECT DAYOFWEEK(recorded_at) AS dow, HOUR(recorded_at) AS h,
                        COUNT(*) AS live_minutes
                   FROM twitch_stream_snapshots
                  WHERE broadcaster_id = ? AND recorded_at > ${sinceSql} AND is_live = 1
                  GROUP BY dow, h`, [bid]),

            // Top games by live minutes. The session rollup (jobs/twitch-analytics-aggregator.js:260)
            // only fills primary_category_name on stream.offline — a live stream has NULL there, so
            // reading from twitch_stream_sessions misses every category used in-flight. Instead
            // compute spans from twitch_category_history (each change starts a span that ends at
            // the next change, or NOW() for the current span) and count 1-minute live snapshots
            // whose recorded_at falls inside each span: COUNT = live minutes in that category.
            pool.execute(
                `SELECT cs.category_name AS game,
                        COUNT(DISTINCT cs.span_start) AS sessions,
                        COUNT(s.id) AS total_min
                   FROM (
                     SELECT category_name,
                            changed_at AS span_start,
                            COALESCE(
                              LEAD(changed_at) OVER (PARTITION BY broadcaster_id ORDER BY changed_at),
                              NOW()
                            ) AS span_end
                       FROM twitch_category_history
                      WHERE broadcaster_id = ? AND changed_at > ${sinceSql}
                        AND category_name IS NOT NULL
                   ) cs
                   LEFT JOIN twitch_stream_snapshots s
                     ON s.broadcaster_id = ? AND s.is_live = 1
                        AND s.recorded_at >= cs.span_start
                        AND s.recorded_at <  cs.span_end
                  GROUP BY cs.category_name
                  ORDER BY total_min DESC LIMIT 10`, [bid, bid]),

            // Title / category change counts across window.
            pool.execute(
                `SELECT COALESCE(SUM(title_change_count), 0) AS title_changes,
                        COALESCE(SUM(category_change_count), 0) AS category_changes
                   FROM twitch_stream_sessions
                  WHERE broadcaster_id = ? AND started_at > ${sinceSql}`, [bid]),

            // Sub endings count.
            pool.execute(
                `SELECT COUNT(*) AS n FROM twitch_sub_endings
                  WHERE broadcaster_id = ? AND occurred_at > ${sinceSql}`, [bid]),

            // (new subs in headline already)
            pool.execute(`SELECT 1`, []),

            // (bits in headline already)
            pool.execute(`SELECT 1`, []),

            // Charity total raised.
            pool.execute(
                `SELECT COALESCE(SUM(donation_amount), 0) AS raised,
                        COUNT(DISTINCT campaign_id) AS campaigns,
                        COUNT(*) AS events
                   FROM twitch_charity_events
                  WHERE broadcaster_id = ? AND occurred_at > ${sinceSql}
                    AND event_type = 'donate'`, [bid]),

            // Ad breaks.
            pool.execute(
                `SELECT COUNT(*) AS n, COALESCE(SUM(duration_seconds), 0) AS s,
                        COALESCE(SUM(is_automatic), 0) AS auto_n
                   FROM twitch_ad_breaks
                  WHERE broadcaster_id = ? AND started_at > ${sinceSql}`, [bid]),

            // Top rewards by redemption count.
            pool.execute(
                `SELECT reward_title, reward_cost, COUNT(*) AS redemption_count,
                        MAX(redeemed_at) AS last_at
                   FROM twitch_redemption_events
                  WHERE broadcaster_id = ? AND redeemed_at > ${sinceSql}
                    AND reward_title IS NOT NULL
                  GROUP BY reward_title, reward_cost
                  ORDER BY redemption_count DESC LIMIT 10`, [bid]),

            // Hype trains.
            pool.execute(
                `SELECT hype_train_id, event_type, level, total_bits, total_subs,
                        goal, progress, is_golden, occurred_at
                   FROM twitch_hype_train_events
                  WHERE broadcaster_id = ? AND occurred_at > ${sinceSql}
                    AND event_type IN ('begin','end')
                  ORDER BY occurred_at DESC LIMIT 30`, [bid]),

            // Goals (latest row per goal_id).
            pool.execute(
                `SELECT g.* FROM twitch_goal_events g
                   INNER JOIN (
                     SELECT goal_id, MAX(occurred_at) AS latest
                       FROM twitch_goal_events
                      WHERE broadcaster_id = ? AND occurred_at > ${sinceSql}
                      GROUP BY goal_id
                   ) l ON g.goal_id = l.goal_id AND g.occurred_at = l.latest
                  WHERE g.broadcaster_id = ?
                  ORDER BY g.occurred_at DESC LIMIT 20`, [bid, bid]),

            // Polls (last end rows).
            pool.execute(
                `SELECT p.* FROM twitch_poll_events p
                   INNER JOIN (
                     SELECT poll_id, MAX(occurred_at) AS latest
                       FROM twitch_poll_events
                      WHERE broadcaster_id = ? AND occurred_at > ${sinceSql}
                        AND event_type = 'end'
                      GROUP BY poll_id
                   ) l ON p.poll_id = l.poll_id AND p.occurred_at = l.latest
                  WHERE p.broadcaster_id = ?
                  ORDER BY p.occurred_at DESC LIMIT 20`, [bid, bid]),

            // Predictions.
            pool.execute(
                `SELECT p.* FROM twitch_prediction_events p
                   INNER JOIN (
                     SELECT prediction_id, MAX(occurred_at) AS latest
                       FROM twitch_prediction_events
                      WHERE broadcaster_id = ? AND occurred_at > ${sinceSql}
                        AND event_type = 'end'
                      GROUP BY prediction_id
                   ) l ON p.prediction_id = l.prediction_id AND p.occurred_at = l.latest
                  WHERE p.broadcaster_id = ?
                  ORDER BY p.occurred_at DESC LIMIT 20`, [bid, bid]),

            // Shoutouts.
            pool.execute(
                `SELECT direction, counterpart_user_login, moderator_user_login,
                        viewer_count, occurred_at
                   FROM twitch_shoutout_events
                  WHERE broadcaster_id = ? AND occurred_at > ${sinceSql}
                  ORDER BY occurred_at DESC LIMIT 30`, [bid]),

            // Resub messages with text.
            pool.execute(
                `SELECT user_login, tier, cumulative_months, streak_months, message, occurred_at
                   FROM twitch_resub_messages
                  WHERE broadcaster_id = ? AND occurred_at > ${sinceSql}
                    AND message IS NOT NULL AND message != ''
                  ORDER BY occurred_at DESC LIMIT 20`, [bid]),

            // VIP + mod changes.
            pool.execute(
                `SELECT role, action, target_user_login, occurred_at
                   FROM twitch_vip_mod_changes
                  WHERE broadcaster_id = ? AND occurred_at > ${sinceSql}
                  ORDER BY occurred_at DESC LIMIT 30`, [bid]),

            // Anomaly alerts. By default hide superseded (proven false positives) so the
            // UI stays focused on actionable items. Pass ?include_superseded=1 to see everything.
            pool.execute(
                req.query.include_superseded === '1'
                    ? `SELECT id, alert_type, severity, score, evidence_json, status, resolved_by_discord_id, resolution_note, created_at
                         FROM twitch_anomaly_alerts
                        WHERE broadcaster_id = ? AND created_at > ${sinceSql}
                        ORDER BY created_at DESC LIMIT 50`
                    : `SELECT id, alert_type, severity, score, evidence_json, status, resolved_by_discord_id, resolution_note, created_at
                         FROM twitch_anomaly_alerts
                        WHERE broadcaster_id = ? AND created_at > ${sinceSql} AND status != 'superseded'
                        ORDER BY created_at DESC LIMIT 30`,
                [bid]),

            // Category history.
            pool.execute(
                `SELECT changed_at, title, category_name, language
                   FROM twitch_category_history
                  WHERE broadcaster_id = ? AND changed_at > ${sinceSql}
                  ORDER BY changed_at DESC LIMIT 30`, [bid]),

            // Chatters: avg + max unique chatters per snapshot across window.
            pool.execute(
                `SELECT COALESCE(AVG(total_count), 0) AS avg_c,
                        COALESCE(MAX(total_count), 0) AS peak_c,
                        COUNT(*) AS snapshot_count
                   FROM twitch_chatters_snapshots
                  WHERE broadcaster_id = ? AND recorded_at > ${sinceSql}`, [bid]),

            // Linked Discord ↔ Twitch members for THIS guild. Role sync populates this
            // for every member who's authorised the identity flow; is_vip/is_mod/is_sub
            // are the per-member Twitch status flags, refreshed on each sync pass.
            pool.execute(
                `SELECT COUNT(*) AS total,
                        COALESCE(SUM(is_vip), 0) AS vips,
                        COALESCE(SUM(is_mod), 0) AS mods,
                        COALESCE(SUM(is_sub), 0) AS subs,
                        COALESCE(SUM(CASE WHEN last_synced > DATE_SUB(NOW(), INTERVAL 1 DAY) THEN 1 ELSE 0 END), 0) AS synced_24h,
                        COALESCE(SUM(CASE WHEN last_synced > DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 1 ELSE 0 END), 0) AS synced_7d
                   FROM twitch_role_sync_members
                  WHERE guild_id = ?`, [guildId]),

            // Clip autopost activity in window — joined via feed to filter to this guild's feeds.
            pool.execute(
                `SELECT DATE(cs.announced_at) AS d, COUNT(*) AS n
                   FROM twitch_clip_seen cs
                   JOIN twitch_clip_feeds cf ON cs.feed_id = cf.id
                  WHERE cf.guild_id = ? AND cs.announced_at > ${sinceSql}
                  GROUP BY DATE(cs.announced_at)
                  ORDER BY d ASC`, [guildId]),
            pool.execute(
                `SELECT cs.clip_id, cs.announced_at, cf.username, cf.broadcaster_id
                   FROM twitch_clip_seen cs
                   JOIN twitch_clip_feeds cf ON cs.feed_id = cf.id
                  WHERE cf.guild_id = ? AND cs.announced_at > ${sinceSql}
                  ORDER BY cs.announced_at DESC LIMIT 10`, [guildId]),

            // EventSub subscription ledger for this broadcaster — one row per topic.
            // Status != 'enabled' means Twitch has flagged the subscription (revoked, auth lost, etc).
            pool.execute(
                `SELECT sub_type, status, updated_at
                   FROM twitch_eventsub_subscriptions
                  WHERE broadcaster_id = ?
                  ORDER BY sub_type ASC`, [bid]),

            // Conduit health (global, 1 row). Analytics flow via the conduit; if it's gone/stale,
            // subs still exist but no events arrive. Shown in the Infra Health strip.
            pool.execute(
                `SELECT conduit_id, shard_count, created_at
                   FROM twitch_eventsub_conduit LIMIT 1`),

            // Last-ingest timestamps per table — a liveness probe. If "last chat message" is 3d
            // ago but subs show 'enabled', the pipeline is broken and the empty event tables mean
            // "nothing happening", not "subscription dead". Each MAX is cheap on indexed cols.
            pool.execute(
                `SELECT
                   (SELECT MAX(recorded_at) FROM twitch_stream_snapshots WHERE broadcaster_id = ?) AS last_snapshot,
                   (SELECT MAX(recorded_at) FROM twitch_chatters_snapshots WHERE broadcaster_id = ?) AS last_chatters,
                   (SELECT MAX(occurred_at)  FROM twitch_hype_train_events  WHERE broadcaster_id = ?) AS last_hype,
                   (SELECT MAX(occurred_at)  FROM twitch_goal_events        WHERE broadcaster_id = ?) AS last_goal,
                   (SELECT MAX(started_at)   FROM twitch_ad_breaks          WHERE broadcaster_id = ?) AS last_ad,
                   (SELECT MAX(occurred_at)  FROM twitch_charity_events     WHERE broadcaster_id = ?) AS last_charity,
                   (SELECT MAX(occurred_at)  FROM twitch_poll_events        WHERE broadcaster_id = ?) AS last_poll,
                   (SELECT MAX(occurred_at)  FROM twitch_prediction_events  WHERE broadcaster_id = ?) AS last_prediction,
                   (SELECT MAX(redeemed_at)  FROM twitch_redemption_events  WHERE broadcaster_id = ?) AS last_redemption,
                   (SELECT MAX(occurred_at)  FROM twitch_shoutout_events    WHERE broadcaster_id = ?) AS last_shoutout,
                   (SELECT MAX(occurred_at)  FROM twitch_resub_messages     WHERE broadcaster_id = ?) AS last_resub,
                   (SELECT MAX(occurred_at)  FROM twitch_vip_mod_changes    WHERE broadcaster_id = ?) AS last_vip_mod,
                   (SELECT MAX(changed_at)   FROM twitch_category_history   WHERE broadcaster_id = ?) AS last_category_change`,
                [bid, bid, bid, bid, bid, bid, bid, bid, bid, bid, bid, bid, bid]),
        ]);

        // Pull the one-shot Helix backfill summary + v2 wave 367 tables in parallel. Everything
        // channel-wide / lifetime that EventSub webhooks can't retroactively emit lives here.
        // Previous-window reference for period-over-period deltas. Shifted back by `range.hours`.
        const prevSinceSql = `DATE_SUB(NOW(), INTERVAL ${Number(range.hours * 2)} HOUR)`;
        const prevUntilSql = `DATE_SUB(NOW(), INTERVAL ${Number(range.hours)} HOUR)`;

        const [
            backfillSummary,
            [chatVelocityRows],
            [dowStatsRows],
            [subTierRow],
            [followerAgeRow],
            [bannedRow],
            [topVodsRows],
            [topClipsRows],
            [customRewardsRows],
            [backfillHistoryRows],
            [alertsCfgRow],
            [shareTokensRows],
            [prevHeadlineRows],
            [milestonesRows],
            [userPrefsRow],
            [gamesCacheRows],
            [unbanEventsRows],
            [chatNotificationsRows],
            [chatSettingsTimelineRows],
            [topChattersRows],
            [suspiciousUsersRows],
            [warningsRows],
            [unbanRequestsRows],
            [shieldModeEventsRows],
            [guestStarRows],
            [automodSettingsRow],
            [blockedTermsRows],
            [channelEditorsRows],
            [chatterWatchRows],
            [chatSampleStatsRow],
            [churnBreakdownRows],
            [churnEventsRows],
            [clipDeltaRows],
            [anomalyBySeverityRows],
            [anomalyByTypeRows],
            [topChattersByMsgsRows],
            [topWordsRows],
        ] = await Promise.all([
            getBackfillSummary(bid).catch(err => {
                logger.warn(`[TwitchAnalyticsPage] getBackfillSummary failed: ${err.message}`, { err: err.message, bid });
                return null;
            }),
            // Chat velocity: msgs per bucket in the window. Grain matches the viewer timeline.
            pool.execute(
                `SELECT UNIX_TIMESTAMP(FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(recorded_at) / ${range.grainMinutes * 60}) * ${range.grainMinutes * 60})) AS bucket_ts,
                        COALESCE(SUM(msg_count), 0) AS msgs
                   FROM twitch_stream_snapshots
                  WHERE broadcaster_id = ? AND recorded_at > ${sinceSql}
                  GROUP BY bucket_ts ORDER BY bucket_ts ASC`, [bid]).catch(emptyOnQueryError),
            // DoW stats: average session metrics by day-of-week.
            pool.execute(
                `SELECT DAYOFWEEK(started_at) AS dow,
                        COUNT(*) AS sessions,
                        AVG(avg_viewers) AS avg_viewers,
                        SUM(total_msgs) AS total_msgs,
                        SUM(total_follows) AS total_follows,
                        SUM(total_subs) AS total_subs,
                        SUM(total_bits) AS total_bits
                   FROM twitch_stream_sessions
                  WHERE broadcaster_id = ? AND started_at > ${sinceSql}
                  GROUP BY dow ORDER BY dow`, [bid]).catch(emptyOnQueryError),
            pool.execute(`SELECT * FROM twitch_subscriber_breakdown WHERE broadcaster_id = ?`, [bid]).catch(emptyOnQueryError),
            pool.execute(`SELECT * FROM twitch_follower_age_histogram WHERE broadcaster_id = ?`, [bid]).catch(emptyOnQueryError),
            pool.execute(`SELECT * FROM twitch_banned_summary WHERE broadcaster_id = ?`, [bid]).catch(emptyOnQueryError),
            pool.execute(`SELECT * FROM twitch_vods_catalog WHERE broadcaster_id = ? ORDER BY view_count DESC LIMIT 25`, [bid]).catch(emptyOnQueryError),
            pool.execute(`SELECT * FROM twitch_clips_catalog WHERE broadcaster_id = ? ORDER BY view_count DESC LIMIT 25`, [bid]).catch(emptyOnQueryError),
            // Custom rewards + their window redemption counts
            pool.execute(
                `SELECT r.*,
                        (SELECT COUNT(*) FROM twitch_redemption_events e WHERE e.reward_id = r.reward_id AND e.redeemed_at > ${sinceSql}) AS redemption_count,
                        (SELECT MAX(redeemed_at) FROM twitch_redemption_events e WHERE e.reward_id = r.reward_id) AS last_redeemed_at
                   FROM twitch_custom_rewards r
                  WHERE r.broadcaster_id = ?
                  ORDER BY r.is_enabled DESC, r.cost DESC`, [bid]).catch(emptyOnQueryError),
            pool.execute(`SELECT * FROM twitch_backfill_history WHERE broadcaster_id = ? ORDER BY started_at DESC LIMIT 10`, [bid]).catch(emptyOnQueryError),
            pool.execute(`SELECT * FROM twitch_analytics_alerts_config WHERE guild_id = ?`, [guildId]).catch(emptyOnQueryError),
            pool.execute(`SELECT * FROM twitch_analytics_share_tokens WHERE guild_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 10`, [guildId]).catch(emptyOnQueryError),
            // Previous-period headline (same shape as the primary headline, back-shifted by range).
            pool.execute(
                `SELECT COUNT(*) AS sessions,
                        COALESCE(SUM(duration_minutes), 0) AS live_minutes,
                        COALESCE(MAX(peak_viewers), 0) AS peak_viewers,
                        COALESCE(AVG(avg_viewers), 0) AS avg_viewers,
                        COALESCE(SUM(total_msgs), 0) AS total_msgs,
                        COALESCE(SUM(total_follows), 0) AS total_follows,
                        COALESCE(SUM(total_subs), 0) AS total_subs,
                        COALESCE(SUM(total_bits), 0) AS total_bits
                   FROM twitch_stream_sessions
                  WHERE broadcaster_id = ? AND started_at > ${prevSinceSql} AND started_at <= ${prevUntilSql}`, [bid]).catch(emptyOnQueryError),
            // Milestones callouts
            pool.execute(`SELECT * FROM twitch_milestones WHERE broadcaster_id = ?`, [bid]).catch(emptyOnQueryError),
            // Current viewer's user prefs — timezone, auto-refresh toggle, collapsed sections
            pool.execute(`SELECT * FROM twitch_analytics_user_prefs WHERE discord_user_id = ?`, [req.user?.id || '']).catch(emptyOnQueryError),
            // Games cache — all cached boxes for the categories this broadcaster has streamed
            pool.execute(
                `SELECT g.game_id, g.name, g.box_art_url FROM twitch_games_cache g
                  WHERE g.game_id IN (SELECT category_id FROM (
                      SELECT DISTINCT category_id FROM twitch_category_history
                       WHERE broadcaster_id = ? AND category_id IS NOT NULL LIMIT 100) recent_categories)`,
                [bid]).catch(emptyOnQueryError),
            // Unban events (wave 368)
            pool.execute(
                `SELECT target_user_login, moderator_user_login, occurred_at FROM twitch_unban_events
                  WHERE broadcaster_id = ? AND occurred_at > ${sinceSql} ORDER BY occurred_at DESC LIMIT 20`, [bid]).catch(emptyOnQueryError),
            // Chat notifications (wave 368) — first-time chatters, raid banners
            pool.execute(
                `SELECT notice_type, COUNT(*) AS n, MAX(occurred_at) AS last_at FROM twitch_chat_notifications
                  WHERE broadcaster_id = ? AND occurred_at > ${sinceSql} GROUP BY notice_type ORDER BY n DESC LIMIT 20`, [bid]).catch(emptyOnQueryError),
            // Chat settings change timeline
            pool.execute(
                `SELECT changed_at, follower_mode, subscriber_mode, slow_mode, slow_mode_wait_time, emote_mode, unique_chat_mode
                   FROM twitch_chat_settings_changes WHERE broadcaster_id = ? AND changed_at > ${sinceSql}
                  ORDER BY changed_at DESC LIMIT 30`, [bid]).catch(emptyOnQueryError),
            // Wave 369 — Tier A data
            // Top chatters all-time
            pool.execute(
                `SELECT chatter_user_login, chatter_display_name, sightings, sessions_seen, messages, first_seen_at, last_seen_at
                   FROM twitch_chatter_sightings s
                  WHERE s.broadcaster_id = ? AND s.chatter_user_id <> s.broadcaster_id AND ${sqlNotBot('s.chatter_user_login')}
                    AND (s.messages > 0 OR NOT EXISTS (
                         SELECT 1 FROM twitch_chatter_sightings z WHERE z.broadcaster_id = s.broadcaster_id AND z.messages > 0))
                  ORDER BY s.messages DESC, s.sightings DESC LIMIT 20`, [bid]).catch(emptyOnQueryError),
            // Suspicious user events in window
            pool.execute(
                `SELECT user_login, low_trust_status, types_json, ban_evasion_evaluation, message_text, occurred_at
                   FROM twitch_suspicious_users WHERE broadcaster_id = ? AND occurred_at > ${sinceSql}
                  ORDER BY occurred_at DESC LIMIT 30`, [bid]).catch(emptyOnQueryError),
            // Warnings in window
            pool.execute(
                `SELECT user_login, moderator_user_login, reason, occurred_at
                   FROM twitch_warnings WHERE broadcaster_id = ? AND event_type = 'send' AND occurred_at > ${sinceSql}
                  ORDER BY occurred_at DESC LIMIT 20`, [bid]).catch(emptyOnQueryError),
            // Unban requests in window
            pool.execute(
                `SELECT request_id, user_login, status, text, resolution_text, occurred_at
                   FROM twitch_unban_requests WHERE broadcaster_id = ? AND occurred_at > ${sinceSql}
                  ORDER BY occurred_at DESC LIMIT 20`, [bid]).catch(emptyOnQueryError),
            // Shield mode events in window
            pool.execute(
                `SELECT event_type, moderator_user_login, occurred_at
                   FROM twitch_shield_mode_events WHERE broadcaster_id = ? AND occurred_at > ${sinceSql}
                  ORDER BY occurred_at DESC LIMIT 30`, [bid]).catch(emptyOnQueryError),
            // Guest star sessions in window
            pool.execute(
                `SELECT session_id, event_type, guests_json, occurred_at
                   FROM twitch_guest_star_sessions WHERE broadcaster_id = ? AND occurred_at > ${sinceSql}
                  ORDER BY occurred_at DESC LIMIT 10`, [bid]).catch(emptyOnQueryError),
            // AutoMod settings snapshot
            pool.execute(`SELECT * FROM twitch_automod_settings WHERE broadcaster_id = ?`, [bid]).catch(emptyOnQueryError),
            // Blocked terms list
            pool.execute(
                `SELECT term_text, created_at_twitch, expires_at FROM twitch_blocked_terms WHERE broadcaster_id = ?
                  ORDER BY created_at_twitch DESC LIMIT 100`, [bid]).catch(emptyOnQueryError),
            // Channel editors
            pool.execute(
                `SELECT user_id, user_name, created_at_twitch FROM twitch_channel_editors WHERE broadcaster_id = ?
                  ORDER BY created_at_twitch DESC`, [bid]).catch(emptyOnQueryError),
            // Chatter watch list
            pool.execute(
                `SELECT id, chatter_user_login, label FROM twitch_chatter_watch WHERE broadcaster_id = ?
                  ORDER BY created_at DESC`, [bid]).catch(emptyOnQueryError),
            // Chat message sample stats (emote top-20 + word top-50)
            pool.execute(
                `SELECT COUNT(*) AS msgs, SUM(emote_count) AS emotes, SUM(has_link) AS links,
                        SUM(is_caps) AS caps, AVG(message_length) AS avg_len
                   FROM twitch_chat_message_samples WHERE broadcaster_id = ? AND occurred_at > ${sinceSql}`, [bid]).catch(emptyOnQueryError),
            // Wave 371 — follower churn in window
            pool.execute(
                `SELECT change_type, COUNT(*) AS n FROM twitch_follower_changes
                  WHERE broadcaster_id = ? AND observed_at > ${sinceSql} GROUP BY change_type`, [bid]).catch(emptyOnQueryError),
            pool.execute(
                `SELECT user_id, user_login, user_name, change_type, observed_at FROM twitch_follower_changes
                  WHERE broadcaster_id = ? AND observed_at > ${sinceSql}
                  ORDER BY observed_at DESC LIMIT 30`, [bid]).catch(emptyOnQueryError),
            // Clip view delta — clips that gained the most views since their first snapshot
            pool.execute(
                `SELECT c.clip_id, c.title, c.view_count AS current_views, c.url,
                        c.view_count - MIN(s.view_count) AS delta_views,
                        DATEDIFF(NOW(), MIN(s.snapshot_at)) AS days_tracked
                   FROM twitch_clips_catalog c
                   JOIN twitch_clip_view_snapshots s ON s.clip_id = c.clip_id
                  WHERE c.broadcaster_id = ?
                  GROUP BY c.clip_id, c.title, c.view_count, c.url
                 HAVING delta_views > 0
                  ORDER BY delta_views DESC LIMIT 10`, [bid]).catch(emptyOnQueryError),
            // Anomaly aggregates — EXCLUDE superseded (proven false positives) from headline
            // counts; the primary view should reflect alerts that actually matter. Acknowledged
            // alerts stay in the counts because they were investigated and confirmed real.
            // Full audit trail still exists; add ?include_superseded=1 to see everything.
            pool.execute(
                `SELECT severity, COUNT(*) AS n FROM twitch_anomaly_alerts
                  WHERE broadcaster_id = ? AND created_at > ${sinceSql} AND status != 'superseded'
                  GROUP BY severity`, [bid]).catch(emptyOnQueryError),
            pool.execute(
                `SELECT alert_type, severity, COUNT(*) AS n, MAX(score) AS peak_score, MAX(created_at) AS last_at
                   FROM twitch_anomaly_alerts WHERE broadcaster_id = ? AND created_at > ${sinceSql} AND status != 'superseded'
                  GROUP BY alert_type, severity ORDER BY n DESC`, [bid]).catch(emptyOnQueryError),
            // Top chatter aggregate — most chat messages sent per user
            pool.execute(
                `SELECT chatter_user_login, COUNT(*) AS msgs
                   FROM twitch_chat_message_samples WHERE broadcaster_id = ? AND occurred_at > ${sinceSql} AND (chatter_user_id IS NULL OR chatter_user_id <> broadcaster_id) AND ${sqlNotBot('chatter_user_login')}
                  GROUP BY chatter_user_login ORDER BY msgs DESC LIMIT 20`, [bid]).catch(emptyOnQueryError),
            // Top words in sampled chat
            pool.execute(
                `SELECT SUBSTRING_INDEX(SUBSTRING_INDEX(message_text, ' ', n.n), ' ', -1) AS word, COUNT(*) AS n
                   FROM twitch_chat_message_samples JOIN (
                       SELECT 1 AS n UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION
                       SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9 UNION SELECT 10
                   ) n ON CHAR_LENGTH(message_text) - CHAR_LENGTH(REPLACE(message_text, ' ', '')) >= n.n - 1
                  WHERE broadcaster_id = ? AND occurred_at > ${sinceSql} AND CHAR_LENGTH(message_text) > 0 AND (chatter_user_id IS NULL OR chatter_user_id <> broadcaster_id) AND ${sqlNotBot('chatter_user_login')}
                  GROUP BY word HAVING CHAR_LENGTH(word) >= 3 AND CHAR_LENGTH(word) <= 30
                  ORDER BY n DESC LIMIT 50`, [bid]).catch(emptyOnQueryError),
        ]);
        const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
        const bf = backfillSummary ? {
            follower_count: backfillSummary.follower_count,
            subscriber_count: backfillSummary.subscriber_count,
            subscriber_points: backfillSummary.subscriber_points,
            bits_leaderboard: parseJson(backfillSummary.bits_leaderboard_json) || [],
            bits_leaderboard_period: backfillSummary.bits_leaderboard_period,
            bits_total_period: backfillSummary.bits_total_period,
            current_vips: parseJson(backfillSummary.current_vips_json) || [],
            current_mods: parseJson(backfillSummary.current_mods_json) || [],
            current_stream: parseJson(backfillSummary.current_stream_json),
            current_channel: parseJson(backfillSummary.current_channel_json),
            charity_campaign: parseJson(backfillSummary.charity_campaign_json),
            active_goals: parseJson(backfillSummary.active_goals_json) || [],
            teams: parseJson(backfillSummary.teams_json) || [],
            // Wave 367 additions
            ad_schedule: parseJson(backfillSummary.ad_schedule_json),
            chat_settings: parseJson(backfillSummary.chat_settings_json),
            current_schedule: parseJson(backfillSummary.current_schedule_json),
            top_clips_preview: parseJson(backfillSummary.top_clips_json) || [],
            scope_errors: parseJson(backfillSummary.scope_errors_json) || {},
            last_run_at: backfillSummary.last_run_at,
            last_run_duration_ms: backfillSummary.last_run_duration_ms,
            last_run_ok: !!backfillSummary.last_run_ok,
        } : null;

        // Pivot DoW stats into 7-row Sun→Sat array (MySQL DAYOFWEEK: Sun=1 … Sat=7).
        const dowStats = Array.from({ length: 7 }, () => ({ sessions: 0, avg_viewers: 0, total_msgs: 0, total_follows: 0, total_subs: 0, total_bits: 0 }));
        for (const r of dowStatsRows) {
            const idx = (Number(r.dow) - 1 + 7) % 7;
            dowStats[idx] = {
                sessions: Number(r.sessions) || 0,
                avg_viewers: Number(r.avg_viewers) || 0,
                total_msgs: Number(r.total_msgs) || 0,
                total_follows: Number(r.total_follows) || 0,
                total_subs: Number(r.total_subs) || 0,
                total_bits: Number(r.total_bits) || 0,
            };
        }

        // Sub tier breakdown — single row, parsed and reshaped.
        const subTierBreakdown = subTierRow[0] ? {
            total_count: subTierRow[0].total_count,
            tier_1000_count: subTierRow[0].tier_1000_count,
            tier_2000_count: subTierRow[0].tier_2000_count,
            tier_3000_count: subTierRow[0].tier_3000_count,
            prime_count: subTierRow[0].prime_count,
            gift_count: subTierRow[0].gift_count,
            top_gifters: parseJson(subTierRow[0].top_gifters_json) || [],
            as_of: subTierRow[0].as_of,
        } : null;

        const followerAgeHistogram = followerAgeRow[0] || null;
        const bannedSummary = bannedRow[0] || null;
        const alertsConfig = alertsCfgRow[0] || null;
        const knownBotBans = await import('../../core/twitch-known-bot-bans.js')
            .then(m => m.recentKnownBotBans(bid)).catch(() => null);
        const kbdActions = await import('../../core/twitch-kbd-defender.js')
            .then(m => m.recentKbdActions(bid)).catch(() => null);

        // Period-over-period deltas — chip next to each headline tile. Null when no prior
        // data (brand-new broadcaster) so the view suppresses the chip rather than divide-by-zero.
        const prev = prevHeadlineRows[0] || {};
        const deltaPct = (now, before) => (before > 0) ? Math.round(((now - before) / before) * 1000) / 10 : null;
        const deltas = {
            sessions: deltaPct(Number(headline[0]?.sessions || 0), Number(prev.sessions || 0)),
            live_minutes: deltaPct(Number(headline[0]?.live_minutes || 0), Number(prev.live_minutes || 0)),
            peak_viewers: deltaPct(Number(headline[0]?.peak_viewers || 0), Number(prev.peak_viewers || 0)),
            avg_viewers: deltaPct(Number(headline[0]?.avg_viewers || 0), Number(prev.avg_viewers || 0)),
            total_msgs: deltaPct(Number(headline[0]?.total_msgs || 0), Number(prev.total_msgs || 0)),
            total_follows: deltaPct(Number(headline[0]?.total_follows || 0), Number(prev.total_follows || 0)),
            total_subs: deltaPct(Number(headline[0]?.total_subs || 0), Number(prev.total_subs || 0)),
            total_bits: deltaPct(Number(headline[0]?.total_bits || 0), Number(prev.total_bits || 0)),
        };

        // Reshape milestones into {type: row} for cheap lookup in the view.
        const milestones = {};
        for (const m of milestonesRows) milestones[m.milestone_type] = m;

        // User preferences — timezone & auto-refresh — default values when none persisted.
        const userPrefs = userPrefsRow[0] || { timezone: 'UTC', auto_refresh_enabled: 0, collapsed_sections_json: null };
        let collapsedSections = [];
        try { collapsedSections = JSON.parse(userPrefs.collapsed_sections_json || '[]'); } catch {}

        // Build a {game_id: {name, box_art_url}} lookup so the view can render thumbs beside categories.
        const gamesCache = {};
        for (const g of gamesCacheRows) gamesCache[g.game_id] = g;

        // Chat notifications aggregated by notice_type — ships to view as a count summary.
        const chatNoticeTypes = chatNotificationsRows;

        // Mark sessions whose started_at predates OAuth connect. Their event-driven columns
        // (msgs/subs/bits/follows/raids) are permanently zero because EventSub wasn't live
        // when they happened; the view uses `pre_connection: true` to badge the row rather
        // than display misleading zeros as if they were real.
        for (const s of sessions) {
            s.pre_connection = !!(connectedAt && s.started_at && new Date(s.started_at) < connectedAt);
        }

        // Derived: engagement rates. For window SUMs that come back zero, coalesce the headline
        // tiles against the Helix backfill so a brand-new connection shows real lifetime numbers
        // instead of a wall of zeros. The actual session table + per-day deltas stay session-
        // scoped (because that's the question "what happened in this window" is really asking).
        const head = headline[0] || {};
        const liveMin = Number(head.live_minutes) || 0;
        const avgV = Number(head.avg_viewers) || 0;
        const viewerHours = (avgV * liveMin) / 60;
        const chatSum = recentChatters[0] || {};

        // Headline fallback — set a `*_display` field that the view renders. If the window SUM
        // is zero AND the Helix backfill has a lifetime number, show the backfill number with
        // a "lifetime" marker. Otherwise show the window SUM.
        const headDisplay = {
            total_follows: Number(head.total_follows) || 0,
            total_subs: Number(head.total_subs) || 0,
            total_bits: Number(head.total_bits) || 0,
            total_msgs: Number(head.total_msgs) || 0,
            follows_source: Number(head.total_follows) > 0 ? 'window' : (bf?.follower_count != null ? 'lifetime' : 'empty'),
            subs_source: Number(head.total_subs) > 0 ? 'window' : (bf?.subscriber_count != null ? 'lifetime' : 'empty'),
            bits_source: Number(head.total_bits) > 0 ? 'window' : (bf?.bits_total_period != null ? 'month' : 'empty'),
        };
        if (headDisplay.follows_source === 'lifetime') headDisplay.total_follows = bf.follower_count;
        if (headDisplay.subs_source === 'lifetime') headDisplay.total_subs = bf.subscriber_count;
        if (headDisplay.bits_source === 'month') headDisplay.total_bits = bf.bits_total_period;

        const engagement = {
            viewer_hours: viewerHours,
            msgs_per_viewer_hour: viewerHours > 0 ? Number(head.total_msgs) / viewerHours : null,
            follows_per_viewer_hour: viewerHours > 0 ? Number(head.total_follows) / viewerHours : null,
            subs_per_viewer_hour: viewerHours > 0 ? Number(head.total_subs) / viewerHours : null,
            bits_per_viewer_hour: viewerHours > 0 ? Number(head.total_bits) / viewerHours : null,
            mod_actions_per_1k_msgs: Number(head.total_msgs) > 0
                ? (Number(head.total_mod_actions) / Number(head.total_msgs)) * 1000 : null,
            avg_chatters: Number(chatSum.avg_c) || 0,
            peak_chatters: Number(chatSum.peak_c) || 0,
            // Sub conversion = subs/follows in window. Only meaningful when follows > 0; otherwise null.
            sub_conversion_pct: Number(head.total_follows) > 0 ? (Number(head.total_subs) / Number(head.total_follows)) * 100 : null,
        };

        // Churn: new subs vs ended subs. Both are strictly window-scoped (no lifetime fallback)
        // because "net ± over 7 days" is a question only EventSub data can answer honestly.
        const churn = {
            new_subs: Number(head.total_subs) || 0,
            ended_subs: Number(subChurn[0]?.n) || 0,
        };
        churn.net = churn.new_subs - churn.ended_subs;

        // Live hours by day-of-week heatmap (7 x 24).
        const hoursGrid = Array.from({ length: 7 }, () => Array(24).fill(0));
        for (const r of liveHoursByDow) {
            // MySQL DAYOFWEEK: Sunday = 1 … Saturday = 7. Convert to 0..6 (Sun..Sat).
            const d = (Number(r.dow) - 1 + 7) % 7;
            const h = Number(r.h);
            if (d >= 0 && d <= 6 && h >= 0 && h <= 23) hoursGrid[d][h] = Number(r.live_minutes);
        }

        // EventSub health — compare the local ledger against the expected topic set so a missing
        // or revoked sub shows up directly instead of leaving the user wondering why an event
        // table is empty. Scoped topics the broadcaster hasn't granted are suppressed because
        // the "scope missing" banner at the top already covers them.
        const expectedTopics = [
            'channel.chat.message', 'channel.chat.message_delete', 'channel.update',
            'channel.hype_train.begin', 'channel.hype_train.progress', 'channel.hype_train.end',
            'channel.goal.begin', 'channel.goal.progress', 'channel.goal.end',
            'channel.ad_break.begin',
            'channel.charity_campaign.start', 'channel.charity_campaign.stop',
            'channel.charity_campaign.progress', 'channel.charity_campaign.donate',
            'channel.poll.begin', 'channel.poll.progress', 'channel.poll.end',
            'channel.prediction.begin', 'channel.prediction.progress',
            'channel.prediction.lock', 'channel.prediction.end',
            'channel.shoutout.create', 'channel.shoutout.receive',
            'channel.subscribe', 'channel.subscription.end',
            'channel.subscription.gift', 'channel.subscription.message',
            'channel.cheer', 'channel.follow', 'channel.raid', 'channel.ban',
            'channel.moderator.add', 'channel.moderator.remove',
            'channel.vip.add', 'channel.vip.remove',
            'channel.channel_points_custom_reward_redemption.add',
            'stream.online', 'stream.offline',
        ];
        const subByType = new Map(subsList.map(r => [r.sub_type, r]));
        const subsHealth = {
            total_expected: expectedTopics.length,
            enabled: subsList.filter(r => r.status === 'enabled').length,
            degraded: subsList.filter(r => r.status !== 'enabled'),
            missing: expectedTopics.filter(t => !subByType.has(t)),
            conduit: conduitRow[0] || null,
            last_ingest: lastIngest[0] || {},
        };

        // Clips: per-day series + totals for the chart section. rate_per_hour_live = clips per
        // live hour, computed against the window's total live minutes so the number has context.
        const clipsSummary = {
            total: clipsDaily.reduce((a, r) => a + Number(r.n || 0), 0),
            daily: clipsDaily.map(r => ({ date: r.d, n: Number(r.n) || 0 })),
            recent: clipsRecent,
            rate_per_hour_live: liveMin > 0 ? (clipsDaily.reduce((a, r) => a + Number(r.n || 0), 0) / (liveMin / 60)) : null,
        };

        const capture = await loadCapture383(bid, sinceSql);
        const [[clipsMadeRow]] = await pool.execute(
            `SELECT COUNT(*) AS n FROM twitch_clips_catalog WHERE broadcaster_id = ? AND created_at_twitch > ${sinceSql}`, [bid]);
        const clipsMadeTotal = Number(clipsMadeRow?.n) || 0;
        const [[coverage]] = await pool.execute(
            'SELECT MIN(recorded_at) AS since FROM twitch_stream_snapshots WHERE broadcaster_id = ?', [bid]);

        const data = {
            sessions,
            capture,
            clipsMade: { total: clipsMadeTotal, rate_per_hour_live: liveMin > 0 ? clipsMadeTotal / (liveMin / 60) : null },
            dataSince: coverage?.since || null,
            headline: head,
            headlineDisplay: headDisplay,
            backfill: bf,
            engagement,
            churn,
            viewerTimeline: timelineRaw.map(r => ({
                t: Number(r.bucket_ts) * 1000,
                avg: Number(r.avg_v) || 0,
                peak: Number(r.peak_v) || 0,
                msgs: Number(r.msgs) || 0,
            })),
            dailyGrowth: dailyGrowth.map(r => ({
                date: r.d, follows: Number(r.follows) || 0, subs: Number(r.subs) || 0,
                gift_subs: Number(r.gift_subs) || 0, bits: Number(r.bits) || 0,
                live_min: Number(r.live_min) || 0,
            })),
            hoursGrid,
            topGames,
            titleChanges: titleChanges[0] || { title_changes: 0, category_changes: 0 },
            adBreaksSummary: adBreaksSum[0] || { n: 0, s: 0, auto_n: 0 },
            charitySummary: charityTotal[0] || { raised: 0, campaigns: 0, events: 0 },
            topRewards: redemptionsTop,
            hypeTrains,
            goals,
            polls,
            predictions,
            shoutouts,
            resubs,
            vipMod,
            recentAlerts,
            categoryHistory: categoryHist,
            chattersSummary: chatSum,
            linkedMembers: linkedMembers[0] || { total: 0, vips: 0, mods: 0, subs: 0, synced_24h: 0, synced_7d: 0 },
            clipsSummary,
            teams: (bf?.teams || []).map(t => t.team_display_name || t.team_name).filter(Boolean),
            subsHealth,
            // Wave 367 additions — new data for the full analytics rebuild.
            chatVelocity: chatVelocityRows.map(r => ({ t: Number(r.bucket_ts) * 1000, msgs: Number(r.msgs) || 0 })),
            dowStats,
            subTierBreakdown,
            followerAgeHistogram,
            bannedSummary,
            topVods: topVodsRows,
            topClips: topClipsRows,
            bitsLeaderboard: bf?.bits_leaderboard || [],
            customRewards: customRewardsRows,
            backfillHistory: backfillHistoryRows,
            alertsConfig,
            knownBotBans,
            kbdActions,
            shareTokens: shareTokensRows,
            // Wave 368 additions
            deltas,
            milestones,
            userPrefs,
            collapsedSections,
            gamesCache,
            unbanEvents: unbanEventsRows,
            chatNoticeTypes,
            chatSettingsTimeline: chatSettingsTimelineRows,
            // Wave 369 — Tier A data in the data object
            topChatters: topChattersRows,
            suspiciousUsers: suspiciousUsersRows,
            warnings: warningsRows,
            unbanRequests: unbanRequestsRows,
            shieldModeEvents: shieldModeEventsRows,
            guestStarSessions: guestStarRows,
            automodSettings: automodSettingsRow[0] || null,
            blockedTerms: blockedTermsRows,
            channelEditors: channelEditorsRows,
            chatterWatch: chatterWatchRows,
            chatSampleStats: chatSampleStatsRow[0] || null,
            // Wave 370 — anomaly breakdown + chat text analytics
            anomalyBySeverity: anomalyBySeverityRows,
            anomalyByType: anomalyByTypeRows,
            topChattersByMsgs: topChattersByMsgsRows,
            topWords: topWordsRows,
            // Wave 371
            churnBreakdown: churnBreakdownRows,
            churnEvents: churnEventsRows,
            clipDelta: clipDeltaRows,
            // H-762: historical (2026-10-28), no longer collected; never on public share links.
            followedChannels: opts.shareMode ? [] : await followsOf(pool, bid, { limit: 100 }).catch(() => []),
        };

        // backfillStatus comes from the POST /backfill route redirecting back with ?backfill=ok|fail
        // so the view can show a one-time toast. The view doesn't have `req` in scope, so pass it.
        const backfillStatus = ['ok', 'fail'].includes(req.query.backfill) ? req.query.backfill : null;

        res.render('twitch-analytics', {
            user: req.user, guildId, guildName: req.guildObject?.name || guildId,
            range: rangeKey, ranges: RANGES, broadcaster, data,
            backfillStatus,
            isSuperAdmin: !!req.isSuperAdmin, shareMode: !!opts.shareMode,
        });

    } catch (err) {
        logger.error(`[TwitchAnalyticsPage] load failed: ${err.message}`, { guildId, err: err.message, stack: err.stack });
        res.status(500).render('error', {
            user: req.user,
            error: 'Failed to load Twitch analytics for this server. See server logs for details.',
        });
    }
}

router.get('/manage/:guildId/twitch-analytics', checkAuth, checkGuildAdmin, (req, res) => renderAnalytics(req, res));

/**
 * Manual re-run of the Helix backfill. Used by the "Refresh backfill" button on the
 * analytics page — useful when scopes change, when the broadcaster disconnects/reconnects,
 * or when a stale summary wants a kick. Guild admins and super-admins only.
 *
 * The call is synchronous (so the dashboard can show a toast with real counts) but has an
 * internal timeout of ~30s via axios per request — total worst case ~2 min for a channel
 * with huge mod/VIP rosters.
 */
router.post('/manage/:guildId/twitch-analytics/backfill', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    try {
        const result = await runBackfillFromConfig(guildId, {
            triggerSource: 'manual',
            triggerUserId: req.user?.id || null,
        });
        if (!result || !result.ok) {
            logger.warn('[TwitchAnalyticsPage] manual backfill failed', { guildId, errors: result?.errors });
        } else {
            logger.info('[TwitchAnalyticsPage] manual backfill succeeded', { guildId, counts: result.counts });
        }
        res.redirect(`/manage/${guildId}/twitch-analytics?range=${req.query.range || '7d'}&backfill=${result?.ok ? 'ok' : 'fail'}`);
    } catch (err) {
        logger.error(`[TwitchAnalyticsPage] manual backfill threw: ${err.message}`, { guildId, err: err.message });
        res.redirect(`/manage/${guildId}/twitch-analytics?range=${req.query.range || '7d'}&backfill=fail`);
    }
});

/**
 * CSV export — sessions, clips, events, anomalies, VODs. Super-admin + guild admin only.
 * Streams back a plain text/csv body with the window applied.
 */
router.get('/manage/:guildId/twitch-analytics/export.csv', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    const type = String(req.query.type || 'sessions').toLowerCase();
    const rangeKey = RANGES[req.query.range] ? req.query.range : '7d';
    const sinceSql = `DATE_SUB(NOW(), INTERVAL ${Number(RANGES[rangeKey].hours)} HOUR)`;

    try {
        const [[cfg]] = await pool.execute(
            `SELECT broadcaster_twitch_id FROM twitch_role_sync_config WHERE guild_id = ? AND enabled = 1 LIMIT 1`,
            [guildId],
        );
        if (!cfg) { res.status(404).send('No broadcaster for this guild.'); return; }
        const bid = String(cfg.broadcaster_twitch_id);

        // CSV-escape — wrap in quotes, double any embedded quote.
        const esc = (v) => {
            if (v === null || v === undefined) return '';
            let s = v instanceof Date ? v.toISOString() : String(v);
            if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
            s = s.replace(/"/g, '""');
            return /[,"\n\r]/.test(s) ? `"${s}"` : s;
        };
        const toCsv = (rows, cols) => cols.join(',') + '\n' + rows.map(r => cols.map(c => esc(r[c])).join(',')).join('\n');

        let csv = '';
        if (type === 'sessions') {
            const [rows] = await pool.execute(
                `SELECT id, started_at, ended_at, duration_minutes, peak_viewers, avg_viewers,
                        total_msgs, unique_chatters, total_follows, total_subs, total_gift_subs,
                        total_bits, total_raids_in, total_mod_actions, primary_category_name, title_at_start
                   FROM twitch_stream_sessions
                  WHERE broadcaster_id = ? AND started_at > ${sinceSql}
                  ORDER BY started_at DESC`, [bid]);
            csv = toCsv(rows, ['id','started_at','ended_at','duration_minutes','peak_viewers','avg_viewers','total_msgs','unique_chatters','total_follows','total_subs','total_gift_subs','total_bits','total_raids_in','total_mod_actions','primary_category_name','title_at_start']);
        } else if (type === 'clips') {
            const [rows] = await pool.execute(
                `SELECT clip_id, creator_name, title, game_name, view_count, duration_seconds, created_at_twitch, url
                   FROM twitch_clips_catalog WHERE broadcaster_id = ? ORDER BY view_count DESC LIMIT 500`, [bid]);
            csv = toCsv(rows, ['clip_id','creator_name','title','game_name','view_count','duration_seconds','created_at_twitch','url']);
        } else if (type === 'vods') {
            const [rows] = await pool.execute(
                `SELECT video_id, type, title, category_name, view_count, duration_seconds, created_at_twitch, url
                   FROM twitch_vods_catalog WHERE broadcaster_id = ? ORDER BY view_count DESC LIMIT 500`, [bid]);
            csv = toCsv(rows, ['video_id','type','title','category_name','view_count','duration_seconds','created_at_twitch','url']);
        } else if (type === 'events') {
            // Mega-union across event tables with a `kind` discriminator so one CSV covers all.
            const [polls] = await pool.execute(`SELECT 'poll' AS kind, poll_id AS id, event_type, title, status, occurred_at FROM twitch_poll_events WHERE broadcaster_id = ? AND occurred_at > ${sinceSql}`, [bid]);
            const [preds] = await pool.execute(`SELECT 'prediction' AS kind, prediction_id AS id, event_type, title, status, occurred_at FROM twitch_prediction_events WHERE broadcaster_id = ? AND occurred_at > ${sinceSql}`, [bid]);
            const [hypes] = await pool.execute(`SELECT 'hype_train' AS kind, hype_train_id AS id, event_type, CAST(level AS CHAR) AS title, '' AS status, occurred_at FROM twitch_hype_train_events WHERE broadcaster_id = ? AND occurred_at > ${sinceSql}`, [bid]);
            const [goals] = await pool.execute(`SELECT 'goal' AS kind, goal_id AS id, event_type, description AS title, goal_type AS status, occurred_at FROM twitch_goal_events WHERE broadcaster_id = ? AND occurred_at > ${sinceSql}`, [bid]);
            const [charity] = await pool.execute(`SELECT 'charity' AS kind, campaign_id AS id, event_type, charity_name AS title, donation_currency AS status, occurred_at FROM twitch_charity_events WHERE broadcaster_id = ? AND occurred_at > ${sinceSql}`, [bid]);
            const combined = [...polls, ...preds, ...hypes, ...goals, ...charity].sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at));
            csv = toCsv(combined, ['kind','id','event_type','title','status','occurred_at']);
        } else if (type === 'anomalies') {
            const [rows] = await pool.execute(
                `SELECT alert_type, severity, score, created_at FROM twitch_anomaly_alerts
                  WHERE broadcaster_id = ? AND created_at > ${sinceSql} ORDER BY created_at DESC`, [bid]);
            csv = toCsv(rows, ['alert_type','severity','score','created_at']);
        } else {
            res.status(400).send('Unknown type. Valid: sessions, clips, vods, events, anomalies.');
            return;
        }

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="twitch-${type}-${guildId}-${rangeKey}.csv"`);
        res.send(csv);
    } catch (err) {
        logger.error(`[TwitchAnalyticsPage] CSV export failed: ${err.message}`, { guildId, type, err: err.message });
        res.status(500).send('Export failed.');
    }
});

/**
 * iCal schedule export — writes a .ics with upcoming scheduled broadcasts. Public endpoint
 * (schedule data is public on Twitch), but guarded here by admin middleware for consistency.
 */
router.get('/manage/:guildId/twitch-analytics/schedule.ics', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    try {
        const [[cfg]] = await pool.execute(
            `SELECT broadcaster_twitch_id, broadcaster_twitch_username FROM twitch_role_sync_config WHERE guild_id = ? AND enabled = 1 LIMIT 1`,
            [guildId],
        );
        if (!cfg) { res.status(404).send('No broadcaster.'); return; }
        const [segments] = await pool.execute(
            `SELECT segment_id, title, category_name, start_time, end_time FROM twitch_schedule_segments
              WHERE broadcaster_id = ? AND start_time > NOW() AND canceled_until IS NULL
              ORDER BY start_time LIMIT 50`, [String(cfg.broadcaster_twitch_id)]);

        const dt = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
        const esc = (s) => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\r?\n/g, '\\n');
        const lines = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//CertiFried//Twitch Schedule//EN',
            `X-WR-CALNAME:${esc(cfg.broadcaster_twitch_username)} Twitch schedule`,
        ];
        for (const s of segments) {
            lines.push('BEGIN:VEVENT');
            lines.push(`UID:${s.segment_id}@certifriedmultitool.com`);
            lines.push(`DTSTAMP:${dt(new Date())}`);
            lines.push(`DTSTART:${dt(s.start_time)}`);
            if (s.end_time) lines.push(`DTEND:${dt(s.end_time)}`);
            lines.push(`SUMMARY:${esc(s.title || 'Stream')}`);
            if (s.category_name) lines.push(`DESCRIPTION:${esc('Category: ' + s.category_name)}`);
            lines.push(`URL:https://twitch.tv/${cfg.broadcaster_twitch_username}`);
            lines.push('END:VEVENT');
        }
        lines.push('END:VCALENDAR');

        res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${cfg.broadcaster_twitch_username}-schedule.ics"`);
        res.send(lines.join('\r\n'));
    } catch (err) {
        logger.error(`[TwitchAnalyticsPage] iCal export failed: ${err.message}`, { guildId, err: err.message });
        res.status(500).send('Export failed.');
    }
});

/**
 * Alert config POST — save which analytics events trigger a Discord notification. Scoped
 * by guild_id; broadcaster_id is denormalized from role_sync_config at save time so the
 * alert dispatcher can look up by broadcaster.
 */
router.post('/manage/:guildId/twitch-analytics/alerts', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    try {
        const [[cfg]] = await pool.execute(
            `SELECT broadcaster_twitch_id FROM twitch_role_sync_config WHERE guild_id = ? AND enabled = 1 LIMIT 1`,
            [guildId],
        );
        const bid = cfg ? String(cfg.broadcaster_twitch_id) : null;
        const channelId = String(req.body.alert_channel_id || '').replace(/[^\d]/g, '').slice(0, 20) || null;
        const unfollowChannelId = String(req.body.unfollow_channel_id || '').replace(/[^\d]/g, '').slice(0, 20) || null;
        const dmUserId = String(req.body.weekly_digest_dm_user_id || '').replace(/[^\d]/g, '').slice(0, 20) || null;
        const streamerbotUrl = String(req.body.streamerbot_bridge_url || '').slice(0, 500) || null;
        const aiOllamaUrl = String(req.body.ai_ollama_url || '').slice(0, 500) || null;
        const aiOllamaModel = String(req.body.ai_ollama_model || '').slice(0, 100) || null;
        const aiProviderPref = ['gemini', 'ollama', 'fallback_chain'].includes(req.body.ai_provider_preference)
            ? req.body.ai_provider_preference : 'fallback_chain';
        const aiDailyCap = Math.max(10, Math.min(10000, Number(req.body.ai_daily_call_cap) || 200));
        const flags = ['notify_hype_train','notify_record_peak','notify_anomaly_critical',
                       'notify_first_time_chatter','notify_goal_reached','notify_charity_milestone',
                       'notify_raid_in','weekly_digest_enabled',
                       'streamerbot_bridge_enabled','chat_sampling_enabled','chatter_identities_enabled',
                       'notify_chatter_watch',
                       'ai_enabled','ai_auto_recap','ai_auto_sentiment',
                       'ai_auto_clip_hype','ai_chat_mod_enabled','ai_prediction_commentary','ai_pii_redaction',
                       'known_bot_autoban_enabled'];
        const vals = flags.map(f => req.body[f] ? 1 : 0);
        await pool.execute(
            `INSERT INTO twitch_analytics_alerts_config
             (guild_id, broadcaster_id, alert_channel_id, unfollow_channel_id, weekly_digest_dm_user_id, streamerbot_bridge_url,
              ai_provider_preference, ai_ollama_url, ai_ollama_model, ai_daily_call_cap, ${flags.join(', ')})
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${flags.map(() => '?').join(', ')})
             ON DUPLICATE KEY UPDATE
                 broadcaster_id = VALUES(broadcaster_id),
                 alert_channel_id = VALUES(alert_channel_id),
                 unfollow_channel_id = VALUES(unfollow_channel_id),
                 weekly_digest_dm_user_id = VALUES(weekly_digest_dm_user_id),
                 streamerbot_bridge_url = VALUES(streamerbot_bridge_url),
                 ai_provider_preference = VALUES(ai_provider_preference),
                 ai_ollama_url = VALUES(ai_ollama_url),
                 ai_ollama_model = VALUES(ai_ollama_model),
                 ai_daily_call_cap = VALUES(ai_daily_call_cap),
                 ${flags.map(f => `${f} = VALUES(${f})`).join(', ')}`,
            [guildId, bid, channelId, unfollowChannelId, dmUserId, streamerbotUrl,
             aiProviderPref, aiOllamaUrl, aiOllamaModel, aiDailyCap, ...vals],
        );
        // KumaBot Defender mode: separate from the 0/1 flags above. Anything unexpected means 'off'.
        const kbdMode = ['off', 'detect', 'enforce'].includes(req.body.kbd_mode) ? req.body.kbd_mode : 'off';
        await pool.execute('UPDATE twitch_analytics_alerts_config SET kbd_mode = ? WHERE guild_id = ?', [kbdMode, guildId]);
        await import('../../core/twitch-kbd-defender.js').then(m => m.invalidateKbdMode(bid)).catch(() => {});
        res.redirect(`/manage/${guildId}/twitch-analytics?range=${req.query.range || '7d'}#admin`);
    } catch (err) {
        logger.error(`[TwitchAnalyticsPage] alerts save failed: ${err.message}`, { guildId, err: err.message });
        res.redirect(`/manage/${guildId}/twitch-analytics?range=${req.query.range || '7d'}&alerts=fail#admin`);
    }
});

/**
 * Create a public share token — tokenized read-only URL for the broadcaster to share
 * analytics with non-admins. Token is 32 bytes of random hex, created with the labeling
 * the admin typed in the form.
 */
router.post('/manage/:guildId/twitch-analytics/share', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    try {
        const [[cfg]] = await pool.execute(
            `SELECT broadcaster_twitch_id FROM twitch_role_sync_config WHERE guild_id = ? AND enabled = 1 LIMIT 1`,
            [guildId],
        );
        if (!cfg) { res.redirect(`/manage/${guildId}/twitch-analytics?share=fail`); return; }
        const token = crypto.randomBytes(24).toString('hex');
        const label = String(req.body.label || '').slice(0, 255) || null;
        await pool.execute(
            `INSERT INTO twitch_analytics_share_tokens
             (token, guild_id, broadcaster_id, created_by_discord_id, label)
             VALUES (?, ?, ?, ?, ?)`,
            [token, guildId, String(cfg.broadcaster_twitch_id), req.user?.id || null, label],
        );
        res.redirect(`/manage/${guildId}/twitch-analytics?range=${req.query.range || '7d'}#admin`);
    } catch (err) {
        logger.error(`[TwitchAnalyticsPage] share create failed: ${err.message}`, { guildId, err: err.message });
        res.redirect(`/manage/${guildId}/twitch-analytics?share=fail#admin`);
    }
});

/**
 * Public read-only share endpoint. Reuses the same analytics page but without auth —
 * token validation + view-counter increment acts as the gate. Only broadcasters with an
 * active (non-revoked, non-expired) token can be viewed through here.
 */
/**
 * OBS browser-source overlay — transparent-background widget for broadcasters to add as an
 * OBS browser source. Gated by share token; auto-refreshes every 30s via meta tag so OBS
 * doesn't need to re-fetch manually.
 */
router.get('/share/twitch/:token/obs', async (req, res) => {
    const token = String(req.params.token || '').replace(/[^a-f0-9]/gi, '');
    const layout = ['stats', 'ticker', 'hype', 'chat', 'charity', 'ai-copy'].includes(req.query.layout) ? req.query.layout : 'stats';
    try {
        const [[row]] = await pool.execute(
            `SELECT guild_id, broadcaster_id FROM twitch_analytics_share_tokens
              WHERE token = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`, [token]);
        if (!row) { res.status(404).send('Share link not found or revoked.'); return; }
        pool.execute(`UPDATE twitch_analytics_share_tokens SET view_count = view_count + 1, last_viewed_at = NOW() WHERE token = ?`, [token]).catch(() => {});

        const bid = row.broadcaster_id;
        const summary = await getBackfillSummary(bid);
        if (!summary) { res.status(404).send('No data yet.'); return; }
        const parseJson = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

        // Variant-specific data loads — only what each layout needs.
        let recentFollowers = [];
        let hypeTrain = null;
        let chatVelocity = [];
        if (layout === 'ticker') {
            const histRows = parseJson(summary.scope_errors_json);
            try {
                const [folls] = await pool.execute(
                    `SELECT top_follow_dates_json FROM twitch_follower_age_histogram WHERE broadcaster_id = ? LIMIT 1`,
                    [bid]);
                recentFollowers = parseJson(folls[0]?.top_follow_dates_json || '[]') || [];
            } catch {}
        } else if (layout === 'hype') {
            try {
                const [h] = await pool.execute(
                    `SELECT level, progress, goal, occurred_at FROM twitch_hype_train_events
                      WHERE broadcaster_id = ? ORDER BY occurred_at DESC LIMIT 1`, [bid]);
                if (h[0] && (Date.now() - new Date(h[0].occurred_at).getTime()) < 15 * 60 * 1000) {
                    hypeTrain = h[0];
                }
            } catch {}
        } else if (layout === 'chat') {
            try {
                const [cv] = await pool.execute(
                    `SELECT UNIX_TIMESTAMP(recorded_at) * 1000 AS t, msg_count AS msgs
                       FROM twitch_stream_snapshots WHERE broadcaster_id = ?
                        AND recorded_at > DATE_SUB(NOW(), INTERVAL 30 MINUTE)
                      ORDER BY recorded_at ASC`, [bid]);
                chatVelocity = cv;
            } catch {}
        }

        // Tier AI-5 — fetch AI caption for ai-copy layout
        let aiCaption = null;
        if (layout === 'ai-copy') {
            try {
                const { generateOverlayCopy } = await import('../../core/twitch-ai.js');
                const context = parseJson(summary.current_stream_json)?.type === 'live'
                    ? `Live now in ${parseJson(summary.current_stream_json)?.game_name || 'their category'}, ${parseJson(summary.current_stream_json)?.viewer_count || 0} viewers`
                    : 'Offline';
                const r = await generateOverlayCopy(bid, context);
                if (r.ok) aiCaption = r.caption;
            } catch {}
        }

        res.render('twitch-analytics-obs', {
            broadcaster: { login: summary.broadcaster_login },
            layout,
            summary,
            liveStream: parseJson(summary.current_stream_json),
            activeGoals: parseJson(summary.active_goals_json) || [],
            charity: parseJson(summary.charity_campaign_json),
            recentFollowers, hypeTrain, chatVelocity, aiCaption,
        });
    } catch (err) {
        logger.error(`[TwitchAnalyticsPage] OBS overlay failed: ${err.message}`, { err: err.message });
        res.status(500).send('OBS overlay failed.');
    }
});

/**
 * Public read-only share endpoint. Token resolves to a (guild_id, broadcaster_id); the view
 * is rendered with the SAME template but with isSuperAdmin forced to false and admin-only
 * sections hidden. Reuses renderAnalytics() so the two render paths stay in sync.
 */
router.get('/share/twitch/:token', async (req, res, next) => {
    if (/\.json$/i.test(String(req.params.token || ''))) return next();
    const token = String(req.params.token || '').replace(/[^a-f0-9]/gi, '');
    if (!token) { res.status(404).send('Not found.'); return; }
    try {
        const [[row]] = await pool.execute(
            `SELECT guild_id, label FROM twitch_analytics_share_tokens
              WHERE token = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`,
            [token],
        );
        if (!row) { res.status(404).send('Share link not found or revoked.'); return; }
        pool.execute(
            `UPDATE twitch_analytics_share_tokens SET view_count = view_count + 1, last_viewed_at = NOW() WHERE token = ?`,
            [token],
        ).catch(() => {});
        req.params.guildId = row.guild_id;
        req.user = { id: 'share-' + token.slice(0, 8), username: row.label || 'Shared view' };
        req.isSuperAdmin = false;
        req.guildObject = { name: row.label || 'Shared Twitch analytics' };
        return renderAnalytics(req, res, { shareMode: true });
    } catch (err) {
        logger.error(`[TwitchAnalyticsPage] share view failed: ${err.message}`, { token: token.slice(0, 8), err: err.message });
        res.status(500).send('Share render failed.');
    }
});

/**
 * JSON API — returns the same data object the HTML page builds, as JSON. Public endpoint
 * gated by share-token so broadcasters can wire their own dashboards / OBS overlays.
 */
router.get('/share/twitch/:token.json', async (req, res) => {
    const token = String(req.params.token || '').replace(/[^a-f0-9]/gi, '');
    try {
        const [[row]] = await pool.execute(
            `SELECT guild_id, broadcaster_id FROM twitch_analytics_share_tokens
              WHERE token = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`, [token]);
        if (!row) { res.status(404).json({ error: 'not_found' }); return; }
        pool.execute(`UPDATE twitch_analytics_share_tokens SET view_count = view_count + 1, last_viewed_at = NOW() WHERE token = ?`, [token]).catch(() => {});

        // Build a compact JSON payload — mirrors the backfill summary + recent sessions.
        const bid = row.broadcaster_id;
        const [[bf]] = await pool.execute(`SELECT follower_count, subscriber_count, bits_total_period, last_run_at FROM twitch_broadcaster_backfill WHERE broadcaster_id = ?`, [bid]);
        const [sessions] = await pool.execute(
            `SELECT started_at, ended_at, duration_minutes, peak_viewers, total_msgs, total_follows, total_subs, total_bits
               FROM twitch_stream_sessions WHERE broadcaster_id = ? ORDER BY started_at DESC LIMIT 10`, [bid]);
        const [milestones] = await pool.execute(`SELECT milestone_type, milestone_value, label, achieved_at FROM twitch_milestones WHERE broadcaster_id = ?`, [bid]);
        res.json({ broadcaster_id: bid, summary: bf || {}, recent_sessions: sessions, milestones });
    } catch (err) {
        logger.error(`[TwitchAnalyticsPage] json api failed: ${err.message}`, { err: err.message });
        res.status(500).json({ error: 'render_failed' });
    }
});

/**
 * Markdown export — human-readable weekly recap. Owners paste this into Discord, Notion, etc.
 */
router.get('/manage/:guildId/twitch-analytics/recap.md', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    try {
        const [[cfg]] = await pool.execute(
            `SELECT broadcaster_twitch_id, broadcaster_twitch_username FROM twitch_role_sync_config WHERE guild_id = ? AND enabled = 1 LIMIT 1`, [guildId]);
        if (!cfg) { res.status(404).send('No broadcaster.'); return; }
        const bid = String(cfg.broadcaster_twitch_id);
        const sinceSql = `DATE_SUB(NOW(), INTERVAL 168 HOUR)`;
        const [[agg]] = await pool.execute(
            `SELECT COUNT(*) AS sessions, COALESCE(SUM(duration_minutes), 0) AS live_min,
                    COALESCE(MAX(peak_viewers), 0) AS peak, COALESCE(SUM(total_msgs), 0) AS msgs,
                    COALESCE(SUM(total_follows), 0) AS follows, COALESCE(SUM(total_subs), 0) AS subs,
                    COALESCE(SUM(total_bits), 0) AS bits
               FROM twitch_stream_sessions WHERE broadcaster_id = ? AND started_at > ${sinceSql}`, [bid]);
        const [sessions] = await pool.execute(
            `SELECT started_at, duration_minutes, peak_viewers, title_at_start, primary_category_name
               FROM twitch_stream_sessions WHERE broadcaster_id = ? AND started_at > ${sinceSql}
              ORDER BY started_at DESC LIMIT 20`, [bid]);
        const [clips] = await pool.execute(
            `SELECT title, view_count, url FROM twitch_clips_catalog
              WHERE broadcaster_id = ? AND created_at_twitch > ${sinceSql} ORDER BY view_count DESC LIMIT 5`, [bid]);

        const lines = [
            `# ${cfg.broadcaster_twitch_username} — Weekly Twitch Recap`,
            ``,
            `*${new Date().toISOString().slice(0, 10)} — last 7 days*`,
            ``,
            `## Overview`,
            ``,
            `- **Sessions:** ${agg.sessions}`,
            `- **Live time:** ${Math.round(agg.live_min / 60 * 10) / 10}h`,
            `- **Peak viewers:** ${agg.peak}`,
            `- **Chat messages:** ${Number(agg.msgs).toLocaleString()}`,
            `- **Follows gained:** ${agg.follows}`,
            `- **Subs gained:** ${agg.subs}`,
            `- **Bits cheered:** ${agg.bits}`,
            ``,
            `## Sessions`,
            ``,
            ...sessions.map(s => `- **${new Date(s.started_at).toLocaleDateString()}** · peak ${s.peak_viewers} · ${Math.floor((s.duration_minutes || 0) / 60)}h ${s.duration_minutes % 60}m · ${s.primary_category_name || '?'} · "${(s.title_at_start || '').slice(0, 80)}"`),
            ``,
            `## Top Clips`,
            ``,
            ...clips.map(c => `- [${(c.title || 'Clip').slice(0, 80)}](${c.url}) — ${c.view_count.toLocaleString()} views`),
            ``,
            `---`,
            `Generated by CertiFried · [twitch.tv/${cfg.broadcaster_twitch_username}](https://twitch.tv/${cfg.broadcaster_twitch_username})`,
        ];
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${cfg.broadcaster_twitch_username}-recap-${new Date().toISOString().slice(0,10)}.md"`);
        res.send(lines.join('\n'));
    } catch (err) {
        logger.error(`[TwitchAnalyticsPage] markdown recap failed: ${err.message}`, { guildId, err: err.message });
        res.status(500).send('Export failed.');
    }
});

/**
 * Prometheus-format /metrics scrape endpoint for self-hosted monitoring. One text-exposition
 * block per connected broadcaster + aggregate counters.
 */
router.get('/metrics/twitch-analytics', async (req, res) => {
    try {
        // Collation hint: role_sync_config and backfill tables were created with different
        // charsets (ci vs unicode_ci) because of historical reasons; the explicit COLLATE on
        // the join column lets MySQL cross-compare them without the "illegal mix" error.
        const [rows] = await pool.query(
            `SELECT r.broadcaster_twitch_id AS bid, r.broadcaster_twitch_username AS login,
                    b.follower_count, b.subscriber_count, b.bits_total_period, b.last_run_at
               FROM twitch_role_sync_config r
               LEFT JOIN twitch_broadcaster_backfill b
                     ON b.broadcaster_id = r.broadcaster_twitch_id COLLATE utf8mb4_unicode_ci
              WHERE r.enabled = 1`);
        const lines = [
            '# HELP certifried_twitch_followers Follower count per connected broadcaster',
            '# TYPE certifried_twitch_followers gauge',
            '# HELP certifried_twitch_subscribers Active subscriber count per connected broadcaster',
            '# TYPE certifried_twitch_subscribers gauge',
            '# HELP certifried_twitch_bits_lifetime Lifetime bits total per connected broadcaster',
            '# TYPE certifried_twitch_bits_lifetime gauge',
        ];
        for (const r of rows) {
            const labels = `{broadcaster_id="${r.bid}",login="${(r.login || '').replace(/"/g, '')}"}`;
            lines.push(`certifried_twitch_followers${labels} ${Number(r.follower_count) || 0}`);
            lines.push(`certifried_twitch_subscribers${labels} ${Number(r.subscriber_count) || 0}`);
            lines.push(`certifried_twitch_bits_lifetime${labels} ${Number(r.bits_total_period) || 0}`);
        }
        res.setHeader('Content-Type', 'text/plain; version=0.0.4');
        res.send(lines.join('\n') + '\n');
    } catch (err) {
        logger.error(`[TwitchAnalyticsPage] metrics endpoint failed: ${err.message}`, { err: err.message });
        res.status(500).send('# metrics failed\n');
    }
});

/**
 * User preferences save — timezone, auto-refresh, collapsed section memory. Scoped by
 * discord_user_id so it follows them across guilds.
 */
router.post('/manage/:guildId/twitch-analytics/prefs', checkAuth, async (req, res) => {
    const uid = req.user?.id;
    if (!uid) { res.status(401).send('No user.'); return; }
    try {
        let tz = String(req.body.timezone || 'UTC').slice(0, 64);
        try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = 'UTC'; }
        const autoRefresh = ['1', 'true', 'on'].includes(String(req.body.auto_refresh)) ? 1 : 0;
        const collapsed = String(req.body.collapsed_sections || '[]').slice(0, 2000);
        await pool.execute(
            `INSERT INTO twitch_analytics_user_prefs (discord_user_id, timezone, auto_refresh_enabled, collapsed_sections_json)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE timezone = VALUES(timezone), auto_refresh_enabled = VALUES(auto_refresh_enabled), collapsed_sections_json = VALUES(collapsed_sections_json)`,
            [uid, tz, autoRefresh, collapsed]);
        res.json({ ok: true });
    } catch (err) {
        logger.error(`[TwitchAnalyticsPage] prefs save failed: ${err.message}`, { err: err.message });
        res.status(500).json({ ok: false });
    }
});

/**
 * Session detail view — per-session deep-dive. Shows viewer timeline for that session only,
 * events during the session, clips created during it, title/category changes within the window.
 */
router.get('/manage/:guildId/twitch-analytics/session/:sessionId', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    const sessionId = String(req.params.sessionId).replace(/[^\d]/g, '');
    try {
        const [[session]] = await pool.execute(
            `SELECT * FROM twitch_stream_sessions WHERE id = ? LIMIT 1`, [sessionId]);
        if (!session) { res.status(404).render('error', { user: req.user, error: 'Session not found.' }); return; }
        if (!req.isSuperAdmin) {
            const cfg = await resolveBroadcaster(guildId);
            if (!cfg || String(cfg.broadcaster_twitch_id) !== String(session.broadcaster_id)) {
                res.status(404).render('error', { user: req.user, error: 'Session not found.' });
                return;
            }
        }
        const bid = session.broadcaster_id;
        const startSec = Math.floor(new Date(session.started_at).getTime() / 1000);
        const endSec = session.ended_at ? Math.floor(new Date(session.ended_at).getTime() / 1000) : Math.floor(Date.now() / 1000);

        const [snapshots] = await pool.execute(
            `SELECT UNIX_TIMESTAMP(recorded_at) AS t, viewer_count, is_live, msg_count AS chat_msg_count
               FROM twitch_stream_snapshots WHERE broadcaster_id = ? AND recorded_at BETWEEN FROM_UNIXTIME(?) AND FROM_UNIXTIME(?)
              ORDER BY recorded_at ASC`, [bid, startSec, endSec]);
        const [events] = await pool.execute(
            `(SELECT 'hype_train' AS kind, event_type, level AS detail, occurred_at FROM twitch_hype_train_events WHERE broadcaster_id = ? AND occurred_at BETWEEN FROM_UNIXTIME(?) AND FROM_UNIXTIME(?))
             UNION ALL
             (SELECT 'poll' AS kind, event_type, title AS detail, occurred_at FROM twitch_poll_events WHERE broadcaster_id = ? AND occurred_at BETWEEN FROM_UNIXTIME(?) AND FROM_UNIXTIME(?))
             UNION ALL
             (SELECT 'prediction' AS kind, event_type, title AS detail, occurred_at FROM twitch_prediction_events WHERE broadcaster_id = ? AND occurred_at BETWEEN FROM_UNIXTIME(?) AND FROM_UNIXTIME(?))
             UNION ALL
             (SELECT 'charity' AS kind, event_type, charity_name AS detail, occurred_at FROM twitch_charity_events WHERE broadcaster_id = ? AND occurred_at BETWEEN FROM_UNIXTIME(?) AND FROM_UNIXTIME(?))
             ORDER BY occurred_at ASC`,
            [bid, startSec, endSec, bid, startSec, endSec, bid, startSec, endSec, bid, startSec, endSec]);
        const [categoryChanges] = await pool.execute(
            `SELECT changed_at, title, category_name FROM twitch_category_history
              WHERE broadcaster_id = ? AND changed_at BETWEEN FROM_UNIXTIME(?) AND FROM_UNIXTIME(?)
              ORDER BY changed_at ASC`, [bid, startSec, endSec]);
        const [clips] = await pool.execute(
            `SELECT clip_id, title, view_count, url, created_at_twitch FROM twitch_clips_catalog
              WHERE broadcaster_id = ? AND created_at_twitch BETWEEN FROM_UNIXTIME(?) AND FROM_UNIXTIME(?)
              ORDER BY view_count DESC LIMIT 20`, [bid, startSec, endSec]);

        // Fetch any cached AI recap for this session (don't block rendering if none).
        const aiRecap = await twitchAI.getCachedRecap(sessionId).catch(() => null);

        res.render('twitch-analytics-session', {
            user: req.user, guildId, guildName: req.guildObject?.name || guildId,
            session, snapshots, events, categoryChanges, clips, aiRecap,
            isSuperAdmin: !!req.isSuperAdmin,
        });
    } catch (err) {
        logger.error(`[TwitchAnalyticsPage] session detail failed: ${err.message}`, { guildId, sessionId, err: err.message });
        res.status(500).render('error', { user: req.user, error: 'Session detail load failed.' });
    }
});

/**
 * Tier B action routes — write operations against Twitch Helix.
 *
 * Every route:
 *   1. checkAuth + checkGuildAdmin
 *   2. Resolves the broadcaster from the guild's role_sync_config
 *   3. Delegates to core/twitch-write.js which handles token refresh + audit log
 *   4. Redirects back with ?action=ok|fail&op=<name>
 */
// Wave 383 capture: category rank, raids, shared chat, emotes, markers, per-moderator
// activity, AutoMod, bits by type, automatic rewards. Each query degrades to [] on error
// so one missing table can't take down the whole page.
const CI = 'COLLATE utf8mb4_unicode_ci';
async function loadCapture383(bid, sinceSql) {
    const q = (sql, params = [bid]) => pool.execute(sql, params).then(([r]) => r).catch(err => {
        logger.warn(`[TwitchAnalyticsPage] capture query failed: ${err.message}`);
        return [];
    });
    const raidsBy = (dir) => q(
        `SELECT other_user_login AS login, COUNT(*) AS n, COALESCE(SUM(viewers), 0) AS viewers, MAX(occurred_at) AS last_at
           FROM twitch_raid_events WHERE broadcaster_id = ? AND direction = '${dir}' AND occurred_at > ${sinceSql}
          GROUP BY other_user_login ORDER BY viewers DESC LIMIT 10`);
    const [rankSummary, rankLatest, raidTotals, raidsIn, raidsOut, sharedChat, emotes, markers,
           modActivity, chatClears, automodStatus, automodCats, bitsByType, powerUps, autoRewards] = await Promise.all([
        q(`SELECT MIN(rank_pos) AS best, ROUND(AVG(rank_pos)) AS avg_rank, COUNT(*) AS samples
             FROM twitch_category_rank_snapshots WHERE broadcaster_id = ? AND recorded_at > ${sinceSql}`),
        q(`SELECT game_name, rank_pos, viewers, channels_sampled, top_viewers, recorded_at
             FROM twitch_category_rank_snapshots WHERE broadcaster_id = ? ORDER BY recorded_at DESC LIMIT 1`),
        q(`SELECT direction, COUNT(*) AS n, COALESCE(SUM(viewers), 0) AS viewers
             FROM twitch_raid_events WHERE broadcaster_id = ? AND occurred_at > ${sinceSql} GROUP BY direction`),
        raidsBy('in'),
        raidsBy('out'),
        q(`SELECT session_id, participants_json, began_at, ended_at FROM twitch_shared_chat_sessions
            WHERE broadcaster_id = ? AND began_at > ${sinceSql} ORDER BY began_at DESC LIMIT 10`),
        q(`SELECT u.emote_id, MAX(u.emote_name) AS emote_name, SUM(u.uses) AS uses,
                  MAX(a.image_url) AS image_url, MAX(a.asset_id IS NOT NULL) AS is_channel
             FROM twitch_emote_usage u
             LEFT JOIN twitch_channel_assets a
                    ON a.broadcaster_id = u.broadcaster_id AND a.kind = 'emote' AND a.asset_id = u.emote_id
            WHERE u.broadcaster_id = ? AND u.day >= DATE(${sinceSql})
            GROUP BY u.emote_id ORDER BY uses DESC LIMIT 20`),
        q(`SELECT video_id, position_seconds, description, created_at_twitch FROM twitch_stream_markers
            WHERE broadcaster_id = ? AND created_at_twitch > ${sinceSql} ORDER BY created_at_twitch DESC LIMIT 50`),
        q(`SELECT login, SUM(bans) AS bans, SUM(timeouts) AS timeouts, SUM(unbans) AS unbans, SUM(warns) AS warns,
                  SUM(automod) AS automod, SUM(unban_reviews) AS unban_reviews, SUM(shields) AS shields,
                  MAX(last_at) AS last_at
             FROM (
               SELECT moderator_user_login ${CI} AS login, SUM(action = 'ban') AS bans, SUM(action = 'timeout') AS timeouts,
                      SUM(action = 'unban') AS unbans, 0 AS warns, 0 AS automod, 0 AS unban_reviews, 0 AS shields,
                      MAX(occurred_at) AS last_at
                 FROM twitch_mod_actions WHERE broadcaster_id = ? AND source = 'ban' AND occurred_at > ${sinceSql}
                GROUP BY moderator_user_login
               UNION ALL
               SELECT moderator_user_login ${CI}, 0, 0, 0, COUNT(*), 0, 0, 0, MAX(occurred_at)
                 FROM twitch_warnings WHERE broadcaster_id = ? AND event_type = 'send' AND occurred_at > ${sinceSql}
                GROUP BY moderator_user_login
               UNION ALL
               SELECT moderator_user_login ${CI}, 0, 0, 0, 0, COUNT(*), 0, 0, MAX(occurred_at)
                 FROM twitch_automod_held WHERE broadcaster_id = ? AND moderator_user_login IS NOT NULL
                  AND occurred_at > ${sinceSql} GROUP BY moderator_user_login
               UNION ALL
               SELECT moderator_user_login ${CI}, 0, 0, 0, 0, 0, COUNT(*), 0, MAX(occurred_at)
                 FROM twitch_unban_requests WHERE broadcaster_id = ? AND event_type = 'resolve'
                  AND occurred_at > ${sinceSql} GROUP BY moderator_user_login
               UNION ALL
               SELECT moderator_user_login ${CI}, 0, 0, 0, 0, 0, 0, SUM(event_type = 'begin'), MAX(occurred_at)
                 FROM twitch_shield_mode_events WHERE broadcaster_id = ? AND occurred_at > ${sinceSql}
                GROUP BY moderator_user_login
             ) t
            WHERE login IS NOT NULL
            GROUP BY login
            ORDER BY SUM(bans + timeouts + unbans + warns + automod + unban_reviews + shields) DESC
            LIMIT 20`, [bid, bid, bid, bid, bid]),
        q(`SELECT action, COUNT(*) AS n FROM twitch_mod_actions
            WHERE broadcaster_id = ? AND source = 'chat' AND occurred_at > ${sinceSql} GROUP BY action`),
        q(`SELECT status, COUNT(*) AS n FROM twitch_automod_held
            WHERE broadcaster_id = ? AND occurred_at > ${sinceSql} GROUP BY status`),
        q(`SELECT category, COUNT(*) AS n FROM twitch_automod_held
            WHERE broadcaster_id = ? AND occurred_at > ${sinceSql} AND category IS NOT NULL
            GROUP BY category ORDER BY n DESC LIMIT 6`),
        q(`SELECT usage_type, COUNT(*) AS n, COALESCE(SUM(bits), 0) AS bits FROM twitch_bits_usage
            WHERE broadcaster_id = ? AND occurred_at > ${sinceSql} GROUP BY usage_type ORDER BY bits DESC`),
        q(`SELECT power_up_type, COUNT(*) AS n, COALESCE(SUM(bits), 0) AS bits FROM twitch_bits_usage
            WHERE broadcaster_id = ? AND occurred_at > ${sinceSql} AND usage_type <> 'cheer'
            GROUP BY power_up_type ORDER BY bits DESC LIMIT 8`),
        q(`SELECT reward_title, COUNT(*) AS n, COALESCE(SUM(reward_cost), 0) AS points FROM twitch_redemption_events
            WHERE broadcaster_id = ? AND reward_kind = 'automatic' AND redeemed_at > ${sinceSql}
            GROUP BY reward_title ORDER BY n DESC LIMIT 10`),
    ]);
    const [silentSummary, silentTop] = await Promise.all([
        q(`SELECT SUM(messages = 0 AND sightings >= 30) AS silent, COUNT(*) AS seen, SUM(messages > 0) AS chatted
             FROM twitch_chatter_sightings WHERE broadcaster_id = ? AND chatter_user_id <> broadcaster_id`),
        q(`SELECT chatter_user_login AS login, sightings, last_seen_at FROM twitch_chatter_sightings
            WHERE broadcaster_id = ? AND chatter_user_id <> broadcaster_id AND messages = 0 AND sightings >= 30
            ORDER BY sightings DESC LIMIT 25`),
    ]);
    const total = (rows, key, val) => Object.fromEntries(rows.map(r => [r[key], Number(r[val]) || 0]));
    return {
        rankSummary: rankSummary[0] || {}, rankLatest: rankLatest[0] || null,
        raidCounts: total(raidTotals, 'direction', 'n'), raidViewers: total(raidTotals, 'direction', 'viewers'),
        raidsIn, raidsOut,
        sharedChat: sharedChat.map(s => {
            let names = [];
            try { names = (JSON.parse(s.participants_json || '[]') || []).map(p => p.broadcaster_user_login || p.broadcaster_user_name).filter(Boolean); } catch {}
            return { ...s, participants: names };
        }),
        emotes, markers, modActivity,
        chatClears: total(chatClears, 'action', 'n'),
        automodStatus: total(automodStatus, 'status', 'n'), automodCats,
        bitsByType, powerUps, autoRewards,
        silent: silentSummary[0] || {}, silentTop,
    };
}

async function resolveBroadcaster(guildId) {
    const [[cfg]] = await pool.execute(
        `SELECT broadcaster_twitch_id, broadcaster_twitch_username FROM twitch_role_sync_config
          WHERE guild_id = ? AND enabled = 1 LIMIT 1`, [guildId]);
    return cfg || null;
}
function actorFromReq(req, guildId) {
    return {
        triggeredByDiscordId: req.user?.id || null,
        triggeredByDiscordUsername: req.user?.username || null,
        guildId,
    };
}
function tierBRedirect(guildId, op, result, range = '7d') {
    return `/manage/${guildId}/twitch-analytics?range=${range}&op=${op}&action=${result?.ok ? 'ok' : 'fail'}#controls`;
}

// Unban an account the known-bot ban caught; it is then exempt from automatic bans for good.
router.post('/manage/:guildId/twitch-controls/known-bot-unban', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    const cfg = await resolveBroadcaster(guildId);
    if (!cfg) return res.redirect(`/manage/${guildId}/twitch-analytics?writeauth=no_broadcaster`);
    const userId = String(req.body.unban_user_id || '').replace(/[^\d]/g, '').slice(0, 20);
    if (!userId) return res.redirect(`/manage/${guildId}/twitch-analytics?range=${req.query.range || '7d'}&op=known_bot_unban&action=fail#admin`);
    const { unbanKnownBot } = await import('../../core/twitch-known-bot-bans.js');
    const r = await unbanKnownBot(cfg.broadcaster_twitch_id, userId, actorFromReq(req, guildId));
    res.redirect(`/manage/${guildId}/twitch-analytics?range=${req.query.range || '7d'}&op=known_bot_unban&action=${r.ok ? 'ok' : 'fail'}#admin`);
});

// Unban an account KumaBot Defender banned; it goes on the network unban list so no protected channel acts on it again.
router.post('/manage/:guildId/twitch-controls/kbd-unban', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    const cfg = await resolveBroadcaster(guildId);
    if (!cfg) return res.redirect(`/manage/${guildId}/twitch-analytics?writeauth=no_broadcaster`);
    // Button value is "<twitch user id>:<login>".
    const [rawId = '', rawLogin = ''] = String(req.body.kbd_unban || '').split(':');
    const userId = rawId.replace(/[^\d]/g, '').slice(0, 20);
    const login = rawLogin.replace(/[^a-z0-9_]/gi, '').slice(0, 40);
    if (!userId) return res.redirect(`/manage/${guildId}/twitch-analytics?range=${req.query.range || '7d'}&op=kbd_unban&action=fail#admin`);
    const { unbanKbd } = await import('../../core/twitch-kbd-defender.js');
    const r = await unbanKbd(cfg.broadcaster_twitch_id, userId, login, actorFromReq(req, guildId));
    res.redirect(`/manage/${guildId}/twitch-analytics?range=${req.query.range || '7d'}&op=kbd_unban&action=${r.ok ? 'ok' : 'fail'}#admin`);
});

router.post('/manage/:guildId/twitch-controls/title', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    const cfg = await resolveBroadcaster(guildId);
    if (!cfg) return res.redirect(`/manage/${guildId}/twitch-analytics?writeauth=no_broadcaster`);
    const r = await twitchWrite.updateChannelInfo(cfg.broadcaster_twitch_id, {
        title: req.body.title ? String(req.body.title).slice(0, 140) : undefined,
        categoryId: req.body.category_id ? String(req.body.category_id).slice(0, 32) : undefined,
    }, actorFromReq(req, guildId));
    res.redirect(tierBRedirect(guildId, 'title', r, req.query.range));
});

router.post('/manage/:guildId/twitch-controls/snooze-ad', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    const cfg = await resolveBroadcaster(guildId);
    if (!cfg) return res.redirect(`/manage/${guildId}/twitch-analytics`);
    const r = await twitchWrite.snoozeNextAd(cfg.broadcaster_twitch_id, actorFromReq(req, guildId));
    res.redirect(tierBRedirect(guildId, 'snooze_ad', r, req.query.range));
});

router.post('/manage/:guildId/twitch-controls/raid', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    const cfg = await resolveBroadcaster(guildId);
    if (!cfg) return res.redirect(`/manage/${guildId}/twitch-analytics`);
    // Target can be a login OR user_id — resolve login via /users if needed.
    let targetId = String(req.body.target_user_id || '').replace(/[^\d]/g, '');
    if (!targetId && req.body.target_login) {
        try {
            const lookupToken = (await import('../../utils/platforms/twitch-api.js')).getAccessToken
                ? await (await import('../../utils/platforms/twitch-api.js')).getAccessToken() : null;
            if (lookupToken) {
                const axios = (await import('axios')).default;
                const look = await axios.get(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(req.body.target_login)}`, {
                    headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${lookupToken}` },
                });
                targetId = look.data?.data?.[0]?.id || '';
            }
        } catch (e) { logger.warn('[TwitchControls] raid target lookup failed', { err: e.message }); }
    }
    if (!targetId) return res.redirect(tierBRedirect(guildId, 'raid', { ok: false }, req.query.range));
    const r = await twitchWrite.startRaid(cfg.broadcaster_twitch_id, targetId, actorFromReq(req, guildId));
    res.redirect(tierBRedirect(guildId, 'raid', r, req.query.range));
});

router.post('/manage/:guildId/twitch-controls/shield-mode', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    const cfg = await resolveBroadcaster(guildId);
    if (!cfg) return res.redirect(`/manage/${guildId}/twitch-analytics`);
    const enable = req.body.enable === '1' || req.body.enable === 'true';
    const r = await twitchWrite.toggleShieldMode(cfg.broadcaster_twitch_id, enable, actorFromReq(req, guildId));
    res.redirect(tierBRedirect(guildId, enable ? 'shield_on' : 'shield_off', r, req.query.range));
});

router.post('/manage/:guildId/twitch-controls/chat-settings', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    const cfg = await resolveBroadcaster(guildId);
    if (!cfg) return res.redirect(`/manage/${guildId}/twitch-analytics`);
    const settings = {};
    if (req.body.follower_mode !== undefined) settings.follower_mode = req.body.follower_mode === '1';
    if (req.body.follower_mode_duration) settings.follower_mode_duration = Math.max(0, Math.min(129600, Number(req.body.follower_mode_duration) || 0));
    if (req.body.subscriber_mode !== undefined) settings.subscriber_mode = req.body.subscriber_mode === '1';
    if (req.body.slow_mode !== undefined) settings.slow_mode = req.body.slow_mode === '1';
    if (req.body.slow_mode_wait_time) settings.slow_mode_wait_time = Math.max(3, Math.min(120, Number(req.body.slow_mode_wait_time) || 3));
    if (req.body.emote_mode !== undefined) settings.emote_mode = req.body.emote_mode === '1';
    if (req.body.unique_chat_mode !== undefined) settings.unique_chat_mode = req.body.unique_chat_mode === '1';
    const r = await twitchWrite.updateChatSettings(cfg.broadcaster_twitch_id, settings, actorFromReq(req, guildId));
    res.redirect(tierBRedirect(guildId, 'chat_settings', r, req.query.range));
});

router.post('/manage/:guildId/twitch-controls/create-poll', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    const cfg = await resolveBroadcaster(guildId);
    if (!cfg) return res.redirect(`/manage/${guildId}/twitch-analytics`);
    const choices = String(req.body.choices || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (!req.body.title || choices.length < 2) {
        return res.redirect(tierBRedirect(guildId, 'poll', { ok: false }, req.query.range));
    }
    const r = await twitchWrite.createPoll(cfg.broadcaster_twitch_id, {
        title: String(req.body.title).slice(0, 60),
        choices, duration: Number(req.body.duration) || 60,
    }, actorFromReq(req, guildId));
    res.redirect(tierBRedirect(guildId, 'poll', r, req.query.range));
});

router.post('/manage/:guildId/twitch-controls/create-clip', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    const cfg = await resolveBroadcaster(guildId);
    if (!cfg) return res.redirect(`/manage/${guildId}/twitch-analytics`);
    const r = await twitchWrite.createClip(cfg.broadcaster_twitch_id, false, actorFromReq(req, guildId));
    res.redirect(tierBRedirect(guildId, 'clip', r, req.query.range));
});

/**
 * Ban or timeout a user. Duration > 0 = timeout; 0 = permanent ban. Looks up target by
 * login if an id wasn't passed so admins can type a username instead of hunting for an id.
 */
router.post('/manage/:guildId/twitch-controls/ban', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    const cfg = await resolveBroadcaster(guildId);
    if (!cfg) return res.redirect(`/manage/${guildId}/twitch-analytics`);
    let targetId = String(req.body.target_user_id || '').replace(/[^\d]/g, '');
    if (!targetId && req.body.target_login) {
        try {
            const { getAccessToken } = await import('../../utils/platforms/twitch-api.js');
            const token = await getAccessToken();
            const axios = (await import('axios')).default;
            const r = await axios.get(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(req.body.target_login)}`, {
                headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` },
            });
            targetId = r.data?.data?.[0]?.id || '';
        } catch (e) { logger.warn('[TwitchControls] ban target lookup failed', { err: e.message }); }
    }
    if (!targetId) return res.redirect(tierBRedirect(guildId, 'ban', { ok: false }, req.query.range));
    const durationSec = Math.max(0, Math.min(1209600, Number(req.body.duration_seconds) || 0));
    const result = await twitchWrite.banUser(cfg.broadcaster_twitch_id, targetId, req.body.reason, durationSec || null, actorFromReq(req, guildId));
    res.redirect(tierBRedirect(guildId, durationSec > 0 ? 'timeout' : 'ban', result, req.query.range));
});

router.post('/manage/:guildId/twitch-controls/warn', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    const cfg = await resolveBroadcaster(guildId);
    if (!cfg) return res.redirect(`/manage/${guildId}/twitch-analytics`);
    let targetId = String(req.body.target_user_id || '').replace(/[^\d]/g, '');
    if (!targetId && req.body.target_login) {
        try {
            const { getAccessToken } = await import('../../utils/platforms/twitch-api.js');
            const token = await getAccessToken();
            const axios = (await import('axios')).default;
            const r = await axios.get(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(req.body.target_login)}`, {
                headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` },
            });
            targetId = r.data?.data?.[0]?.id || '';
        } catch (e) { logger.warn('[TwitchControls] warn target lookup failed', { err: e.message }); }
    }
    if (!targetId) return res.redirect(tierBRedirect(guildId, 'warn', { ok: false }, req.query.range));
    const r = await twitchWrite.warnUser(cfg.broadcaster_twitch_id, targetId, req.body.reason, actorFromReq(req, guildId));
    res.redirect(tierBRedirect(guildId, 'warn', r, req.query.range));
});

router.post('/manage/:guildId/twitch-controls/unban-request/:id/:verdict', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    const cfg = await resolveBroadcaster(guildId);
    if (!cfg) return res.redirect(`/manage/${guildId}/twitch-analytics`);
    const requestId = String(req.params.id).replace(/[^\d]/g, '');
    const verdict = req.params.verdict === 'approve' ? 'approved' : 'denied';
    const r = await twitchWrite.resolveUnbanRequest(cfg.broadcaster_twitch_id, requestId, verdict, req.body.note, actorFromReq(req, guildId));
    res.redirect(tierBRedirect(guildId, `unban_${verdict}`, r, req.query.range));
});

router.post('/manage/:guildId/twitch-controls/blocked-term/add', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    const cfg = await resolveBroadcaster(guildId);
    if (!cfg) return res.redirect(`/manage/${guildId}/twitch-analytics`);
    const term = String(req.body.term || '').slice(0, 500);
    if (!term) return res.redirect(tierBRedirect(guildId, 'blocked_add', { ok: false }, req.query.range));
    const r = await twitchWrite.addBlockedTerm(cfg.broadcaster_twitch_id, term, actorFromReq(req, guildId));
    res.redirect(tierBRedirect(guildId, 'blocked_add', r, req.query.range));
});

router.post('/manage/:guildId/twitch-controls/blocked-term/:id/remove', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    const cfg = await resolveBroadcaster(guildId);
    if (!cfg) return res.redirect(`/manage/${guildId}/twitch-analytics`);
    const termId = String(req.params.id).replace(/[^a-f0-9-]/gi, '');
    const r = await twitchWrite.removeBlockedTerm(cfg.broadcaster_twitch_id, termId, actorFromReq(req, guildId));
    res.redirect(tierBRedirect(guildId, 'blocked_remove', r, req.query.range));
});

/**
 * Chatter-watch add/remove (not a Helix call — writes to local twitch_chatter_watch).
 */
router.post('/manage/:guildId/twitch-controls/watch/add', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    const cfg = await resolveBroadcaster(guildId);
    if (!cfg) return res.redirect(`/manage/${guildId}/twitch-analytics`);
    const login = String(req.body.login || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 100).toLowerCase();
    if (!login) return res.redirect(`/manage/${guildId}/twitch-analytics#admin`);
    await pool.execute(
        `INSERT INTO twitch_chatter_watch (broadcaster_id, chatter_user_login, label) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE label = VALUES(label)`,
        [String(cfg.broadcaster_twitch_id), login, String(req.body.label || '').slice(0, 255)]);
    res.redirect(`/manage/${guildId}/twitch-analytics?range=${req.query.range || '7d'}#admin`);
});

router.post('/manage/:guildId/twitch-controls/watch/:id/remove', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    const id = String(req.params.id).replace(/[^\d]/g, '');
    const cfg = await resolveBroadcaster(guildId);
    if (!cfg) return res.redirect(`/manage/${guildId}/twitch-analytics`);
    await pool.execute(`DELETE FROM twitch_chatter_watch WHERE id = ? AND broadcaster_id = ?`, [id, String(cfg.broadcaster_twitch_id)]).catch(() => {});
    res.redirect(`/manage/${guildId}/twitch-analytics?range=${req.query.range || '7d'}#admin`);
});

/**
 * AI endpoints — on-demand generation of AI insights. Each returns JSON so the dashboard
 * can show inline feedback without a full page reload.
 */
// The session / clip / VOD in the URL must belong to this server's channel (super admins excepted).
function ownsTwitchResource(kind) {
    const q = {
        session: ['sessionId', `SELECT 1 FROM twitch_stream_sessions WHERE id = ? AND broadcaster_id = ? LIMIT 1`, (v) => String(v).replace(/[^\d]/g, '')],
        clip: ['clipId', `SELECT 1 FROM twitch_clips_catalog WHERE clip_id = ? AND broadcaster_id = ? LIMIT 1`, (v) => String(v).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120)],
        vod: ['videoId', `SELECT 1 FROM twitch_vods_catalog WHERE video_id = ? AND broadcaster_id = ? LIMIT 1`, (v) => String(v).replace(/[^\d]/g, '')],
    }[kind];
    return async (req, res, next) => {
        try {
            if (req.isSuperAdmin) return next();
            const cfg = await resolveBroadcaster(req.params.guildId);
            const id = q[2](req.params[q[0]] || '');
            if (cfg && id) {
                const [rows] = await pool.execute(q[1], [id, String(cfg.broadcaster_twitch_id)]);
                if (rows.length) return next();
            }
            res.status(404).json({ ok: false, error: `${kind} not found for this channel` });
        } catch (err) {
            logger.warn(`[TwitchAI] ownership check failed: ${err.message}`);
            res.status(500).json({ ok: false, error: 'check failed' });
        }
    };
}

router.post('/manage/:guildId/twitch-ai/session/:sessionId/recap', checkAuth, checkGuildAdmin, ownsTwitchResource('session'), async (req, res) => {
    try {
        const r = await twitchAI.generateSessionRecap(req.params.sessionId);
        res.json(r);
    } catch (err) {
        logger.error('[TwitchAI] recap route failed', { err: err.message });
        res.status(500).json({ ok: false, error: err.message });
    }
});

router.post('/manage/:guildId/twitch-ai/clip/:clipId/titles', checkAuth, checkGuildAdmin, ownsTwitchResource('clip'), async (req, res) => {
    try {
        const r = await twitchAI.suggestClipTitles(req.params.clipId);
        res.json(r);
    } catch (err) {
        logger.error('[TwitchAI] clip titles failed', { err: err.message });
        res.status(500).json({ ok: false, error: err.message });
    }
});

router.post('/manage/:guildId/twitch-ai/harassment', checkAuth, checkGuildAdmin, async (req, res) => {
    try {
        const cfg = await resolveBroadcaster(req.params.guildId);
        if (!cfg) return res.status(404).json({ ok: false, error: 'no broadcaster' });
        const r = await twitchAI.analyzeHarassment(cfg.broadcaster_twitch_id);
        res.json(r);
    } catch (err) {
        logger.error('[TwitchAI] harassment analysis failed', { err: err.message });
        res.status(500).json({ ok: false, error: err.message });
    }
});

router.post('/manage/:guildId/twitch-ai/stream-titles', checkAuth, checkGuildAdmin, async (req, res) => {
    try {
        const cfg = await resolveBroadcaster(req.params.guildId);
        if (!cfg) return res.status(404).json({ ok: false, error: 'no broadcaster' });
        const r = await twitchAI.suggestStreamTitles(cfg.broadcaster_twitch_id, {
            desiredCategory: req.body.category,
            moodHint: req.body.mood,
        });
        res.json(r);
    } catch (err) {
        logger.error('[TwitchAI] stream titles failed', { err: err.message });
        res.status(500).json({ ok: false, error: err.message });
    }
});

router.post('/manage/:guildId/twitch-ai/chatter/:login/persona', checkAuth, checkGuildAdmin, async (req, res) => {
    try {
        const cfg = await resolveBroadcaster(req.params.guildId);
        if (!cfg) return res.status(404).json({ ok: false, error: 'no broadcaster' });
        const r = await twitchAI.analyzeChatterPersona(cfg.broadcaster_twitch_id, req.params.login);
        res.json(r);
    } catch (err) {
        logger.error('[TwitchAI] persona failed', { err: err.message });
        res.status(500).json({ ok: false, error: err.message });
    }
});

router.post('/manage/:guildId/twitch-ai/automod/tune', checkAuth, checkGuildAdmin, async (req, res) => {
    try {
        const cfg = await resolveBroadcaster(req.params.guildId);
        if (!cfg) return res.status(404).json({ ok: false, error: 'no broadcaster' });
        const r = await twitchAI.tuneAutoMod(cfg.broadcaster_twitch_id);
        res.json(r);
    } catch (err) {
        logger.error('[TwitchAI] automod tune failed', { err: err.message });
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Tier AI-3 routes
router.post('/manage/:guildId/twitch-ai/session/:sessionId/highlights', checkAuth, checkGuildAdmin, ownsTwitchResource('session'), async (req, res) => {
    try {
        const r = await twitchAI.detectHighlightMoments(req.params.sessionId, { withAiCaptions: req.body.captions === '1' });
        res.json(r);
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/manage/:guildId/twitch-ai/session/:sessionId/coach', checkAuth, checkGuildAdmin, ownsTwitchResource('session'), async (req, res) => {
    try {
        const r = await twitchAI.generateStreamerCoach(req.params.sessionId);
        res.json(r);
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/manage/:guildId/twitch-ai/journey', checkAuth, checkGuildAdmin, async (req, res) => {
    try {
        const cfg = await resolveBroadcaster(req.params.guildId);
        if (!cfg) return res.status(404).json({ ok: false, error: 'no broadcaster' });
        const r = await twitchAI.analyzeFollowerSubJourney(cfg.broadcaster_twitch_id);
        res.json(r);
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/manage/:guildId/twitch-ai/pivots', checkAuth, checkGuildAdmin, async (req, res) => {
    try {
        const cfg = await resolveBroadcaster(req.params.guildId);
        if (!cfg) return res.status(404).json({ ok: false, error: 'no broadcaster' });
        const r = await twitchAI.analyzeCategoryPivots(cfg.broadcaster_twitch_id);
        res.json(r);
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Tier AI-4/5 routes
router.post('/manage/:guildId/twitch-ai/moderate-chat', checkAuth, checkGuildAdmin, async (req, res) => {
    try {
        const cfg = await resolveBroadcaster(req.params.guildId);
        if (!cfg) return res.status(404).json({ ok: false, error: 'no broadcaster' });
        const r = await twitchAI.moderateChat(cfg.broadcaster_twitch_id);
        res.json(r);
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/manage/:guildId/twitch-ai/semantic-clip-search', checkAuth, checkGuildAdmin, async (req, res) => {
    try {
        const cfg = await resolveBroadcaster(req.params.guildId);
        if (!cfg) return res.status(404).json({ ok: false, error: 'no broadcaster' });
        const r = await twitchAI.semanticClipSearch(cfg.broadcaster_twitch_id, req.body.query || '', { limit: 10 });
        res.json(r);
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/manage/:guildId/twitch-ai/sentiment/by-category', checkAuth, checkGuildAdmin, async (req, res) => {
    try {
        const cfg = await resolveBroadcaster(req.params.guildId);
        if (!cfg) return res.status(404).json({ ok: false, error: 'no broadcaster' });
        const r = await twitchAI.sentimentByCategory(cfg.broadcaster_twitch_id);
        res.json(r);
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

/**
 * Peer insight — AI narrative over k-anonymized peer aggregates. Reciprocal opt-in required.
 */
router.post('/manage/:guildId/twitch-ai/peer-insight', checkAuth, checkGuildAdmin, async (req, res) => {
    try {
        const cfg = await resolveBroadcaster(req.params.guildId);
        if (!cfg) return res.status(404).json({ ok: false, error: 'no broadcaster' });
        const r = await twitchAI.generatePeerInsight(cfg.broadcaster_twitch_id);
        res.json(r);
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/manage/:guildId/twitch-ai/peer-pool/optin', checkAuth, checkGuildAdmin, async (req, res) => {
    try {
        const cfg = await resolveBroadcaster(req.params.guildId);
        if (!cfg) return res.status(404).json({ ok: false, error: 'no broadcaster' });
        await peerInsights.setOptIn(cfg.broadcaster_twitch_id, req.body.enable === '1');
        res.redirect(`/manage/${req.params.guildId}/twitch-analytics?range=${req.query.range || '7d'}#admin`);
    } catch (err) {
        logger.error(`[TwitchAnalyticsPage] peer-pool opt-in failed: ${err.message}`, { err: err.message });
        res.redirect(`/manage/${req.params.guildId}/twitch-analytics?peer=fail#admin`);
    }
});

/**
 * Super-admin rebuild of peer buckets (also runs daily at 05:00 UTC automatically).
 */
/**
 * Request a VOD transcript via local whisper. Fire-and-forget — the job runs in the
 * background and the client polls the status via GET.
 */
router.post('/manage/:guildId/twitch-ai/vod/:videoId/transcribe', checkAuth, checkGuildAdmin, ownsTwitchResource('vod'), async (req, res) => {
    const videoId = String(req.params.videoId).replace(/[^\d]/g, '');
    const model = req.body.model === 'accurate' ? 'accurate' : 'fast';
    // Fire-and-forget, respond immediately.
    vodTranscripts.transcribeVOD(videoId, { model, requestedBy: req.user?.id })
        .catch(err => logger.warn(`[TwitchAI] vod transcript bg: ${err.message}`));
    res.json({ ok: true, status: 'queued' });
});

router.get('/manage/:guildId/twitch-ai/vod/:videoId/transcript', checkAuth, checkGuildAdmin, ownsTwitchResource('vod'), async (req, res) => {
    try {
        const row = await vodTranscripts.getTranscript(req.params.videoId);
        if (!row) return res.json({ ok: true, status: 'none' });
        res.json({
            ok: true, status: row.status,
            transcript: row.transcript_text, segments: row.segments_json ? JSON.parse(row.segments_json) : null,
            whisper_model: row.whisper_model, duration_ms: row.processing_duration_ms,
            error: row.error_message, completed_at: row.completed_at,
        });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/manage/:guildId/twitch-ai/transcript-search', checkAuth, checkGuildAdmin, async (req, res) => {
    try {
        const cfg = await resolveBroadcaster(req.params.guildId);
        if (!cfg) return res.status(404).json({ ok: false, error: 'no broadcaster' });
        const r = await vodTranscripts.searchTranscripts(cfg.broadcaster_twitch_id, req.body.query || '', { limit: 10 });
        res.json(r);
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

/**
 * Gemini Vision analysis of a clip thumbnail.
 */
router.post('/manage/:guildId/twitch-ai/clip/:clipId/vision', checkAuth, checkGuildAdmin, ownsTwitchResource('clip'), async (req, res) => {
    try {
        const r = await twitchVision.analyzeClipThumbnail(req.params.clipId);
        res.json(r);
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/admin/twitch-analytics/peer-pool/rebuild', checkAuth, async (req, res) => {
    if (!isSuperAdmin(req.user?.id)) return res.status(403).send('Super admin only.');
    try {
        await peerInsights.rebuildPeerBuckets();
        res.json({ ok: true });
    } catch (err) {
        logger.error(`[TwitchAnalyticsPage] peer rebuild failed: ${err.message}`, { err: err.message });
        res.status(500).json({ ok: false, error: err.message });
    }
});

router.post('/manage/:guildId/twitch-ai/sentiment/by-tier', checkAuth, checkGuildAdmin, async (req, res) => {
    try {
        const cfg = await resolveBroadcaster(req.params.guildId);
        if (!cfg) return res.status(404).json({ ok: false, error: 'no broadcaster' });
        const r = await twitchAI.sentimentBySubTier(cfg.broadcaster_twitch_id);
        res.json(r);
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

/**
 * AI mod-queue — admins review flagged chat messages, dismiss or action.
 */
router.get('/manage/:guildId/twitch-analytics/mod-queue', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    try {
        const cfg = await resolveBroadcaster(guildId);
        if (!cfg) { res.redirect(`/manage/${guildId}/twitch-analytics`); return; }
        const [queue] = await pool.execute(
            `SELECT * FROM twitch_ai_mod_queue WHERE broadcaster_id = ? AND status = 'pending'
              ORDER BY FIELD(severity, 'critical','high','medium','low'), created_at DESC LIMIT 100`,
            [String(cfg.broadcaster_twitch_id)]);
        const op = ['dismissed', 'handled', 'timeout_600', 'ban'].includes(req.query.op) ? req.query.op : null;
        res.render('twitch-analytics-mod-queue', {
            user: req.user, guildId, guildName: req.guildObject?.name || guildId,
            broadcasterLogin: cfg.broadcaster_twitch_username, queue,
            isSuperAdmin: !!req.isSuperAdmin,
            result: op ? { op, ok: req.query.result === 'ok' } : null,
        });
    } catch (err) {
        logger.error(`[TwitchAnalyticsPage] mod-queue failed: ${err.message}`, { err: err.message });
        res.status(500).render('error', { user: req.user, error: 'Mod queue load failed.' });
    }
});

router.post('/manage/:guildId/twitch-analytics/mod-queue/:id/:verdict', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    const id = String(req.params.id).replace(/[^\d]/g, '');
    const verdict = ['dismissed', 'actioned'].includes(req.params.verdict) ? req.params.verdict : 'dismissed';
    const action = verdict === 'dismissed' ? 'dismissed'
        : (['timeout_600', 'ban', 'handled'].includes(req.body.action) ? req.body.action : 'handled');
    const back = (ok) => res.redirect(`/manage/${guildId}/twitch-analytics/mod-queue?op=${action}&result=${ok ? 'ok' : 'fail'}`);
    try {
        const cfg = await resolveBroadcaster(guildId);
        if (!cfg) return res.redirect(`/manage/${guildId}/twitch-analytics`);
        const bid = String(cfg.broadcaster_twitch_id);
        const [[item]] = await pool.execute(
            `SELECT id, chatter_user_id, chatter_user_login, category, reason FROM twitch_ai_mod_queue
              WHERE id = ? AND broadcaster_id = ? AND status = 'pending' LIMIT 1`, [id, bid]);
        if (!item) return back(false);
        if (action === 'timeout_600' || action === 'ban') {
            let targetId = String(item.chatter_user_id || '').replace(/[^\d]/g, '');
            if (!targetId && item.chatter_user_login) {
                try {
                    const { getAccessToken } = await import('../../utils/platforms/twitch-api.js');
                    const token = await getAccessToken();
                    const axios = (await import('axios')).default;
                    const r = await axios.get(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(item.chatter_user_login)}`, {
                        headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` },
                    });
                    targetId = r.data?.data?.[0]?.id || '';
                } catch (e) { logger.warn('[TwitchAnalyticsPage] mod-queue target lookup failed', { err: e.message }); }
            }
            if (!targetId) return back(false);
            const reason = String(item.reason || `Flagged by the AI chat moderator${item.category ? ` (${item.category})` : ''}`).slice(0, 500);
            const r = await twitchWrite.banUser(bid, targetId, reason, action === 'timeout_600' ? 600 : null, actorFromReq(req, guildId));
            if (!r?.ok) return back(false);
        }
        const [upd] = await pool.execute(
            `UPDATE twitch_ai_mod_queue SET status = ?, reviewed_by_discord_id = ?, reviewed_at = NOW(), action_taken = ?
              WHERE id = ? AND broadcaster_id = ?`,
            [verdict, req.user?.id || null, action, id, bid]);
        return back(upd.affectedRows > 0);
    } catch (e) {
        logger.warn(`[TwitchAnalyticsPage] mod-queue update failed: ${e.message}`, { err: e.message });
        return back(false);
    }
});

/**
 * Super-admin AI usage dashboard — all providers, all broadcasters, cost/latency/failure.
 */
router.get('/admin/twitch-analytics/ai-usage', checkAuth, async (req, res) => {
    if (!isSuperAdmin(req.user?.id)) return res.status(403).send('Super admin only.');
    try {
        // 30-day totals (p95 computed in two steps — MariaDB does not allow subqueries in OFFSET)
        const [[baseTotals]] = await pool.query(
            `SELECT COUNT(*) AS calls, SUM(ok = 0) AS failures, AVG(duration_ms) AS avg_duration_ms
               FROM twitch_ai_provider_log WHERE created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)`);
        let p95_duration_ms = null;
        const calls = Number(baseTotals?.calls || 0);
        if (calls > 0) {
            const p95Offset = Math.max(0, Math.floor(calls * 0.95) - 1);
            const [[p95Row]] = await pool.query(
                `SELECT duration_ms FROM twitch_ai_provider_log WHERE created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
                  ORDER BY duration_ms LIMIT 1 OFFSET ?`, [p95Offset]);
            p95_duration_ms = p95Row?.duration_ms ?? null;
        }
        const totals = { ...baseTotals, p95_duration_ms };
        const [byProvider] = await pool.query(
            `SELECT provider, model, COUNT(*) AS n, SUM(ok = 0) AS failures, AVG(duration_ms) AS avg_ms,
                    MAX(duration_ms) AS p95_ms
               FROM twitch_ai_provider_log WHERE created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
              GROUP BY provider, model ORDER BY n DESC`);
        const [byFeature] = await pool.query(
            `SELECT feature, COUNT(*) AS n, SUM(ok = 0) AS failures, AVG(duration_ms) AS avg_ms,
                    AVG(prompt_chars) AS avg_prompt, AVG(response_chars) AS avg_resp
               FROM twitch_ai_provider_log WHERE created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
              GROUP BY feature ORDER BY n DESC`);
        const [byBroadcaster] = await pool.query(
            `SELECT l.broadcaster_id,
                    (SELECT broadcaster_twitch_username FROM twitch_role_sync_config r WHERE r.broadcaster_twitch_id = l.broadcaster_id LIMIT 1) AS login,
                    COUNT(*) AS n,
                    SUM(DATE(l.created_at) = CURDATE()) AS today,
                    (SELECT cap_at_time FROM twitch_ai_budget_history b WHERE b.broadcaster_id = l.broadcaster_id AND b.day = CURDATE() LIMIT 1) AS cap_at_time,
                    (SELECT alerted_at IS NOT NULL FROM twitch_ai_budget_history b WHERE b.broadcaster_id = l.broadcaster_id AND b.day = CURDATE() LIMIT 1) AS alerted_today
               FROM twitch_ai_provider_log l
              WHERE l.created_at > DATE_SUB(NOW(), INTERVAL 30 DAY) AND l.broadcaster_id IS NOT NULL
              GROUP BY l.broadcaster_id ORDER BY today DESC, n DESC LIMIT 50`);
        const [recentFailures] = await pool.query(
            `SELECT broadcaster_id, feature, provider, error_message, created_at
               FROM twitch_ai_provider_log WHERE ok = 0 AND created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
              ORDER BY created_at DESC LIMIT 20`);
        res.render('twitch-analytics-ai-usage', {
            user: req.user, isSuperAdmin: true, totals, byProvider, byFeature, byBroadcaster, recentFailures,
        });
    } catch (err) {
        logger.error(`[TwitchAnalyticsPage] ai-usage dashboard failed: ${err.message}`, { err: err.message });
        res.status(500).send('AI usage render failed.');
    }
});

router.post('/manage/:guildId/twitch-ai/raid/verify', checkAuth, checkGuildAdmin, async (req, res) => {
    try {
        const cfg = await resolveBroadcaster(req.params.guildId);
        if (!cfg) return res.status(404).json({ ok: false, error: 'no broadcaster' });
        const r = await twitchAI.verifyRaid(cfg.broadcaster_twitch_id, {
            from_broadcaster_user_id: req.body.from_user_id,
            from_broadcaster_user_name: req.body.from_user_name,
            viewers: Number(req.body.viewers) || 0,
        });
        res.json(r);
    } catch (err) {
        logger.error('[TwitchAI] raid verify failed', { err: err.message });
        res.status(500).json({ ok: false, error: err.message });
    }
});

/**
 * Super-admin multi-broadcaster comparison view. Shows every connected broadcaster's
 * headline numbers side-by-side so the super-admin can spot outliers and compare perf.
 */
router.get('/admin/twitch-analytics/compare', checkAuth, async (req, res) => {
    if (!isSuperAdmin(req.user?.id)) return res.status(403).send('Super admin only.');
    try {
        const [rows] = await pool.query(
            `SELECT r.guild_id, r.broadcaster_twitch_id AS bid, r.broadcaster_twitch_username AS login,
                    r.tier_b_granted_at IS NOT NULL AS has_tier_b,
                    b.follower_count, b.subscriber_count, b.bits_total_period, b.last_run_at,
                    (SELECT COUNT(*) FROM twitch_stream_sessions s WHERE s.broadcaster_id = r.broadcaster_twitch_id AND s.started_at > DATE_SUB(NOW(), INTERVAL 30 DAY)) AS sessions_30d,
                    (SELECT COUNT(*) FROM twitch_clips_catalog c WHERE c.broadcaster_id = r.broadcaster_twitch_id COLLATE utf8mb4_unicode_ci) AS clips,
                    (SELECT MAX(peak_viewers) FROM twitch_stream_sessions s WHERE s.broadcaster_id = r.broadcaster_twitch_id) AS all_time_peak,
                    (SELECT COUNT(*) FROM twitch_anomaly_alerts a WHERE a.broadcaster_id = r.broadcaster_twitch_id AND a.created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)) AS anomalies_30d
               FROM twitch_role_sync_config r
               LEFT JOIN twitch_broadcaster_backfill b
                     ON b.broadcaster_id = r.broadcaster_twitch_id COLLATE utf8mb4_unicode_ci
              WHERE r.enabled = 1
              ORDER BY b.follower_count DESC`);
        res.render('twitch-analytics-compare', {
            user: req.user, isSuperAdmin: true, rows,
        });
    } catch (err) {
        logger.error(`[TwitchAnalyticsPage] compare view failed: ${err.message}`, { err: err.message });
        res.status(500).send('Compare render failed.');
    }
});

/**
 * Audit log viewer — super-admin + guild-admin visibility into every Tier B write action
 * taken against this broadcaster. Scoped by guild so broadcasters can audit their own
 * dashboard activity.
 */
router.get('/manage/:guildId/twitch-analytics/audit', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    try {
        const cfg = await resolveBroadcaster(guildId);
        if (!cfg) { res.redirect(`/manage/${guildId}/twitch-analytics`); return; }
        const [rows] = await pool.execute(
            `SELECT id, triggered_by_discord_username, action, http_verb, helix_path,
                    response_status, ok, error_message, duration_ms, created_at
               FROM twitch_action_audit_log
              WHERE broadcaster_id = ?
              ORDER BY created_at DESC LIMIT 200`, [String(cfg.broadcaster_twitch_id)]);
        res.render('twitch-analytics-audit', {
            user: req.user, guildId, guildName: req.guildObject?.name || guildId,
            broadcasterLogin: cfg.broadcaster_twitch_username, rows,
            isSuperAdmin: !!req.isSuperAdmin,
        });
    } catch (err) {
        logger.error(`[TwitchAnalyticsPage] audit view failed: ${err.message}`, { guildId, err: err.message });
        res.status(500).render('error', { user: req.user, error: 'Audit view failed.' });
    }
});

/**
 * Anomaly acknowledge — writes an acknowledged flag + who ack'd + optional note. Lets the
 * owner clear the queue without the detector having to re-fire.
 */
router.post('/manage/:guildId/twitch-analytics/anomaly/:id/:verdict', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    const alertId = String(req.params.id).replace(/[^\d]/g, '');
    const verdict = ['ack', 'false-positive', 'resolve'].includes(req.params.verdict) ? req.params.verdict : 'ack';
    // Map UI verb → status enum. `ack` = investigated and real; `false-positive` = investigated
    // and dismissed; `resolve` = acted on and closed. All three remove the alert from the
    // active queue, but only `false-positive` fully hides it from count aggregates.
    const statusMap = { 'ack': 'acknowledged', 'false-positive': 'superseded', 'resolve': 'resolved' };
    const nextStatus = statusMap[verdict];
    const note = String(req.body.note || '').slice(0, 500);
    const uname = req.user?.username || 'unknown';
    const cfg = await resolveBroadcaster(guildId);
    if (!cfg) return res.redirect(`/manage/${guildId}/twitch-analytics`);
    try {
        const [result] = await pool.execute(
            `UPDATE twitch_anomaly_alerts
                SET status = ?, resolved_by_discord_id = ?, resolved_at = NOW(), resolution_note = ?,
                    evidence_json = JSON_SET(COALESCE(evidence_json, '{}'),
                        '$.acknowledged_by', ?, '$.acknowledged_at', NOW(), '$.ack_note', ?)
              WHERE id = ? AND broadcaster_id = ?`,
            [nextStatus, req.user?.id || null, note, uname, note, alertId, String(cfg.broadcaster_twitch_id)]);
        if (result.affectedRows) logger.info(`[TwitchAnalyticsPage] anomaly ${alertId} marked ${nextStatus} by ${uname}`);
        else logger.warn(`[TwitchAnalyticsPage] anomaly ${alertId} not found for guild ${guildId}`);
        clearIntegrityCache();
    } catch (e) { logger.warn(`[TwitchAnalyticsPage] anomaly status update failed: ${e.message}`, { err: e.message }); }
    if (req.query.next === 'streamers') return res.redirect(`/manage/${guildId}?page=streamers&tab=analytics`);
    if (req.query.next === 'integrity') {
        const days = INTEGRITY_DAYS.has(Number(req.query.days)) ? Number(req.query.days) : 90;
        return res.redirect(`/manage/${guildId}/twitch-analytics/integrity?days=${days}#sec-anomalies`);
    }
    res.redirect(`/manage/${guildId}/twitch-analytics?range=${req.query.range || '7d'}#alerts`);
});


// Live hero feed for the Live tab. A snapshot older than LIVE_STALE_MS means the
// aggregator stopped seeing the stream, so it reads as offline even if is_live=1.
const LIVE_STALE_MS = 5 * 60 * 1000;
const LIVE_SERIES_CAP_MIN = 12 * 60;

router.get('/manage/:guildId/twitch-analytics/live.json', checkAuth, checkGuildAdmin, async (req, res) => {
    try {
        const cfg = await resolveBroadcaster(req.params.guildId);
        if (!cfg) return res.status(404).json({ ok: false, error: 'no broadcaster' });
        const bid = String(cfg.broadcaster_twitch_id);

        const [[latest]] = await pool.execute(
            `SELECT recorded_at, is_live, viewer_count, chatter_count
               FROM twitch_stream_snapshots WHERE broadcaster_id = ?
              ORDER BY recorded_at DESC LIMIT 1`, [bid]);
        const fresh = latest && (Date.now() - new Date(latest.recorded_at).getTime()) < LIVE_STALE_MS;
        const isLive = !!(fresh && latest.is_live);

        const [[meta]] = await pool.execute(
            `SELECT title, category_name, changed_at FROM twitch_category_history
              WHERE broadcaster_id = ? ORDER BY changed_at DESC LIMIT 1`, [bid]);

        const out = {
            ok: true, login: cfg.broadcaster_twitch_username, live: isLive,
            as_of: latest?.recorded_at || null,
            title: meta?.title || null, category: meta?.category_name || null,
        };

        if (isLive) {
            const [[open]] = await pool.execute(
                `SELECT started_at FROM twitch_stream_sessions
                  WHERE broadcaster_id = ? AND ended_at IS NULL
                  ORDER BY started_at DESC LIMIT 1`, [bid]);
            const capStart = new Date(Date.now() - LIVE_SERIES_CAP_MIN * 60000);
            const startedAt = open?.started_at ? new Date(open.started_at) : null;
            const since = startedAt && startedAt > capStart ? startedAt : capStart;

            const [series] = await pool.execute(
                `SELECT UNIX_TIMESTAMP(recorded_at) AS t, viewer_count AS v, chatter_count AS c,
                        msg_count AS m, follow_count AS f, sub_count + gift_sub_count AS s, bit_count AS b
                   FROM twitch_stream_snapshots
                  WHERE broadcaster_id = ? AND recorded_at >= ? AND is_live = 1
                  ORDER BY recorded_at ASC`, [bid, since]);

            const sum = (k) => series.reduce((a, r) => a + (Number(r[k]) || 0), 0);
            const last15 = series.slice(-15);
            out.started_at = startedAt;
            out.viewers = Number(latest.viewer_count) || 0;
            out.peak_viewers = series.reduce((a, r) => Math.max(a, Number(r.v) || 0), 0);
            out.chat_per_min = last15.length ? Math.round(last15.reduce((a, r) => a + (Number(r.m) || 0), 0) / last15.length) : 0;
            out.chatters_now = Number(latest.chatter_count) || 0;
            out.totals = { follows: sum('f'), subs: sum('s'), bits: sum('b'), msgs: sum('m') };
            const [[rank]] = await pool.execute(
                `SELECT game_name, rank_pos, channels_sampled FROM twitch_category_rank_snapshots
                  WHERE broadcaster_id = ? AND recorded_at > DATE_SUB(NOW(), INTERVAL 15 MINUTE)
                  ORDER BY recorded_at DESC LIMIT 1`, [bid]);
            out.rank = rank ? { pos: rank.rank_pos, of: Number(rank.channels_sampled) || 0, game: rank.game_name } : null;
            out.series = series.map(r => [Number(r.t), Number(r.v) || 0, Number(r.m) || 0, Number(r.f) || 0, Number(r.s) || 0, Number(r.b) || 0]);
        } else {
            const [[last]] = await pool.execute(
                `SELECT started_at, ended_at, duration_minutes, peak_viewers, avg_viewers,
                        total_msgs, total_follows, total_subs, total_gift_subs, total_bits,
                        primary_category_name, title_at_start
                   FROM twitch_stream_sessions
                  WHERE broadcaster_id = ? AND ended_at IS NOT NULL
                  ORDER BY started_at DESC LIMIT 1`, [bid]);
            out.last_session = last || null;
        }

        const [alerts] = await pool.execute(
            `SELECT id, alert_type, severity, created_at, evidence_json
               FROM twitch_anomaly_alerts
              WHERE broadcaster_id = ? AND status = 'open'
                AND severity IN ('warning','critical')
                AND created_at > DATE_SUB(NOW(), INTERVAL 60 MINUTE)
              ORDER BY created_at DESC LIMIT 5`, [bid]);
        out.alerts = alerts.map(a => {
            let interp = null;
            try { interp = JSON.parse(a.evidence_json || '{}').interpretation || null; } catch {}
            return { id: a.id, type: a.alert_type, severity: a.severity, at: a.created_at, note: interp };
        });

        res.set('Cache-Control', 'no-store');
        res.json(out);
    } catch (err) {
        logger.error(`[TwitchAnalyticsPage] live.json failed: ${err.message}`);
        res.status(500).json({ ok: false, error: 'live feed failed' });
    }
});


// ─── Channel integrity report (HTML / PDF / PNG) ────────────────────────────
const INTEGRITY_VIEW = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'views', 'twitch-integrity-report.ejs');
const INTEGRITY_DAYS = new Set([7, 30, 90]);

/** The server's configured timezone (guild_settings), as an IANA zone the report can format in. */
async function reportTimezone(guildId) {
    const { getGuildTimezone, isIanaTimezone } = await import('../../utils/guild-timezone.js');
    const tz = await getGuildTimezone(guildId);
    return isIanaTimezone(tz) ? tz : 'UTC';
}

async function integrityLocals(req) {
    const guildId = req.params.guildId;
    const cfg = await resolveBroadcaster(guildId);
    if (!cfg) return null;
    const days = INTEGRITY_DAYS.has(Number(req.query.days)) ? Number(req.query.days) : 90;
    const report = await buildIntegrityReport(String(cfg.broadcaster_twitch_id), { days });
    const tz = await reportTimezone(guildId);
    return { report, guildId, tz, days, bid: String(cfg.broadcaster_twitch_id), login: cfg.broadcaster_twitch_username,
             base: `/manage/${guildId}/twitch-analytics/integrity`, printMode: false,
             user: req.user, isSuperAdmin: !!req.isSuperAdmin };
}

router.get('/manage/:guildId/twitch-analytics/integrity', checkAuth, checkGuildAdmin, async (req, res) => {
    try {
        const locals = await integrityLocals(req);
        if (!locals) return res.status(404).render('error', { user: req.user, error: 'No Twitch channel connected to this server.' });
        res.set('Cache-Control', 'no-store');
        locals.alertMessages = await alertChatMessages(locals.bid, locals.report.anomalies.alerts);
        res.render('twitch-integrity-report', locals);
    } catch (err) {
        logger.error(`[TwitchAnalyticsPage] integrity report failed: ${err.message}`);
        res.status(500).render('error', { user: req.user, error: 'Integrity report failed to build.' });
    }
});

async function sendIntegrityFile(req, res, format) {
    try {
        const locals = await integrityLocals(req);
        if (!locals) return res.status(404).send('No Twitch channel connected to this server.');
        const files = await renderIntegrityFiles(locals.report, { login: locals.login, guildId: locals.guildId, tz: locals.tz });
        res.set({ 'Content-Type': format === 'pdf' ? 'application/pdf' : 'image/png',
                  'Content-Disposition': `attachment; filename="${files.baseName}.${format}"`, 'Cache-Control': 'no-store' });
        res.send(format === 'pdf' ? files.pdf : files.png);
    } catch (err) {
        logger.error(`[TwitchAnalyticsPage] integrity ${format} failed: ${err.message}`);
        if (!res.headersSent) res.status(500).send('Integrity report failed to render.');
    }
}

router.get('/manage/:guildId/twitch-analytics/integrity.pdf', checkAuth, checkGuildAdmin, (req, res) => sendIntegrityFile(req, res, 'pdf'));
router.get('/manage/:guildId/twitch-analytics/integrity.png', checkAuth, checkGuildAdmin, (req, res) => sendIntegrityFile(req, res, 'png'));
router.get('/manage/:guildId/twitch-analytics/integrity.csv', checkAuth, checkGuildAdmin, async (req, res) => {
    try {
        const locals = await integrityLocals(req);
        if (!locals) return res.status(404).send('No Twitch channel connected to this server.');
        const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: locals.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        const iso = (d) => (d ? fmt.format(new Date(d)) : '');
        const zone = locals.tz.replace(/[^A-Za-z0-9_/+-]/g, '');
        const yn = (v) => (v === null || v === undefined ? '' : v ? 'yes' : 'no');
        // Logins are validated [a-z0-9_] Twitch names, so no cell can start a spreadsheet formula.
        const lines = [['login', `account_created (${zone})`, 'still_on_twitch', 'minutes_in_chat', 'streams_present',
                        `first_seen (${zone})`, 'first_seen_is_data_start', `last_seen (${zone})`, 'last_seen_is_data_end',
                        'in_creation_batch', 'sync_cohort', 'other_tracked_channels_seen', 'on_commanderroot_known_bot_list',
                        'default_avatar', 'has_bio', 'ever_streamed', 'stream_evidence', `last_stream (${zone})`, `removed_from_twitch (${zone})`,
                        'days_old_when_first_seen', 'flag_count', 'flags'].join(',')];
        for (const a of locals.report.accounts || []) {
            lines.push([a.login, iso(a.created), a.exists === null ? '' : a.exists ? 'yes' : 'no', a.minutes, a.streams,
                        iso(a.firstSeen), a.firstAtEdge ? 'yes' : 'no', iso(a.lastSeen), a.lastAtEdge ? 'yes' : 'no',
                        a.inBatch ? 'yes' : 'no', a.cohort || '', a.otherChannels,
                        a.onKnownList === null ? 'not checked' : a.onKnownList ? 'yes' : 'no',
                        yn(a.defaultAvatar), yn(a.hasBio), yn(a.streamed), a.streamEvidence || '', iso(a.lastVodAt), iso(a.goneAt),
                        a.ageAtFirstSeen ?? '',
                        (a.flags || []).filter(f => f.key !== 'silent' && f.key !== 'elsewhere').length,
                        // Labels are fixed strings from the report builder; quoted so the list stays one cell.
                        `"${(a.flags || []).map(f => f.label).join('; ').replace(/"/g, '""')}"`].join(','));
        }
        const stamp = new Date().toISOString().slice(0, 10);
        const name = `${String(locals.login).replace(/[^a-z0-9_]/gi, '')}-silent-accounts-${locals.report.window.days}d-${stamp}.csv`;
        res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
        res.send(lines.join('\n') + '\n');
    } catch (err) {
        logger.error(`[TwitchAnalyticsPage] integrity csv failed: ${err.message}`);
        if (!res.headersSent) res.status(500).send('Account list failed to build.');
    }
});

// ─── Known-bot accounts: one row per listed account, oldest first ───────────
async function knownBotLocals(req) {
    const guildId = req.params.guildId;
    const cfg = await resolveBroadcaster(guildId);
    if (!cfg) return null;
    const bid = String(cfg.broadcaster_twitch_id);
    const days = INTEGRITY_DAYS.has(Number(req.query.days)) ? Number(req.query.days) : 90;
    return { list: await buildKnownBotList(bid), tz: await reportTimezone(guildId), guildId, bid, days,
             login: cfg.broadcaster_twitch_username, batchDays: INTEGRITY_THRESHOLDS.creationClusterDays,
             onlyNew: req.query.view === 'new',
             base: `/manage/${guildId}/twitch-analytics/integrity/known-bots`,
             user: req.user, isSuperAdmin: !!req.isSuperAdmin };
}

router.get('/manage/:guildId/twitch-analytics/integrity/known-bots', checkAuth, checkGuildAdmin, async (req, res) => {
    try {
        const locals = await knownBotLocals(req);
        if (!locals) return res.status(404).render('error', { user: req.user, error: 'No Twitch channel connected to this server.' });
        res.set('Cache-Control', 'no-store');
        res.render('twitch-known-bots', locals);
    } catch (err) {
        logger.error(`[TwitchAnalyticsPage] known-bot list failed: ${err.message}`);
        res.status(500).render('error', { user: req.user, error: 'Known-bot list failed to build.' });
    }
});

router.get('/manage/:guildId/twitch-analytics/integrity/known-bots.csv', checkAuth, checkGuildAdmin, async (req, res) => {
    try {
        const locals = await knownBotLocals(req);
        if (!locals) return res.status(404).send('No Twitch channel connected to this server.');
        const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: locals.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        const iso = (d) => (d ? fmt.format(new Date(d)) : '');
        const zone = locals.tz.replace(/[^A-Za-z0-9_/+-]/g, '');
        // Logins are validated [a-z0-9_] Twitch names, so no cell can start a spreadsheet formula.
        const lines = [['login', 'user_id', `account_created (${zone})`, 'on_commanderroot_known_bot_list', `first_found_on_list (${zone})`,
                        `last_checked (${zone})`, 'commanderroot_lookup_url', `first_in_chat (${zone})`, `last_in_chat (${zone})`, 'minutes_in_chat_lists',
                        'has_chatted', 'role', 'in_creation_batch', 'still_on_twitch', 'twitch_profile_url', 'twitch_report_url', 'new_in_latest_stream'].join(',')];
        const accounts = locals.onlyNew ? locals.list.accounts.filter(a => a.isNew) : locals.list.accounts;
        for (const a of accounts) {
            lines.push([a.login, a.id, iso(a.created), 'yes', iso(a.firstListedAt), iso(a.checkedAt), a.listUrl, iso(a.firstSeen), iso(a.lastSeen), a.minutes,
                        a.chatted ? 'yes' : 'no', a.role ? `"${a.role}"` : '', a.inBatch ? 'yes' : 'no', a.exists === null ? '' : a.exists ? 'yes' : 'no',
                        a.profileUrl, a.exists === false ? '' : a.reportUrl, a.isNew ? 'yes' : 'no'].join(','));
        }
        const stamp = new Date().toISOString().slice(0, 10);
        const name = `${String(locals.login).replace(/[^a-z0-9_]/gi, '')}-known-bot-accounts${locals.onlyNew ? '-new' : ''}-${stamp}.csv`;
        res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
        res.send(lines.join('\n') + '\n');
    } catch (err) {
        logger.error(`[TwitchAnalyticsPage] known-bot csv failed: ${err.message}`);
        if (!res.headersSent) res.status(500).send('Known-bot list failed to build.');
    }
});

export default router;
