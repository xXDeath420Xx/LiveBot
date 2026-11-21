/*
 * Stream bot: the documented Twitch Helix calls the stream actions use, made with the Stream bot grant's token
 * (twitch-auth.js refreshes it before use). No private GQL; every endpoint below is in the Helix reference.
 *
 *   createHelix({ auth, fetchImpl?, clientId?, logger? })
 *     createClip(profileId)                                   POST   /clips                      clips:edit
 *     setTitle(profileId, title)                              PATCH  /channels                   channel:manage:broadcast
 *     findCategory(profileId, name)                           GET    /games?name, /search/categories
 *     setCategory(profileId, name)                            PATCH  /channels (game_id)         channel:manage:broadcast
 *     startAd(profileId, length)                              POST   /channels/commercial        channel:edit:commercial
 *     startRaid(profileId, login)                             POST   /raids                      channel:manage:raids
 *     createPoll / endPoll(profileId, …)                      POST / PATCH /polls                channel:manage:polls
 *     createPrediction / endPrediction(profileId, …)          POST / PATCH /predictions          channel:manage:predictions
 *     announce(profileId, { message, color })                 POST   /chat/announcements         moderator:manage:announcements
 *     shoutout(profileId, login)                              POST   /chat/shoutouts             moderator:manage:shoutouts
 *     deleteChat(profileId, messageId?)                       DELETE /moderation/chat            moderator:manage:chat_messages
 *     sayAsBroadcaster(profileId, message)                    POST   /chat/messages              user:write:chat (sender = the streamer)
 *     banUser(profileId, { userId, seconds?, reason? })       POST   /moderation/bans            moderator:manage:banned_users (no seconds = permanent)
 *     searchCategories(profileId, query)                      GET    /search/categories          (no scope)
 *     listRedemptions(profileId, rewardId)                    GET    /channel_points/custom_rewards/redemptions   channel:manage:redemptions (read or manage)
 *     updateRedemption(profileId, { rewardId, redemptionId, status })   PATCH /channel_points/custom_rewards/redemptions   channel:manage:redemptions
 *     streamInfo(profileId)                                   GET    /streams, /channels         (no scope)
 *
 * The broadcaster (and, for the moderator endpoints, the moderator) is always the grant's own Twitch user: the
 * streamer acts on their own channel. A 401 refreshes the token once and retries. Errors are HelixError with
 * Twitch's message (never the token).
 *
 * Tested in tests/stream-bot-gaps.test.js against a fake fetch.
 */

const BASE = 'https://api.twitch.tv/helix';

export class HelixError extends Error {
    constructor(status, message, code = 'helix') { super(message); this.status = status; this.code = code; }
}

export const SCOPE_FOR = Object.freeze({
    clip: 'clips:edit', broadcast: 'channel:manage:broadcast', ad: 'channel:edit:commercial', raid: 'channel:manage:raids',
    poll: 'channel:manage:polls', prediction: 'channel:manage:predictions', announce: 'moderator:manage:announcements',
    shoutout: 'moderator:manage:shoutouts', chat: 'moderator:manage:chat_messages', say: 'user:write:chat',
    ban: 'moderator:manage:banned_users', redemptions: 'channel:manage:redemptions',
});

export const ANNOUNCE_COLORS = Object.freeze(['primary', 'blue', 'green', 'orange', 'purple']);
const LOGIN = /^[a-z0-9_]{1,25}$/;

/** Twitch's explanation from an error body, cut short. */
function twitchMessage(body, status) {
    const m = body && typeof body === 'object' ? (body.message || body.error) : null;
    return m ? String(m).slice(0, 200) : `Twitch answered HTTP ${status}`;
}

export function createHelix({ auth, fetchImpl = (...a) => fetch(...a), clientId = process.env.TWITCH_CLIENT_ID, logger = null } = {}) {
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[StreamBotHelix] ${msg}`, meta); } catch { /* ignore */ } };

    async function call(profileId, method, path, { query = null, body = null, need = [] } = {}) {
        let t = await auth.token(profileId, { need });
        const url = (who) => {
            const qs = new URLSearchParams();
            for (const [k, v] of Object.entries(typeof query === 'function' ? query(who) : (query || {}))) if (v != null && v !== '') qs.set(k, String(v));
            const s = qs.toString();
            return `${BASE}${path}${s ? `?${s}` : ''}`;
        };
        const send = (tok) => fetchImpl(url(tok), {
            method,
            headers: { 'Client-Id': clientId || '', Authorization: `Bearer ${tok.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(typeof body === 'function' ? body(tok) : body) : undefined,
        });
        let res = await send(t);
        if (res.status === 401) {
            t = await auth.token(profileId, { need, force: true });
            res = await send(t);
        }
        let data = null;
        if (res.status !== 204) { try { data = await res.json(); } catch { data = null; } }
        if (!res.ok) {
            log('debug', 'helix call refused', { path, status: res.status });
            throw new HelixError(res.status, twitchMessage(data, res.status));
        }
        return { data, me: t };
    }

    async function userByLogin(profileId, login) {
        const l = String(login || '').replace(/^@/, '').trim().toLowerCase();
        if (!LOGIN.test(l)) throw new HelixError(400, `"${String(login).slice(0, 40)}" is not a Twitch user name`, 'bad_login');
        const { data } = await call(profileId, 'GET', '/users', { query: { login: l } });
        const u = data?.data?.[0];
        if (!u) throw new HelixError(404, `There is no Twitch user called ${l}`, 'no_user');
        return { id: String(u.id), login: u.login, name: u.display_name || u.login };
    }

    async function findCategory(profileId, name) {
        const n = String(name || '').trim().slice(0, 100);
        if (!n) throw new HelixError(400, 'No category name', 'bad_category');
        const exact = await call(profileId, 'GET', '/games', { query: { name: n } });
        const hit = exact.data?.data?.[0];
        if (hit) return { id: String(hit.id), name: hit.name };
        const search = await call(profileId, 'GET', '/search/categories', { query: { query: n, first: 10 } });
        const list = search.data?.data || [];
        const same = list.find((c) => String(c.name).toLowerCase() === n.toLowerCase()) || list[0];
        if (!same) throw new HelixError(404, `Twitch has no category matching "${n}"`, 'no_category');
        return { id: String(same.id), name: same.name };
    }

    const latest = async (profileId, kind) => {
        const { data } = await call(profileId, 'GET', `/${kind}`, { query: (me) => ({ broadcaster_id: me.userId, first: 1 }), need: [SCOPE_FOR[kind === 'polls' ? 'poll' : 'prediction']] });
        return data?.data?.[0] || null;
    };

    return {
        call,
        userByLogin,
        findCategory,

        async createClip(profileId) {
            const { data } = await call(profileId, 'POST', '/clips', { query: (me) => ({ broadcaster_id: me.userId }), need: [SCOPE_FOR.clip] });
            const c = data?.data?.[0];
            if (!c?.id) throw new HelixError(502, 'Twitch did not return a clip');
            return { id: String(c.id), url: `https://clips.twitch.tv/${encodeURIComponent(c.id)}`, editUrl: c.edit_url || null };
        },

        async setTitle(profileId, title) {
            const t = String(title || '').trim().slice(0, 140);
            if (!t) throw new HelixError(400, 'The title is empty', 'empty');
            await call(profileId, 'PATCH', '/channels', { query: (me) => ({ broadcaster_id: me.userId }), body: { title: t }, need: [SCOPE_FOR.broadcast] });
            return { title: t };
        },

        async setCategory(profileId, name) {
            const cat = await findCategory(profileId, name);
            await call(profileId, 'PATCH', '/channels', { query: (me) => ({ broadcaster_id: me.userId }), body: { game_id: cat.id }, need: [SCOPE_FOR.broadcast] });
            return cat;
        },

        async startAd(profileId, length) {
            const len = [30, 60, 90, 120, 150, 180].includes(Number(length)) ? Number(length) : 30;
            const { data } = await call(profileId, 'POST', '/channels/commercial', { body: (me) => ({ broadcaster_id: me.userId, length: len }), need: [SCOPE_FOR.ad] });
            const r = data?.data?.[0] || {};
            return { length: Number(r.length) || len, retryAfter: Number(r.retry_after) || null, message: r.message ? String(r.message).slice(0, 200) : '' };
        },

        async startRaid(profileId, login) {
            const target = await userByLogin(profileId, login);
            await call(profileId, 'POST', '/raids', { query: (me) => ({ from_broadcaster_id: me.userId, to_broadcaster_id: target.id }), need: [SCOPE_FOR.raid] });
            return target;
        },

        async createPoll(profileId, { title, choices, duration }) {
            const { data } = await call(profileId, 'POST', '/polls', {
                body: (me) => ({ broadcaster_id: me.userId, title: String(title).slice(0, 60), choices: choices.slice(0, 5).map((c) => ({ title: String(c).slice(0, 25) })), duration: Number(duration) }),
                need: [SCOPE_FOR.poll],
            });
            const p = data?.data?.[0];
            return { id: p?.id ? String(p.id) : null, title: p?.title || title };
        },

        async endPoll(profileId, { show = true } = {}) {
            const p = await latest(profileId, 'polls');
            if (!p || p.status !== 'ACTIVE') throw new HelixError(409, 'There is no poll running', 'none');
            await call(profileId, 'PATCH', '/polls', { body: (me) => ({ broadcaster_id: me.userId, id: p.id, status: show ? 'TERMINATED' : 'ARCHIVED' }), need: [SCOPE_FOR.poll] });
            return { id: String(p.id), title: p.title };
        },

        async createPrediction(profileId, { title, outcomes, window }) {
            const { data } = await call(profileId, 'POST', '/predictions', {
                body: (me) => ({ broadcaster_id: me.userId, title: String(title).slice(0, 45), outcomes: outcomes.slice(0, 10).map((o) => ({ title: String(o).slice(0, 25) })), prediction_window: Number(window) }),
                need: [SCOPE_FOR.prediction],
            });
            const p = data?.data?.[0];
            return { id: p?.id ? String(p.id) : null, title: p?.title || title };
        },

        /** action: lock | resolve | cancel; winner: an outcome title (resolve only, case-insensitive). */
        async endPrediction(profileId, { action, winner = '' }) {
            const p = await latest(profileId, 'predictions');
            if (!p || !['ACTIVE', 'LOCKED'].includes(p.status)) throw new HelixError(409, 'There is no prediction running', 'none');
            const body = { id: p.id };
            if (action === 'lock') {
                if (p.status === 'LOCKED') return { id: String(p.id), title: p.title, already: true };
                body.status = 'LOCKED';
            } else if (action === 'cancel') body.status = 'CANCELED';
            else {
                const w = String(winner || '').trim().toLowerCase();
                const o = (p.outcomes || []).find((x) => String(x.title).toLowerCase() === w);
                if (!o) throw new HelixError(400, `No outcome called "${String(winner).slice(0, 40)}" (outcomes: ${(p.outcomes || []).map((x) => x.title).join(', ')})`, 'no_outcome');
                body.status = 'RESOLVED';
                body.winning_outcome_id = o.id;
            }
            await call(profileId, 'PATCH', '/predictions', { body: (me) => ({ broadcaster_id: me.userId, ...body }), need: [SCOPE_FOR.prediction] });
            return { id: String(p.id), title: p.title };
        },

        async announce(profileId, { message, color = 'primary' }) {
            const m = String(message || '').trim().slice(0, 500);
            if (!m) throw new HelixError(400, 'The announcement is empty', 'empty');
            await call(profileId, 'POST', '/chat/announcements', {
                query: (me) => ({ broadcaster_id: me.userId, moderator_id: me.userId }),
                body: { message: m, color: ANNOUNCE_COLORS.includes(color) ? color : 'primary' },
                need: [SCOPE_FOR.announce],
            });
            return { message: m };
        },

        async shoutout(profileId, login) {
            const target = await userByLogin(profileId, login);
            await call(profileId, 'POST', '/chat/shoutouts', {
                query: (me) => ({ from_broadcaster_id: me.userId, to_broadcaster_id: target.id, moderator_id: me.userId }),
                need: [SCOPE_FOR.shoutout],
            });
            return target;
        },

        /** Without a message id: clear the whole chat. */
        async deleteChat(profileId, messageId = null) {
            await call(profileId, 'DELETE', '/moderation/chat', {
                query: (me) => ({ broadcaster_id: me.userId, moderator_id: me.userId, ...(messageId ? { message_id: messageId } : {}) }),
                need: [SCOPE_FOR.chat],
            });
            return { cleared: !messageId };
        },

        /** A chat line sent from the streamer's own account (the grant's user), in their own channel. */
        async sayAsBroadcaster(profileId, message) {
            const m = String(message || '').trim().slice(0, 500);
            if (!m) throw new HelixError(400, 'The message is empty', 'empty');
            const { data } = await call(profileId, 'POST', '/chat/messages', {
                body: (me) => ({ broadcaster_id: me.userId, sender_id: me.userId, message: m }),
                need: [SCOPE_FOR.say],
            });
            const r = data?.data?.[0] || {};
            if (r.is_sent === false) throw new HelixError(422, `Twitch did not send it${r.drop_reason?.message ? `: ${String(r.drop_reason.message).slice(0, 150)}` : ''}`, 'dropped');
            return { message: m, id: r.message_id ? String(r.message_id) : null };
        },

        /** Time out (seconds 1 to 1209600) or, without seconds, ban a user in the grant user's own channel. */
        async banUser(profileId, { userId, seconds = null, reason = '' }) {
            const uid = String(userId || '');
            if (!/^\d{1,20}$/.test(uid)) throw new HelixError(400, 'That is not a Twitch user id', 'bad_user');
            const data = { user_id: uid };
            if (seconds != null) {
                const s = Math.floor(Number(seconds));
                if (!Number.isFinite(s) || s < 1 || s > 1_209_600) throw new HelixError(400, 'A timeout is 1 second to 14 days', 'bad_duration');
                data.duration = s;
            }
            const r = String(reason || '').trim().slice(0, 500);
            if (r) data.reason = r;
            await call(profileId, 'POST', '/moderation/bans', {
                query: (me) => ({ broadcaster_id: me.userId, moderator_id: me.userId }),
                body: { data },
                need: [SCOPE_FOR.ban],
            });
            return { userId: uid, seconds: data.duration ?? null };
        },

        /** Up to 8 matching categories for the title and category editor's autocomplete. */
        async searchCategories(profileId, query) {
            const q = String(query || '').trim().slice(0, 100);
            if (q.length < 2) return [];
            const { data } = await call(profileId, 'GET', '/search/categories', { query: { query: q, first: 8 } });
            return (data?.data || []).slice(0, 8).map((c) => ({ id: String(c.id), name: String(c.name) }));
        },

        /** Unfulfilled redemptions of one reward. Twitch answers 403 for a reward that CertiFried's client did not create. */
        async listRedemptions(profileId, rewardId, { status = 'UNFULFILLED' } = {}) {
            const { data } = await call(profileId, 'GET', '/channel_points/custom_rewards/redemptions', {
                query: (me) => ({ broadcaster_id: me.userId, reward_id: rewardId, status, first: 50 }),
                need: [SCOPE_FOR.redemptions],
            });
            return (data?.data || []).map((x) => ({ id: String(x.id), status: String(x.status || '') }));
        },

        /** status: FULFILLED (done) or CANCELED (refunds the points). Only rewards created by CertiFried's client can be changed. */
        async updateRedemption(profileId, { rewardId, redemptionId, status }) {
            if (!['FULFILLED', 'CANCELED'].includes(status)) throw new HelixError(400, 'Choose done or refund', 'bad_status');
            await call(profileId, 'PATCH', '/channel_points/custom_rewards/redemptions', {
                query: (me) => ({ id: redemptionId, broadcaster_id: me.userId, reward_id: rewardId }),
                body: { status },
                need: [SCOPE_FOR.redemptions],
            });
            return { redemptionId: String(redemptionId), status };
        },

        async streamInfo(profileId) {
            const s = await call(profileId, 'GET', '/streams', { query: (me) => ({ user_id: me.userId, first: 1 }) });
            const live = s.data?.data?.[0];
            if (live) {
                return { live: true, title: live.title || '', category: live.game_name || '', viewers: Number(live.viewer_count) || 0, startedAt: live.started_at || null };
            }
            const c = await call(profileId, 'GET', '/channels', { query: (me) => ({ broadcaster_id: me.userId }) });
            const ch = c.data?.data?.[0] || {};
            return { live: false, title: ch.title || '', category: ch.game_name || '', viewers: 0, startedAt: null };
        },
    };
}

export default { createHelix, HelixError, SCOPE_FOR, ANNOUNCE_COLORS };
