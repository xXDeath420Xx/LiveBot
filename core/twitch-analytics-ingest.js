/**
 * Twitch analytics event ingester.
 *
 * In-memory per-minute counters keyed by broadcaster. EventSub handlers in
 * core/twitch-eventsub-manager.js call ingest.*() for each event they receive; the
 * aggregator cron (jobs/twitch-analytics-aggregator.js) flushes these buckets to
 * twitch_stream_snapshots once per minute and resets them.
 *
 * Keeping counters in memory keeps the hot path cheap (no DB write per chat message), and
 * the aggregator is the only writer to twitch_stream_snapshots so there is one place to
 * reason about correctness. The trade is: a bot crash loses THIS minute's events. For
 * anti-abuse detection that's fine — the next minute's bucket still catches the pattern.
 *
 * Snapshot shape stored by the aggregator:
 *   { broadcaster_id, broadcaster_login, recorded_at (minute-aligned),
 *     viewer_count (filled by aggregator via Helix if the stream is live),
 *     chatter_count (distinct chatter_user_id this minute),
 *     msg_count, follow_count, sub_count, gift_sub_count, bit_count,
 *     raid_in_count, mod_action_count, deleted_msg_count, is_live }
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { isChatBot } from '../utils/twitch-chat-bots.js';

const LOG = '[AnalyticsIngest]';

/** Safe DB insert — never let an EventSub handler throw, just log and move on. */
async function safeInsert(sql, params, label) {
    try {
        await pool.execute(sql, params);
    } catch (err) {
        logger.warn(`${LOG} ${label} insert failed: ${err.message}`);
    }
}

/** broadcaster_id -> this-minute counters */
const buckets = new Map();
/** broadcaster_id -> Set<chatter_user_id> seen this minute */
const chatters = new Map();
/** broadcaster_id -> { targetLogin -> Set<senderLogin> } (this minute, for the mention-target panel) */
const mentions = new Map();
/** broadcaster_id -> { targetLogin -> Map<senderLogin, lastMentionMs> } (harassment detection) */
const mentionWindows = new Map();
const MENTION_WINDOW_MS = 5 * 60 * 1000;

function bucketFor(bid) {
    if (!bid) return null;
    const key = String(bid);
    let b = buckets.get(key);
    if (!b) {
        b = {
            msg_count: 0, follow_count: 0, sub_count: 0, gift_sub_count: 0,
            bit_count: 0, raid_in_count: 0, mod_action_count: 0, deleted_msg_count: 0,
            logins_seen: new Set(),
        };
        buckets.set(key, b);
    }
    return b;
}

function chattersFor(bid) {
    if (!bid) return null;
    const key = String(bid);
    let s = chatters.get(key);
    if (!s) { s = new Set(); chatters.set(key, s); }
    return s;
}

function mentionsFor(bid) {
    if (!bid) return null;
    const key = String(bid);
    let m = mentions.get(key);
    if (!m) { m = new Map(); mentions.set(key, m); }
    return m;
}

// Commands (!so, !slap), bots and mentions of the streamer say nothing about a pile-on.
function recordMention(bid, broadcasterLogin, sender, target) {
    const channel = String(broadcasterLogin || '').toLowerCase();
    if (!sender || sender === target || sender === channel || target === channel) return;
    if (isChatBot(sender) || isChatBot(target)) return;
    const key = String(bid);
    let w = mentionWindows.get(key);
    if (!w) { w = new Map(); mentionWindows.set(key, w); }
    let senders = w.get(target);
    if (!senders) { senders = new Map(); w.set(target, senders); }
    senders.set(sender, Date.now());
}

/**
 * Targets @-mentioned by at least `threshold` different people in the last 5 minutes, leaving
 * out anyone the target @-mentioned back: that is a conversation, not a pile-on.
 */
export function mentionTargets(bid, threshold, now = Date.now()) {
    const w = mentionWindows.get(String(bid));
    if (!w) return [];
    const cutoff = now - MENTION_WINDOW_MS;
    for (const [target, senders] of w) {
        for (const [sender, at] of senders) if (at < cutoff) senders.delete(sender);
        if (!senders.size) w.delete(target);
    }
    const out = [];
    for (const [target, senders] of w) {
        const logins = [...senders.keys()];
        const conversing = logins.filter(s => w.get(s)?.has(target));
        const oneWay = logins.filter(s => !w.get(s)?.has(target));
        if (oneWay.length >= threshold) out.push({ target, senders: oneWay, conversing });
    }
    return out;
}

// ─── Ingesters ──────────────────────────────────────────────────────────────

export function ingestChatMessage(broadcasterId, chatterLogin, chatterId, text, broadcasterLogin) {
    const b = bucketFor(broadcasterId);
    if (!b) return;
    b.msg_count++;
    const c = chattersFor(broadcasterId);
    if (chatterId) c.add(String(chatterId));
    if (chatterLogin) b.logins_seen.add(String(chatterLogin).toLowerCase());

    // Harassment target detection: who's being mentioned in chat and how many unique senders
    // are mentioning them. Extracts `@target` mentions.
    const matches = String(text || '').matchAll(/@([A-Za-z0-9_]{2,25})\b/g);
    const m = mentionsFor(broadcasterId);
    const isCommand = String(text || '').trimStart().startsWith('!');
    for (const mm of matches) {
        const target = mm[1].toLowerCase();
        let set = m.get(target);
        if (!set) { set = new Set(); m.set(target, set); }
        if (chatterLogin) set.add(String(chatterLogin).toLowerCase());
        if (!isCommand) recordMention(broadcasterId, broadcasterLogin, String(chatterLogin || '').toLowerCase(), target);
    }
}

export function ingestFollow(broadcasterId, _login, _userId) {
    const b = bucketFor(broadcasterId);
    if (b) b.follow_count++;
}
export function ingestRaid(broadcasterId, _fromLogin, _viewers) {
    const b = bucketFor(broadcasterId);
    if (b) b.raid_in_count++;
}
export function ingestSubscribe(broadcasterId, _login, _tier, _isGift) {
    const b = bucketFor(broadcasterId);
    if (b) b.sub_count++;
}
export function ingestGiftSub(broadcasterId, _login, total, _tier) {
    const b = bucketFor(broadcasterId);
    if (!b) return;
    b.gift_sub_count += Math.max(1, Number(total) || 1);
}
export function ingestCheer(broadcasterId, _login, bits) {
    const b = bucketFor(broadcasterId);
    if (b) b.bit_count += Math.max(0, Number(bits) || 0);
}
export function ingestBan(broadcasterId, _login, _permanent, _reason) {
    const b = bucketFor(broadcasterId);
    if (b) b.mod_action_count++;
}
export function ingestMessageDelete(broadcasterId, _targetLogin) {
    const b = bucketFor(broadcasterId);
    if (!b) return;
    b.mod_action_count++;
    b.deleted_msg_count++;
}

// ─── v2 ingesters (growth + engagement) — direct DB inserts per event ───────
// These are LOW volume compared to chat.message, so we don't bother with buckets.
// Each handler is idempotent-ish via the UNIQUE keys on the event tables; a duplicate
// webhook delivery just gets a dup-key error that safeInsert swallows.

const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const toSql = (iso) => {
    if (!iso) return nowSql();
    try { return new Date(iso).toISOString().slice(0, 19).replace('T', ' '); }
    catch { return nowSql(); }
};

/** channel.update — title / category / CCL change. */
export function ingestCategoryUpdate(broadcasterId, data) {
    if (!broadcasterId || !data) return;
    const labels = Array.isArray(data.content_classification_labels)
        ? JSON.stringify(data.content_classification_labels) : null;
    safeInsert(
        `INSERT INTO twitch_category_history
         (broadcaster_id, changed_at, title, category_id, category_name, language, content_classification_labels)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [String(broadcasterId), nowSql(), data.title || null,
         data.category_id || null, data.category_name || null,
         data.language || null, labels],
        'channel.update');
}

/** channel.hype_train.{begin,progress,end}. */
export function ingestHypeTrain(broadcasterId, eventType, data) {
    if (!broadcasterId || !data) return;
    const top = Array.isArray(data.top_contributions) ? JSON.stringify(data.top_contributions) : null;
    safeInsert(
        `INSERT INTO twitch_hype_train_events
         (broadcaster_id, hype_train_id, event_type, level, total_bits, total_subs, goal,
          progress, top_contributions_json, is_golden, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [String(broadcasterId), String(data.id || ''), eventType,
         data.level ?? null, data.total_bits ?? null, data.total_subs ?? null,
         data.goal ?? null, data.progress ?? null, top,
         data.is_golden_kappa_train ? 1 : 0, toSql(data.started_at || data.ended_at)],
        `hype_train.${eventType}`);
}

/** channel.goal.{begin,progress,end}. */
export function ingestGoal(broadcasterId, eventType, data) {
    if (!broadcasterId || !data) return;
    safeInsert(
        `INSERT INTO twitch_goal_events
         (broadcaster_id, goal_id, event_type, goal_type, description, current_amount,
          target_amount, is_achieved, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [String(broadcasterId), String(data.id || ''), eventType,
         data.type || null, data.description || null,
         data.current_amount ?? null, data.target_amount ?? null,
         (eventType === 'end' ? (data.is_achieved ? 1 : 0) : null),
         toSql(data.started_at || data.ended_at)],
        `goal.${eventType}`);
}

/** channel.ad_break.begin. */
export function ingestAdBreak(broadcasterId, data) {
    if (!broadcasterId || !data) return;
    safeInsert(
        `INSERT INTO twitch_ad_breaks
         (broadcaster_id, duration_seconds, is_automatic, requester_user_login, started_at)
         VALUES (?, ?, ?, ?, ?)`,
        [String(broadcasterId), Number(data.duration_seconds) || null,
         data.is_automatic ? 1 : 0, data.requester_user_login || null,
         toSql(data.started_at)],
        'ad_break.begin');
}

/** channel.charity_campaign.{donate,progress,start,stop}. */
export function ingestCharity(broadcasterId, eventType, data) {
    if (!broadcasterId || !data) return;
    const amt = data.amount || data.current_amount || null;
    const tgt = data.target_amount || null;
    safeInsert(
        `INSERT INTO twitch_charity_events
         (broadcaster_id, campaign_id, event_type, charity_name, donor_user_login,
          donation_amount, donation_currency, current_amount, target_amount, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [String(broadcasterId), String(data.id || data.campaign_id || ''), eventType,
         data.charity_name || null, data.user_login || null,
         data.amount?.value ?? null, data.amount?.currency ?? null,
         amt?.value ?? amt ?? null, tgt?.value ?? tgt ?? null,
         nowSql()],
        `charity.${eventType}`);
}

/** channel.poll.{begin,progress,end}. */
export function ingestPoll(broadcasterId, eventType, data) {
    if (!broadcasterId || !data) return;
    const choices = Array.isArray(data.choices) ? JSON.stringify(data.choices) : null;
    safeInsert(
        `INSERT INTO twitch_poll_events
         (broadcaster_id, poll_id, event_type, title, choices_json, bits_voting_enabled,
          bits_per_vote, channel_points_voting_enabled, channel_points_per_vote, status, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [String(broadcasterId), String(data.id || ''), eventType,
         data.title || null, choices,
         data.bits_voting?.is_enabled ? 1 : 0, data.bits_voting?.amount_per_vote ?? null,
         data.channel_points_voting?.is_enabled ? 1 : 0, data.channel_points_voting?.amount_per_vote ?? null,
         data.status || null, toSql(data.started_at || data.ended_at)],
        `poll.${eventType}`);
}

/** channel.prediction.{begin,progress,lock,end}. */
export function ingestPrediction(broadcasterId, eventType, data) {
    if (!broadcasterId || !data) return;
    const outcomes = Array.isArray(data.outcomes) ? JSON.stringify(data.outcomes) : null;
    safeInsert(
        `INSERT INTO twitch_prediction_events
         (broadcaster_id, prediction_id, event_type, title, outcomes_json,
          winning_outcome_id, status, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [String(broadcasterId), String(data.id || ''), eventType,
         data.title || null, outcomes,
         data.winning_outcome_id || null, data.status || null,
         toSql(data.started_at || data.locked_at || data.ended_at)],
        `prediction.${eventType}`);
}

/** channel.shoutout.{create,receive}. */
export function ingestShoutout(broadcasterId, direction, data) {
    if (!broadcasterId || !data) return;
    const counterId = direction === 'sent'
        ? data.to_broadcaster_user_id
        : data.from_broadcaster_user_id;
    const counterLogin = direction === 'sent'
        ? data.to_broadcaster_user_login
        : data.from_broadcaster_user_login;
    safeInsert(
        `INSERT INTO twitch_shoutout_events
         (broadcaster_id, direction, counterpart_user_id, counterpart_user_login,
          moderator_user_login, viewer_count, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [String(broadcasterId), direction, counterId || null, counterLogin || null,
         data.moderator_user_login || null, data.viewer_count ?? null,
         toSql(data.started_at || data.cooldown_ends_at)],
        `shoutout.${direction}`);
}

/** channel.channel_points_custom_reward_redemption.add. */
export function ingestRedemption(broadcasterId, data) {
    if (!broadcasterId || !data) return;
    safeInsert(
        `INSERT INTO twitch_redemption_events
         (broadcaster_id, reward_id, reward_title, reward_cost, redeemer_user_login,
          user_input, status, redeemed_at, redemption_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [String(broadcasterId), data.reward?.id || null, data.reward?.title || null,
         Number(data.reward?.cost) || null, data.user_login || null,
         data.user_input || null, data.status || null, toSql(data.redeemed_at),
         data.id ? String(data.id) : null],
        'redemption.add');
}

/** channel.subscription.message. Also bumps the per-minute sub bucket for aggregates. */
export function ingestResubMessage(broadcasterId, data) {
    if (!broadcasterId || !data) return;
    const b = bucketFor(broadcasterId);
    if (b) b.sub_count++;      // a resub still counts as a sub for the per-minute rollup
    safeInsert(
        `INSERT INTO twitch_resub_messages
         (broadcaster_id, user_login, user_id, tier, cumulative_months, streak_months,
          duration_months, message, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [String(broadcasterId), data.user_login || null, data.user_id || null,
         data.tier || null, data.cumulative_months ?? null, data.streak_months ?? null,
         data.duration_months ?? null, data.message?.text || null, nowSql()],
        'subscription.message');
}

/** channel.subscription.end (churn). */
export function ingestSubEnd(broadcasterId, data) {
    if (!broadcasterId || !data) return;
    safeInsert(
        `INSERT INTO twitch_sub_endings
         (broadcaster_id, user_login, user_id, tier, is_gift, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [String(broadcasterId), data.user_login || null, data.user_id || null,
         data.tier || null, data.is_gift ? 1 : 0, nowSql()],
        'subscription.end');
}

/** channel.vip.add / .remove + channel.moderator.add / .remove. */
export function ingestRoleChange(broadcasterId, role, action, data) {
    if (!broadcasterId || !data) return;
    safeInsert(
        `INSERT INTO twitch_vip_mod_changes
         (broadcaster_id, role, action, target_user_login, target_user_id, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [String(broadcasterId), role, action, data.user_login || null, data.user_id || null, nowSql()],
        `${role}.${action}`);
}

// ─── Flush (called by the aggregator cron) ──────────────────────────────────

/** Return + reset every bucket. The aggregator writes these into twitch_stream_snapshots. */
export function drainBuckets() {
    const out = [];
    for (const [bid, b] of buckets) {
        const c = chatters.get(bid);
        out.push({
            broadcaster_id: bid,
            chatter_count: c ? c.size : 0,
            ...b,
            logins_seen: Array.from(b.logins_seen),
        });
    }
    buckets.clear();
    chatters.clear();
    return out;
}

/** Return + reset the mention map. The aggregator rolls into twitch_mention_targets. */
export function drainMentions() {
    const out = [];
    for (const [bid, m] of mentions) {
        for (const [target, senders] of m) {
            out.push({ broadcaster_id: bid, target_login: target, mention_count: senders.size, unique_senders: senders.size });
        }
    }
    mentions.clear();
    return out;
}

export default {
    // v1 (anti-abuse)
    ingestChatMessage, ingestFollow, ingestRaid, ingestSubscribe, ingestGiftSub,
    ingestCheer, ingestBan, ingestMessageDelete,
    // v2 (growth + engagement)
    ingestCategoryUpdate, ingestHypeTrain, ingestGoal, ingestAdBreak, ingestCharity,
    ingestPoll, ingestPrediction, ingestShoutout, ingestRedemption,
    ingestResubMessage, ingestSubEnd, ingestRoleChange,
    // flush
    drainBuckets, drainMentions,
};
