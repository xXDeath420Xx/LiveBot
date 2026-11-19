/**
 * Twitch Helix write-action helper.
 *
 * Every Tier B dashboard action (title edit, Shield Mode toggle, launch poll, ban user, etc.)
 * calls through callHelixWrite() which:
 *
 *   1. Pulls the broadcaster's tier_b_token (NOT the read token — those are separate OAuth grants)
 *   2. Decrypts it, refreshes it if close to expiry
 *   3. Issues the Helix request
 *   4. Writes an audit-log row (ALWAYS, success or failure) so broadcasters can review
 *      what their dashboard did on their behalf
 *   5. Returns { ok, status, data, error } to the caller
 *
 * Audit log is the LOAD-BEARING abstraction here. Without it, write scopes become a dark
 * closet of mutations with no accountability. Every row ties action → broadcaster → Discord
 * user who clicked the button.
 */
import axios from 'axios';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import logger from '../utils/logger.js';
import { refreshBroadcasterToken } from '../utils/platforms/twitch.js';

const LOG = '[TwitchWrite]';
const HELIX = 'https://api.twitch.tv/helix';

/**
 * Resolve the write-scope token for a broadcaster. Refreshes if expiring in next 2 minutes.
 * Returns { accessToken, scopes:Set<string> } or null on failure.
 */
export async function getTierBAuth(broadcasterId) {
    const [[cfg]] = await pool.execute(
        `SELECT guild_id, tier_b_token, tier_b_refresh_token, tier_b_token_expires_at, tier_b_scopes
           FROM twitch_role_sync_config
          WHERE broadcaster_twitch_id = ? AND enabled = 1 AND tier_b_token IS NOT NULL
          ORDER BY last_synced DESC LIMIT 1`, [String(broadcasterId)]);
    if (!cfg) return null;

    let accessToken;
    try { accessToken = encryption.decrypt(JSON.parse(cfg.tier_b_token)); }
    catch { logger.warn(`${LOG} tier_b_token decrypt failed for ${broadcasterId}`); return null; }

    // Refresh if token expires in < 2 minutes.
    const expiresAt = cfg.tier_b_token_expires_at ? new Date(cfg.tier_b_token_expires_at) : null;
    if (expiresAt && (expiresAt.getTime() - Date.now()) < 120_000 && cfg.tier_b_refresh_token) {
        try {
            const refreshTokenPlain = encryption.decrypt(JSON.parse(cfg.tier_b_refresh_token));
            const newData = await refreshBroadcasterToken(refreshTokenPlain);
            accessToken = newData.access_token;
            const newExpiresAt = new Date(Date.now() + newData.expires_in * 1000).toISOString().slice(0, 19).replace('T', ' ');
            await pool.execute(
                `UPDATE twitch_role_sync_config
                    SET tier_b_token = ?, tier_b_refresh_token = ?, tier_b_token_expires_at = ?
                  WHERE broadcaster_twitch_id = ?`,
                [JSON.stringify(encryption.encrypt(newData.access_token)),
                 newData.refresh_token ? JSON.stringify(encryption.encrypt(newData.refresh_token)) : null,
                 newExpiresAt, String(broadcasterId)]);
        } catch (e) {
            logger.warn(`${LOG} tier_b_token refresh failed for ${broadcasterId}: ${e.message}`);
        }
    }

    const scopes = new Set(String(cfg.tier_b_scopes || '').split(/[\s,]+/).filter(Boolean));
    return { accessToken, scopes, guildId: cfg.guild_id };
}

/**
 * Execute a Helix write call with audit logging.
 *
 * @param {Object} args
 * @param {string} args.broadcasterId  Twitch user id
 * @param {string} args.verb           HTTP verb (POST, PATCH, PUT, DELETE)
 * @param {string} args.path           Helix path (e.g. "/channels")
 * @param {Object} [args.params]       Query-string params
 * @param {Object} [args.body]         JSON body
 * @param {string} args.action         Action name for audit log (e.g. "update_title")
 * @param {string} args.requiredScope  Twitch scope this call needs — fails early if missing
 * @param {string} [args.triggeredByDiscordId]
 * @param {string} [args.triggeredByDiscordUsername]
 * @param {string} [args.guildId]      For audit log; falls back to the broadcaster's primary guild
 */
export async function callHelixWrite({
    broadcasterId, verb, path, params = {}, body = null,
    action, requiredScope,
    triggeredByDiscordId = null, triggeredByDiscordUsername = null, guildId = null,
}) {
    const started = Date.now();
    const bid = String(broadcasterId);
    const auth = await getTierBAuth(bid);

    const auditInsert = async (ok, status, respBody, errorMsg) => {
        try {
            await pool.execute(
                `INSERT INTO twitch_action_audit_log
                 (broadcaster_id, guild_id, triggered_by_discord_id, triggered_by_discord_username,
                  action, http_verb, helix_path, request_body_json,
                  response_status, response_body_json, ok, error_message, duration_ms)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [bid, guildId || auth?.guildId || null,
                 triggeredByDiscordId, triggeredByDiscordUsername,
                 action, verb, path, body ? JSON.stringify(body).slice(0, 20000) : null,
                 status, respBody ? JSON.stringify(respBody).slice(0, 20000) : null,
                 ok ? 1 : 0, (errorMsg || '').slice(0, 500), Date.now() - started]);
        } catch (e) { logger.warn(`${LOG} audit insert failed: ${e.message}`); }
    };

    if (!auth) {
        await auditInsert(false, 0, null, 'no tier_b token — broadcaster has not granted write scopes');
        return { ok: false, status: 0, error: 'tier_b_not_granted' };
    }
    if (requiredScope && !auth.scopes.has(requiredScope)) {
        await auditInsert(false, 0, null, `required scope ${requiredScope} not granted`);
        return { ok: false, status: 0, error: 'scope_not_granted', scope: requiredScope };
    }

    try {
        const res = await axios({
            method: verb,
            url: `${HELIX}${path}`,
            headers: {
                'Client-ID': process.env.TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${auth.accessToken}`,
                'Content-Type': 'application/json',
            },
            params,
            data: body || undefined,
            timeout: 15_000,
            validateStatus: () => true, // we want to log every status, not throw on 4xx
        });
        const ok = res.status >= 200 && res.status < 300;
        await auditInsert(ok, res.status, res.data || null, ok ? null : (res.data?.message || `HTTP ${res.status}`));
        return { ok, status: res.status, data: res.data, error: ok ? null : (res.data?.message || `HTTP ${res.status}`) };
    } catch (e) {
        await auditInsert(false, 0, null, e.message);
        logger.error(`${LOG} ${action} failed: ${e.message}`);
        return { ok: false, status: 0, error: e.message };
    }
}

/** Convenience wrappers for the common Tier B actions. */

export function updateChannelInfo(broadcasterId, { title, categoryId, broadcasterLanguage, tags }, actor) {
    const body = {};
    if (title !== undefined) body.title = title;
    if (categoryId !== undefined) body.game_id = categoryId;
    if (broadcasterLanguage !== undefined) body.broadcaster_language = broadcasterLanguage;
    if (tags !== undefined) body.tags = tags;
    return callHelixWrite({
        broadcasterId, verb: 'PATCH', path: '/channels',
        params: { broadcaster_id: broadcasterId }, body,
        action: 'update_channel_info', requiredScope: 'channel:manage:broadcast',
        ...actor,
    });
}

export function snoozeNextAd(broadcasterId, actor) {
    return callHelixWrite({
        broadcasterId, verb: 'POST', path: '/channels/ads/schedule/snooze',
        params: { broadcaster_id: broadcasterId },
        action: 'snooze_next_ad', requiredScope: 'channel:manage:ads',
        ...actor,
    });
}

export function startRaid(broadcasterId, toBroadcasterId, actor) {
    return callHelixWrite({
        broadcasterId, verb: 'POST', path: '/raids',
        params: { from_broadcaster_id: broadcasterId, to_broadcaster_id: toBroadcasterId },
        action: 'start_raid', requiredScope: 'channel:manage:raids',
        ...actor,
    });
}

export function toggleShieldMode(broadcasterId, enable, actor) {
    return callHelixWrite({
        broadcasterId, verb: 'PUT', path: '/moderation/shield_mode',
        params: { broadcaster_id: broadcasterId, moderator_id: broadcasterId },
        body: { is_active: !!enable },
        action: enable ? 'shield_mode_enable' : 'shield_mode_disable',
        requiredScope: 'moderator:manage:shield_mode',
        ...actor,
    });
}

export function updateChatSettings(broadcasterId, settings, actor) {
    // settings = {follower_mode?, follower_mode_duration?, slow_mode?, slow_mode_wait_time?,
    //             subscriber_mode?, emote_mode?, non_moderator_chat_delay?, unique_chat_mode?}
    return callHelixWrite({
        broadcasterId, verb: 'PATCH', path: '/chat/settings',
        params: { broadcaster_id: broadcasterId, moderator_id: broadcasterId },
        body: settings,
        action: 'update_chat_settings', requiredScope: 'moderator:manage:chat_settings',
        ...actor,
    });
}

export function createPoll(broadcasterId, { title, choices, duration, bitsVoting, cpVoting }, actor) {
    return callHelixWrite({
        broadcasterId, verb: 'POST', path: '/polls',
        body: {
            broadcaster_id: broadcasterId,
            title: title.slice(0, 60),
            choices: choices.slice(0, 5).map(t => ({ title: String(t).slice(0, 25) })),
            duration: Math.max(15, Math.min(1800, Number(duration) || 60)),
            channel_points_voting_enabled: !!cpVoting?.enabled,
            channel_points_per_vote: cpVoting?.cost || undefined,
            bits_voting_enabled: !!bitsVoting?.enabled,
            bits_per_vote: bitsVoting?.cost || undefined,
        },
        action: 'create_poll', requiredScope: 'channel:manage:polls',
        ...actor,
    });
}

export function banUser(broadcasterId, targetUserId, reason, durationSec, actor) {
    return callHelixWrite({
        broadcasterId, verb: 'POST', path: '/moderation/bans',
        params: { broadcaster_id: broadcasterId, moderator_id: broadcasterId },
        body: {
            data: {
                user_id: String(targetUserId),
                reason: (reason || '').slice(0, 500),
                ...(durationSec ? { duration: Number(durationSec) } : {}),
            },
        },
        action: durationSec ? 'timeout_user' : 'ban_user',
        requiredScope: 'moderator:manage:banned_users',
        ...actor,
    });
}

export function unbanUser(broadcasterId, targetUserId, actor) {
    return callHelixWrite({
        broadcasterId, verb: 'DELETE', path: '/moderation/bans',
        params: { broadcaster_id: broadcasterId, moderator_id: broadcasterId, user_id: String(targetUserId) },
        action: 'unban_user',
        requiredScope: 'moderator:manage:banned_users',
        ...actor,
    });
}

export function deleteChatMessage(broadcasterId, messageId, actor) {
    return callHelixWrite({
        broadcasterId, verb: 'DELETE', path: '/moderation/chat',
        params: { broadcaster_id: broadcasterId, moderator_id: broadcasterId, message_id: messageId },
        action: 'delete_chat_message', requiredScope: 'moderator:manage:chat_messages',
        ...actor,
    });
}

export function warnUser(broadcasterId, targetUserId, reason, actor) {
    return callHelixWrite({
        broadcasterId, verb: 'POST', path: '/moderation/warnings',
        params: { broadcaster_id: broadcasterId, moderator_id: broadcasterId },
        body: { data: { user_id: String(targetUserId), reason: (reason || '').slice(0, 500) } },
        action: 'warn_user', requiredScope: 'moderator:manage:warnings',
        ...actor,
    });
}

export function resolveUnbanRequest(broadcasterId, requestId, status, resolutionText, actor) {
    return callHelixWrite({
        broadcasterId, verb: 'PATCH', path: '/moderation/unban_requests',
        params: {
            broadcaster_id: broadcasterId, moderator_id: broadcasterId,
            unban_request_id: requestId, status,
        },
        body: resolutionText ? { resolution_text: resolutionText.slice(0, 500) } : null,
        action: 'resolve_unban_request', requiredScope: 'moderator:manage:unban_requests',
        ...actor,
    });
}

export function createClip(broadcasterId, hasDelay, actor) {
    return callHelixWrite({
        broadcasterId, verb: 'POST', path: '/clips',
        params: { broadcaster_id: broadcasterId, ...(hasDelay ? { has_delay: 'true' } : {}) },
        action: 'create_clip', requiredScope: 'clips:edit',
        ...actor,
    });
}

/**
 * Send a chat message as the broadcaster. Scope: user:write:chat.
 * Rate-limited naturally by Twitch (20 msgs/30s for non-mod, 100/30s for mod).
 */
export function sendChatMessage(broadcasterId, text, actor) {
    return callHelixWrite({
        broadcasterId, verb: 'POST', path: '/chat/messages',
        body: {
            broadcaster_id: broadcasterId,
            sender_id: broadcasterId,
            message: String(text || '').slice(0, 500),
        },
        action: 'send_chat_message', requiredScope: 'user:write:chat',
        ...actor,
    });
}

export function addBlockedTerm(broadcasterId, text, actor) {
    return callHelixWrite({
        broadcasterId, verb: 'POST', path: '/moderation/blocked_terms',
        params: { broadcaster_id: broadcasterId, moderator_id: broadcasterId },
        body: { text: text.slice(0, 500) },
        action: 'add_blocked_term', requiredScope: 'moderator:manage:blocked_terms',
        ...actor,
    });
}

export function removeBlockedTerm(broadcasterId, termId, actor) {
    return callHelixWrite({
        broadcasterId, verb: 'DELETE', path: '/moderation/blocked_terms',
        params: { broadcaster_id: broadcasterId, moderator_id: broadcasterId, id: termId },
        action: 'remove_blocked_term', requiredScope: 'moderator:manage:blocked_terms',
        ...actor,
    });
}


/* -------------------------------------------------------------------------- */
/* Role management: VIPs + Mods add/remove                                     */
/* The Helix endpoints for VIP and Mod add/remove take broadcaster_id +        */
/* user_id as query params and return 204 on success. No body.                 */
/* -------------------------------------------------------------------------- */

export function addVip(broadcasterId, targetUserId, actor) {
    return callHelixWrite({
        broadcasterId, verb: 'POST', path: '/channels/vips',
        params: { broadcaster_id: String(broadcasterId), user_id: String(targetUserId) },
        action: 'add_vip', requiredScope: 'channel:manage:vips',
        ...actor,
    });
}

export function removeVip(broadcasterId, targetUserId, actor) {
    return callHelixWrite({
        broadcasterId, verb: 'DELETE', path: '/channels/vips',
        params: { broadcaster_id: String(broadcasterId), user_id: String(targetUserId) },
        action: 'remove_vip', requiredScope: 'channel:manage:vips',
        ...actor,
    });
}

export function addModerator(broadcasterId, targetUserId, actor) {
    return callHelixWrite({
        broadcasterId, verb: 'POST', path: '/moderation/moderators',
        params: { broadcaster_id: String(broadcasterId), user_id: String(targetUserId) },
        action: 'add_moderator', requiredScope: 'channel:manage:moderators',
        ...actor,
    });
}

export function removeModerator(broadcasterId, targetUserId, actor) {
    return callHelixWrite({
        broadcasterId, verb: 'DELETE', path: '/moderation/moderators',
        params: { broadcaster_id: String(broadcasterId), user_id: String(targetUserId) },
        action: 'remove_moderator', requiredScope: 'channel:manage:moderators',
        ...actor,
    });
}

/**
 * Resolve a Twitch login (username) to a user id + display name.
 * Uses the broadcaster's Tier B token (any valid user token works for /users).
 * Returns { ok, user: {id, login, display_name} } or { ok:false, error }.
 */
export async function resolveTwitchLogin(broadcasterId, login) {
    const auth = await getTierBAuth(broadcasterId);
    if (!auth) return { ok: false, error: 'tier_b_not_granted' };
    try {
        const res = await axios.get(`${HELIX}/users`, {
            headers: {
                'Client-ID': process.env.TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${auth.accessToken}`,
            },
            params: { login: String(login).toLowerCase().trim() },
            timeout: 10_000,
            validateStatus: () => true,
        });
        if (res.status !== 200) return { ok: false, error: `helix /users status ${res.status}` };
        const u = res.data?.data?.[0];
        if (!u) return { ok: false, error: 'user_not_found' };
        return { ok: true, user: { id: u.id, login: u.login, display_name: u.display_name } };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}
