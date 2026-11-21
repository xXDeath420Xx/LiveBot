/*
 * Stream bot: the one normalised event shape and the converters from each source (pure, no I/O).
 * Design: docs/superpowers/specs/2026-11-19-stream-bot-design.md §2.2.
 *
 *   { platform, type, channelId, user: { id, login, name, roles[] } | null, amount, currency, message,
 *     metadata, raw, occurredAt: Date, dedupeKey }
 *
 * normaliseTwitch(subType, event, specKey)  EventSub notification → event, or null (not a stream-bot type)
 * normaliseKick(eventType, event)           Kick webhook → event, or null
 * normaliseTip(source, payload)             tip services → event, or null
 * normaliseStudio(event)                    an OBS event CertiFried Studio reported → event, or null
 * sampleEvent(type, overrides)              the Test button's event for a trigger type
 * (YouTube Live events are converted in core/stream-bot/youtube/normalise.js, H-741, design §13.)
 *
 * Tested in tests/stream-bot-events.test.js.
 */

export const ROLES = Object.freeze(['broadcaster', 'moderator', 'vip', 'subscriber']);
export const PLATFORMS = Object.freeze(['twitch', 'kick', 'youtube', 'streamelements', 'streamlabs', 'kofi', 'bmac', 'throne', 'fourthwall', 'studio', 'bot', 'test']);
export const TIP_SOURCES = Object.freeze(['streamelements', 'streamlabs', 'kofi', 'bmac', 'throne', 'fourthwall']);

const MESSAGE_MAX = 1000;
const TEXT_MAX = 100;

const sample = (o) => Object.freeze(o);
const SAMPLE_USER = { id: '100000001', login: 'maplefan_88', name: 'MapleFan_88', roles: ['subscriber'] };

/**
 * Every event type. `platforms` are where it can come from; `fields` the template variables that carry a value
 * for it; `sample` what the Test button fires.
 */
export const EVENT_TYPES = [   // not frozen: registerEventType() adds feature triggers (core/stream-bot/music)
    // YouTube: a new subscriber to the channel (subscriptions.list myRecentSubscribers while live, youtube/service.js).
    { type: 'follow', label: 'Follow', group: 'Community', platforms: ['twitch', 'kick', 'youtube'], fields: ['user'],
        sample: sample({ user: SAMPLE_USER }) },
    { type: 'sub', label: 'Subscription', group: 'Support', platforms: ['twitch', 'kick'], fields: ['user', 'tier'],
        sample: sample({ user: SAMPLE_USER, metadata: { tier: '1000', isGift: false } }) },
    { type: 'resub', label: 'Resubscription', group: 'Support', platforms: ['twitch', 'kick'], fields: ['user', 'tier', 'months', 'message'],
        sample: sample({ user: SAMPLE_USER, amount: 7, currency: 'months', message: 'Seven months already!', metadata: { tier: '1000', months: 7, streak: 3 } }) },
    { type: 'gift_sub', label: 'Gift subs', group: 'Support', platforms: ['twitch', 'kick', 'youtube'], fields: ['user', 'count', 'tier'],
        sample: sample({ user: SAMPLE_USER, amount: 5, currency: 'subs', metadata: { tier: '1000', count: 5, anonymous: false } }) },
    { type: 'cheer', label: 'Bits (cheer)', group: 'Support', platforms: ['twitch'], fields: ['user', 'amount', 'message'],
        sample: sample({ user: SAMPLE_USER, amount: 500, currency: 'bits', message: 'Cheer500 good luck on the boss' }) },
    { type: 'raid', label: 'Raid', group: 'Community', platforms: ['twitch'], fields: ['user', 'viewers'],
        sample: sample({ user: { id: '100000002', login: 'bramblebyte_live', name: 'BrambleByte_Live', roles: [] }, amount: 42, currency: 'viewers', metadata: { viewers: 42 } }) },
    { type: 'redemption', label: 'Channel points redemption', group: 'Community', platforms: ['twitch'], fields: ['user', 'reward', 'amount', 'message'],
        sample: sample({ user: SAMPLE_USER, amount: 500, currency: 'points', message: 'Play the sad trombone', metadata: { reward: 'Sound alert', rewardId: 'demo-reward', redemptionId: 'demo-redemption', status: 'unfulfilled' } }) },
    // channel.bits.use (bits:read): every use of Bits, cheers included, the power-ups (message effect, celebration, giant emote) and
    // custom power-ups (metadata kind custom_power_up, powerUpId, powerUpTitle).
    { type: 'bits.used', label: 'Power-up or Bits used', group: 'Support', platforms: ['twitch'], fields: ['user', 'amount', 'message', 'powerup'],
        sample: sample({ user: SAMPLE_USER, amount: 100, currency: 'bits', message: 'Big text for a big win', metadata: { kind: 'power_up', powerUp: 'message_effect', emote: null } }) },
    // channel.chat.notification (user:read:chat + user:bot, already held for chat): watch streaks and charity donations.
    { type: 'watch_streak', label: 'Watch streak shared', group: 'Community', platforms: ['twitch'], fields: ['user', 'amount', 'message'],
        sample: sample({ user: SAMPLE_USER, amount: 5, currency: 'streams', message: 'Five in a row', metadata: { streak: 5, points: 450 } }) },
    { type: 'charity', label: 'Charity donation', group: 'Support', platforms: ['twitch'], fields: ['user', 'amount', 'currency'],
        sample: sample({ user: SAMPLE_USER, amount: 10, currency: 'USD', metadata: { charity: 'Maple Hollow Food Bank' } }) },
    { type: 'hype_train.begin', label: 'Hype train started', group: 'Hype train', platforms: ['twitch'], fields: ['level'],
        sample: sample({ amount: 1, currency: 'level', metadata: { level: 1, total: 1200, goal: 1800 } }) },
    { type: 'hype_train.progress', label: 'Hype train progress', group: 'Hype train', platforms: ['twitch'], fields: ['level'],
        sample: sample({ amount: 2, currency: 'level', metadata: { level: 2, total: 2400, goal: 3200 } }) },
    { type: 'hype_train.end', label: 'Hype train ended', group: 'Hype train', platforms: ['twitch'], fields: ['level'],
        sample: sample({ amount: 3, currency: 'level', metadata: { level: 3, total: 5100 } }) },
    { type: 'poll.begin', label: 'Poll started', group: 'Polls and predictions', platforms: ['twitch'], fields: ['title'],
        sample: sample({ message: 'Which game next?', metadata: { title: 'Which game next?', choices: [{ title: 'Celeste', votes: 0 }, { title: 'Hades', votes: 0 }] } }) },
    { type: 'poll.progress', label: 'Poll votes', group: 'Polls and predictions', platforms: ['twitch'], fields: ['title'],
        sample: sample({ message: 'Which game next?', metadata: { title: 'Which game next?', choices: [{ title: 'Celeste', votes: 12 }, { title: 'Hades', votes: 9 }] } }) },
    { type: 'poll.end', label: 'Poll ended', group: 'Polls and predictions', platforms: ['twitch'], fields: ['title', 'winner'],
        sample: sample({ message: 'Which game next?', metadata: { title: 'Which game next?', winner: 'Celeste', status: 'completed', choices: [{ title: 'Celeste', votes: 30 }, { title: 'Hades', votes: 21 }] } }) },
    { type: 'prediction.begin', label: 'Prediction started', group: 'Polls and predictions', platforms: ['twitch'], fields: ['title'],
        sample: sample({ message: 'Boss down first try?', metadata: { title: 'Boss down first try?', outcomes: [{ title: 'Yes' }, { title: 'No' }] } }) },
    { type: 'prediction.progress', label: 'Prediction progress', group: 'Polls and predictions', platforms: ['twitch'], fields: ['title'],
        sample: sample({ message: 'Boss down first try?', metadata: { title: 'Boss down first try?' } }) },
    { type: 'prediction.lock', label: 'Prediction locked', group: 'Polls and predictions', platforms: ['twitch'], fields: ['title'],
        sample: sample({ message: 'Boss down first try?', metadata: { title: 'Boss down first try?' } }) },
    { type: 'prediction.end', label: 'Prediction ended', group: 'Polls and predictions', platforms: ['twitch'], fields: ['title', 'winner'],
        sample: sample({ message: 'Boss down first try?', metadata: { title: 'Boss down first try?', winner: 'No', status: 'resolved' } }) },
    { type: 'ad_break', label: 'Ad break', group: 'Stream', platforms: ['twitch'], fields: ['amount'],
        sample: sample({ amount: 90, currency: 'seconds', metadata: { automatic: true } }) },
    { type: 'stream.online', label: 'Stream went live', group: 'Stream', platforms: ['twitch', 'kick', 'youtube'], fields: [],
        sample: sample({ metadata: {} }) },
    { type: 'stream.offline', label: 'Stream ended', group: 'Stream', platforms: ['twitch', 'kick', 'youtube'], fields: [],
        sample: sample({ metadata: {} }) },
    { type: 'chat', label: 'Chat message', group: 'Chat', platforms: ['twitch', 'kick', 'youtube'], fields: ['user', 'message'],
        sample: sample({ user: SAMPLE_USER, message: '!hello' }) },
    { type: 'tip', label: 'Tip or Super Chat', group: 'Tips', platforms: [...TIP_SOURCES, 'youtube'], fields: ['user', 'amount', 'currency', 'message'],
        sample: sample({ platform: 'streamelements', user: { id: null, login: null, name: 'Juniper', roles: [] }, amount: 5, currency: 'USD', message: 'Coffee is on me', metadata: { kind: 'donation' } }) },
    { type: 'membership', label: 'Membership (YouTube or tip service)', group: 'Tips', platforms: ['kofi', 'bmac', 'fourthwall', 'youtube'], fields: ['user', 'amount', 'currency', 'tier'],
        sample: sample({ platform: 'kofi', user: { id: null, login: null, name: 'Juniper', roles: [] }, amount: 3, currency: 'USD', metadata: { tier: 'Supporter', first: true } }) },
    { type: 'merch_order', label: 'Merch order', group: 'Tips', platforms: ['kofi', 'fourthwall'], fields: ['user', 'amount', 'currency'],
        sample: sample({ platform: 'fourthwall', user: { id: null, login: null, name: 'Juniper', roles: [] }, amount: 28, currency: 'USD', metadata: { items: 2 } }) },
    // Phase 2: OBS events reported by CertiFried Studio (platform 'studio', no channel, no viewer).
    { type: 'obs.scene_changed', label: 'OBS: scene changed', group: 'OBS', platforms: ['studio'], fields: [],
        sample: sample({ metadata: { scene: 'Just Chatting', previous: 'Starting Soon' } }) },
    { type: 'obs.stream_started', label: 'OBS: stream started', group: 'OBS', platforms: ['studio'], fields: [], sample: sample({ metadata: {} }) },
    { type: 'obs.stream_stopped', label: 'OBS: stream stopped', group: 'OBS', platforms: ['studio'], fields: [], sample: sample({ metadata: {} }) },
    { type: 'obs.recording_started', label: 'OBS: recording started', group: 'OBS', platforms: ['studio'], fields: [], sample: sample({ metadata: {} }) },
    { type: 'obs.recording_stopped', label: 'OBS: recording stopped', group: 'OBS', platforms: ['studio'], fields: [], sample: sample({ metadata: { file: 'recording.mkv' } }) },
    { type: 'obs.recording_paused', label: 'OBS: recording paused', group: 'OBS', platforms: ['studio'], fields: [], sample: sample({ metadata: {} }) },
    { type: 'obs.recording_resumed', label: 'OBS: recording resumed', group: 'OBS', platforms: ['studio'], fields: [], sample: sample({ metadata: {} }) },
    { type: 'obs.replay_saved', label: 'OBS: replay saved', group: 'OBS', platforms: ['studio'], fields: [], sample: sample({ metadata: { file: 'Replay.mkv' } }) },
    { type: 'obs.virtualcam_started', label: 'OBS: virtual camera started', group: 'OBS', platforms: ['studio'], fields: [], sample: sample({ metadata: {} }) },
    { type: 'obs.virtualcam_stopped', label: 'OBS: virtual camera stopped', group: 'OBS', platforms: ['studio'], fields: [], sample: sample({ metadata: {} }) },
    // Phase 2c: a phrase CertiFried Studio recognised on the streamer's PC (offline; only the phrase text is sent).
    { type: 'voice.phrase', label: 'Voice command', group: 'Studio', platforms: ['studio'], fields: ['message'],
        sample: sample({ user: { id: null, login: null, name: 'Voice', roles: ['broadcaster'] }, message: 'start the raid', metadata: { phrase: 'start the raid', confidence: 0.92 } }) },
    // CertiFried Studio signed in to the realtime channel (realtime.js hello, through hub.use onConnect).
    { type: 'studio.connected', label: 'CertiFried Studio connected', group: 'CertiFried Studio', platforms: ['studio'], fields: [],
        sample: sample({ metadata: { device: 'Streaming PC', version: '0.2.2' } }) },
    // A stream bot value changed ({sdb:…}, {db:…}, Set a variable, Add to a counter); core/stream-bot/counters.js.
    { type: 'variable.changed', label: 'Counter or variable changed', group: 'Stream bot', platforms: ['bot'], fields: ['counter'],
        sample: sample({ amount: 13, metadata: { key: 'deaths', scope: 'channel', value: '13', oldValue: '12', change: 1, depth: 1 } }) },
];

const BY_TYPE = new Map(EVENT_TYPES.map((t) => [t.type, t]));
export function eventType(type) { return BY_TYPE.get(type) || null; }
export function isEventType(type) { return BY_TYPE.has(type); }
/** Registration hook for feature modules (core/stream-bot/music: 'music.song_changed'). Never adds to STUDIO_EVENT_TYPES. */
export function registerEventType(def) {
    if (!def?.type || BY_TYPE.has(def.type) || !Array.isArray(def.platforms)) return false;
    EVENT_TYPES.push(def);
    BY_TYPE.set(def.type, def);
    return true;
}
/** Converters feature modules add (core/stream-bot/control): tried when the built-in Twitch or Kick converter has no case. */
const EXTRA_NORMALISERS = { twitch: [], kick: [] };
export function registerNormaliser(platform, fn) {
    if (!EXTRA_NORMALISERS[platform] || typeof fn !== 'function' || EXTRA_NORMALISERS[platform].includes(fn)) return false;
    EXTRA_NORMALISERS[platform].push(fn);
    return true;
}
function extraNormalise(platform, ...args) {
    for (const fn of EXTRA_NORMALISERS[platform]) { try { const ev = fn(...args); if (ev) return ev; } catch { /* a feature converter never breaks intake */ } }
    return null;
}
/** Feed-line writers for feature event types (describeEvent falls back to them before the plain label). */
const DESCRIBERS = [];
export function registerDescriber(fn) { if (typeof fn !== 'function' || DESCRIBERS.includes(fn)) return false; DESCRIBERS.push(fn); return true; }

// ── helpers ────────────────────────────────────────────────────────────────────────────────

const str = (v, max = TEXT_MAX) => (v == null || v === '' ? null : String(v).slice(0, max));
const num = (v) => {
    const n = typeof v === 'number' ? v : Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
};
const when = (v) => {
    const d = v ? new Date(v) : new Date();
    return Number.isNaN(d.getTime()) ? new Date() : d;
};

function user(id, login, name, roles = []) {
    if (id == null && login == null && name == null) return null;
    return {
        id: id == null ? null : String(id).slice(0, 64),
        login: str(login && String(login).toLowerCase()),
        name: str(name || login),
        roles: [...new Set(roles.filter((r) => ROLES.includes(r)))],
    };
}

function make(platform, type, { channelId = null, user: u = null, amount = null, currency = null, message = null, metadata = {}, raw = null, occurredAt = null, dedupeKey = null } = {}) {
    return {
        platform, type,
        channelId: channelId == null ? null : String(channelId),
        user: u,
        amount: num(amount),
        currency: currency ? String(currency).slice(0, 12) : null,
        message: message == null ? null : String(message).slice(0, MESSAGE_MAX),
        metadata: metadata || {},
        raw,
        occurredAt: when(occurredAt),
        dedupeKey: dedupeKey ? String(dedupeKey).slice(0, 120) : null,
    };
}

/** Twitch chat badges ([{ set_id }]) → roles. */
export function twitchRoles(badges = []) {
    const set = new Set((badges || []).map((b) => String(b?.set_id || '').toLowerCase()));
    const roles = [];
    if (set.has('broadcaster')) roles.push('broadcaster');
    if (set.has('moderator') || set.has('lead_moderator')) roles.push('moderator');
    if (set.has('vip')) roles.push('vip');
    if (set.has('subscriber') || set.has('founder')) roles.push('subscriber');
    return roles;
}

/** Kick sender.identity.badges ([{ type }]) → roles. */
export function kickRoles(badges = []) {
    const set = new Set((badges || []).map((b) => String(b?.type || '').toLowerCase()));
    const roles = [];
    if (set.has('broadcaster')) roles.push('broadcaster');
    if (set.has('moderator')) roles.push('moderator');
    if (set.has('vip')) roles.push('vip');
    if (set.has('subscriber') || set.has('founder')) roles.push('subscriber');
    return roles;
}

// ── Twitch (EventSub) ───────────────────────────────────────────────────────────────────────

const HYPE = { 'channel.hype_train.begin': 'hype_train.begin', 'channel.hype_train.progress': 'hype_train.progress', 'channel.hype_train.end': 'hype_train.end' };
const POLL = { 'channel.poll.begin': 'poll.begin', 'channel.poll.progress': 'poll.progress', 'channel.poll.end': 'poll.end' };
const PREDICTION = { 'channel.prediction.begin': 'prediction.begin', 'channel.prediction.progress': 'prediction.progress', 'channel.prediction.lock': 'prediction.lock', 'channel.prediction.end': 'prediction.end' };

/**
 * @param {string} subType  EventSub subscription type
 * @param {object} e        the notification's `event`
 * @param {string} [specKey] the registry key ('channel.raid:out' for outgoing raids, which are skipped)
 */
export function normaliseTwitch(subType, e, specKey = subType) {
    if (!e || typeof e !== 'object') return null;
    const bid = e.broadcaster_user_id ?? null;
    const base = { raw: e };
    switch (subType) {
        case 'channel.follow':
            return make('twitch', 'follow', { ...base, channelId: bid, user: user(e.user_id, e.user_login, e.user_name), occurredAt: e.followed_at,
                dedupeKey: `tw:follow:${bid}:${e.user_id}:${e.followed_at || ''}` });
        case 'channel.subscribe':
            return make('twitch', 'sub', { ...base, channelId: bid, user: user(e.user_id, e.user_login, e.user_name, ['subscriber']),
                metadata: { tier: str(e.tier, 8), isGift: !!e.is_gift } });
        case 'channel.subscription.message':
            return make('twitch', 'resub', { ...base, channelId: bid, user: user(e.user_id, e.user_login, e.user_name, ['subscriber']),
                amount: e.cumulative_months, currency: 'months', message: e.message?.text ?? null,
                metadata: { tier: str(e.tier, 8), months: num(e.cumulative_months), streak: num(e.streak_months), duration: num(e.duration_months) } });
        case 'channel.subscription.gift': {
            const anon = !!e.is_anonymous;
            return make('twitch', 'gift_sub', { ...base, channelId: bid, user: anon ? null : user(e.user_id, e.user_login, e.user_name),
                amount: e.total, currency: 'subs', metadata: { tier: str(e.tier, 8), count: num(e.total), total: num(e.cumulative_total), anonymous: anon } });
        }
        case 'channel.cheer': {
            const anon = !!e.is_anonymous;
            return make('twitch', 'cheer', { ...base, channelId: bid, user: anon ? null : user(e.user_id, e.user_login, e.user_name),
                amount: e.bits, currency: 'bits', message: e.message, metadata: { anonymous: anon } });
        }
        case 'channel.raid':
            if (specKey === 'channel.raid:out' || !e.to_broadcaster_user_id) return null;
            return make('twitch', 'raid', { ...base, channelId: e.to_broadcaster_user_id,
                user: user(e.from_broadcaster_user_id, e.from_broadcaster_user_login, e.from_broadcaster_user_name),
                amount: e.viewers, currency: 'viewers', metadata: { viewers: num(e.viewers) } });
        case 'channel.channel_points_custom_reward_redemption.add':
            return make('twitch', 'redemption', { ...base, channelId: bid, user: user(e.user_id, e.user_login, e.user_name),
                amount: e.reward?.cost, currency: 'points', message: e.user_input || null, occurredAt: e.redeemed_at,
                dedupeKey: e.id ? `tw:redeem:${e.id}` : null,
                metadata: { reward: str(e.reward?.title), rewardId: str(e.reward?.id, 64), redemptionId: str(e.id, 64), status: str(e.status, 20) } });
        case 'channel.bits.use': {
            // type: cheer | power_up | custom_power_up (combo until 2025); power_up.type: message_effect | celebration | gigantify_an_emote.
            // custom_power_up { title, reward_id }: a power-up the streamer made (the owner's Volcano, Back-To-Back …), told apart
            // by its id (metadata.powerUpId), which is what Firebot's power-ups.json and Streamer.bot's trigger keep (2026-11-20).
            const pu = e.power_up && typeof e.power_up === 'object' ? e.power_up : null;
            const cpu = e.custom_power_up && typeof e.custom_power_up === 'object' ? e.custom_power_up : null;
            return make('twitch', 'bits.used', { ...base, channelId: bid, user: user(e.user_id, e.user_login, e.user_name),
                amount: e.bits, currency: 'bits', message: e.message?.text ?? null,
                metadata: { kind: str(e.type, 20), powerUp: pu ? str(pu.type, 40) : null, emote: pu?.emote?.name ? str(pu.emote.name, 100) : null,
                    ...(cpu ? { powerUpId: str(cpu.reward_id, 64), powerUpTitle: str(cpu.title, 100) } : {}) } });
        }
        case 'channel.ad_break.begin':
            return make('twitch', 'ad_break', { ...base, channelId: bid, amount: e.duration_seconds, currency: 'seconds', occurredAt: e.started_at,
                metadata: { automatic: !!e.is_automatic } });
        case 'stream.online':
            return make('twitch', 'stream.online', { ...base, channelId: bid, occurredAt: e.started_at,
                dedupeKey: e.id ? `tw:online:${e.id}` : null, metadata: { streamId: str(e.id, 64), kind: str(e.type, 20) } });
        case 'stream.offline':
            return make('twitch', 'stream.offline', { ...base, channelId: bid, metadata: {} });
        case 'channel.chat.message': {
            if (!e.message_id && !e.message) return null;
            const reward = e.channel_points_custom_reward_id || null;
            return make('twitch', 'chat', { ...base, channelId: bid,
                user: user(e.chatter_user_id, e.chatter_user_login, e.chatter_user_name, twitchRoles(e.badges)),
                message: e.message?.text ?? '', dedupeKey: e.message_id ? `tw:chat:${e.message_id}` : null,
                metadata: { messageId: str(e.message_id, 64), bits: num(e.cheer?.bits), rewardId: reward, reply: !!e.reply, color: str(e.color, 10) } });
        }
        case 'channel.chat.notification': {
            // Only the notices with no subscription of their own: watch streaks and charity donations. Subs, resubs, gifts and
            // raids arrive through their own subscriptions. A shared-chat notice from another channel is not this channel's.
            if (e.source_broadcaster_user_id && String(e.source_broadcaster_user_id) !== String(bid)) return null;
            const who = e.chatter_is_anonymous ? null : user(e.chatter_user_id, e.chatter_user_login, e.chatter_user_name, twitchRoles(e.badges));
            const dk = e.message_id ? `tw:notice:${e.message_id}` : null;
            if (e.notice_type === 'watch_streak' && e.watch_streak) {
                const n = num(e.watch_streak.streak_count);
                return make('twitch', 'watch_streak', { ...base, channelId: bid, user: who, amount: n, currency: 'streams', message: e.message?.text || null, dedupeKey: dk,
                    metadata: { streak: n, points: num(e.watch_streak.channel_points_awarded) } });
            }
            if (e.notice_type === 'charity_donation' && e.charity_donation) {
                const a = e.charity_donation.amount || {};
                const v = num(a.value);
                const places = Math.max(0, Math.min(4, num(a.decimal_place) ?? 2));
                return make('twitch', 'charity', { ...base, channelId: bid, user: who, amount: v == null ? null : v / 10 ** places, currency: str(a.currency, 8), dedupeKey: dk,
                    metadata: { charity: str(e.charity_donation.charity_name, 200) } });
            }
            return null;
        }
        default:
            break;
    }
    if (HYPE[subType]) {
        const level = num(e.level);
        return make('twitch', HYPE[subType], { ...base, channelId: bid, amount: level, currency: 'level',
            metadata: { level, total: num(e.total), goal: num(e.goal), progress: num(e.progress), id: str(e.id, 64),
                expiresAt: str(e.expires_at, 40), endedAt: str(e.ended_at, 40) } });
    }
    if (POLL[subType]) {
        const choices = (e.choices || []).map((c) => ({ title: str(c.title), votes: num(c.votes) ?? 0 }));
        const winner = subType === 'channel.poll.end' && choices.length
            ? choices.reduce((a, b) => (b.votes > a.votes ? b : a)).title : null;
        return make('twitch', POLL[subType], { ...base, channelId: bid, message: e.title,
            dedupeKey: e.id && subType !== 'channel.poll.progress' ? `tw:${POLL[subType]}:${e.id}` : null,
            metadata: { title: str(e.title, 200), choices, winner, status: str(e.status, 20), id: str(e.id, 64), endsAt: str(e.ends_at, 40) } });
    }
    if (PREDICTION[subType]) {
        const outcomes = (e.outcomes || []).map((o) => ({ id: str(o.id, 64), title: str(o.title), users: num(o.users), points: num(o.channel_points) }));
        const winner = e.winning_outcome_id ? (outcomes.find((o) => o.id === e.winning_outcome_id)?.title || null) : null;
        return make('twitch', PREDICTION[subType], { ...base, channelId: bid, message: e.title,
            dedupeKey: e.id && subType !== 'channel.prediction.progress' ? `tw:${PREDICTION[subType]}:${e.id}` : null,
            metadata: { title: str(e.title, 200), outcomes, winner, status: str(e.status, 20), id: str(e.id, 64), endsAt: str(e.locks_at, 40) } });
    }
    return extraNormalise('twitch', subType, e, specKey);
}

// ── Kick (webhooks) ─────────────────────────────────────────────────────────────────────────

export function normaliseKick(eventType, e) {
    if (!e || typeof e !== 'object') return null;
    const bid = e.broadcaster?.user_id ?? e.broadcaster_user_id ?? null;
    if (bid == null) return null;
    const base = { channelId: bid, raw: e };
    const ku = (u, roles = []) => (u ? user(u.user_id ?? null, u.channel_slug || u.username, u.username, roles) : null);
    switch (eventType) {
        case 'chat.message.sent':
            return make('kick', 'chat', { ...base, user: ku(e.sender, kickRoles(e.sender?.identity?.badges)), message: e.content ?? '',
                dedupeKey: e.message_id ? `kk:chat:${e.message_id}` : null, metadata: { messageId: str(e.message_id, 64) } });
        case 'channel.followed':
            return make('kick', 'follow', { ...base, user: ku(e.follower),
                dedupeKey: e.follower?.user_id != null ? `kk:follow:${bid}:${e.follower.user_id}:${Math.floor(Date.now() / 60000)}` : null });
        case 'channel.subscription.new':
            return make('kick', 'sub', { ...base, user: ku(e.subscriber, ['subscriber']), occurredAt: e.created_at,
                metadata: { months: num(e.duration), isGift: false } });
        case 'channel.subscription.renewal':
            return make('kick', 'resub', { ...base, user: ku(e.subscriber, ['subscriber']), amount: e.duration, currency: 'months', occurredAt: e.created_at,
                metadata: { months: num(e.duration) } });
        case 'channel.subscription.gifts': {
            const giftees = Array.isArray(e.giftees) ? e.giftees : [];
            const anon = !e.gifter || e.gifter.is_anonymous === true;
            return make('kick', 'gift_sub', { ...base, user: anon ? null : ku(e.gifter), amount: giftees.length || 1, currency: 'subs', occurredAt: e.created_at,
                metadata: { count: giftees.length || 1, anonymous: anon, giftees: giftees.slice(0, 50).map((g) => str(g?.username)).filter(Boolean) } });
        }
        case 'livestream.status.updated':
            return make('kick', e.is_live ? 'stream.online' : 'stream.offline', { ...base, occurredAt: e.is_live ? e.started_at : e.ended_at,
                message: e.title ?? null, metadata: { title: str(e.title, 200) } });
        default:
            return extraNormalise('kick', eventType, e);
    }
}

// ── Tips ────────────────────────────────────────────────────────────────────────────────────

const BMAC_FRESH_MS = 60 * 60 * 1000;

/**
 * @param {string} source  one of TIP_SOURCES
 * @param {object} p       the source's payload, in the shape its hook passes (see each case)
 * @param {object} [opt]   { now } for tests
 */
export function normaliseTip(source, p, { now = Date.now() } = {}) {
    if (!p || typeof p !== 'object') return null;
    const base = { raw: p };
    switch (source) {
        case 'streamelements': {
            // Astro channel.tips: { data: { donation: { user: { username }, amount, currency, message }, ... }, ... }
            const d = p.data || p;
            const don = d.donation || d;
            const amount = num(don.amount);
            if (amount == null) return null;
            const id = p._id || d._id || p.id || d.tipId || null;
            return make('streamelements', 'tip', { ...base, user: user(null, null, don.user?.username || d.username || 'Anonymous'),
                amount, currency: don.currency || d.currency || null, message: don.message ?? d.message ?? null,
                occurredAt: p.createdAt || d.createdAt, dedupeKey: id ? `se:${id}` : null, metadata: { kind: 'donation' } });
        }
        case 'streamlabs': {
            // socket "event" { type: 'donation', message: [{ id, name, amount, formatted_amount, currency, message }] }
            if (p.type !== 'donation') return null;
            const m = Array.isArray(p.message) ? p.message[0] : p.message;
            if (!m) return null;
            const amount = num(m.amount);
            if (amount == null) return null;
            const id = m.id ?? m.donation_id ?? m._id ?? null;
            return make('streamlabs', 'tip', { ...base, user: user(null, null, m.from || m.name || 'Anonymous'),
                amount, currency: m.currency || null, message: m.message ?? null,
                dedupeKey: id != null ? `sl:${id}` : null, metadata: { kind: 'donation' } });
        }
        case 'kofi': {
            // core/kofi-manager.js parsePayload() output
            const kind = String(p.type || 'Donation');
            const type = p.isSubscription || kind === 'Subscription' ? 'membership' : kind === 'Shop Order' ? 'merch_order' : 'tip';
            return make('kofi', type, { ...base, raw: { ...p, email: undefined, verificationToken: undefined },
                user: user(null, null, p.isPublic === false ? 'Anonymous' : (p.fromName || 'Anonymous')),
                amount: p.amount, currency: p.currency, message: p.isPublic === false ? null : p.message,
                dedupeKey: p.messageId ? `kofi:${p.messageId}` : null,
                metadata: { kind: kind.toLowerCase().replace(/\s+/g, '_'), tier: str(p.tierName), first: !!p.isFirst } });
        }
        case 'bmac': {
            // core/buymeacoffee-manager.js _normalize() output: { id, type, name, amountNum, currency, note, createdOn, hidden }
            if (p.createdOn) {
                const at = new Date(String(p.createdOn).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(p.createdOn)) ? '' : 'Z'));
                if (!Number.isNaN(at.getTime()) && now - at.getTime() > BMAC_FRESH_MS) return null;
            }
            const type = p.type === 'subscription' ? 'membership' : 'tip';
            return make('bmac', type, { ...base, user: user(null, null, p.hidden ? 'Anonymous' : (p.name || 'Anonymous')),
                amount: p.amountNum, currency: p.currency, message: p.hidden ? null : p.note,
                dedupeKey: p.id ? `bmac:${p.type}:${p.id}` : null, metadata: { kind: p.type === 'extra' ? 'extra' : p.type === 'subscription' ? 'membership' : 'donation' } });
        }
        case 'throne': {
            // webhook body { event_type, event_id, data: { creator_username, gifter_username, item_name, price|amount (cents), currency, message } }
            const d = p.data || {};
            const kinds = { gift_purchased: 'gift', gift_crowdfunded: 'crowdfund', contribution_purchased: 'contribution' };
            const kind = kinds[p.event_type];
            if (!kind) return null;
            const cents = num(kind === 'contribution' ? d.amount : d.price);
            const anon = !d.gifter_username || /^anonymous$/i.test(String(d.gifter_username).trim());
            return make('throne', 'tip', { ...base, user: kind === 'crowdfund' ? null : user(null, null, anon ? 'Anonymous' : d.gifter_username),
                amount: cents == null ? null : Math.round(cents) / 100, currency: d.currency || 'USD', message: d.message ?? null,
                dedupeKey: p.event_id ? `throne:${p.event_id}` : null, metadata: { kind, item: str(d.item_name, 200), creator: str(d.creator_username) } });
        }
        case 'fourthwall': {
            // webhook body { type, id, data: { ... } }; amounts as { value, currency }
            const t = String(p.type || '').toUpperCase();
            const d = p.data || {};
            const money = d.amounts?.total || d.amounts?.subtotal || d.amount || d.total || null;
            const value = num(money?.value ?? money);
            const currency = money?.currency || d.currency || null;
            // Never the buyer's email or address: only a public name the supporter chose.
            const who = d.username || d.supporter?.username || 'Supporter';
            const dk = p.id ? `fw:${p.id}` : null;
            // Orders carry the buyer's address and email: keep only what the event needs.
            const fw = { raw: { type: p.type, id: p.id, data: { amounts: d.amounts ?? null, message: d.message ?? null, username: d.username ?? null } } };
            if (t === 'DONATION') return make('fourthwall', 'tip', { ...fw, user: user(null, null, who), amount: value, currency, message: d.message ?? null, dedupeKey: dk, metadata: { kind: 'donation' } });
            if (t === 'GIFT_PURCHASE') return make('fourthwall', 'tip', { ...fw, user: user(null, null, who), amount: value, currency, message: d.message ?? null, dedupeKey: dk, metadata: { kind: 'gift' } });
            if (t === 'ORDER_PLACED') return make('fourthwall', 'merch_order', { ...fw, user: user(null, null, who), amount: value, currency, message: d.message ?? null, dedupeKey: dk,
                metadata: { items: Array.isArray(d.offers) ? d.offers.length : null } });
            if (t === 'SUBSCRIPTION_PURCHASED') return make('fourthwall', 'membership', { ...fw, user: user(null, null, who), amount: value, currency, dedupeKey: dk,
                metadata: { tier: str(d.subscription?.variant?.name || d.tier?.name) } });
            return null;
        }
        default:
            return null;
    }
}

// ── CertiFried Studio (OBS events) ─────────────────────────────────────────────────────────

// Only OBS events come from the app's `event` frames; studio.connected is raised by the server itself.
// What the app itself may send: OBS events and recognised voice phrases (studio.connected is made by the server).
export const STUDIO_EVENT_TYPES = Object.freeze(EVENT_TYPES.filter((t) => t.platforms.includes('studio') && (t.type.startsWith('obs.') || t.type === 'voice.phrase')).map((t) => t.type));
const baseName = (v) => str(String(v ?? '').split(/[\\/]/).pop(), 200);

/**
 * An OBS event the app reported ({ type, metadata, occurredAt }) → event, or null for an unknown type.
 * Only known metadata fields are kept, and file paths are cut to the file name.
 */
export function normaliseStudio(e) {
    if (!e || typeof e !== 'object' || !STUDIO_EVENT_TYPES.includes(e.type)) return null;
    const m = e.metadata && typeof e.metadata === 'object' ? e.metadata : {};
    const metadata = {};
    if (e.type === 'obs.scene_changed') {
        metadata.scene = str(m.scene, 200);
        metadata.previous = str(m.previous, 200);
    }
    if (['obs.replay_saved', 'obs.recording_stopped'].includes(e.type) && m.file) metadata.file = baseName(m.file);
    const t = Number(e.occurredAt);
    const occurredAt = Number.isFinite(t) && Math.abs(Date.now() - t) < 10 * 60_000 ? new Date(t) : new Date();
    if (e.type === 'voice.phrase') {
        // The streamer at their own PC: broadcaster, so role conditions behave as for their own chat.
        const phrase = str(String(m.phrase ?? '').replace(/\s+/g, ' ').trim(), 100);
        if (!phrase) return null;
        const c = Number(m.confidence);
        return make('studio', e.type, { message: phrase, user: { id: null, login: null, name: 'Voice', roles: ['broadcaster'] },
            metadata: { phrase, confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, Math.round(c * 1000) / 1000)) : null }, occurredAt });
    }
    return make('studio', e.type, { metadata, occurredAt });
}

/** The event the Test button fires for a trigger type (marked platform 'test' unless the sample names a tip source). */
export function sampleEvent(type, { platform = null, channelId = null, overrides = {} } = {}) {
    const def = eventType(type);
    if (!def) return null;
    const s = def.sample || {};
    const ev = make(platform || s.platform || (def.platforms.includes('twitch') ? 'twitch' : def.platforms[0]) || 'test', type, {
        channelId, user: s.user ? { ...s.user, roles: [...(s.user.roles || [])] } : null,
        amount: s.amount ?? null, currency: s.currency ?? null, message: s.message ?? null,
        metadata: { ...(s.metadata || {}) }, raw: { sample: true },
    });
    for (const k of ['amount', 'currency', 'message']) if (overrides[k] !== undefined) ev[k] = k === 'amount' ? num(overrides[k]) : overrides[k];
    if (overrides.userName) ev.user = { ...(ev.user || { id: null, login: null, roles: [] }), name: String(overrides.userName).slice(0, TEXT_MAX), login: String(overrides.userName).toLowerCase().slice(0, TEXT_MAX) };
    if (Array.isArray(overrides.roles) && ev.user) ev.user.roles = overrides.roles.filter((r) => ROLES.includes(r));
    ev.test = true;
    return ev;
}

/** Event as sent to browsers and devices: no raw payload. */
export function publicEvent(ev, id = null) {
    if (!ev) return null;
    return {
        id: id ?? ev.id ?? null, platform: ev.platform, type: ev.type, channelId: ev.channelId ?? null,
        user: ev.user ? { id: ev.user.id ?? null, login: ev.user.login ?? null, name: ev.user.name ?? null, roles: ev.user.roles || [] } : null,
        amount: ev.amount ?? null, currency: ev.currency ?? null, message: ev.message ?? null,
        metadata: ev.metadata || {}, occurredAt: (ev.occurredAt instanceof Date ? ev.occurredAt : new Date(ev.occurredAt || Date.now())).toISOString(),
        test: !!ev.test,
    };
}

/** A one-line description for feeds and logs ("MapleFan_88 cheered 500 bits"). */
export function describeEvent(ev) {
    const who = ev.user?.name || 'Someone';
    const amt = ev.amount != null ? Number(ev.amount).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '';
    const money = ev.currency && /^[A-Z]{3}$/.test(ev.currency) ? `${amt} ${ev.currency}` : amt;
    switch (ev.type) {
        case 'follow': return ev.platform === 'youtube' ? `${who} subscribed on YouTube` : `${who} followed`;
        case 'watch_streak': return `${who} is on a ${amt}-stream watch streak`;
        case 'charity': return `${ev.user ? who : 'Someone'} gave ${money} to ${ev.metadata?.charity || 'charity'}`.trim();
        case 'sub': return ev.metadata?.isGift ? `${who} received a gift sub` : `${who} subscribed`;
        case 'resub': return amt ? `${who} resubscribed (${amt} months)` : `${who} resubscribed`;
        case 'gift_sub': return `${ev.user ? who : 'An anonymous viewer'} gifted ${amt} ${ev.platform === 'youtube' ? 'membership' : 'sub'}${ev.amount === 1 ? '' : 's'}`;
        case 'cheer': return `${ev.user ? who : 'An anonymous viewer'} cheered ${amt} bits`;
        case 'raid': return `${who} raided with ${amt} viewer${ev.amount === 1 ? '' : 's'}`;
        case 'redemption': return `${who} redeemed ${ev.metadata?.reward || 'a reward'}`;
        case 'tip': {
            const k = ev.metadata?.kind;   // YouTube (H-741): Super Chat, Super Sticker, Jewels; tracked, never processed
            if (k === 'super_chat') return `${who} sent a Super Chat${money ? ` (${money})` : ''}`;
            if (k === 'super_sticker') return `${who} sent a Super Sticker${money ? ` (${money})` : ''}`;
            if (k === 'jewels') return `${who} sent ${amt} jewels`;
            return `${who} tipped ${money}`.trim();
        }
        case 'membership':
            if (ev.platform === 'youtube') {
                const lvl = ev.metadata?.tier ? ` (${ev.metadata.tier})` : '';
                if (ev.metadata?.kind === 'milestone') return `${who} has been a member for ${ev.metadata?.months ?? amt} months${lvl}`;
                if (ev.metadata?.kind === 'gift') return `${who} received a gifted membership${lvl}`;
                return `${who} became a member${lvl}`;
            }
            return `${who} became a member${money ? ` (${money})` : ''}`;
        case 'merch_order': return `${who} placed an order${money ? ` (${money})` : ''}`;
        case 'chat': return `${who}: ${ev.message || ''}`;
        case 'stream.online': return 'Stream went live';
        case 'stream.offline': return 'Stream ended';
        case 'ad_break': return `Ad break (${amt} s)`;
        case 'obs.scene_changed': return `OBS switched to ${ev.metadata?.scene || 'another scene'}`;
        case 'bits.used': {
            const pu = { message_effect: 'a message effect', celebration: 'a celebration', gigantify_an_emote: 'a giant emote' }[ev.metadata?.powerUp]
                || (ev.metadata?.kind === 'custom_power_up' ? `the ${String(ev.metadata?.powerUpTitle || 'custom').slice(0, 60)} power-up` : '');
            return `${ev.user ? who : 'Someone'} used ${amt} bits${pu ? ` on ${pu}` : ev.metadata?.kind === 'cheer' ? ' (cheer)' : ''}`;
        }
        case 'variable.changed': return `${ev.metadata?.key || 'A value'} is now ${String(ev.metadata?.value ?? '').slice(0, 60) || 'empty'}${ev.metadata?.oldValue !== undefined && ev.metadata?.oldValue !== '' ? ` (was ${String(ev.metadata.oldValue).slice(0, 40)})` : ''}`;
        case 'studio.connected': return `CertiFried Studio connected${ev.metadata?.device ? ` on ${ev.metadata.device}` : ''}`;
        default: {
            for (const fn of DESCRIBERS) { try { const t = fn(ev); if (t) return t; } catch { /* next */ } }
            return eventType(ev.type)?.label || ev.type;
        }
    }
}

/** The event builders, for feature converters (core/stream-bot/control/events.js). */
export { make as makeEvent, user as eventUser };

export default { EVENT_TYPES, ROLES, PLATFORMS, TIP_SOURCES, eventType, isEventType, normaliseTwitch, normaliseKick, normaliseTip, normaliseStudio, STUDIO_EVENT_TYPES, sampleEvent, publicEvent, describeEvent, twitchRoles, kickRoles };
