/*
 * Stream bot: the public Kick API (https://api.kick.com/public/v1) for the stream actions that Kick has.
 *
 *   createKickApi({ resolveChannel?, appToken?, fetchImpl? })
 *     setTitle(channelId, title)            PATCH  /channels { stream_title }    scope channel:write
 *     setCategory(channelId, name)          GET    /categories?q=  then PATCH /channels { category_id }   channel:write
 *     deleteMessage(channelId, messageId)   DELETE /chat/{message_id}             moderation:chat_message:manage
 *     streamInfo(channelId)                 GET    /channels?broadcaster_user_id= (app token)
 *
 * The channel's token is the Kick sign-in that Kick Defender uses (services/certifried-bot/defender/channel-tokens.js
 * resolveChannel, refreshed there), the same path the chat action and the Kick timers use. When it is missing, lacks a
 * scope, or Kick rejects it, the error says so in the Connections page's words with the sign-in link (kick-scopes.js;
 * err.href is the same-origin path). Kick has no public
 * endpoint for clearing chat, clips, polls, predictions, raids, ads, announcements or shoutouts: those actions
 * are Twitch only.
 *
 * Tested in tests/stream-bot-gaps.test.js against a fake fetch.
 */

import { kickBotProblem, kickBotRejectedMessage, KICK_BOT_SIGNIN_PATH } from './kick-scopes.js';

const BASE = 'https://api.kick.com/public/v1';

export class KickError extends Error {
    constructor(status, message, code = 'kick', extra = {}) { super(message); this.status = status; this.code = code; Object.assign(this, extra); }
}

export const KICK_WRITE_SCOPE = 'channel:write';
export const KICK_CHAT_SCOPE = 'moderation:chat_message:manage';

async function bodyOf(res) {
    try { return await res.json(); } catch { return null; }
}
const kickMessage = (b, status) => (b && typeof b === 'object' && (b.message || b.error) ? String(b.message || b.error).slice(0, 200) : `Kick answered HTTP ${status}`);

export function createKickApi({
    resolveChannel = null, appToken = null, fetchImpl = (...a) => fetch(...a),
} = {}) {
    async function channel(channelId, scope) {
        const resolve = resolveChannel || (await import('../../services/certifried-bot/defender/channel-tokens.js')).resolveChannel;
        const ch = await resolve(String(channelId));
        const problem = kickBotProblem(ch, scope);
        if (problem) throw new KickError(403, problem.message, problem.code, { href: problem.href, scope: problem.scope || null });
        return ch;
    }
    async function send(token, method, path, { query = null, body = null, asUser = false } = {}) {
        const qs = query ? `?${new URLSearchParams(query)}` : '';
        const res = await fetchImpl(`${BASE}${path}${qs}`, {
            method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        const data = res.status === 204 ? null : await bodyOf(res);
        if (res.status === 401 && asUser) throw new KickError(401, kickBotRejectedMessage(), 'rejected', { href: KICK_BOT_SIGNIN_PATH });
        if (!res.ok) throw new KickError(res.status, kickMessage(data, res.status));
        return data;
    }

    async function findCategory(token, name) {
        const n = String(name || '').trim().slice(0, 100);
        if (!n) throw new KickError(400, 'No category name', 'bad_category');
        const data = await send(token, 'GET', '/categories', { query: { q: n }, asUser: true });
        const list = Array.isArray(data?.data) ? data.data : [];
        const hit = list.find((c) => String(c.name).toLowerCase() === n.toLowerCase()) || list[0];
        if (!hit) throw new KickError(404, `Kick has no category matching "${n}"`, 'no_category');
        return { id: Number(hit.id), name: hit.name };
    }

    return {
        async setTitle(channelId, title) {
            const t = String(title || '').trim().slice(0, 140);
            if (!t) throw new KickError(400, 'The title is empty', 'empty');
            const ch = await channel(channelId, KICK_WRITE_SCOPE);
            await send(ch.token, 'PATCH', '/channels', { body: { stream_title: t }, asUser: true });
            return { title: t };
        },
        async setCategory(channelId, name) {
            const ch = await channel(channelId, KICK_WRITE_SCOPE);
            const cat = await findCategory(ch.token, name);
            await send(ch.token, 'PATCH', '/channels', { body: { category_id: cat.id }, asUser: true });
            return cat;
        },
        async deleteMessage(channelId, messageId) {
            if (!/^[A-Za-z0-9-]{1,64}$/.test(String(messageId || ''))) throw new KickError(400, 'No message to delete', 'no_message');
            const ch = await channel(channelId, KICK_CHAT_SCOPE);
            await send(ch.token, 'DELETE', `/chat/${encodeURIComponent(messageId)}`, { asUser: true });
            return { deleted: true };
        },
        async streamInfo(channelId) {
            let token = appToken ? await appToken() : null;
            if (!token) {
                const { getAccessToken } = await import('../../utils/platforms/kick.js');
                token = await getAccessToken();
            }
            if (!token) throw new KickError(503, 'Kick did not give CertiFried an app token', 'no_app_token');
            const data = await send(token, 'GET', '/channels', { query: { broadcaster_user_id: String(channelId) } });
            const c = Array.isArray(data?.data) ? data.data[0] : null;
            if (!c) throw new KickError(404, 'Kick did not find that channel', 'no_channel');
            const live = !!c.stream?.is_live;
            return {
                live, title: c.stream_title || '', category: c.category?.name || '',
                viewers: live ? Number(c.stream?.viewer_count) || 0 : 0, startedAt: live ? c.stream?.start_time || null : null,
            };
        },
    };
}

export default { createKickApi, KickError, KICK_WRITE_SCOPE, KICK_CHAT_SCOPE };
