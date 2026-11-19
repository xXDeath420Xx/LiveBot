/**
 * Twitch broadcaster backfill — one-shot Helix sweep that seeds analytics tables with
 * state EventSub webhooks can't retroactively emit.
 *
 * EventSub only fires events going forward: subs happening now, polls starting now, bits
 * being cheered now. For a freshly-connected broadcaster the entire history is invisible,
 * so the analytics page sits empty until events accumulate. This module hits the Helix
 * REST endpoints that return CURRENT STATE and RECENT HISTORY so the owner sees real
 * numbers immediately instead of a wasteland of zeros.
 *
 * Scope-aware: each Helix call checks the broadcaster's granted scopes before firing. A
 * missing scope records a soft error in scope_errors_json instead of a 401 explosion.
 *
 * Idempotent for event tables: before inserting into twitch_{poll,prediction,hype_train,
 * goal,charity}_events we check for (broadcaster_id, X_id, event_type) existence. Repeat
 * runs don't duplicate historical events.
 *
 * Scope lookup table — which Helix endpoint needs which OAuth scope:
 *   /channels/followers         — moderator:read:followers
 *   /subscriptions              — channel:read:subscriptions
 *   /bits/leaderboard           — bits:read
 *   /channels/vips              — channel:read:vips
 *   /moderation/moderators      — moderation:read
 *   /goals                      — channel:read:goals
 *   /charity/campaigns          — channel:read:charity
 *   /polls                      — channel:read:polls
 *   /predictions                — channel:read:predictions
 *   /hypetrain/events           — channel:read:hype_train
 *   /streams, /channels, /teams — no scope (app-token-safe but accepts user token)
 */
import axios from 'axios';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { getTierBAuth } from './twitch-write.js';

const LOG = '[TwitchBackfill]';
const HELIX = 'https://api.twitch.tv/helix';

function headers(token) {
    return {
        'Client-ID': process.env.TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${token}`,
    };
}

function has(scopes, s) {
    return scopes instanceof Set ? scopes.has(s) : Array.isArray(scopes) ? scopes.includes(s) : false;
}

/**
 * GET a Helix endpoint, returning data array (or empty array on scope miss / error).
 * Each call sets its own entry in `errors` on failure so one dead endpoint doesn't poison
 * the whole run.
 */
async function helixGet(url, token, params, errors, key) {
    try {
        const r = await axios.get(url, { headers: headers(token), params, timeout: 15000 });
        return r.data;
    } catch (e) {
        const status = e.response?.status;
        const msg = e.response?.data?.message || e.message;
        errors[key] = { status, message: msg };
        logger.warn(`${LOG} ${key} failed status=${status} msg=${msg}`);
        return null;
    }
}

/**
 * Insert an event row only if (broadcaster_id, id_col, event_type) doesn't already exist.
 * Idempotency guard for the *_events tables since none of them carry a unique constraint
 * on the natural key (schema has MUL indexes only, so a naïve INSERT would duplicate).
 */
async function upsertEventIfNew(table, idCol, broadcasterId, idValue, eventType, columns) {
    const [existing] = await pool.query(
        `SELECT id FROM ?? WHERE broadcaster_id = ? AND ?? = ? AND event_type = ? LIMIT 1`,
        [table, broadcasterId, idCol, idValue, eventType],
    );
    if (existing.length) return false;
    const cols = Object.keys(columns);
    const placeholders = cols.map(() => '?').join(', ');
    await pool.query(
        `INSERT INTO ?? (${cols.join(', ')}) VALUES (${placeholders})`,
        [table, ...cols.map(c => columns[c])],
    );
    return true;
}

function sqlDate(iso) {
    if (!iso) return null;
    try {
        return new Date(iso).toISOString().slice(0, 19).replace('T', ' ');
    } catch { return null; }
}

/**
 * Run a complete backfill for one broadcaster.
 *
 * @param {Object} args
 * @param {string} args.broadcasterId   Twitch user id (numeric string)
 * @param {string} args.accessToken     Decrypted user access token
 * @param {string[]|Set<string>} args.scopes  Granted OAuth scopes
 * @param {string} args.login           Broadcaster's twitch login (for logging)
 * @returns {Promise<{ok:boolean, duration_ms:number, errors:object, counts:object}>}
 */
export async function runBackfill({ broadcasterId, accessToken, scopes, login, triggerSource, triggerUserId }) {
    const started = Date.now();
    const bid = String(broadcasterId);
    const scopeSet = scopes instanceof Set ? scopes : new Set(scopes || []);
    const errors = {};
    const counts = {
        followers: 0, subscribers: 0, bits_entries: 0,
        vips: 0, mods: 0, goals: 0, polls: 0, predictions: 0,
        hype_trains: 0, charity: 0, teams: 0,
    };
    const summary = { broadcaster_id: bid, broadcaster_login: login || null };

    logger.info(`${LOG} starting backfill for ${login || bid}`);

    // 1. Follower count (moderator:read:followers)
    if (has(scopeSet, 'moderator:read:followers')) {
        const r = await helixGet(`${HELIX}/channels/followers`, accessToken, { broadcaster_id: bid, first: 1 }, errors, 'followers');
        if (r && typeof r.total === 'number') { summary.follower_count = r.total; counts.followers = r.total; }
    } else errors.followers = { status: 0, message: 'scope moderator:read:followers not granted' };

    // 2. Subscriber count + total points (channel:read:subscriptions)
    if (has(scopeSet, 'channel:read:subscriptions')) {
        const r = await helixGet(`${HELIX}/subscriptions`, accessToken, { broadcaster_id: bid, first: 1 }, errors, 'subscriptions');
        if (r && typeof r.total === 'number') {
            summary.subscriber_count = r.total;
            summary.subscriber_points = typeof r.points === 'number' ? r.points : null;
            counts.subscribers = r.total;
        }
    } else errors.subscriptions = { status: 0, message: 'scope channel:read:subscriptions not granted' };

    // 3. Bits leaderboard (bits:read) — top 100 all-time. Helix rejects {period: 'month'}
    // without an explicit started_at; period='all' sidesteps that and gives a more durable
    // signal for a brand-new connection anyway.
    if (has(scopeSet, 'bits:read')) {
        const r = await helixGet(`${HELIX}/bits/leaderboard`, accessToken, { count: 100, period: 'all' }, errors, 'bits_leaderboard');
        if (r && Array.isArray(r.data)) {
            summary.bits_leaderboard_json = JSON.stringify(r.data);
            summary.bits_leaderboard_period = 'all';
            summary.bits_total_period = r.total || null;
            counts.bits_entries = r.data.length;
        }
    } else errors.bits_leaderboard = { status: 0, message: 'scope bits:read not granted' };

    // 4. Current stream (public — works with any token)
    {
        const r = await helixGet(`${HELIX}/streams`, accessToken, { user_id: bid }, errors, 'stream');
        if (r && Array.isArray(r.data)) {
            summary.current_stream_json = JSON.stringify(r.data[0] || null);
        }
    }

    // 5. Current channel info (public)
    {
        const r = await helixGet(`${HELIX}/channels`, accessToken, { broadcaster_id: bid }, errors, 'channel');
        if (r && Array.isArray(r.data) && r.data[0]) {
            summary.current_channel_json = JSON.stringify(r.data[0]);
        }
    }

    // 6. Current VIPs (channel:read:vips) — stored as roster snapshot, NOT as fake 'add' events
    if (has(scopeSet, 'channel:read:vips')) {
        const vips = [];
        let cursor = null;
        for (let page = 0; page < 10; page++) {
            const r = await helixGet(`${HELIX}/channels/vips`, accessToken,
                { broadcaster_id: bid, first: 100, ...(cursor ? { after: cursor } : {}) }, errors, 'vips');
            if (!r?.data) break;
            vips.push(...r.data);
            cursor = r.pagination?.cursor;
            if (!cursor) break;
        }
        summary.current_vips_json = JSON.stringify(vips);
        counts.vips = vips.length;
    } else errors.vips = { status: 0, message: 'scope channel:read:vips not granted' };

    // 7. Current mods (moderation:read)
    if (has(scopeSet, 'moderation:read')) {
        const mods = [];
        let cursor = null;
        for (let page = 0; page < 10; page++) {
            const r = await helixGet(`${HELIX}/moderation/moderators`, accessToken,
                { broadcaster_id: bid, first: 100, ...(cursor ? { after: cursor } : {}) }, errors, 'mods');
            if (!r?.data) break;
            mods.push(...r.data);
            cursor = r.pagination?.cursor;
            if (!cursor) break;
        }
        summary.current_mods_json = JSON.stringify(mods);
        counts.mods = mods.length;
    } else errors.mods = { status: 0, message: 'scope moderation:read not granted' };

    // 8. Active goals (channel:read:goals) — insert as 'progress' events (idempotent per goal_id)
    if (has(scopeSet, 'channel:read:goals')) {
        const r = await helixGet(`${HELIX}/goals`, accessToken, { broadcaster_id: bid }, errors, 'goals');
        if (r && Array.isArray(r.data)) {
            summary.active_goals_json = JSON.stringify(r.data);
            for (const g of r.data) {
                const inserted = await upsertEventIfNew('twitch_goal_events', 'goal_id', bid, g.id, 'progress', {
                    broadcaster_id: bid,
                    goal_id: g.id,
                    event_type: 'progress',
                    goal_type: g.type || null,
                    description: g.description || null,
                    current_amount: g.current_amount || 0,
                    target_amount: g.target_amount || 0,
                    is_achieved: 0,
                    occurred_at: sqlDate(g.created_at) || new Date().toISOString().slice(0, 19).replace('T', ' '),
                }).catch(e => { logger.warn(`${LOG} goal insert failed: ${e.message}`); return false; });
                if (inserted) counts.goals++;
            }
        }
    } else errors.goals = { status: 0, message: 'scope channel:read:goals not granted' };

    // 9. Current charity campaign (channel:read:charity)
    if (has(scopeSet, 'channel:read:charity')) {
        const r = await helixGet(`${HELIX}/charity/campaigns`, accessToken, { broadcaster_id: bid }, errors, 'charity');
        if (r && Array.isArray(r.data) && r.data[0]) {
            const c = r.data[0];
            summary.charity_campaign_json = JSON.stringify(c);
            // Store as a 'start' event (idempotent per campaign_id)
            const inserted = await upsertEventIfNew('twitch_charity_events', 'campaign_id', bid, c.id, 'start', {
                broadcaster_id: bid,
                campaign_id: c.id,
                event_type: 'start',
                charity_name: c.charity_name || null,
                donor_user_login: null,
                donation_amount: null,
                donation_currency: c.current_amount?.currency || null,
                current_amount: c.current_amount?.value || 0,
                target_amount: c.target_amount?.value || 0,
                occurred_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
            }).catch(e => { logger.warn(`${LOG} charity insert failed: ${e.message}`); return false; });
            if (inserted) counts.charity++;
        }
    } else errors.charity = { status: 0, message: 'scope channel:read:charity not granted' };

    // 10. Recent polls (channel:read:polls) — last 20
    if (has(scopeSet, 'channel:read:polls')) {
        const r = await helixGet(`${HELIX}/polls`, accessToken, { broadcaster_id: bid, first: 20 }, errors, 'polls');
        if (r && Array.isArray(r.data)) {
            for (const p of r.data) {
                const eventType = p.status === 'ACTIVE' ? 'begin' : 'end';
                const inserted = await upsertEventIfNew('twitch_poll_events', 'poll_id', bid, p.id, eventType, {
                    broadcaster_id: bid,
                    poll_id: p.id,
                    event_type: eventType,
                    title: (p.title || '').slice(0, 255),
                    choices_json: JSON.stringify(p.choices || []),
                    bits_voting_enabled: p.bits_voting_enabled ? 1 : 0,
                    bits_per_vote: p.bits_per_vote || 0,
                    channel_points_voting_enabled: p.channel_points_voting_enabled ? 1 : 0,
                    channel_points_per_vote: p.channel_points_per_vote || 0,
                    status: p.status || null,
                    occurred_at: sqlDate(p.ended_at || p.started_at) || new Date().toISOString().slice(0, 19).replace('T', ' '),
                }).catch(e => { logger.warn(`${LOG} poll insert failed: ${e.message}`); return false; });
                if (inserted) counts.polls++;
            }
        }
    } else errors.polls = { status: 0, message: 'scope channel:read:polls not granted' };

    // 11. Recent predictions (channel:read:predictions) — last 25
    if (has(scopeSet, 'channel:read:predictions')) {
        const r = await helixGet(`${HELIX}/predictions`, accessToken, { broadcaster_id: bid, first: 25 }, errors, 'predictions');
        if (r && Array.isArray(r.data)) {
            for (const p of r.data) {
                const eventType = p.status === 'ACTIVE' ? 'begin'
                    : p.status === 'LOCKED' ? 'lock'
                    : 'end';
                const inserted = await upsertEventIfNew('twitch_prediction_events', 'prediction_id', bid, p.id, eventType, {
                    broadcaster_id: bid,
                    prediction_id: p.id,
                    event_type: eventType,
                    title: (p.title || '').slice(0, 255),
                    outcomes_json: JSON.stringify(p.outcomes || []),
                    winning_outcome_id: p.winning_outcome_id || null,
                    status: p.status || null,
                    occurred_at: sqlDate(p.ended_at || p.locked_at || p.created_at) || new Date().toISOString().slice(0, 19).replace('T', ' '),
                }).catch(e => { logger.warn(`${LOG} prediction insert failed: ${e.message}`); return false; });
                if (inserted) counts.predictions++;
            }
        }
    } else errors.predictions = { status: 0, message: 'scope channel:read:predictions not granted' };

    // 12. Hype train history — Helix /hypetrain/events was deprecated 2026 with no replacement
    // (see https://discuss.dev.twitch.com/t/.../64299). Hype train data now flows exclusively
    // via EventSub channel.hype_train.{begin,progress,end} going forward; no backfill possible.
    // Left as a no-op so the shape of the backfill result stays stable for callers.

    // 13. Teams (public)
    {
        const r = await helixGet(`${HELIX}/teams/channel`, accessToken, { broadcaster_id: bid }, errors, 'teams');
        if (r && Array.isArray(r.data)) {
            summary.teams_json = JSON.stringify(r.data);
            counts.teams = r.data.length;
        }
    }

    // 14. VODs — archive + highlight, up to 100 of each. Enriches pre-OAuth session rows
    // (whose title/category are NULL because they predate OAuth) by matching VOD created_at
    // to session started_at within a ±5 min window.
    counts.vods = 0;
    for (const vodType of ['archive', 'highlight']) {
        const r = await helixGet(`${HELIX}/videos`, accessToken,
            { user_id: bid, first: 100, type: vodType }, errors, `vods_${vodType}`);
        if (r && Array.isArray(r.data)) {
            for (const v of r.data) {
                try {
                    // Parse Twitch duration string (eg "3h47m22s") to seconds.
                    const dur = String(v.duration || '0s');
                    const h = (dur.match(/(\d+)h/) || [])[1] | 0;
                    const m = (dur.match(/(\d+)m/) || [])[1] | 0;
                    const s = (dur.match(/(\d+)s/) || [])[1] | 0;
                    const durSec = h * 3600 + m * 60 + s;
                    await pool.query(
                        `INSERT INTO twitch_vods_catalog
                         (video_id, broadcaster_id, type, title, description, category_id, category_name,
                          view_count, duration_seconds, language, thumbnail_url, url, created_at_twitch, published_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE
                             title = VALUES(title), view_count = VALUES(view_count),
                             duration_seconds = VALUES(duration_seconds),
                             category_name = COALESCE(VALUES(category_name), category_name),
                             updated_at = CURRENT_TIMESTAMP`,
                        [
                            String(v.id), bid, vodType,
                            (v.title || '').slice(0, 500), v.description || null,
                            v.stream_id || null, null,
                            v.view_count || 0, durSec, v.language || null,
                            (v.thumbnail_url || '').replace(/%\{width\}x%\{height\}/, '320x180'),
                            v.url || null,
                            sqlDate(v.created_at), sqlDate(v.published_at),
                        ],
                    );
                    counts.vods++;
                } catch (e) {
                    logger.warn(`${LOG} vod insert failed id=${v.id}: ${e.message}`);
                }
            }
        }
    }

    // 14b. Enrich pre-OAuth sessions from VODs. Match on broadcaster_id + started_at ≈
    // VOD created_at (±5 min). Only touches rows where title_at_start IS NULL so we don't
    // overwrite real EventSub-captured session data.
    try {
        const [enrichResult] = await pool.query(
            `UPDATE twitch_stream_sessions s
                JOIN twitch_vods_catalog v
                  ON s.broadcaster_id = v.broadcaster_id
                 AND v.type = 'archive'
                 AND ABS(TIMESTAMPDIFF(SECOND, s.started_at, v.created_at_twitch)) <= 300
                SET s.title_at_start = COALESCE(s.title_at_start, v.title),
                    s.duration_minutes = COALESCE(s.duration_minutes, GREATEST(1, v.duration_seconds DIV 60))
              WHERE s.broadcaster_id = ?
                AND (s.title_at_start IS NULL OR s.duration_minutes IS NULL)`,
            [bid],
        );
        counts.vod_enriched_sessions = enrichResult.affectedRows || 0;
    } catch (e) {
        logger.warn(`${LOG} VOD→session enrichment failed: ${e.message}`);
    }

    // 15. Clips — the all-time top 100 by views, plus every clip from the last 90 days so
    // per-window counts and view-gain tracking include recent low-view clips. Separate from
    // twitch_clip_seen (the autopost table).
    {
        const seenClips = new Set();
        const upsertClip = async (c) => {
            if (!c?.id || seenClips.has(c.id)) return;
            seenClips.add(c.id);
            try {
                await pool.query(
                    `INSERT INTO twitch_clips_catalog
                     (clip_id, broadcaster_id, creator_name, creator_id, title, game_id, game_name,
                      view_count, duration_seconds, language, thumbnail_url, url, embed_url, vod_id, vod_offset, created_at_twitch)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                         view_count = VALUES(view_count),
                         title = VALUES(title),
                         game_name = COALESCE(VALUES(game_name), game_name),
                         updated_at = CURRENT_TIMESTAMP`,
                    [
                        String(c.id), bid,
                        c.creator_name || null, c.creator_id || null,
                        (c.title || '').slice(0, 500),
                        c.game_id || null, null,
                        c.view_count || 0, c.duration || 0,
                        c.language || null, c.thumbnail_url || null,
                        c.url || null, c.embed_url || null,
                        c.video_id || null, c.vod_offset || null,
                        sqlDate(c.created_at),
                    ],
                );
                counts.clips = (counts.clips || 0) + 1;
            } catch (e) {
                logger.warn(`${LOG} clip insert failed id=${c.id}: ${e.message}`);
            }
        };

        const r = await helixGet(`${HELIX}/clips`, accessToken, { broadcaster_id: bid, first: 100 }, errors, 'clips_catalog');
        if (r && Array.isArray(r.data)) {
            for (const c of r.data) await upsertClip(c);
            summary.top_clips_json = JSON.stringify(r.data.slice(0, 10));
        }

        const windowParams = {
            broadcaster_id: bid, first: 100,
            started_at: new Date(Date.now() - 90 * 86_400_000).toISOString(),
            ended_at: new Date().toISOString(),
        };
        let cursor = null;
        for (let page = 0; page < 20; page++) {
            const w = await helixGet(`${HELIX}/clips`, accessToken,
                cursor ? { ...windowParams, after: cursor } : windowParams, errors, 'clips_recent');
            if (!w || !Array.isArray(w.data) || !w.data.length) break;
            for (const c of w.data) await upsertClip(c);
            cursor = w.pagination?.cursor || null;
            if (!cursor) break;
        }
    }

    // 16. Ad schedule — scope channel:read:ads. Fills the "Ads" headline tile.
    if (has(scopeSet, 'channel:read:ads')) {
        const r = await helixGet(`${HELIX}/channels/ads`, accessToken, { broadcaster_id: bid }, errors, 'ads');
        if (r && Array.isArray(r.data) && r.data[0]) {
            summary.ad_schedule_json = JSON.stringify(r.data[0]);
            counts.ads_info = 1;
        }
    } else errors.ads = { status: 0, message: 'scope channel:read:ads not granted' };

    // 17. Chat settings (public). Shows follower-only / sub-only / slow / emote-only state.
    {
        const r = await helixGet(`${HELIX}/chat/settings`, accessToken, { broadcaster_id: bid, moderator_id: bid }, errors, 'chat_settings');
        if (r && Array.isArray(r.data) && r.data[0]) {
            summary.chat_settings_json = JSON.stringify(r.data[0]);
            counts.chat_settings = 1;
        }
    }

    // 18. Schedule — upcoming scheduled broadcasts (public endpoint). Returns 404 when the
    // channel has no schedule which is fine; errors[] records it as a soft 404.
    {
        const r = await helixGet(`${HELIX}/schedule`, accessToken, { broadcaster_id: bid, first: 25 }, errors, 'schedule');
        if (r && r.data && Array.isArray(r.data.segments)) {
            summary.current_schedule_json = JSON.stringify({
                vacation: r.data.vacation || null,
                segments: r.data.segments.slice(0, 25),
            });
            for (const seg of r.data.segments.slice(0, 25)) {
                try {
                    await pool.query(
                        `INSERT INTO twitch_schedule_segments
                         (segment_id, broadcaster_id, title, category_id, category_name, is_recurring, start_time, end_time, canceled_until)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE
                             title = VALUES(title),
                             start_time = VALUES(start_time), end_time = VALUES(end_time),
                             canceled_until = VALUES(canceled_until),
                             updated_at = CURRENT_TIMESTAMP`,
                        [
                            String(seg.id), bid,
                            (seg.title || '').slice(0, 500),
                            seg.category?.id || null, seg.category?.name || null,
                            seg.is_recurring ? 1 : 0,
                            sqlDate(seg.start_time), sqlDate(seg.end_time),
                            sqlDate(seg.canceled_until),
                        ],
                    );
                    counts.schedule = (counts.schedule || 0) + 1;
                } catch (e) {
                    logger.warn(`${LOG} schedule insert failed id=${seg.id}: ${e.message}`);
                }
            }
        }
    }

    // 19. Custom channel-point rewards (channel:read:redemptions). Enables "rewards +
    // redemption counts" cross-join in the view.
    if (has(scopeSet, 'channel:read:redemptions')) {
        const r = await helixGet(`${HELIX}/channel_points/custom_rewards`, accessToken,
            { broadcaster_id: bid }, errors, 'custom_rewards');
        if (r && Array.isArray(r.data)) {
            for (const rw of r.data) {
                try {
                    await pool.query(
                        `INSERT INTO twitch_custom_rewards
                         (reward_id, broadcaster_id, title, prompt, cost, background_color,
                          is_enabled, is_user_input_required, is_sub_only, cooldown_seconds,
                          max_per_stream, max_per_user_per_stream, is_paused, is_in_stock, redemptions_this_stream)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE
                             title = VALUES(title), cost = VALUES(cost),
                             is_enabled = VALUES(is_enabled),
                             is_paused = VALUES(is_paused), is_in_stock = VALUES(is_in_stock),
                             redemptions_this_stream = VALUES(redemptions_this_stream),
                             updated_at = CURRENT_TIMESTAMP`,
                        [
                            String(rw.id), bid,
                            (rw.title || '').slice(0, 255), rw.prompt || null,
                            rw.cost || 0, rw.background_color || null,
                            rw.is_enabled ? 1 : 0,
                            rw.is_user_input_required ? 1 : 0,
                            rw.is_sub_only ? 1 : 0,
                            rw.global_cooldown_setting?.global_cooldown_seconds || 0,
                            rw.max_per_stream_setting?.max_per_stream || 0,
                            rw.max_per_user_per_stream_setting?.max_per_user_per_stream || 0,
                            rw.is_paused ? 1 : 0,
                            rw.is_in_stock ? 1 : 0,
                            rw.redemptions_redeemed_current_stream || 0,
                        ],
                    );
                    counts.rewards = (counts.rewards || 0) + 1;
                } catch (e) {
                    logger.warn(`${LOG} reward insert failed id=${rw.id}: ${e.message}`);
                }
            }
        }
    } else errors.custom_rewards = { status: 0, message: 'scope channel:read:redemptions not granted' };

    // 20. Subscriber tier breakdown — paginate full sub list to get T1/T2/T3/Prime counts
    // and top gifters. For a channel with 10k+ subs this is 100 pages × ~100ms = 10s; our
    // bound is 50 pages (5k subs) which is fine for 99% of channels.
    if (has(scopeSet, 'channel:read:subscriptions')) {
        const tiers = { '1000': 0, '2000': 0, '3000': 0, 'Prime': 0 };
        const giftersByUser = new Map();
        let cursor = null;
        let giftSubCount = 0;
        for (let page = 0; page < 50; page++) {
            const r = await helixGet(`${HELIX}/subscriptions`, accessToken,
                { broadcaster_id: bid, first: 100, ...(cursor ? { after: cursor } : {}) },
                errors, 'subscriptions_full');
            if (!r?.data) break;
            for (const s of r.data) {
                const tier = s.is_gift ? (giftSubCount++, s.tier) : s.tier;
                if (tier === 'Prime') tiers['Prime']++;
                else if (tiers[tier] !== undefined) tiers[tier]++;
                if (s.is_gift && s.gifter_login) {
                    const g = giftersByUser.get(s.gifter_login) || { login: s.gifter_login, name: s.gifter_name, count: 0 };
                    g.count++;
                    giftersByUser.set(s.gifter_login, g);
                }
            }
            cursor = r.pagination?.cursor;
            if (!cursor || !r.data.length) break;
        }
        const total = tiers['1000'] + tiers['2000'] + tiers['3000'] + tiers['Prime'];
        const topGifters = Array.from(giftersByUser.values()).sort((a, b) => b.count - a.count).slice(0, 10);
        try {
            await pool.query(
                `INSERT INTO twitch_subscriber_breakdown
                 (broadcaster_id, total_count, tier_1000_count, tier_2000_count, tier_3000_count, prime_count, gift_count, top_gifters_json, as_of)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE
                     total_count = VALUES(total_count),
                     tier_1000_count = VALUES(tier_1000_count),
                     tier_2000_count = VALUES(tier_2000_count),
                     tier_3000_count = VALUES(tier_3000_count),
                     prime_count = VALUES(prime_count),
                     gift_count = VALUES(gift_count),
                     top_gifters_json = VALUES(top_gifters_json),
                     as_of = NOW()`,
                [bid, total, tiers['1000'], tiers['2000'], tiers['3000'], tiers['Prime'], giftSubCount, JSON.stringify(topGifters)],
            );
            counts.sub_tiers = total;
        } catch (e) {
            logger.warn(`${LOG} sub breakdown write failed: ${e.message}`);
        }
    }

    // 21. Follower account-age histogram — paginate full follower list to get followed_at
    // timing distribution. Bound at 25 pages (2.5k followers) to keep run time under 5s.
    if (has(scopeSet, 'moderator:read:followers')) {
        const buckets = { lt_1d: 0, '1d_7d': 0, '7d_30d': 0, '30d_90d': 0, '90d_1y': 0, '1y_plus': 0 };
        const recent = [];
        let cursor = null;
        let totalSampled = 0;
        const now = Date.now();
        for (let page = 0; page < 25; page++) {
            const r = await helixGet(`${HELIX}/channels/followers`, accessToken,
                { broadcaster_id: bid, first: 100, ...(cursor ? { after: cursor } : {}) },
                errors, 'followers_full');
            if (!r?.data) break;
            for (const f of r.data) {
                totalSampled++;
                const ageMs = now - new Date(f.followed_at).getTime();
                const d = ageMs / (24 * 3600 * 1000);
                if (d < 1) buckets.lt_1d++;
                else if (d < 7) buckets['1d_7d']++;
                else if (d < 30) buckets['7d_30d']++;
                else if (d < 90) buckets['30d_90d']++;
                else if (d < 365) buckets['90d_1y']++;
                else buckets['1y_plus']++;
                if (recent.length < 10) recent.push({ login: f.user_login, name: f.user_name, at: f.followed_at });
            }
            cursor = r.pagination?.cursor;
            if (!cursor || !r.data.length) break;
        }
        try {
            await pool.query(
                `INSERT INTO twitch_follower_age_histogram
                 (broadcaster_id, total_sampled, bucket_lt_1d, bucket_1d_7d, bucket_7d_30d, bucket_30d_90d, bucket_90d_1y, bucket_1y_plus, top_follow_dates_json, as_of)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE
                     total_sampled = VALUES(total_sampled),
                     bucket_lt_1d = VALUES(bucket_lt_1d),
                     bucket_1d_7d = VALUES(bucket_1d_7d),
                     bucket_7d_30d = VALUES(bucket_7d_30d),
                     bucket_30d_90d = VALUES(bucket_30d_90d),
                     bucket_90d_1y = VALUES(bucket_90d_1y),
                     bucket_1y_plus = VALUES(bucket_1y_plus),
                     top_follow_dates_json = VALUES(top_follow_dates_json),
                     as_of = NOW()`,
                [bid, totalSampled, buckets.lt_1d, buckets['1d_7d'], buckets['7d_30d'], buckets['30d_90d'], buckets['90d_1y'], buckets['1y_plus'], JSON.stringify(recent)],
            );
            counts.follower_histogram = totalSampled;
        } catch (e) {
            logger.warn(`${LOG} follower histogram write failed: ${e.message}`);
        }
    }

    // 22a. AutoMod settings (moderator:read:automod_settings) — one-row snapshot.
    if (has(scopeSet, 'moderator:read:automod_settings')) {
        const r = await helixGet(`${HELIX}/moderation/automod/settings`, accessToken,
            { broadcaster_id: bid, moderator_id: bid }, errors, 'automod_settings');
        if (r && Array.isArray(r.data) && r.data[0]) {
            const s = r.data[0];
            try {
                await pool.query(
                    `INSERT INTO twitch_automod_settings
                     (broadcaster_id, overall_level, disability, aggression, sexuality_sex_or_gender,
                      misogyny, bullying, swearing, race_ethnicity_or_religion, sex_based_terms, as_of)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
                     ON DUPLICATE KEY UPDATE
                         overall_level = VALUES(overall_level), disability = VALUES(disability),
                         aggression = VALUES(aggression), sexuality_sex_or_gender = VALUES(sexuality_sex_or_gender),
                         misogyny = VALUES(misogyny), bullying = VALUES(bullying), swearing = VALUES(swearing),
                         race_ethnicity_or_religion = VALUES(race_ethnicity_or_religion),
                         sex_based_terms = VALUES(sex_based_terms), as_of = NOW()`,
                    [bid, s.overall_level, s.disability, s.aggression, s.sexuality_sex_or_gender,
                     s.misogyny, s.bullying, s.swearing, s.race_ethnicity_or_religion, s.sex_based_terms],
                );
                counts.automod_settings = 1;
            } catch (e) { logger.warn(`${LOG} automod settings insert failed: ${e.message}`); }
        }
    } else errors.automod_settings = { status: 0, message: 'scope moderator:read:automod_settings not granted' };

    // 22b/22c read endpoints also accept the manage scope, which only the write grant has.
    const writeAuth = await getTierBAuth(bid).catch(() => null);
    const modToken = (readScope, manageScope) => (has(scopeSet, readScope) ? accessToken
        : (writeAuth?.accessToken && writeAuth.scopes.has(manageScope) ? writeAuth.accessToken : null));

    // 22b. Blocked terms (moderator:read:blocked_terms or moderator:manage:blocked_terms)
    const blockedTermsToken = modToken('moderator:read:blocked_terms', 'moderator:manage:blocked_terms');
    if (blockedTermsToken) {
        const terms = [];
        let cursor = null;
        for (let page = 0; page < 10; page++) {
            const r = await helixGet(`${HELIX}/moderation/blocked_terms`, blockedTermsToken,
                { broadcaster_id: bid, moderator_id: bid, first: 100, ...(cursor ? { after: cursor } : {}) },
                errors, 'blocked_terms');
            if (!r?.data) break;
            terms.push(...r.data);
            cursor = r.pagination?.cursor;
            if (!cursor) break;
        }
        try {
            // Replace: delete rows no longer present, upsert current.
            if (terms.length) {
                for (const t of terms) {
                    await pool.query(
                        `INSERT INTO twitch_blocked_terms (id, broadcaster_id, term_text, created_at_twitch, expires_at, updated_at_twitch)
                         VALUES (?, ?, ?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE term_text = VALUES(term_text), expires_at = VALUES(expires_at), updated_at_twitch = VALUES(updated_at_twitch)`,
                        [t.id, bid, t.text || null, sqlDate(t.created_at), sqlDate(t.expires_at), sqlDate(t.updated_at)]);
                }
            }
            counts.blocked_terms = terms.length;
        } catch (e) { logger.warn(`${LOG} blocked terms persist failed: ${e.message}`); }
    } else errors.blocked_terms = { status: 0, message: 'scope moderator:read:blocked_terms not granted' };

    // 22c. Shield Mode status (read or manage scope) — single row with current state.
    const shieldToken = modToken('moderator:read:shield_mode', 'moderator:manage:shield_mode');
    if (shieldToken) {
        const r = await helixGet(`${HELIX}/moderation/shield_mode`, shieldToken,
            { broadcaster_id: bid, moderator_id: bid }, errors, 'shield_mode_status');
        if (r && Array.isArray(r.data) && r.data[0]) {
            summary.shield_mode_json = JSON.stringify(r.data[0]);
            counts.shield_mode = 1;
        }
    } else errors.shield_mode_status = { status: 0, message: 'scope moderator:read:shield_mode not granted' };

    // 22d. Channel editors (channel:read:editors)
    if (has(scopeSet, 'channel:read:editors')) {
        const r = await helixGet(`${HELIX}/channels/editors`, accessToken,
            { broadcaster_id: bid }, errors, 'channel_editors');
        if (r && Array.isArray(r.data)) {
            try {
                // Replace: clear + reinsert so removed editors drop out.
                await pool.query(`DELETE FROM twitch_channel_editors WHERE broadcaster_id = ?`, [bid]);
                for (const ed of r.data) {
                    await pool.query(
                        `INSERT INTO twitch_channel_editors (broadcaster_id, user_id, user_name, created_at_twitch)
                         VALUES (?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE user_name = VALUES(user_name)`,
                        [bid, ed.user_id, ed.user_name || null, sqlDate(ed.created_at)]);
                }
                counts.editors = r.data.length;
            } catch (e) { logger.warn(`${LOG} editors persist failed: ${e.message}`); }
        }
    } else errors.channel_editors = { status: 0, message: 'scope channel:read:editors not granted' };

    // 22. Games cache — resolve every unique category_id seen in twitch_category_history to
    // its box_art_url. Twitch /games supports up to 100 ids per request.
    try {
        const [games] = await pool.query(
            `SELECT DISTINCT category_id FROM twitch_category_history
              WHERE broadcaster_id = ? AND category_id IS NOT NULL AND category_id != ''
              LIMIT 100`, [bid]);
        const needLookup = [];
        for (const g of games) {
            const [[cached]] = await pool.query(
                `SELECT game_id FROM twitch_games_cache WHERE game_id = ? AND updated_at > DATE_SUB(NOW(), INTERVAL 7 DAY)`,
                [g.category_id]);
            if (!cached) needLookup.push(g.category_id);
        }
        if (needLookup.length) {
            const r = await helixGet(`${HELIX}/games`, accessToken,
                { id: needLookup.slice(0, 100) }, errors, 'games_cache');
            if (r && Array.isArray(r.data)) {
                for (const gm of r.data) {
                    await pool.query(
                        `INSERT INTO twitch_games_cache (game_id, name, box_art_url, igdb_id)
                         VALUES (?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE name = VALUES(name), box_art_url = VALUES(box_art_url), igdb_id = VALUES(igdb_id)`,
                        [gm.id, gm.name || null, (gm.box_art_url || '').replace(/\{width\}x\{height\}/, '144x192'), gm.igdb_id || null],
                    ).catch(e => logger.warn(`${LOG} game cache insert failed: ${e.message}`));
                }
                counts.games_cached = r.data.length;
            }
        }
    } catch (e) {
        logger.warn(`${LOG} games cache sweep failed: ${e.message}`);
    }

    // 23. Banned-user summary count (moderation:read). Just a count, no identities stored.
    if (has(scopeSet, 'moderation:read')) {
        let total = 0, permanent = 0, timed = 0;
        let cursor = null;
        for (let page = 0; page < 25; page++) {
            const r = await helixGet(`${HELIX}/moderation/banned`, accessToken,
                { broadcaster_id: bid, first: 100, ...(cursor ? { after: cursor } : {}) },
                errors, 'banned');
            if (!r?.data) break;
            for (const b of r.data) {
                total++;
                if (b.expires_at) timed++;
                else permanent++;
            }
            cursor = r.pagination?.cursor;
            if (!cursor || !r.data.length) break;
        }
        try {
            await pool.query(
                `INSERT INTO twitch_banned_summary (broadcaster_id, total_banned, permanent_count, timed_count, as_of)
                 VALUES (?, ?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE
                     total_banned = VALUES(total_banned),
                     permanent_count = VALUES(permanent_count),
                     timed_count = VALUES(timed_count),
                     as_of = NOW()`,
                [bid, total, permanent, timed],
            );
            counts.banned = total;
        } catch (e) {
            logger.warn(`${LOG} banned summary write failed: ${e.message}`);
        }
    }

    // Persist summary row + history ledger
    const duration_ms = Date.now() - started;
    const ok = Object.keys(errors).filter(k => errors[k].status && errors[k].status >= 500).length === 0;
    try {
        await pool.query(
            `INSERT INTO twitch_broadcaster_backfill
             (broadcaster_id, broadcaster_login, follower_count, subscriber_count, subscriber_points,
              bits_leaderboard_json, bits_leaderboard_period, bits_total_period,
              current_vips_json, current_mods_json, current_stream_json, current_channel_json,
              charity_campaign_json, active_goals_json, teams_json,
              ad_schedule_json, chat_settings_json, current_schedule_json, top_clips_json, shield_mode_json,
              scope_errors_json, last_run_at, last_run_duration_ms, last_run_ok, last_error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, NULL)
             ON DUPLICATE KEY UPDATE
                 broadcaster_login = VALUES(broadcaster_login),
                 follower_count = COALESCE(VALUES(follower_count), follower_count),
                 subscriber_count = COALESCE(VALUES(subscriber_count), subscriber_count),
                 subscriber_points = COALESCE(VALUES(subscriber_points), subscriber_points),
                 bits_leaderboard_json = COALESCE(VALUES(bits_leaderboard_json), bits_leaderboard_json),
                 bits_leaderboard_period = COALESCE(VALUES(bits_leaderboard_period), bits_leaderboard_period),
                 bits_total_period = COALESCE(VALUES(bits_total_period), bits_total_period),
                 current_vips_json = COALESCE(VALUES(current_vips_json), current_vips_json),
                 current_mods_json = COALESCE(VALUES(current_mods_json), current_mods_json),
                 current_stream_json = VALUES(current_stream_json),
                 current_channel_json = VALUES(current_channel_json),
                 charity_campaign_json = VALUES(charity_campaign_json),
                 active_goals_json = VALUES(active_goals_json),
                 teams_json = COALESCE(VALUES(teams_json), teams_json),
                 ad_schedule_json = VALUES(ad_schedule_json),
                 chat_settings_json = VALUES(chat_settings_json),
                 current_schedule_json = VALUES(current_schedule_json),
                 top_clips_json = COALESCE(VALUES(top_clips_json), top_clips_json),
                 shield_mode_json = VALUES(shield_mode_json),
                 scope_errors_json = VALUES(scope_errors_json),
                 last_run_at = VALUES(last_run_at),
                 last_run_duration_ms = VALUES(last_run_duration_ms),
                 last_run_ok = VALUES(last_run_ok),
                 last_error = NULL`,
            [
                bid, summary.broadcaster_login || null,
                summary.follower_count ?? null, summary.subscriber_count ?? null, summary.subscriber_points ?? null,
                summary.bits_leaderboard_json ?? null, summary.bits_leaderboard_period ?? null, summary.bits_total_period ?? null,
                summary.current_vips_json ?? null, summary.current_mods_json ?? null,
                summary.current_stream_json ?? null, summary.current_channel_json ?? null,
                summary.charity_campaign_json ?? null, summary.active_goals_json ?? null, summary.teams_json ?? null,
                summary.ad_schedule_json ?? null, summary.chat_settings_json ?? null,
                summary.current_schedule_json ?? null, summary.top_clips_json ?? null,
                summary.shield_mode_json ?? null,
                JSON.stringify(errors), duration_ms, ok ? 1 : 0,
            ],
        );
        // History ledger — append-only per run so super-admins can audit scope errors over time.
        await pool.query(
            `INSERT INTO twitch_backfill_history
             (broadcaster_id, trigger_source, trigger_user_id, started_at, duration_ms, ok, counts_json, errors_json)
             VALUES (?, ?, ?, FROM_UNIXTIME(? / 1000), ?, ?, ?, ?)`,
            [bid, triggerSource || 'manual', triggerUserId || null, started, duration_ms, ok ? 1 : 0,
             JSON.stringify(counts), JSON.stringify(errors)],
        );
    } catch (e) {
        logger.error(`${LOG} summary row write failed: ${e.message}`);
        return { ok: false, duration_ms, errors: { ...errors, summary_write: { message: e.message } }, counts };
    }

    logger.info(`${LOG} backfill complete for ${login || bid} in ${duration_ms}ms`,
        { counts, scope_errors: Object.keys(errors).length });

    return { ok, duration_ms, errors, counts };
}

/**
 * Convenience: run backfill using the token stored in twitch_role_sync_config.
 * Returns null if no config row or token can't be decrypted.
 */
export async function runBackfillFromConfig(guildId, options = {}) {
    const encryption = (await import('../utils/encryption.js')).default;
    const [rows] = await pool.execute(
        `SELECT broadcaster_twitch_id, broadcaster_twitch_username, broadcaster_token, token_scopes
           FROM twitch_role_sync_config WHERE guild_id = ? AND enabled = 1 LIMIT 1`,
        [guildId],
    );
    const cfg = rows[0];
    if (!cfg?.broadcaster_token) return { ok: false, errors: { config: { message: 'no config / no token' } }, counts: {} };
    const { getBroadcasterAccessToken } = await import('./twitch-broadcaster-auth.js');
    const token = await getBroadcasterAccessToken({ broadcasterId: cfg.broadcaster_twitch_id, guildId });
    if (!token) return { ok: false, errors: { token: { message: 'no usable broadcaster token' } }, counts: {} };
    const scopes = String(cfg.token_scopes || '').split(/[\s,]+/).filter(Boolean);
    return runBackfill({
        broadcasterId: cfg.broadcaster_twitch_id,
        accessToken: token,
        scopes,
        login: cfg.broadcaster_twitch_username,
        triggerSource: options.triggerSource || 'manual',
        triggerUserId: options.triggerUserId || null,
    });
}

/** Read summary row — used by the analytics page to coalesce zero-session headlines. */
export async function getBackfillSummary(broadcasterId) {
    const [rows] = await pool.execute(
        `SELECT * FROM twitch_broadcaster_backfill WHERE broadcaster_id = ? LIMIT 1`,
        [String(broadcasterId)],
    );
    return rows[0] || null;
}
