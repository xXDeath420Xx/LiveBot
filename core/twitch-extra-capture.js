/*
 * Wave 383 — the remaining Twitch signals the broadcaster's existing grants allow
 * (channel.moderate is excluded: it needs scopes broadcasters haven't granted).
 * EventSub handlers are registered in core/twitch-eventsub-manager.js; the Helix pulls are
 * driven from core/twitch-analytics-cron.js. Tables come from migration 383.
 */
import axios from 'axios';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { getAccessToken } from '../utils/platforms/twitch-api.js';
import { getTierBAuth } from './twitch-write.js';
import { ingestCheer } from './twitch-analytics-ingest.js';
import { isChatBot } from '../utils/twitch-chat-bots.js';

const LOG = '[TwitchExtraCapture]';
const HELIX = 'https://api.twitch.tv/helix';
const RANK_MAX_PAGES = 10;

const now = () => new Date();
const toSql = (v) => {
    const d = v ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? d : now();
};
const clip = (s, n) => (s == null ? null : String(s).slice(0, n));

async function safe(label, fn) {
    try { return await fn(); }
    catch (e) { logger.warn(`${LOG} ${label} failed: ${e.message}`); return null; }
}

// ─── Moderator actions + chat clears ─────────────────────────────────────────
// channel.moderate would give one feed of every mod action, but it needs
// moderator:read:moderators + moderator:read:vips, which broadcasters haven't granted.
// Bans, timeouts and unbans already name the moderator, so they feed per-mod activity here.

export async function recordBan(event) {
    const permanent = !!event.is_permanent || !event.ends_at;
    const duration = permanent ? null
        : Math.max(0, Math.round((new Date(event.ends_at) - new Date(event.banned_at || Date.now())) / 1000));
    await safe('ban action insert', () => pool.execute(
        `INSERT INTO twitch_mod_actions
         (broadcaster_id, source, action, moderator_user_id, moderator_user_login, target_user_id,
          target_user_login, duration_seconds, reason, occurred_at)
         VALUES (?, 'ban', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [String(event.broadcaster_user_id), permanent ? 'ban' : 'timeout',
         event.moderator_user_id || null, event.moderator_user_login || null,
         event.user_id || null, event.user_login || null, duration, clip(event.reason, 500),
         toSql(event.banned_at)]));
}

export async function recordUnban(event) {
    await safe('unban action insert', () => pool.execute(
        `INSERT INTO twitch_mod_actions
         (broadcaster_id, source, action, moderator_user_id, moderator_user_login, target_user_id,
          target_user_login, occurred_at)
         VALUES (?, 'ban', 'unban', ?, ?, ?, ?, ?)`,
        [String(event.broadcaster_user_id), event.moderator_user_id || null, event.moderator_user_login || null,
         event.user_id || null, event.user_login || null, now()]));
}

export async function handleChatClear(kind, event) {
    await safe('chat clear insert', () => pool.execute(
        `INSERT INTO twitch_mod_actions
         (broadcaster_id, source, action, target_user_id, target_user_login, occurred_at)
         VALUES (?, 'chat', ?, ?, ?, ?)`,
        [String(event.broadcaster_user_id), kind === 'user' ? 'user_messages_cleared' : 'chat_clear',
         event.target_user_id || null, event.target_user_login || null, now()]));
    return `chat_clear_${kind}_ingested`;
}

// ─── AutoMod ─────────────────────────────────────────────────────────────────

export async function handleAutomodHold(event) {
    await safe('automod hold insert', () => pool.execute(
        `INSERT INTO twitch_automod_held
         (broadcaster_id, message_id, event_type, user_id, user_login, message_text, category, level, status, occurred_at)
         VALUES (?, ?, 'hold', ?, ?, ?, ?, ?, 'pending', ?)`,
        [String(event.broadcaster_user_id), String(event.message_id || ''),
         event.user_id || null, event.user_login || null, clip(event.message?.text, 2000),
         clip(event.automod?.category || (event.reason === 'blocked_term' ? 'blocked_term' : event.reason), 64),
         event.automod?.level ?? null, toSql(event.held_at)]));
    return 'automod_hold_ingested';
}

export async function handleAutomodUpdate(event) {
    const params = [clip(event.status, 16), event.moderator_user_id || null, event.moderator_user_login || null,
                    String(event.broadcaster_user_id), String(event.message_id || '')];
    const res = await safe('automod update', () => pool.execute(
        `UPDATE twitch_automod_held SET status = ?, moderator_user_id = ?, moderator_user_login = ?
          WHERE broadcaster_id = ? AND message_id = ?`, params));
    if (res && res[0]?.affectedRows === 0) {
        await safe('automod update insert', () => pool.execute(
            `INSERT INTO twitch_automod_held
             (broadcaster_id, message_id, event_type, user_id, user_login, message_text, category, level, status,
              moderator_user_id, moderator_user_login, occurred_at)
             VALUES (?, ?, 'update', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [String(event.broadcaster_user_id), String(event.message_id || ''), event.user_id || null,
             event.user_login || null, clip(event.message?.text, 2000), clip(event.automod?.category, 64),
             event.automod?.level ?? null, clip(event.status, 16), event.moderator_user_id || null,
             event.moderator_user_login || null, toSql(event.held_at)]));
    }
    return 'automod_update_ingested';
}

export async function handleAutomodTerms(event) {
    await safe('automod terms insert', () => pool.execute(
        `INSERT INTO twitch_mod_actions
         (broadcaster_id, source, action, moderator_user_id, moderator_user_login, detail_json, occurred_at)
         VALUES (?, 'automod', ?, ?, ?, ?, ?)`,
        [String(event.broadcaster_user_id), clip(`terms_${event.action || 'update'}`, 48),
         event.moderator_user_id || null, event.moderator_user_login || null,
         clip(JSON.stringify({ terms: event.terms || [], from_automod: !!event.from_automod }), 8000), now()]));
    return 'automod_terms_ingested';
}

// ─── Bits, raids, shared chat ────────────────────────────────────────────────

export async function handleBitsUse(event) {
    const type = String(event.type || 'cheer');
    const bits = Math.max(0, Number(event.bits) || 0);
    // channel.cheer already counts plain cheers into the minute buckets; only add the rest.
    if (type !== 'cheer') ingestCheer(event.broadcaster_user_id, event.user_login, bits);
    await safe('bits use insert', () => pool.execute(
        `INSERT INTO twitch_bits_usage
         (broadcaster_id, user_id, user_login, bits, usage_type, power_up_type, message_text, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [String(event.broadcaster_user_id), event.user_id || null, event.user_login || null, bits,
         clip(type, 16), clip(event.power_up?.type, 48), clip(event.message?.text, 500), now()]));
    return `bits_${type}_ingested`;
}

export async function recordRaid(direction, event) {
    const self = direction === 'in' ? event.to_broadcaster_user_id : event.from_broadcaster_user_id;
    const otherId = direction === 'in' ? event.from_broadcaster_user_id : event.to_broadcaster_user_id;
    const otherLogin = direction === 'in' ? event.from_broadcaster_user_login : event.to_broadcaster_user_login;
    await safe('raid insert', () => pool.execute(
        `INSERT INTO twitch_raid_events (broadcaster_id, direction, other_user_id, other_user_login, viewers, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [String(self), direction, otherId || null, otherLogin || null, Number(event.viewers) || 0, now()]));
}

export async function handleRaidOut(event) {
    await recordRaid('out', event);
    return 'raid_out_ingested';
}

export async function handleSharedChat(phase, event) {
    const bid = String(event.broadcaster_user_id);
    const participants = event.participants ? clip(JSON.stringify(event.participants), 8000) : null;
    if (phase === 'begin') {
        await safe('shared chat begin', () => pool.execute(
            `INSERT INTO twitch_shared_chat_sessions
             (broadcaster_id, session_id, host_broadcaster_id, participants_json, began_at, last_update_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE participants_json = VALUES(participants_json), last_update_at = VALUES(last_update_at)`,
            [bid, String(event.session_id), event.host_broadcaster_user_id || null, participants, now(), now()]));
    } else if (phase === 'update') {
        await safe('shared chat update', () => pool.execute(
            `INSERT INTO twitch_shared_chat_sessions
             (broadcaster_id, session_id, host_broadcaster_id, participants_json, began_at, last_update_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE participants_json = VALUES(participants_json), last_update_at = VALUES(last_update_at)`,
            [bid, String(event.session_id), event.host_broadcaster_user_id || null, participants, now(), now()]));
    } else {
        await safe('shared chat end', () => pool.execute(
            `UPDATE twitch_shared_chat_sessions SET ended_at = ? WHERE broadcaster_id = ? AND session_id = ?`,
            [now(), bid, String(event.session_id)]));
    }
    return `shared_chat_${phase}_ingested`;
}

// ─── Channel points ──────────────────────────────────────────────────────────

export async function handleRewardChange(phase, event) {
    const bid = String(event.broadcaster_user_id);
    if (phase === 'remove') {
        await safe('reward remove', () => pool.execute(
            'DELETE FROM twitch_custom_rewards WHERE reward_id = ? AND broadcaster_id = ?', [String(event.id), bid]));
        return 'reward_remove_ingested';
    }
    await safe('reward upsert', () => pool.execute(
        `INSERT INTO twitch_custom_rewards
         (reward_id, broadcaster_id, title, prompt, cost, background_color, is_enabled, is_user_input_required,
          is_sub_only, cooldown_seconds, max_per_stream, max_per_user_per_stream, is_paused, is_in_stock, redemptions_this_stream)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE title = VALUES(title), prompt = VALUES(prompt), cost = VALUES(cost),
             background_color = VALUES(background_color), is_enabled = VALUES(is_enabled),
             is_user_input_required = VALUES(is_user_input_required), cooldown_seconds = VALUES(cooldown_seconds),
             max_per_stream = VALUES(max_per_stream), max_per_user_per_stream = VALUES(max_per_user_per_stream),
             is_paused = VALUES(is_paused), is_in_stock = VALUES(is_in_stock),
             redemptions_this_stream = VALUES(redemptions_this_stream), updated_at = CURRENT_TIMESTAMP`,
        [String(event.id), bid, clip(event.title, 255), clip(event.prompt, 500), Number(event.cost) || 0,
         clip(event.background_color, 16), event.is_enabled ? 1 : 0, event.is_user_input_required ? 1 : 0,
         event.global_cooldown?.is_enabled ? Number(event.global_cooldown.seconds) || 0 : 0,
         event.max_per_stream?.is_enabled ? Number(event.max_per_stream.value) || 0 : 0,
         event.max_per_user_per_stream?.is_enabled ? Number(event.max_per_user_per_stream.value) || 0 : 0,
         event.is_paused ? 1 : 0, event.is_in_stock === false ? 0 : 1,
         Number(event.redemptions_redeemed_current_stream) || 0]));
    return `reward_${phase}_ingested`;
}

export async function handleRedemptionUpdate(event) {
    const res = await safe('redemption status update', () => pool.execute(
        'UPDATE twitch_redemption_events SET status = ? WHERE redemption_id = ? AND broadcaster_id = ?',
        [clip(event.status, 32), String(event.id), String(event.broadcaster_user_id)]));
    return res && res[0]?.affectedRows ? 'redemption_update_ingested' : 'redemption_update_unmatched';
}

const AUTO_REWARD_TITLES = {
    single_message_bypass_sub_mode: 'Send a message in sub-only mode',
    send_highlighted_message: 'Highlight my message',
    random_sub_emote_unlock: 'Unlock a random sub emote',
    chosen_sub_emote_unlock: 'Choose an emote to unlock',
    chosen_modified_sub_emote_unlock: 'Modify a single emote',
    message_effect: 'Message effect',
    gigantify_an_emote: 'Gigantify an emote',
    celebration: 'On-screen celebration',
};

export async function handleAutomaticRedemption(event) {
    const type = String(event.reward?.type || 'unknown');
    await safe('automatic redemption insert', () => pool.execute(
        `INSERT INTO twitch_redemption_events
         (broadcaster_id, reward_id, reward_title, reward_cost, redeemer_user_login, user_input, status,
          redeemed_at, redemption_id, reward_kind)
         VALUES (?, ?, ?, ?, ?, ?, 'fulfilled', ?, ?, 'automatic')`,
        [String(event.broadcaster_user_id), clip(`auto:${type}`, 64), AUTO_REWARD_TITLES[type] || type.replace(/_/g, ' '),
         Number(event.reward?.channel_points ?? event.reward?.cost) || null, event.user_login || null,
         clip(event.message?.text, 500), toSql(event.redeemed_at), event.id ? String(event.id) : null]));
    return 'automatic_redemption_ingested';
}

// ─── Emote usage (in-memory tally, flushed every minute) ─────────────────────

const emoteTally = new Map();

export function countEmotes(broadcasterId, fragments, chatterLogin) {
    if (!broadcasterId || !Array.isArray(fragments) || isChatBot(chatterLogin)) return;
    for (const f of fragments) {
        if (f?.type !== 'emote' || !f.emote?.id) continue;
        const key = `${broadcasterId}\u0000${f.emote.id}`;
        const cur = emoteTally.get(key);
        if (cur) cur.uses++;
        else emoteTally.set(key, { bid: String(broadcasterId), id: String(f.emote.id), name: clip(f.text, 128),
                                   owner: f.emote.owner_id || null, uses: 1 });
    }
}

async function flushEmotes() {
    if (!emoteTally.size) return;
    const rows = Array.from(emoteTally.values());
    emoteTally.clear();
    const day = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < rows.length; i += 200) {
        const batch = rows.slice(i, i + 200);
        await safe('emote flush', () => pool.query(
            `INSERT INTO twitch_emote_usage (broadcaster_id, day, emote_id, emote_name, owner_id, uses) VALUES ?
             ON DUPLICATE KEY UPDATE uses = uses + VALUES(uses), emote_name = VALUES(emote_name)`,
            [batch.map(r => [r.bid, day, r.id, r.name, r.owner, r.uses])]));
    }
}
setInterval(() => { flushEmotes().catch(() => {}); }, 60_000).unref?.();

// ─── Messages per chatter (in-memory tally, flushed every minute) ────────────
// twitch_chatter_sightings is otherwise presence-only (chatter-list polls).

const chatterTally = new Map();

export function countChatterMessage(broadcasterId, userId, login) {
    if (!broadcasterId || !userId) return;
    const key = `${broadcasterId}\u0000${userId}`;
    const cur = chatterTally.get(key);
    if (cur) { cur.n++; cur.login = login || cur.login; }
    else chatterTally.set(key, { bid: String(broadcasterId), uid: String(userId), login: clip(login, 100), n: 1 });
}

async function flushChatters() {
    if (!chatterTally.size) return;
    const rows = Array.from(chatterTally.values());
    chatterTally.clear();
    const at = now();
    for (let i = 0; i < rows.length; i += 200) {
        const batch = rows.slice(i, i + 200);
        await safe('chatter message flush', () => pool.query(
            `INSERT INTO twitch_chatter_sightings
             (broadcaster_id, chatter_user_id, chatter_user_login, first_seen_at, last_seen_at,
              sightings, sessions_seen, messages, last_message_at) VALUES ?
             ON DUPLICATE KEY UPDATE messages = messages + VALUES(messages), last_message_at = VALUES(last_message_at)`,
            [batch.map(r => [r.bid, r.uid, r.login, at, at, 0, 0, r.n, at])]));
    }
}
setInterval(() => { flushChatters().catch(() => {}); }, 60_000).unref?.();

// ─── Helix pulls ─────────────────────────────────────────────────────────────

async function appHeaders() {
    const token = await getAccessToken();
    return token ? { 'Client-ID': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` } : null;
}

async function enabledBroadcasters() {
    const [rows] = await pool.query(
        `SELECT DISTINCT broadcaster_twitch_id AS bid FROM twitch_role_sync_config
          WHERE enabled = 1 AND broadcaster_twitch_id IS NOT NULL`);
    return rows.map(r => String(r.bid));
}

/** Every 5 min while live: where the broadcaster sits in their category by viewer count. */
export async function runCategoryRank() {
    const headers = await appHeaders();
    if (!headers) return;
    const [live] = await pool.query(
        `SELECT s.broadcaster_id AS bid, s.viewer_count
           FROM twitch_stream_snapshots s
           JOIN (SELECT broadcaster_id, MAX(recorded_at) AS m FROM twitch_stream_snapshots
                  WHERE recorded_at > DATE_SUB(NOW(), INTERVAL 5 MINUTE) GROUP BY broadcaster_id) x
             ON x.broadcaster_id = s.broadcaster_id AND x.m = s.recorded_at
          WHERE s.is_live = 1`);
    const enabled = new Set(await enabledBroadcasters());
    for (const row of live) {
        const bid = String(row.bid);
        if (!enabled.has(bid)) continue;
        await safe(`category rank ${bid}`, async () => {
            const [[cat]] = await pool.execute(
                `SELECT category_id, category_name FROM twitch_category_history
                  WHERE broadcaster_id = ? ORDER BY changed_at DESC LIMIT 1`, [bid]);
            if (!cat?.category_id) return;
            let cursor = null, rank = null, sampled = 0, viewersSampled = 0, top = 0, viewers = Number(row.viewer_count) || 0;
            for (let page = 0; page < RANK_MAX_PAGES; page++) {
                const params = new URLSearchParams({ game_id: String(cat.category_id), first: '100', type: 'live' });
                if (cursor) params.set('after', cursor);
                const r = await axios.get(`${HELIX}/streams?${params}`, { headers, timeout: 10_000 });
                const data = r.data?.data || [];
                for (const s of data) {
                    sampled++;
                    viewersSampled += Number(s.viewer_count) || 0;
                    if (sampled === 1) top = Number(s.viewer_count) || 0;
                    if (String(s.user_id) === bid && rank == null) { rank = sampled; viewers = Number(s.viewer_count) || viewers; }
                }
                cursor = r.data?.pagination?.cursor || null;
                // Streams come back busiest first: once a page ends below our viewer count,
                // deeper pages can't contain us.
                const lastViewers = Number(data[data.length - 1]?.viewer_count) || 0;
                if (rank != null || !cursor || !data.length || lastViewers < viewers) break;
            }
            await pool.execute(
                `INSERT INTO twitch_category_rank_snapshots
                 (broadcaster_id, recorded_at, game_id, game_name, rank_pos, viewers, channels_sampled, viewers_sampled, top_viewers)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [bid, now(), String(cat.category_id), clip(cat.category_name, 255), rank, viewers, sampled, viewersSampled, top]);
        });
    }
}

/** Hourly: stream markers from the latest VOD plus recent catalogued VODs. Needs the write grant. */
export async function runStreamMarkers() {
    for (const bid of await enabledBroadcasters()) {
        await safe(`markers ${bid}`, async () => {
            const auth = await getTierBAuth(bid);
            if (!auth?.accessToken) return;
            if (!auth.scopes.has('channel:manage:broadcast') && !auth.scopes.has('user:read:broadcast')) return;
            const headers = { 'Client-ID': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${auth.accessToken}` };
            const [vods] = await pool.execute(
                `SELECT video_id FROM twitch_vods_catalog WHERE broadcaster_id = ? ORDER BY created_at_twitch DESC LIMIT 10`, [bid]);
            const queries = [{ user_id: bid }, ...vods.map(v => ({ video_id: String(v.video_id) }))];
            for (const q of queries) {
                const r = await axios.get(`${HELIX}/streams/markers?${new URLSearchParams({ ...q, first: '100' })}`,
                    { headers, timeout: 10_000 }).catch(e => (e.response?.status === 404 ? null : Promise.reject(e)));
                for (const user of r?.data?.data || []) {
                    for (const video of user.videos || []) {
                        for (const m of video.markers || []) {
                            await pool.execute(
                                `INSERT INTO twitch_stream_markers
                                 (broadcaster_id, marker_id, video_id, position_seconds, description, url, created_at_twitch)
                                 VALUES (?, ?, ?, ?, ?, ?, ?)
                                 ON DUPLICATE KEY UPDATE description = VALUES(description), url = VALUES(url)`,
                                [bid, String(m.id), String(video.video_id || ''), Number(m.position_seconds) || 0,
                                 clip(m.description, 255), clip(m.url, 255), toSql(m.created_at)]);
                        }
                    }
                }
                await new Promise(res => setTimeout(res, 150));
            }
        });
    }
}

/** Daily: the channel's own emotes and chat badges, so emote usage can tell them apart from global ones. */
export async function runChannelAssets() {
    const headers = await appHeaders();
    if (!headers) return;
    for (const bid of await enabledBroadcasters()) {
        await safe(`assets ${bid}`, async () => {
            const [emotes, badges] = await Promise.all([
                axios.get(`${HELIX}/chat/emotes?broadcaster_id=${bid}`, { headers, timeout: 10_000 }),
                axios.get(`${HELIX}/chat/badges?broadcaster_id=${bid}`, { headers, timeout: 10_000 }),
            ]);
            const rows = [];
            for (const e of emotes.data?.data || []) {
                rows.push([bid, 'emote', String(e.id), clip(e.name, 128), clip(e.tier, 16), clip(e.emote_type, 32),
                           clip(e.images?.url_2x || e.images?.url_1x, 512)]);
            }
            for (const set of badges.data?.data || []) {
                for (const v of set.versions || []) {
                    rows.push([bid, 'badge', clip(`${set.set_id}/${v.id}`, 96), clip(v.title || set.set_id, 128),
                               clip(v.id, 16), clip(set.set_id, 32), clip(v.image_url_2x || v.image_url_1x, 512)]);
                }
            }
            await pool.execute('DELETE FROM twitch_channel_assets WHERE broadcaster_id = ?', [bid]);
            if (rows.length) {
                await pool.query(
                    `INSERT INTO twitch_channel_assets (broadcaster_id, kind, asset_id, name, tier, asset_type, image_url) VALUES ?`,
                    [rows]);
            }
        });
    }
}
