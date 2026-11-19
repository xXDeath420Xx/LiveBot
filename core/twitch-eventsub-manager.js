/*
 * Twitch EventSub — push notifications for "went live" + anti-abuse analytics.
 *
 * CHANGES VS v1 (2026-10-14 analytics work):
 *   - SUB_TYPES is now a declarative registry (name/version/condition/scope/handler) instead
 *     of a plain string array. Adding a new EventSub subscription type is a single entry.
 *   - Subscriptions that require USER access tokens (channel.chat.message, channel.follow v2,
 *     channel.subscribe, channel.cheer, channel.ban, …) are only created when the broadcaster
 *     has a matching row in twitch_oauth_accounts with the required scope. Types that use the
 *     app token (stream.online, stream.offline, channel.raid) work for every broadcaster.
 *   - handleNotification dispatches to the registry entry's handler. The stream.online /
 *     stream.offline handlers behave identically to v1 (announce path).
 *   - All new event types feed into core/twitch-analytics-ingest.js, which keeps per-minute
 *     counters that the aggregator cron (jobs/twitch-analytics-aggregator.js) flushes to
 *     twitch_stream_snapshots.
 *
 * HOW TO ADD A NEW SUBSCRIPTION TYPE:
 *   1. Append an entry to SUB_TYPES below.
 *   2. If it needs analytics ingestion, call ingest.*() from the handler.
 *   3. Reconcile picks it up automatically on the next scheduler tick.
 */
import axios from 'axios';
import crypto from 'crypto';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import { getBroadcasterAccessToken } from './twitch-broadcaster-auth.js';
import { getCachedConduitId, ensureConduit as ensureConduitImpl } from './twitch-conduit.js';
import logger from '../utils/logger.js';
import { getAccessToken } from '../utils/platforms/twitch-api.js';
import { checkStreamerNow } from './stream-manager.js';
import {
    // v1 (anti-abuse)
    ingestChatMessage,
    ingestFollow,
    ingestRaid,
    ingestSubscribe,
    ingestGiftSub,
    ingestCheer,
    ingestBan,
    ingestMessageDelete,
    // v2 (growth + engagement — 2026-10-18)
    ingestCategoryUpdate,
    ingestHypeTrain,
    ingestGoal,
    ingestAdBreak,
    ingestCharity,
    ingestPoll,
    ingestPrediction,
    ingestShoutout,
    ingestRedemption,
    ingestResubMessage,
    ingestSubEnd,
    ingestRoleChange,
} from './twitch-analytics-ingest.js';
import * as extra from './twitch-extra-capture.js';

const HELIX_EVENTSUB = 'https://api.twitch.tv/helix/eventsub/subscriptions';
const LOG = '[TwitchEventSub]';

const MISSING_RETRY_MS = 24 * 60 * 60 * 1000;
const missingUntil = new Map();
const isTwitchId = id => /^[0-9]+$/.test(String(id));

/**
 * EventSub subscription type registry.
 *   - name            Twitch EventSub subscription type
 *   - version         Twitch's version for this type (per their docs)
 *   - condition(b)    Returns the Twitch `condition` object. `b` = {id, login}.
 *   - handler(event)  Called on verified notifications of this type.
 *   - scope           Required OAuth scope (string). If present, this type uses the broadcaster's
 *                     USER token from twitch_oauth_accounts and is only created when they've
 *                     granted the scope. If absent, this type uses the app token.
 */
const SUB_TYPES = [
    // ─── App-token types (work for every tracked broadcaster) ────────────────
    { name: 'stream.online',   version: '1', condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      handler: handleStreamOnline },
    { name: 'stream.offline',  version: '1', condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      handler: handleStreamOffline },
    { name: 'channel.raid',    version: '1', bidField: 'to_broadcaster_user_id',
      condition: (b) => ({ to_broadcaster_user_id: String(b.id) }),
      handler: handleRaid },

    // ─── User-token types (require OAuth with specific scopes) ───────────────
    { name: 'channel.follow', version: '2',
      condition: (b) => ({ broadcaster_user_id: String(b.id), moderator_user_id: String(b.id) }),
      scope: 'moderator:read:followers',
      handler: handleFollow },

    { name: 'channel.subscribe', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:subscriptions',
      handler: handleSubscribe },

    { name: 'channel.subscription.gift', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:subscriptions',
      handler: handleGiftSub },

    { name: 'channel.cheer', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'bits:read',
      handler: handleCheer },

    { name: 'channel.ban', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:moderate',
      handler: handleBan },

    // Unban events (wave 368) — pairs with channel.ban. Scope same as ban.
    { name: 'channel.unban', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:moderate',
      handler: handleUnban },

    // Chat notification stream (wave 368) — first-time chatter, raid banner, sub announce.
    // Twitch requires BOTH user:read:chat and user:bot on the reader's token.
    { name: 'channel.chat.notification', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id), user_id: String(b.id) }),
      scope: ['user:read:chat', 'user:bot'],
      handler: handleChatNotification },

    // Chat settings changes (wave 368) — follower-only / sub-only / slow mode toggles.
    { name: 'channel.chat_settings.update', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id), user_id: String(b.id) }),
      scope: ['user:read:chat', 'user:bot'],
      handler: handleChatSettingsUpdate },

    // ─── Wave 369: Tier A read-only expansion ────────────────────────────────

    // Suspicious user activity (shared ban list / low-trust flags)
    { name: 'channel.suspicious_user.message', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id), moderator_user_id: String(b.id) }),
      scope: 'moderator:read:suspicious_users',
      handler: (e) => handleSuspiciousUser('message', e) },
    { name: 'channel.suspicious_user.update', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id), moderator_user_id: String(b.id) }),
      scope: 'moderator:read:suspicious_users',
      handler: (e) => handleSuspiciousUser('update', e) },

    // Warnings issued / acknowledged
    { name: 'channel.warning.send', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id), moderator_user_id: String(b.id) }),
      scope: 'moderator:read:warnings',
      handler: (e) => handleWarning('send', e) },
    { name: 'channel.warning.acknowledge', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id), moderator_user_id: String(b.id) }),
      scope: 'moderator:read:warnings',
      handler: (e) => handleWarning('acknowledge', e) },

    // Unban request lifecycle
    { name: 'channel.unban_request.create', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id), moderator_user_id: String(b.id) }),
      scope: 'moderator:read:unban_requests',
      handler: (e) => handleUnbanRequest('create', e) },
    { name: 'channel.unban_request.resolve', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id), moderator_user_id: String(b.id) }),
      scope: 'moderator:read:unban_requests',
      handler: (e) => handleUnbanRequest('resolve', e) },

    // Shield Mode on/off
    { name: 'channel.shield_mode.begin', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id), moderator_user_id: String(b.id) }),
      scope: 'moderator:read:shield_mode',
      handler: (e) => handleShieldMode('begin', e) },
    { name: 'channel.shield_mode.end', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id), moderator_user_id: String(b.id) }),
      scope: 'moderator:read:shield_mode',
      handler: (e) => handleShieldMode('end', e) },

    // Guest star session lifecycle
    { name: 'channel.guest_star_session.begin', version: 'beta',
      condition: (b) => ({ broadcaster_user_id: String(b.id), moderator_user_id: String(b.id) }),
      scope: 'moderator:read:guest_star',
      handler: (e) => handleGuestStar('begin', e) },
    { name: 'channel.guest_star_session.end', version: 'beta',
      condition: (b) => ({ broadcaster_user_id: String(b.id), moderator_user_id: String(b.id) }),
      scope: 'moderator:read:guest_star',
      handler: (e) => handleGuestStar('end', e) },

    // Chat EventSub uses `user_id` as the reader; we use the broadcaster's own id so it reads
    // their own chat. Requires user:read:chat on the broadcaster's token.
    // Chat subs require BOTH scopes: user:read:chat (documented) and user:bot (undocumented
    // Twitch requirement — without it Twitch returns 403 on creation when user_id = broadcaster_id).
    { name: 'channel.chat.message', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id), user_id: String(b.id) }),
      scope: ['user:read:chat', 'user:bot'],
      handler: handleChatMessage },

    { name: 'channel.chat.message_delete', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id), user_id: String(b.id) }),
      scope: ['user:read:chat', 'user:bot'],
      handler: handleMessageDelete },

    // ─── v2 topics (2026-10-18 scope expansion) ──────────────────────────────

    // channel.update: no scope required (public app-token sub). Title / category / CCL changes.
    { name: 'channel.update', version: '2',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      handler: handleChannelUpdate },

    // Hype train (3 topics, same scope)
    { name: 'channel.hype_train.begin', version: '2',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:hype_train',
      handler: (e) => handleHypeTrain('begin', e) },
    { name: 'channel.hype_train.progress', version: '2',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:hype_train',
      handler: (e) => handleHypeTrain('progress', e) },
    { name: 'channel.hype_train.end', version: '2',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:hype_train',
      handler: (e) => handleHypeTrain('end', e) },

    // Goals (3 topics, same scope)
    { name: 'channel.goal.begin', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:goals',
      handler: (e) => handleGoal('begin', e) },
    { name: 'channel.goal.progress', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:goals',
      handler: (e) => handleGoal('progress', e) },
    { name: 'channel.goal.end', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:goals',
      handler: (e) => handleGoal('end', e) },

    // Ad breaks
    { name: 'channel.ad_break.begin', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:ads',
      handler: handleAdBreak },

    // Charity campaigns (4 topics, same scope)
    { name: 'channel.charity_campaign.start', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:charity',
      handler: (e) => handleCharity('start', e) },
    { name: 'channel.charity_campaign.donate', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:charity',
      handler: (e) => handleCharity('donate', e) },
    { name: 'channel.charity_campaign.progress', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:charity',
      handler: (e) => handleCharity('progress', e) },
    { name: 'channel.charity_campaign.stop', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:charity',
      handler: (e) => handleCharity('stop', e) },

    // Polls (3 topics, same scope)
    { name: 'channel.poll.begin', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:polls',
      handler: (e) => handlePoll('begin', e) },
    { name: 'channel.poll.progress', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:polls',
      handler: (e) => handlePoll('progress', e) },
    { name: 'channel.poll.end', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:polls',
      handler: (e) => handlePoll('end', e) },

    // Predictions (4 topics, same scope)
    { name: 'channel.prediction.begin', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:predictions',
      handler: (e) => handlePrediction('begin', e) },
    { name: 'channel.prediction.progress', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:predictions',
      handler: (e) => handlePrediction('progress', e) },
    { name: 'channel.prediction.lock', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:predictions',
      handler: (e) => handlePrediction('lock', e) },
    { name: 'channel.prediction.end', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:predictions',
      handler: (e) => handlePrediction('end', e) },

    // Shoutouts — both subs read the broadcaster's own perspective, so moderator_user_id = broadcaster.
    { name: 'channel.shoutout.create', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id), moderator_user_id: String(b.id) }),
      scope: 'moderator:read:shoutouts',
      handler: (e) => handleShoutout('sent', e) },
    { name: 'channel.shoutout.receive', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id), moderator_user_id: String(b.id) }),
      scope: 'moderator:read:shoutouts',
      handler: (e) => handleShoutout('received', e) },

    // Channel points redemptions
    { name: 'channel.channel_points_custom_reward_redemption.add', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:redemptions',
      handler: handleRedemption },

    // Resub messages + sub endings (reuse existing scope).
    { name: 'channel.subscription.message', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:subscriptions',
      handler: handleResubMessage },
    { name: 'channel.subscription.end', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:subscriptions',
      handler: handleSubEnd },

    // VIP + moderator add/remove (reuse existing scopes).
    { name: 'channel.vip.add', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:vips',
      handler: (e) => handleRoleChange('vip', 'add', e) },
    { name: 'channel.vip.remove', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:vips',
      handler: (e) => handleRoleChange('vip', 'remove', e) },
    { name: 'channel.moderator.add', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'moderation:read',
      handler: (e) => handleRoleChange('moderator', 'add', e) },
    { name: 'channel.moderator.remove', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'moderation:read',
      handler: (e) => handleRoleChange('moderator', 'remove', e) },

    // ─── Wave 383: everything else the existing grants allow ─────────────────
    // A read scope is also satisfied by the matching manage scope (scopeSatisfied).
    // channel.moderate is deliberately absent: Twitch requires moderator:read:moderators and
    // moderator:read:vips, which broadcasters haven't granted (403 on create).
    { name: 'channel.raid', key: 'channel.raid:out', version: '1', bidField: 'from_broadcaster_user_id',
      condition: (b) => ({ from_broadcaster_user_id: String(b.id) }),
      handler: extra.handleRaidOut },

    { name: 'automod.message.hold', version: '2',
      condition: (b) => ({ broadcaster_user_id: String(b.id), moderator_user_id: String(b.id) }),
      scope: 'moderator:manage:automod',
      handler: extra.handleAutomodHold },
    { name: 'automod.message.update', version: '2',
      condition: (b) => ({ broadcaster_user_id: String(b.id), moderator_user_id: String(b.id) }),
      scope: 'moderator:manage:automod',
      handler: extra.handleAutomodUpdate },
    { name: 'automod.terms.update', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id), moderator_user_id: String(b.id) }),
      scope: 'moderator:manage:automod',
      handler: extra.handleAutomodTerms },

    { name: 'channel.chat.clear', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id), user_id: String(b.id) }),
      scope: ['user:read:chat', 'user:bot'],
      handler: (e) => extra.handleChatClear('all', e) },
    { name: 'channel.chat.clear_user_messages', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id), user_id: String(b.id) }),
      scope: ['user:read:chat', 'user:bot'],
      handler: (e) => extra.handleChatClear('user', e) },

    { name: 'channel.bits.use', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'bits:read',
      handler: extra.handleBitsUse },

    { name: 'channel.shared_chat.begin', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      handler: (e) => extra.handleSharedChat('begin', e) },
    { name: 'channel.shared_chat.update', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      handler: (e) => extra.handleSharedChat('update', e) },
    { name: 'channel.shared_chat.end', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      handler: (e) => extra.handleSharedChat('end', e) },

    { name: 'channel.channel_points_custom_reward.add', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:redemptions',
      handler: (e) => extra.handleRewardChange('add', e) },
    { name: 'channel.channel_points_custom_reward.update', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:redemptions',
      handler: (e) => extra.handleRewardChange('update', e) },
    { name: 'channel.channel_points_custom_reward.remove', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:redemptions',
      handler: (e) => extra.handleRewardChange('remove', e) },
    { name: 'channel.channel_points_custom_reward_redemption.update', version: '1',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:redemptions',
      handler: extra.handleRedemptionUpdate },
    { name: 'channel.channel_points_automatic_reward_redemption.add', version: '2',
      condition: (b) => ({ broadcaster_user_id: String(b.id) }),
      scope: 'channel:read:redemptions',
      handler: extra.handleAutomaticRedemption },
];

for (const t of SUB_TYPES) {
    t.key = t.key || t.name;
    t.bidField = t.bidField || 'broadcaster_user_id';
}
const TYPES_BY_NAME = new Map();
for (const t of SUB_TYPES) {
    if (!TYPES_BY_NAME.has(t.name)) TYPES_BY_NAME.set(t.name, []);
    TYPES_BY_NAME.get(t.name).push(t);
}

// Incoming and outgoing raids share a Twitch type; the subscription condition says which fired.
function specFor(subType, condition) {
    const specs = TYPES_BY_NAME.get(subType);
    if (!specs) return null;
    if (specs.length === 1 || !condition) return specs[0];
    return specs.find(t => condition[t.bidField]) || specs[0];
}

// ─── Configuration + headers ────────────────────────────────────────────────

export function getSecret() { return process.env.TWITCH_EVENTSUB_SECRET || ''; }
export function getCallbackUrl() {
    // Explicit override takes precedence.
    if (process.env.TWITCH_EVENTSUB_CALLBACK_URL) return process.env.TWITCH_EVENTSUB_CALLBACK_URL;
    // Fallback: derive from DASHBOARD_URL + the webhook mount path. The dashboard mounts
    // this router at /webhooks/twitch/eventsub (see dashboard/server.js). Normalise trailing
    // slash on DASHBOARD_URL so we never produce a double slash.
    const base = String(process.env.DASHBOARD_URL || '').replace(/\/+$/, '');
    return base ? `${base}/webhooks/twitch/eventsub` : '';
}
export function isConfigured() { return !!(getSecret() && /^https:\/\//i.test(getCallbackUrl())); }

async function twitchHeaders() {
    const token = await getAccessToken();
    return {
        'Client-ID': process.env.TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
    };
}

function userHeaders(userAccessToken) {
    return {
        'Client-ID': process.env.TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${userAccessToken}`,
        'Content-Type': 'application/json',
    };
}

/**
 * Look up the user auth for a broadcaster: the server grants below, plus the scopes of a stream bot grant
 * (core/stream-bot, stream_bot_twitch_grants — per CertiFried user, not per server). Subscriptions are created
 * with the app token, so only the scope set matters for eligibility; both grants authorize the same client id.
 * Returns {accessToken, scopes:Set<string>} or null.
 */
async function getBroadcasterUserAuth(broadcasterId) {
    const auth = await getServerGrantAuth(broadcasterId);
    const extra = await import('./stream-bot/index.js')
        .then((m) => m.streamBotScopesFor(broadcasterId))
        .catch(() => new Set());
    if (!extra.size) return auth;
    return { accessToken: auth?.accessToken || null, scopes: new Set([...(auth?.scopes || []), ...extra]) };
}

/** The server grants (analytics + tier B) for a broadcaster. Returns {accessToken, scopes:Set<string>} or null. */
async function getServerGrantAuth(broadcasterId) {
    // Prefer the broadcaster-scope table: twitch_role_sync_config holds the real scope set
    // (chat, follow, raid, subscribe, cheer, ban, moderate, …) that EventSub subscriptions
    // need. twitch_oauth_accounts is identity-only (user:read:email) and can't authorize any
    // of the scoped sub types. See memory certifried-twitch-oauth-tables.
    // If a broadcaster is bound to multiple guilds (rare), pick the most-recently-synced
    // enabled row — that's the one whose token is freshest.
    const [cfgRows] = await pool.execute(
        `SELECT broadcaster_token, token_scopes, tier_b_scopes
           FROM twitch_role_sync_config
          WHERE broadcaster_twitch_id = ? AND enabled = 1 AND broadcaster_token IS NOT NULL
          ORDER BY last_synced DESC, updated_at DESC
          LIMIT 1`,
        [String(broadcasterId)]);
    const cfg = cfgRows[0];
    if (cfg?.broadcaster_token) {
        try {
            const accessToken = await getBroadcasterAccessToken({ broadcasterId });
            if (!accessToken) throw new Error('no usable broadcaster token');
            // Both grants authorize the same client id, so Twitch honours either set.
            const scopes = `${cfg.token_scopes || ''} ${cfg.tier_b_scopes || ''}`.split(/[\s,]+/).filter(Boolean);
            return { accessToken, scopes: new Set(scopes) };
        } catch (err) {
            logger.warn(`${LOG} failed to decrypt broadcaster_token for ${broadcasterId}: ${err.message}`);
        }
    }

    // Fallback: legacy identity-flow lookup. Only useful for app-token subscriptions
    // (which don't need user scopes anyway); kept so existing code paths don't regress.
    const [idRows] = await pool.execute(
        `SELECT access_token, scopes_granted FROM twitch_oauth_accounts WHERE twitch_user_id = ? LIMIT 1`,
        [String(broadcasterId)]);
    const r = idRows[0];
    if (!r?.access_token) return null;
    const scopes = String(r.scopes_granted || '').split(/[\s,]+/).filter(Boolean);
    return { accessToken: r.access_token, scopes: new Set(scopes) };
}

function scopeSatisfied(have, need) {
    if (Array.isArray(need)) return need.some(n => scopeSatisfied(have, n));
    if (have.has(need)) return true;
    const m = String(need).match(/^(moderator|channel):read:(.+)$/);
    return !!m && have.has(`${m[1]}:manage:${m[2]}`);
}

/** For a broadcaster, which SUB_TYPES are eligible right now. */
async function eligibleTypesFor(broadcaster) {
    const auth = await getBroadcasterUserAuth(broadcaster.id);
    const out = [];
    for (const t of SUB_TYPES) {
        if (!t.scope) { out.push(t); continue; }
        // scope may be a string (single required scope) or an array (all required)
        const required = Array.isArray(t.scope) ? t.scope : [t.scope];
        if (auth && required.every(s => scopeSatisfied(auth.scopes, s))) out.push(t);
    }
    return { types: out, auth };
}

// ─── Remote (Twitch-side) subscription API ───────────────────────────────────

async function listRemoteSubscriptions() {
    const headers = await twitchHeaders();
    const out = [];
    let cursor = null;
    do {
        const url = cursor ? `${HELIX_EVENTSUB}?after=${encodeURIComponent(cursor)}` : HELIX_EVENTSUB;
        const res = await axios.get(url, { headers, timeout: 15000 });
        out.push(...(res.data?.data || []));
        cursor = res.data?.pagination?.cursor || null;
    } while (cursor);
    return out;
}

// The conduit id is cached by ensureConduit() a few seconds after boot. A create that runs before
// then (an OAuth reconnect right after a restart) waits for it instead of creating a webhook twin.
let conduitLoading = null;
async function conduitIdForCreate() {
    if (getCachedConduitId()) return getCachedConduitId();
    conduitLoading ||= ensureConduitImpl()
        .catch(e => logger.warn(`${LOG} conduit not ready for create: ${e.message}`))
        .finally(() => { conduitLoading = null; });
    await conduitLoading;
    return getCachedConduitId();
}

async function createRemoteSubscription(broadcaster, typeSpec, _authOverride) {
    // Transport choice: prefer conduit when we have one (scales past the 10K direct-webhook
    // ceiling). Fall back to direct webhook if ensureConduit hasn't finished (first boot after
    // the conduit migration or if the conduit was deleted upstream).
    //
    // In both cases the API call itself uses the APP access token — Twitch requires that for
    // webhook-transport subs and allows it for conduit-transport too. The user's granted scopes
    // are verified server-side against our client_id; eligibleTypesFor() gates client-side.
    const headers = await twitchHeaders();
    const conduitId = await conduitIdForCreate();
    const transport = conduitId
        ? { method: 'conduit', conduit_id: conduitId }
        : { method: 'webhook', callback: getCallbackUrl(), secret: getSecret() };
    const body = {
        type: typeSpec.name,
        version: typeSpec.version,
        condition: typeSpec.condition(broadcaster),
        transport,
    };
    const res = await axios.post(HELIX_EVENTSUB, body, { headers, timeout: 15000 });
    return res.data?.data?.[0] || null;
}

async function deleteRemoteSubscription(twitchSubId) {
    const headers = await twitchHeaders();
    await axios.delete(`${HELIX_EVENTSUB}?id=${encodeURIComponent(twitchSubId)}`, { headers, timeout: 15000 });
}

// ─── Local ledger ────────────────────────────────────────────────────────────

async function upsertLedger(twitchSubId, broadcasterId, login, type, status) {
    await pool.execute(
        `INSERT INTO twitch_eventsub_subscriptions (twitch_sub_id, broadcaster_id, broadcaster_login, sub_type, status)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE twitch_sub_id = VALUES(twitch_sub_id), broadcaster_login = VALUES(broadcaster_login),
                                 status = VALUES(status), updated_at = CURRENT_TIMESTAMP`,
        [twitchSubId, String(broadcasterId), login || null, type, status]);
}

export async function markStatus(twitchSubId, status) {
    await pool.execute(
        'UPDATE twitch_eventsub_subscriptions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE twitch_sub_id = ?',
        [status, twitchSubId]);
}

// ─── Reconciliation ──────────────────────────────────────────────────────────

async function trackedBroadcasters() {
    const [rows] = await pool.execute(
        `SELECT DISTINCT platform_user_id AS id, username AS login FROM streamers
          WHERE platform = 'twitch' AND platform_user_id IS NOT NULL`);
    // Channels linked to a stream bot profile are tracked too, so reconcile keeps (and creates) their subscriptions.
    const linked = await import('./stream-bot/index.js').then((m) => m.streamBotTwitchChannels()).catch(() => []);
    const seen = new Set(rows.map((r) => String(r.id)));
    for (const r of linked) {
        if (!seen.has(String(r.id))) { rows.push({ id: r.id, login: r.login }); seen.add(String(r.id)); }
    }
    return rows;
}

export async function reconcile() {
    if (!isConfigured()) {
        logger.warn(`${LOG} Not configured (missing secret or non-https callback) — skipping reconcile`);
        return { skipped: true };
    }

    const [tracked, remote] = await Promise.all([trackedBroadcasters(), listRemoteSubscriptions().catch(err => {
        logger.error(`${LOG} Could not list remote subscriptions: ${err.response?.status || err.message}`);
        return null;
    })]);
    if (!remote) return { error: 'list_failed' };

    const trackedById = new Map();
    const noId = [];
    for (const t of tracked) {
        if (isTwitchId(t.id)) trackedById.set(String(t.id), t.login);
        else noId.push(t.login || t.id);
    }
    if (noId.length) logger.info(`${LOG} ${noId.length} broadcaster(s) still missing Twitch id — skipping until identity sync fills them`);

    const subTypeNames = new Set(SUB_TYPES.map(t => t.name));
    const remoteByKey = new Map();
    for (const s of remote) {
        if (!subTypeNames.has(s.type)) continue;
        for (const t of TYPES_BY_NAME.get(s.type)) {
            const bid = s.condition?.[t.bidField];
            if (bid) remoteByKey.set(`${bid}:${t.key}`, { id: s.id, status: s.status });
        }
    }

    let created = 0, deleted = 0, kept = 0, skippedScope = 0, missing = 0;

    for (const [id, login] of trackedById) {
        if (missingUntil.get(id) > Date.now()) { missing++; continue; }

        const { types: eligible, auth } = await eligibleTypesFor({ id, login });
        for (const t of SUB_TYPES) {
            const key = `${id}:${t.key}`;
            if (!eligible.includes(t)) {
                if (remoteByKey.has(key)) {
                    try { await deleteRemoteSubscription(remoteByKey.get(key).id); deleted++; } catch { /* ignore */ }
                    await pool.execute(
                        'DELETE FROM twitch_eventsub_subscriptions WHERE broadcaster_id = ? AND sub_type = ?',
                        [id, t.key]);
                }
                skippedScope++;
                continue;
            }
            if (remoteByKey.has(key)) { kept++; continue; }
            try {
                const sub = await createRemoteSubscription({ id, login }, t, t.scope ? auth : null);
                if (sub) {
                    await upsertLedger(sub.id, id, login, t.key, sub.status);
                    created++;
                }
            } catch (err) {
                const status = err.response?.status;
                if (status === 404 || status === 400) {
                    // 400 is what Twitch returns for an account that was deleted or banned; back off
                    // like a 404 instead of retrying every type on every reconcile.
                    if (!missingUntil.has(id)) logger.warn(`${LOG} create ${t.key} for ${login || id} failed: ${status}; backing off (account may be deleted or banned)`);
                    missingUntil.set(id, Date.now() + MISSING_RETRY_MS);
                } else if (status !== 409) {
                    logger.warn(`${LOG} create ${t.key} for ${login || id} failed: ${status || err.message}`);
                }
            }
        }
    }

    for (const [key, remoteSub] of remoteByKey) {
        const bid = key.split(':')[0];
        if (!trackedById.has(bid)) {
            try { await deleteRemoteSubscription(remoteSub.id); deleted++; } catch { /* ignore */ }
            await pool.execute(
                'DELETE FROM twitch_eventsub_subscriptions WHERE twitch_sub_id = ?', [remoteSub.id]);
        }
    }

    logger.info(`${LOG} reconcile: ${trackedById.size} broadcasters · created ${created} · kept ${kept} · deleted ${deleted} · skipped-scope ${skippedScope} · missing-id ${missing}`);
    return { tracked: trackedById.size, created, deleted, kept, skippedScope, missing };
}

export const ensureConduit = ensureConduitImpl;

export async function subscribeBroadcaster(broadcasterId, login) {
    if (!isConfigured()) return;
    const { types: eligible, auth } = await eligibleTypesFor({ id: broadcasterId, login });
    for (const t of eligible) {
        try {
            const sub = await createRemoteSubscription({ id: broadcasterId, login }, t, t.scope ? auth : null);
            if (sub) await upsertLedger(sub.id, broadcasterId, login, t.key, sub.status);
        } catch (err) {
            if (err.response?.status !== 409) {
                logger.warn(`${LOG} subscribeBroadcaster ${login || broadcasterId} ${t.name}: ${err.response?.status || err.message}`);
            }
        }
    }
}

// ─── Notification dispatch ───────────────────────────────────────────────────

export async function handleNotification(subType, event, subscription = null) {
    const typeSpec = specFor(subType, subscription?.condition);
    if (!typeSpec) { logger.warn(`${LOG} ignoring unknown subscription type ${subType}`); return 'unknown_type'; }
    // Stream bot (core/stream-bot): normalised event feed + automations. Fire-and-forget, before the handler so a
    // handler error cannot hide the event; the stream bot never throws into this path.
    import('./stream-bot/index.js').then(({ onTwitch }) => onTwitch(subType, event, typeSpec.key)).catch(() => {});
    try {
        const result = await typeSpec.handler(event);
        // Fire-and-forget analytics alert dispatch — guild-admins can opt into Discord DMs/
        // channel pings for hype trains, goals, charity milestones, raids, first-time
        // chatters, etc. Lives in core/twitch-analytics-alerts.js; checks per-guild config.
        import('./twitch-analytics-alerts.js').then(({ dispatch }) => {
            // Grab the discord client lazily off process.env.DISCORD_CLIENT or globalThis.client
            // depending on how the host registers it. Fall back to null → dispatch no-ops.
            const client = globalThis.__discordClient || null;
            dispatch(client, subType, event).catch(err =>
                logger.warn(`${LOG} analytics-alerts dispatch failed for ${subType}: ${err.message}`));
        }).catch(err => logger.warn(`${LOG} analytics-alerts import failed: ${err.message}`));

        // Wave 371 — Streamer.bot bridge dispatch. Only for high-value events to avoid flooding.
        const bridgeEvents = ['channel.subscribe', 'channel.subscription.gift', 'channel.subscription.message',
                              'channel.cheer', 'channel.raid', 'channel.follow',
                              'channel.hype_train.begin', 'channel.hype_train.end',
                              'channel.goal.end', 'channel.charity_campaign.donate',
                              'stream.online', 'stream.offline'];
        if (bridgeEvents.includes(subType) && typeSpec.key !== 'channel.raid:out') {
            import('./twitch-streamerbot-bridge.js').then(({ pushEvent }) => {
                const bid = event.broadcaster_user_id || event.to_broadcaster_user_id;
                if (bid) pushEvent(bid, subType, event).catch(() => {});
            }).catch(() => {});
        }
        return result;
    }
    catch (err) { logger.error(`${LOG} handler threw for ${subType}: ${err.message}`); return 'handler_error'; }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function lookupStreamer(broadcasterId) {
    if (!broadcasterId) return null;
    const [rows] = await pool.execute(
        `SELECT streamer_id, username FROM streamers WHERE platform = 'twitch' AND platform_user_id = ? LIMIT 1`,
        [String(broadcasterId)]);
    return rows[0] || null;
}

async function handleStreamOnline(event) {
    const broadcasterId = event?.broadcaster_user_id;
    const login = event?.broadcaster_user_login || event?.broadcaster_user_name;
    const streamer = await lookupStreamer(broadcasterId);
    if (!streamer) { logger.info(`${LOG} stream.online for untracked ${login || broadcasterId}`); return 'untracked'; }
    logger.info(`${LOG} ${login} went LIVE — announcing (streamer_id ${streamer.streamer_id})`);
    checkStreamerNow(streamer.streamer_id, { forceLive: true }).catch(err =>
        logger.error(`${LOG} immediate announce failed for ${login}: ${err.message}`));
    return 'announced';
}

async function handleStreamOffline(event) {
    const broadcasterId = event?.broadcaster_user_id;
    const login = event?.broadcaster_user_login || event?.broadcaster_user_name;
    const streamer = await lookupStreamer(broadcasterId);
    if (!streamer) return 'untracked';
    logger.info(`${LOG} ${login} went OFFLINE — targeted end check`);
    checkStreamerNow(streamer.streamer_id).catch(err =>
        logger.error(`${LOG} offline check failed for ${login}: ${err.message}`));
    return 'offline_checked';
}

async function handleFollow(event) {
    ingestFollow(event.broadcaster_user_id, event.user_login, event.user_id);
    return 'follow_ingested';
}
async function handleRaid(event) {
    ingestRaid(event.to_broadcaster_user_id, event.from_broadcaster_user_login, event.viewers);
    extra.recordRaid('in', event).catch(() => {});
    // Wave 372 Tier AI-2 — fire-and-forget AI raid verification. Classifies the incoming
    // raid as likely-legit / likely-fake / unclear. Result cached in twitch_ai_insights
    // (type=raid_verify) keyed by raider id — dashboard shows a classification badge.
    import('./twitch-ai.js').then(({ verifyRaid }) => {
        verifyRaid(event.to_broadcaster_user_id, event).catch(err =>
            logger.warn(`${LOG} AI raid verify failed: ${err.message}`));
    }).catch(() => {});
    return 'raid_ingested';
}
async function handleSubscribe(event) {
    ingestSubscribe(event.broadcaster_user_id, event.user_login, event.tier, !!event.is_gift);
    return 'subscribe_ingested';
}
async function handleGiftSub(event) {
    ingestGiftSub(event.broadcaster_user_id, event.user_login, event.total, event.tier);
    return 'gift_ingested';
}
async function handleCheer(event) {
    ingestCheer(event.broadcaster_user_id, event.user_login, Number(event.bits) || 0);
    return 'cheer_ingested';
}
async function handleBan(event) {
    ingestBan(event.broadcaster_user_id, event.user_login, event.is_permanent, event.reason || null);
    extra.recordBan(event).catch(() => {});
    return 'ban_ingested';
}

// Wave 368 handlers — unban events, chat notifications, chat settings changes.
async function handleUnban(event) {
    try {
        await pool.execute(
            `INSERT INTO twitch_unban_events (broadcaster_id, target_user_id, target_user_login, moderator_user_id, moderator_user_login, occurred_at)
             VALUES (?, ?, ?, ?, ?, NOW())`,
            [String(event.broadcaster_user_id), event.user_id || null, event.user_login || null,
             event.moderator_user_id || null, event.moderator_user_login || null],
        );
    } catch (e) { logger.warn(`${LOG} unban insert failed: ${e.message}`); }
    extra.recordUnban(event).catch(() => {});
    return 'unban_ingested';
}
async function handleChatNotification(event) {
    try {
        await pool.execute(
            `INSERT INTO twitch_chat_notifications
             (broadcaster_id, notice_type, chatter_user_id, chatter_user_login, system_message, message_text, payload_json, occurred_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
            [String(event.broadcaster_user_id), event.notice_type || 'unknown',
             event.chatter_user_id || null, event.chatter_user_login || null,
             (event.system_message || '').slice(0, 2000),
             (event.message?.text || '').slice(0, 2000),
             JSON.stringify(event).slice(0, 20000)],
        );
    } catch (e) { logger.warn(`${LOG} chat notification insert failed: ${e.message}`); }
    return 'chat_notification_ingested';
}
async function handleChatSettingsUpdate(event) {
    try {
        await pool.execute(
            `INSERT INTO twitch_chat_settings_changes
             (broadcaster_id, follower_mode, follower_mode_duration, subscriber_mode, slow_mode, slow_mode_wait_time, emote_mode, unique_chat_mode, changed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [String(event.broadcaster_user_id),
             event.follower_mode ? 1 : 0, event.follower_mode_duration_minutes || 0,
             event.subscriber_mode ? 1 : 0,
             event.slow_mode ? 1 : 0, event.slow_mode_wait_time_seconds || 0,
             event.emote_mode ? 1 : 0,
             event.unique_chat_mode ? 1 : 0],
        );
    } catch (e) { logger.warn(`${LOG} chat settings insert failed: ${e.message}`); }
    return 'chat_settings_ingested';
}

// Wave 369 handlers — Tier A read-only EventSub topics.
async function handleSuspiciousUser(eventType, event) {
    try {
        await pool.execute(
            `INSERT INTO twitch_suspicious_users
             (broadcaster_id, event_type, user_id, user_login, low_trust_status, types_json, ban_evasion_evaluation, shared_ban_channel_ids_json, message_text, occurred_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [String(event.broadcaster_user_id), eventType,
             event.user_id || null, event.user_login || null,
             event.low_trust_status || null,
             JSON.stringify(event.types || []),
             event.ban_evasion_evaluation || null,
             JSON.stringify(event.shared_ban_channel_ids || []),
             (event.message?.text || '').slice(0, 2000)],
        );
    } catch (e) { logger.warn(`${LOG} suspicious_user insert failed: ${e.message}`); }
    return `suspicious_user_${eventType}_ingested`;
}
async function handleWarning(eventType, event) {
    try {
        await pool.execute(
            `INSERT INTO twitch_warnings
             (broadcaster_id, event_type, user_id, user_login, moderator_user_id, moderator_user_login, reason, chat_rules_cited_json, occurred_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [String(event.broadcaster_user_id), eventType,
             event.user_id || null, event.user_login || null,
             event.moderator_user_id || null, event.moderator_user_login || null,
             (event.reason || '').slice(0, 500),
             JSON.stringify(event.chat_rules_cited || [])],
        );
    } catch (e) { logger.warn(`${LOG} warning insert failed: ${e.message}`); }
    return `warning_${eventType}_ingested`;
}
async function handleUnbanRequest(eventType, event) {
    try {
        await pool.execute(
            `INSERT INTO twitch_unban_requests
             (broadcaster_id, request_id, event_type, user_id, user_login, text, status, moderator_user_id, moderator_user_login, resolution_text, occurred_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [String(event.broadcaster_user_id), String(event.id || event.unban_request_id || ''),
             eventType, event.user_id || null, event.user_login || null,
             (event.text || '').slice(0, 2000), event.status || null,
             event.moderator_user_id || null, event.moderator_user_login || null,
             (event.resolution_text || '').slice(0, 2000)],
        );
    } catch (e) { logger.warn(`${LOG} unban_request insert failed: ${e.message}`); }
    return `unban_request_${eventType}_ingested`;
}
async function handleShieldMode(eventType, event) {
    try {
        await pool.execute(
            `INSERT INTO twitch_shield_mode_events
             (broadcaster_id, event_type, moderator_user_id, moderator_user_login, occurred_at)
             VALUES (?, ?, ?, ?, NOW())`,
            [String(event.broadcaster_user_id), eventType,
             event.moderator_user_id || null, event.moderator_user_login || null],
        );
    } catch (e) { logger.warn(`${LOG} shield_mode insert failed: ${e.message}`); }
    return `shield_mode_${eventType}_ingested`;
}
async function handleGuestStar(eventType, event) {
    try {
        await pool.execute(
            `INSERT INTO twitch_guest_star_sessions
             (broadcaster_id, session_id, event_type, moderator_user_id, guests_json, occurred_at)
             VALUES (?, ?, ?, ?, ?, NOW())`,
            [String(event.broadcaster_user_id), String(event.session_id || ''),
             eventType, event.moderator_user_id || null,
             JSON.stringify(event.guests || [])],
        );
    } catch (e) { logger.warn(`${LOG} guest_star insert failed: ${e.message}`); }
    return `guest_star_${eventType}_ingested`;
}
async function handleChatMessage(event) {
    ingestChatMessage(event.broadcaster_user_id, event.chatter_user_login, event.chatter_user_id, event.message?.text || '', event.broadcaster_user_login);
    extra.countEmotes(event.broadcaster_user_id, event.message?.fragments, event.chatter_user_login);
    extra.countChatterMessage(event.broadcaster_user_id, event.chatter_user_id, event.chatter_user_login);
    // Wave 369 — opt-in chat message sampling. Writes to a bounded ring-buffer table so
    // emote/word/sentiment analysis has something to work with. The ingestChatMessage call
    // above still handles count-only aggregation; this is strictly for text analysis.
    sampleChatMessage(event).catch(e => logger.warn(`${LOG} chat sample failed: ${e.message}`));
    // Wave 370 — chatter-watch alerts. If this chatter is on any guild's watch list, DM
    // or ping the configured alert channel. First-seen-in-window dedup prevents spamming.
    checkChatterWatch(event).catch(e => logger.warn(`${LOG} chatter watch check failed: ${e.message}`));
    // KumaBot Defender (core/twitch-kbd-defender.js). Off unless the broadcaster turned it on (kbd_mode).
    import('./twitch-kbd-defender.js')
        .then(m => m.checkTwitchMessage(event))
        .catch(e => logger.warn(`${LOG} KBD check failed: ${e.message}`));
    return 'chat_ingested';
}

/** Chatter-watch alert dispatcher — fires once per (broadcaster, watched user) per hour. */
async function checkChatterWatch(event) {
    const bid = String(event.broadcaster_user_id || '');
    const login = String(event.chatter_user_login || '').toLowerCase();
    if (!bid || !login) return;
    // In-memory dedup — one alert per (bid, login) per hour window.
    if (!checkChatterWatch._seen) checkChatterWatch._seen = new Map();
    const key = `${bid}:${login}`;
    const last = checkChatterWatch._seen.get(key);
    if (last && (Date.now() - last) < 3_600_000) return;
    const [rows] = await pool.execute(
        `SELECT w.label FROM twitch_chatter_watch w
           JOIN twitch_analytics_alerts_config c ON c.broadcaster_id = w.broadcaster_id COLLATE utf8mb4_unicode_ci
          WHERE w.broadcaster_id = ? AND LOWER(w.chatter_user_login) = ?
            AND c.notify_chatter_watch = 1 AND c.alert_channel_id IS NOT NULL
          LIMIT 1`, [bid, login]);
    if (!rows.length) return;
    checkChatterWatch._seen.set(key, Date.now());
    const { dispatchChatterWatch } = await import('./twitch-analytics-alerts.js');
    await dispatchChatterWatch(bid, login, event.chatter_user_name, rows[0].label).catch(() => {});
}
async function sampleChatMessage(event) {
    const bid = String(event.broadcaster_user_id || '');
    if (!bid) return;
    // Opt-in gate: only sample when the guild has flipped the toggle. Avoid the per-message
    // DB roundtrip for the config check — cache the boolean per-broadcaster for 5 minutes.
    const now = Date.now();
    const cached = sampleChatMessage._cache?.get(bid);
    let enabled;
    if (cached && (now - cached.at) < 300_000) enabled = cached.v;
    else {
        const [rows] = await pool.execute(
            `SELECT 1 FROM twitch_analytics_alerts_config
              WHERE broadcaster_id = ? AND chat_sampling_enabled = 1 LIMIT 1`, [bid]);
        enabled = rows.length > 0;
        if (!sampleChatMessage._cache) sampleChatMessage._cache = new Map();
        sampleChatMessage._cache.set(bid, { v: enabled, at: now });
    }
    if (!enabled) return;

    const text = (event.message?.text || '').slice(0, 500);
    const fragments = event.message?.fragments || [];
    let emoteCount = 0;
    for (const f of fragments) if (f.type === 'emote') emoteCount++;
    const hasLink = /https?:\/\//i.test(text) ? 1 : 0;
    const upperLen = text.replace(/[^A-Za-z]/g, '').length;
    const upperOnly = text.replace(/[^A-Z]/g, '').length;
    const isCaps = upperLen > 10 && (upperOnly / upperLen) > 0.7 ? 1 : 0;

    await pool.execute(
        `INSERT INTO twitch_chat_message_samples
         (broadcaster_id, chatter_user_id, chatter_user_login, message_text, message_length, has_link, is_caps, emote_count, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [bid, event.chatter_user_id || null, event.chatter_user_login || null,
         text, text.length, hasLink, isCaps, emoteCount]);

    // Age-out is the retention sweeper's job (data_retention_policy, 90 days, migration 393).
}
async function handleMessageDelete(event) {
    ingestMessageDelete(event.broadcaster_user_id, event.target_user_login || null);
    return 'delete_ingested';
}

// ─── v2 handlers (growth + engagement) ───────────────────────────────────────
async function handleChannelUpdate(event) {
    ingestCategoryUpdate(event.broadcaster_user_id, event);
    return 'channel_update_ingested';
}
async function handleHypeTrain(eventType, event) {
    ingestHypeTrain(event.broadcaster_user_id, eventType, event);
    // Wave 373 — on hype_train.end, trigger AI auto-clip (opt-in).
    if (eventType === 'end') {
        import('./twitch-ai.js').then(({ autoClipOnHypeEnd }) => {
            autoClipOnHypeEnd(event.broadcaster_user_id, event).catch(err =>
                logger.warn(`${LOG} auto-clip on hype end failed: ${err.message}`));
        }).catch(() => {});
    }
    return `hype_train_${eventType}_ingested`;
}
async function handleGoal(eventType, event) {
    ingestGoal(event.broadcaster_user_id, eventType, event);
    return `goal_${eventType}_ingested`;
}
async function handleAdBreak(event) {
    ingestAdBreak(event.broadcaster_user_id, event);
    return 'ad_break_ingested';
}
async function handleCharity(eventType, event) {
    ingestCharity(event.broadcaster_user_id, eventType, event);
    return `charity_${eventType}_ingested`;
}
async function handlePoll(eventType, event) {
    ingestPoll(event.broadcaster_user_id, eventType, event);
    return `poll_${eventType}_ingested`;
}
async function handlePrediction(eventType, event) {
    ingestPrediction(event.broadcaster_user_id, eventType, event);
    // Wave 373 — AI commentary on prediction resolution.
    if (eventType === 'end') {
        import('./twitch-ai.js').then(({ commentaryForPrediction }) => {
            commentaryForPrediction(event.broadcaster_user_id, event).catch(err =>
                logger.warn(`${LOG} prediction commentary failed: ${err.message}`));
        }).catch(() => {});
    }
    return `prediction_${eventType}_ingested`;
}
async function handleShoutout(direction, event) {
    ingestShoutout(event.broadcaster_user_id, direction, event);
    return `shoutout_${direction}_ingested`;
}
async function handleRedemption(event) {
    ingestRedemption(event.broadcaster_user_id, event);
    return 'redemption_ingested';
}
async function handleResubMessage(event) {
    ingestResubMessage(event.broadcaster_user_id, event);
    return 'resub_message_ingested';
}
async function handleSubEnd(event) {
    ingestSubEnd(event.broadcaster_user_id, event);
    return 'sub_end_ingested';
}
async function handleRoleChange(role, action, event) {
    ingestRoleChange(event.broadcaster_user_id, role, action, event);
    return `${role}_${action}_ingested`;
}

// ─── Signature verification ──────────────────────────────────────────────────

export function verifySignature({ messageId, timestamp, rawBody, signature }) {
    if (!messageId || !timestamp || !signature) return false;
    const hmac = crypto.createHmac('sha256', getSecret())
        .update(messageId + timestamp + rawBody)
        .digest('hex');
    const expected = `sha256=${hmac}`;
    if (expected.length !== signature.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
