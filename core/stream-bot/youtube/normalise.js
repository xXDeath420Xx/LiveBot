/*
 * Stream bot, YouTube: liveChatMessage resources and broadcasts → the stream bot's one event shape (design §2.2, §13.4). Pure.
 *
 *   YouTube (snippet.type)            stream bot event                          notes
 *   textMessageEvent                  chat                                      metadata.firstWords: the viewer's first line this broadcast
 *   superChatEvent                    tip (metadata.kind 'super_chat')          amount = amountMicros / 1e6, currency ISO; tracked, never processed
 *   superStickerEvent                 tip (kind 'super_sticker')                as above; metadata.sticker = the sticker's alt text
 *   giftEvent (Jewels)                tip (kind 'jewels', currency 'jewels')    the jewels amount, like Bits
 *   newSponsorEvent                   membership (kind 'new')                   metadata.tier = the level name, isUpgrade
 *   memberMilestoneChatEvent          membership (kind 'milestone')             amount = months (currency 'months'), message = their comment
 *   membershipGiftingEvent            gift_sub                                  amount = how many, currency 'subs'
 *   giftMembershipReceivedEvent       membership (kind 'gift', isGift)          the gifter's channel id in metadata
 *   broadcast went live / ended       stream.online / stream.offline            from liveBroadcasts (service.js)
 *   tombstone, userBannedEvent, chatEndedEvent, sponsorOnlyMode*, pollDetails: not events (chatEndedEvent ends the reader)
 *
 * Roles: the channel owner is the broadcaster, chat moderators are moderators, members (isChatSponsor) count as subscribers.
 * The viewer's id is their YouTube channel id; login is their display name (the @handle) without the @, lower-cased.
 */

const MESSAGE_MAX = 1000;
const TEXT_MAX = 100;

const str = (v, max = TEXT_MAX) => (v == null || v === '' ? null : String(v).slice(0, max));
const num = (v) => {
    const n = typeof v === 'number' ? v : Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
};
const when = (v) => {
    const d = v ? new Date(v) : new Date();
    return Number.isNaN(d.getTime()) ? new Date() : d;
};

export function ytRoles(a = {}) {
    const roles = [];
    if (a?.isChatOwner) roles.push('broadcaster');
    if (a?.isChatModerator) roles.push('moderator');
    if (a?.isChatSponsor) roles.push('subscriber');
    return roles;
}

export function ytUser(a) {
    if (!a || !a.channelId) return null;
    const display = String(a.displayName || '').trim();
    const login = display.replace(/^@/, '').toLowerCase();
    return { id: String(a.channelId).slice(0, 64), login: str(login), name: str(display || a.channelId), roles: ytRoles(a) };
}

function make(type, { channelId, user = null, amount = null, currency = null, message = null, metadata = {}, raw = null, occurredAt = null, dedupeKey = null }) {
    return {
        platform: 'youtube', type,
        channelId: channelId == null ? null : String(channelId),
        user,
        amount: num(amount),
        currency: currency ? String(currency).slice(0, 12) : null,
        message: message == null ? null : String(message).slice(0, MESSAGE_MAX),
        metadata: metadata || {},
        raw,
        occurredAt: when(occurredAt),
        dedupeKey: dedupeKey ? String(dedupeKey).slice(0, 120) : null,
    };
}

/** The resource as kept in the event log: no profile picture addresses, nothing else trimmed. */
function rawOf(item) {
    const a = item.authorDetails || {};
    return { id: item.id, snippet: item.snippet, authorDetails: { channelId: a.channelId, displayName: a.displayName, isChatOwner: a.isChatOwner, isChatModerator: a.isChatModerator, isChatSponsor: a.isChatSponsor, isVerified: a.isVerified } };
}

const micros = (v) => { const n = num(v); return n == null ? null : Math.round(n / 10_000) / 100; };

/**
 * @param {object} item  a liveChatMessage (part snippet,authorDetails)
 * @param {object} ctx   { channelId: the streamer's channel id, broadcastId, isFirst(userId) → boolean (chat only) }
 * @returns {object|null} a normalised event, or null for message kinds that are not events
 */
export function normaliseYouTubeMessage(item, { channelId, broadcastId = null, isFirst = null } = {}) {
    if (!item || typeof item !== 'object' || !item.snippet) return null;
    const s = item.snippet;
    const u = ytUser(item.authorDetails);
    const id = str(item.id, 128);
    const at = s.publishedAt;
    const base = { channelId, user: u, raw: rawOf(item), occurredAt: at };
    const meta = (m) => ({ messageId: id, broadcastId: str(broadcastId, 64), verified: !!item.authorDetails?.isVerified, ...m });
    const key = (k) => (id ? `yt:${k}:${id}` : null);
    switch (s.type) {
        case 'textMessageEvent': {
            const text = s.textMessageDetails?.messageText ?? s.displayMessage ?? '';
            const first = u?.id && typeof isFirst === 'function' ? !!isFirst(u.id) : false;
            return make('chat', { ...base, message: text, dedupeKey: key('chat'), metadata: meta({ firstWords: first }) });
        }
        case 'superChatEvent': {
            const d = s.superChatDetails || {};
            return make('tip', { ...base, amount: micros(d.amountMicros), currency: str(d.currency, 8), message: d.userComment ?? null, dedupeKey: key('superchat'),
                metadata: meta({ kind: 'super_chat', display: str(d.amountDisplayString, 40), tier: num(d.tier) }) });
        }
        case 'superStickerEvent': {
            const d = s.superStickerDetails || {};
            return make('tip', { ...base, amount: micros(d.amountMicros), currency: str(d.currency, 8), message: null, dedupeKey: key('supersticker'),
                metadata: meta({ kind: 'super_sticker', display: str(d.amountDisplayString, 40), tier: num(d.tier), sticker: str(d.superStickerMetadata?.altText, 200) }) });
        }
        case 'giftEvent': {
            const d = s.giftDetails || {};
            const jewels = num(d.jewelsAmount);
            if (jewels == null) return null;
            return make('tip', { ...base, amount: jewels, currency: 'jewels', message: null, dedupeKey: key('jewels'),
                metadata: meta({ kind: 'jewels', gift: str(d.giftName || d.altText, 100), combo: num(d.comboCount) }) });
        }
        case 'newSponsorEvent': {
            const d = s.newSponsorDetails || {};
            return make('membership', { ...base, user: u ? { ...u, roles: [...new Set([...u.roles, 'subscriber'])] } : null, dedupeKey: key('member'),
                metadata: meta({ kind: 'new', tier: str(d.memberLevelName), isUpgrade: !!d.isUpgrade, months: 1, isGift: false }) });
        }
        case 'memberMilestoneChatEvent': {
            const d = s.memberMilestoneChatDetails || {};
            const months = num(d.memberMonth);
            return make('membership', { ...base, amount: months, currency: months == null ? null : 'months', message: d.userComment ?? null, dedupeKey: key('milestone'),
                metadata: meta({ kind: 'milestone', tier: str(d.memberLevelName), months, isGift: false }) });
        }
        case 'membershipGiftingEvent': {
            const d = s.membershipGiftingDetails || {};
            const count = num(d.giftMembershipsCount) ?? 1;
            return make('gift_sub', { ...base, amount: count, currency: 'subs', dedupeKey: key('gifting'),
                metadata: meta({ count, tier: str(d.giftMembershipsLevelName), anonymous: false }) });
        }
        case 'giftMembershipReceivedEvent': {
            const d = s.giftMembershipReceivedDetails || {};
            return make('membership', { ...base, user: u ? { ...u, roles: [...new Set([...u.roles, 'subscriber'])] } : null, dedupeKey: key('giftreceived'),
                metadata: meta({ kind: 'gift', tier: str(d.memberLevelName), isGift: true, months: 1, gifterChannelId: str(d.gifterChannelId, 64), giftingMessageId: str(d.associatedMembershipGiftingMessageId, 128) }) });
        }
        default:
            return null;
    }
}

/** A broadcast (liveBroadcasts resource, or the service's state) going live or ending. */
export function broadcastEvent(type, { channelId, broadcastId, title = null, startedAt = null, endedAt = null }) {
    if (type !== 'stream.online' && type !== 'stream.offline') return null;
    return make(type, {
        channelId, message: title, occurredAt: type === 'stream.online' ? startedAt : endedAt,
        dedupeKey: broadcastId ? `yt:${type === 'stream.online' ? 'online' : 'offline'}:${broadcastId}` : null,
        metadata: { broadcastId: str(broadcastId, 64), title: str(title, 200) },
        raw: { broadcastId, title, startedAt, endedAt },
    });
}

/** Messages that mean the chat is over. */
export const isChatEnded = (item) => item?.snippet?.type === 'chatEndedEvent';

export default { normaliseYouTubeMessage, broadcastEvent, ytRoles, ytUser, isChatEnded };
