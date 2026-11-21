/*
 * Stream bot control: the documented Twitch Helix and Kick public API calls the wave 2 actions use. No private GQL.
 *
 *   createTwitchControl({ helix })   every call goes through helix.call (the Stream bot grant, refreshed before use; the
 *                                    broadcaster acts on their own channel, so moderator_id is the grant's own user)
 *   createKickControl({ resolveChannel?, fetchImpl? })   the Kick channel bot sign-in (Kick Defender), as kick-api.js
 *   friendlyError(err)               { status, detail }: a missing scope says "Reconnect Twitch to enable"
 *
 * Scopes (core/stream-bot/scopes.js, added 2026-11-20 for wave 2 group A):
 *   unban, timeout, ban              moderator:manage:banned_users (already granted)
 *   chat modes                       moderator:manage:chat_settings
 *   VIP add / remove                 channel:manage:vips
 *   moderator add / remove           channel:manage:moderators
 *   shield mode                      moderator:manage:shield_mode
 *   warn                             moderator:manage:warnings
 *   rewards, redemptions             channel:manage:redemptions (already granted; only rewards CertiFried's client created)
 *   stream marker                    channel:manage:broadcast (already granted)
 *   ad schedule (read)               channel:read:ads (already granted); snooze: channel:manage:ads
 *   cancel raid                      channel:manage:raids (already granted)
 *   user info, follow age            no scope for /users; moderator:read:followers (already granted) for /channels/followers
 * Kick: moderation:ban (unban), chat:write (reply), channel:rewards:write (rewards and redemptions, added to the channel bot
 * sign-in 2026-11-20).
 *
 * Tested in tests/stream-bot-control.test.js against fake fetches.
 */
import { kickBotProblem, kickBotRejectedMessage, KICK_BOT_SIGNIN_PATH } from '../kick-scopes.js';

export const TWITCH_SCOPE = Object.freeze({
    ban: 'moderator:manage:banned_users', chatSettings: 'moderator:manage:chat_settings', vips: 'channel:manage:vips',
    mods: 'channel:manage:moderators', shield: 'moderator:manage:shield_mode', warn: 'moderator:manage:warnings',
    rewards: 'channel:manage:redemptions', broadcast: 'channel:manage:broadcast', adsRead: 'channel:read:ads', adsManage: 'channel:manage:ads',
    raids: 'channel:manage:raids', followers: 'moderator:read:followers',
});
export const KICK_REWARDS_SCOPE = 'channel:rewards:write';

const short = (s, n = 200) => String(s ?? '').slice(0, n);

/** Run-history wording for an error from a call. A missing Twitch scope is "skipped" with the reconnect hint. */
export function friendlyError(err) {
    if (err?.code === 'missing_scope') {
        return { status: 'skipped', detail: `Reconnect Twitch to enable this (Connections, Re-approve). Missing: ${(err.missing || []).join(', ') || 'a permission'}` };
    }
    if (err?.code === 'no_grant') return { status: 'skipped', detail: 'Connect Twitch on the Connections page to enable this' };
    if (err?.scope && err?.href) return { status: 'skipped', detail: short(err.message, 300) };   // Kick: already says how to sign in again
    return { status: 'failed', detail: short(err?.message || 'failed', 300) };
}

export function createTwitchControl({ helix }) {
    const call = (pid, method, path, o) => helix.call(pid, method, path, o);
    const mod = (me) => ({ broadcaster_id: me.userId, moderator_id: me.userId });

    return {
        userByLogin: (pid, login) => helix.userByLogin(pid, login),
        ban: (pid, o) => helix.banUser(pid, o),
        async unban(pid, userId) {
            await call(pid, 'DELETE', '/moderation/bans', { query: (me) => ({ ...mod(me), user_id: String(userId) }), need: [TWITCH_SCOPE.ban] });
        },
        /** settings: Helix chat settings fields (emote_mode, follower_mode, follower_mode_duration, slow_mode, …). */
        async chatSettings(pid, settings) {
            await call(pid, 'PATCH', '/chat/settings', { query: mod, body: settings, need: [TWITCH_SCOPE.chatSettings] });
        },
        async vip(pid, userId, add) {
            await call(pid, add ? 'POST' : 'DELETE', '/channels/vips', { query: (me) => ({ broadcaster_id: me.userId, user_id: String(userId) }), need: [TWITCH_SCOPE.vips] });
        },
        async moderator(pid, userId, add) {
            await call(pid, add ? 'POST' : 'DELETE', '/moderation/moderators', { query: (me) => ({ broadcaster_id: me.userId, user_id: String(userId) }), need: [TWITCH_SCOPE.mods] });
        },
        async shield(pid, active) {
            await call(pid, 'PUT', '/moderation/shield_mode', { query: mod, body: { is_active: !!active }, need: [TWITCH_SCOPE.shield] });
        },
        async warn(pid, userId, reason) {
            await call(pid, 'POST', '/moderation/warnings', { query: mod, body: { data: { user_id: String(userId), reason: short(reason, 500) } }, need: [TWITCH_SCOPE.warn] });
        },
        /** Rewards CertiFried's client can change (Twitch only lets the app that created a reward edit it). */
        async manageableRewards(pid) {
            const { data } = await call(pid, 'GET', '/channel_points/custom_rewards', { query: (me) => ({ broadcaster_id: me.userId, only_manageable_rewards: 'true' }), need: [TWITCH_SCOPE.rewards] });
            return (data?.data || []).map((r) => ({ id: String(r.id), title: String(r.title || '') }));
        },
        async updateReward(pid, rewardId, body) {
            const { data } = await call(pid, 'PATCH', '/channel_points/custom_rewards', { query: (me) => ({ broadcaster_id: me.userId, id: rewardId }), body, need: [TWITCH_SCOPE.rewards] });
            return data?.data?.[0] || null;
        },
        updateRedemption: (pid, o) => helix.updateRedemption(pid, o),
        async marker(pid, description) {
            const { data } = await call(pid, 'POST', '/streams/markers', { body: (me) => ({ user_id: me.userId, ...(description ? { description: short(description, 140) } : {}) }), need: [TWITCH_SCOPE.broadcast] });
            const m = data?.data?.[0] || {};
            return { id: m.id ? String(m.id) : '', seconds: Number(m.position_seconds) || 0 };
        },
        async adSchedule(pid) {
            const { data } = await call(pid, 'GET', '/channels/ads', { query: (me) => ({ broadcaster_id: me.userId }), need: [TWITCH_SCOPE.adsRead] });
            const a = data?.data?.[0] || {};
            const at = (v) => (v == null || v === '' || Number(v) === 0 ? null : (typeof v === 'number' || /^\d+$/.test(String(v)) ? Number(v) * 1000 : Date.parse(v)));
            return { nextAdAt: at(a.next_ad_at), length: Number(a.duration) || 0, snoozes: Number(a.snooze_count) || 0, snoozeRefreshAt: at(a.snooze_refresh_at) };
        },
        async snoozeAd(pid) {
            const { data } = await call(pid, 'POST', '/channels/ads/schedule/snooze', { query: (me) => ({ broadcaster_id: me.userId }), need: [TWITCH_SCOPE.adsManage] });
            const a = data?.data?.[0] || {};
            return { snoozes: Number(a.snooze_count) || 0 };
        },
        async cancelRaid(pid) {
            await call(pid, 'DELETE', '/raids', { query: (me) => ({ broadcaster_id: me.userId }), need: [TWITCH_SCOPE.raids] });
        },
        async userInfo(pid, userId) {
            const { data } = await call(pid, 'GET', '/users', { query: { id: String(userId) } });
            const u = data?.data?.[0];
            return u ? { id: String(u.id), login: u.login, name: u.display_name || u.login, createdAt: u.created_at || null } : null;
        },
        /** When the viewer followed the grant's channel, or null when they do not follow. */
        async followedAt(pid, userId) {
            const { data } = await call(pid, 'GET', '/channels/followers', { query: (me) => ({ broadcaster_id: me.userId, user_id: String(userId) }), need: [TWITCH_SCOPE.followers] });
            return data?.data?.[0]?.followed_at || null;
        },
    };
}

const KICK_BASE = 'https://api.kick.com/public/v1';

export class KickControlError extends Error {
    constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

export function createKickControl({ resolveChannel = null, fetchImpl = (...a) => fetch(...a) } = {}) {
    async function channel(channelId, scope) {
        const resolve = resolveChannel || (await import('../../../services/certifried-bot/defender/channel-tokens.js')).resolveChannel;
        const ch = await resolve(String(channelId));
        const problem = kickBotProblem(ch, scope);
        if (problem) throw new KickControlError(403, problem.message, { href: problem.href, scope: problem.scope || scope });
        return ch;
    }
    async function send(channelId, scope, method, path, { query = null, body = null } = {}) {
        const ch = await channel(channelId, scope);
        const qs = query ? `?${new URLSearchParams(query)}` : '';
        const res = await fetchImpl(`${KICK_BASE}${path}${qs}`, {
            method, headers: { Authorization: `Bearer ${ch.token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        let data = null;
        if (res.status !== 204) { try { data = await res.json(); } catch { data = null; } }
        if (res.status === 401) throw new KickControlError(401, kickBotRejectedMessage(), { href: KICK_BOT_SIGNIN_PATH, scope });
        if (!res.ok) throw new KickControlError(res.status, data?.message ? short(data.message) : `Kick answered HTTP ${res.status}`);
        return data;
    }
    return {
        async unban(channelId, userId) {
            await send(channelId, 'moderation:ban', 'DELETE', '/moderation/bans', { body: { broadcaster_user_id: Number(channelId), user_id: Number(userId) } });
        },
        /** A Kick user id from a channel slug (every Kick user has a channel). */
        async userIdBySlug(channelId, slug) {
            const s = String(slug || '').replace(/^@/, '').trim().toLowerCase();
            if (!/^[a-z0-9_-]{1,40}$/.test(s)) throw new KickControlError(400, `"${short(slug, 40)}" is not a Kick user name`);
            const data = await send(channelId, 'channel:read', 'GET', '/channels', { query: { slug: s } });
            const c = Array.isArray(data?.data) ? data.data[0] : null;
            if (!c?.broadcaster_user_id) throw new KickControlError(404, `There is no Kick user called ${s}`);
            return { id: String(c.broadcaster_user_id), login: s, name: s };
        },
        async reply(channelId, text, replyTo) {
            await send(channelId, 'chat:write', 'POST', '/chat', { body: { broadcaster_user_id: Number(channelId), content: short(text, 500), type: 'bot', reply_to_message_id: String(replyTo) } });
        },
        async rewards(channelId) {
            const data = await send(channelId, KICK_REWARDS_SCOPE, 'GET', '/channels/rewards');
            return (Array.isArray(data?.data) ? data.data : []).map((r) => ({ id: String(r.id), title: String(r.title || '') }));
        },
        async updateReward(channelId, id, body) {
            await send(channelId, KICK_REWARDS_SCOPE, 'PATCH', `/channels/rewards/${encodeURIComponent(id)}`, { body });
        },
        async redemption(channelId, id, accept) {
            const data = await send(channelId, KICK_REWARDS_SCOPE, 'POST', `/channels/rewards/redemptions/${accept ? 'accept' : 'reject'}`, { body: { ids: [String(id)] } });
            const failed = Array.isArray(data?.data) ? data.data : [];
            if (failed.length) throw new KickControlError(409, `Kick could not ${accept ? 'accept' : 'reject'} it${failed[0]?.reason ? `: ${short(failed[0].reason, 100)}` : ''}`);
        },
    };
}

export default { createTwitchControl, createKickControl, friendlyError, TWITCH_SCOPE, KICK_REWARDS_SCOPE };
