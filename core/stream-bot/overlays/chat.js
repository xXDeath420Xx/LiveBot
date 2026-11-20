/*
 * Stream bot overlays: chat for the Chat overlay, from what Twitch, Kick and YouTube send (pure; design §9, §13.10).
 *
 * The stream bot's normalised chat event keeps no badges or emote positions, so the Chat overlay reads the raw
 * notifications the receivers already hand to the stream bot (core/stream-bot/index.js onTwitch / onKick), before
 * normalisation. Nothing here is stored.
 *
 *   twitchChat(subType, e)  → { kind: 'message', channelId, message } | { kind: 'delete', channelId, id }
 *                             | { kind: 'clear_user', channelId, platform, userId } | { kind: 'clear', channelId } | null
 *   kickChat(eventType, e)  → the same shapes for Kick (chat.message.sent, moderation.banned)
 *   youtubeChat(item, channelId) → the same shapes for a YouTube liveChatMessage (a chat line or Super Chat, a deleted
 *                             message, a banned viewer), handed over by youtube/service.js before normalisation
 *   visibleFor(message, config) → whether a Chat overlay with these settings shows the message
 *
 * A message: { id: 'tw:<id>' | 'kk:<id>' | 'yt:<id>', platform, userId, login, name, color, badges: [{ kind: 'img', src, title } |
 * { kind: 'role', role }], parts: [{ t: 'text', v } | { t: 'emote', src, alt }], at }.
 * Image `src` values are paths under the overlay's own URL (img/…): the overlay fetches emotes and badges through
 * this server (overlays/images.js), never from Twitch or Kick directly.
 */

const TEXT_MAX = 500;
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const TW_EMOTE = /^[A-Za-z0-9_]{1,80}$/;
const KICK_EMOTE = /^\d{1,12}$/;
const COLOR = /^#[0-9a-f]{6}$/i;
const ROLE_BADGES = new Set(['broadcaster', 'moderator', 'vip', 'subscriber', 'founder', 'og', 'verified', 'staff', 'sub_gifter', 'artist']);
const KICK_TOKEN = /\[emote:(\d{1,12}):([^\]\s]{1,60})\]/g;
const YT_ID = /^[A-Za-z0-9._%-]{1,200}$/;   // liveChatMessage ids are longer than Twitch's and carry dots
const YT_CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;

const s = (v, max = 100) => (v == null ? null : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max));
const at = () => Date.now();

function twitchBadges(list) {
    const out = [];
    for (const b of Array.isArray(list) ? list.slice(0, 6) : []) {
        const set = String(b?.set_id || '');
        const ver = String(b?.id || '');
        if (!/^[a-z0-9_-]{1,40}$/.test(set) || !/^[A-Za-z0-9_-]{1,40}$/.test(ver)) continue;
        out.push({ kind: 'img', src: `img/tw-badge/${set}/${ver}`, title: set.replace(/[-_]/g, ' '), role: ROLE_BADGES.has(set) ? set : null });
    }
    return out;
}

function twitchParts(msg) {
    const frags = Array.isArray(msg?.fragments) ? msg.fragments : null;
    if (!frags) return [{ t: 'text', v: s(msg?.text ?? '', TEXT_MAX) || '' }];
    const parts = [];
    let used = 0;
    for (const fr of frags.slice(0, 200)) {
        const text = String(fr?.text ?? '');
        if (used >= TEXT_MAX) break;
        if (fr?.type === 'emote' && TW_EMOTE.test(String(fr.emote?.id || ''))) {
            parts.push({ t: 'emote', src: `img/tw-emote/${fr.emote.id}`, alt: s(text, 60) || 'emote' });
        } else {
            const v = s(text, TEXT_MAX - used);
            if (v) parts.push({ t: 'text', v });
        }
        used += text.length;
    }
    return parts.length ? parts : [{ t: 'text', v: '' }];
}

/** Twitch EventSub chat notifications → what the Chat overlay does. */
export function twitchChat(subType, e) {
    if (!e || typeof e !== 'object' || e.broadcaster_user_id == null) return null;
    const channelId = String(e.broadcaster_user_id);
    switch (subType) {
        case 'channel.chat.message': {
            if (!e.message_id || !ID.test(String(e.message_id))) return null;
            return {
                kind: 'message', channelId,
                message: {
                    id: `tw:${e.message_id}`, platform: 'twitch', userId: s(e.chatter_user_id, 64), login: s(e.chatter_user_login && String(e.chatter_user_login).toLowerCase(), 40),
                    name: s(e.chatter_user_name || e.chatter_user_login, 40) || 'viewer', color: COLOR.test(String(e.color || '')) ? String(e.color) : null,
                    badges: twitchBadges(e.badges), parts: twitchParts(e.message), action: e.message_type === 'channel_points_highlighted' ? 'highlight' : null, at: at(),
                },
            };
        }
        case 'channel.chat.message_delete':
            return e.message_id ? { kind: 'delete', channelId, id: `tw:${String(e.message_id).slice(0, 80)}` } : null;
        case 'channel.chat.clear_user_messages':
            return e.target_user_id ? { kind: 'clear_user', channelId, platform: 'twitch', userId: String(e.target_user_id).slice(0, 64) } : null;
        case 'channel.ban':
            return e.user_id ? { kind: 'clear_user', channelId, platform: 'twitch', userId: String(e.user_id).slice(0, 64) } : null;
        case 'channel.chat.clear':
            return { kind: 'clear', channelId };
        default:
            return null;
    }
}

function kickParts(e) {
    const content = String(e?.content ?? '');
    const parts = [];
    const push = (v) => { const t = s(v, TEXT_MAX); if (t) parts.push({ t: 'text', v: t }); };
    // Positions when Kick sends them ({ emote_id, positions: [{ s, e }] }), else [emote:<id>:<name>] tokens in the text.
    const positions = [];
    for (const em of Array.isArray(e?.emotes) ? e.emotes.slice(0, 50) : []) {
        const id = String(em?.emote_id ?? em?.id ?? '');
        if (!KICK_EMOTE.test(id)) continue;
        for (const p of Array.isArray(em.positions) ? em.positions.slice(0, 50) : []) {
            const a = Number(p?.s), b = Number(p?.e);
            if (Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= a && b < content.length) positions.push({ a, b, id });
        }
    }
    if (positions.length) {
        positions.sort((x, y) => x.a - y.a);
        let i = 0;
        for (const p of positions) {
            if (p.a < i) continue;
            push(content.slice(i, p.a));
            parts.push({ t: 'emote', src: `img/kick-emote/${p.id}`, alt: s(content.slice(p.a, p.b + 1), 60) || 'emote' });
            i = p.b + 1;
        }
        push(content.slice(i));
    } else {
        let i = 0;
        for (const m of content.matchAll(KICK_TOKEN)) {
            if (parts.length >= 200) break;
            push(content.slice(i, m.index));
            parts.push({ t: 'emote', src: `img/kick-emote/${m[1]}`, alt: m[2] });
            i = m.index + m[0].length;
        }
        push(content.slice(i));
    }
    return parts.length ? parts : [{ t: 'text', v: '' }];
}

/** Kick webhooks → what the Chat overlay does. Kick sends no "message deleted" webhook; bans clear the viewer. */
export function kickChat(eventType, e) {
    if (!e || typeof e !== 'object') return null;
    const bid = e.broadcaster?.user_id ?? e.broadcaster_user_id ?? null;
    if (bid == null) return null;
    const channelId = String(bid);
    if (eventType === 'chat.message.sent') {
        const id = String(e.message_id || '');
        if (!ID.test(id)) return null;
        const u = e.sender || {};
        const badges = [];
        for (const b of Array.isArray(u.identity?.badges) ? u.identity.badges.slice(0, 6) : []) {
            const role = String(b?.type || '').toLowerCase();
            if (ROLE_BADGES.has(role)) badges.push({ kind: 'role', role, title: s(b.text || role, 40) });
        }
        return {
            kind: 'message', channelId,
            message: {
                id: `kk:${id}`, platform: 'kick', userId: u.user_id == null ? null : String(u.user_id).slice(0, 64), login: s((u.channel_slug || u.username || '').toLowerCase(), 40),
                name: s(u.username, 40) || 'viewer', color: COLOR.test(String(u.identity?.username_color || '')) ? String(u.identity.username_color) : null,
                badges, parts: kickParts(e), action: null, at: at(),
            },
        };
    }
    if (eventType === 'moderation.banned') {
        const uid = e.banned_user?.user_id;
        return uid != null ? { kind: 'clear_user', channelId, platform: 'kick', userId: String(uid).slice(0, 64) } : null;
    }
    return null;
}

/**
 * A YouTube liveChatMessage (part snippet,authorDetails) → what the Chat overlay does. YouTube sends no emote positions
 * (custom emoji arrive as :name: text) and no colours; owners, moderators, members and verified channels get role badges.
 */
export function youtubeChat(item, channelId) {
    if (!item || typeof item !== 'object' || !item.snippet || channelId == null) return null;
    const ch = String(channelId);
    const sn = item.snippet;
    if (sn.type === 'messageDeletedEvent') {
        const id = String(sn.messageDeletedDetails?.deletedMessageId || '');
        return YT_ID.test(id) ? { kind: 'delete', channelId: ch, id: `yt:${id}` } : null;
    }
    if (sn.type === 'userBannedEvent') {
        const uid = String(sn.userBannedDetails?.bannedUserDetails?.channelId || '');
        return YT_CHANNEL.test(uid) ? { kind: 'clear_user', channelId: ch, platform: 'youtube', userId: uid } : null;
    }
    if (sn.type !== 'textMessageEvent' && sn.type !== 'superChatEvent') return null;
    const id = String(item.id || '');
    const a = item.authorDetails || {};
    if (!YT_ID.test(id) || !YT_CHANNEL.test(String(a.channelId || ''))) return null;
    const display = String(a.displayName || '').trim().replace(/^@/, '');
    const badges = [];
    if (a.isChatOwner) badges.push({ kind: 'role', role: 'broadcaster', title: 'Owner' });
    if (a.isChatModerator) badges.push({ kind: 'role', role: 'moderator', title: 'Moderator' });
    if (a.isChatSponsor) badges.push({ kind: 'role', role: 'subscriber', title: 'Member' });
    if (a.isVerified) badges.push({ kind: 'role', role: 'verified', title: 'Verified' });
    let text;
    if (sn.type === 'superChatEvent') {
        const d = sn.superChatDetails || {};
        text = [d.amountDisplayString, d.userComment].filter((v) => v != null && String(v).trim()).join(' ');
    } else {
        text = sn.textMessageDetails?.messageText ?? sn.displayMessage ?? '';
    }
    return {
        kind: 'message', channelId: ch,
        message: {
            id: `yt:${id}`, platform: 'youtube', userId: String(a.channelId), login: s(display.toLowerCase(), 40), name: s(display, 40) || 'viewer',
            color: null, badges, parts: [{ t: 'text', v: s(text, TEXT_MAX) || '' }], action: sn.type === 'superChatEvent' ? 'highlight' : null, at: at(),
        },
    };
}

/** Whether a Chat overlay shows a message (platforms ticked, commands and named users hidden). */
export function visibleFor(message, config = {}) {
    if (!message) return false;
    if (Array.isArray(config.platforms) && !config.platforms.includes(message.platform)) return false;
    const first = message.parts[0];
    if (config.hideCommands && first?.t === 'text' && /^\s*!/.test(first.v)) return false;
    const hidden = String(config.hideUsers || '').split(/[\s,]+/).filter(Boolean);
    if (message.login && hidden.includes(message.login)) return false;
    return true;
}

export default { twitchChat, kickChat, youtubeChat, visibleFor };
