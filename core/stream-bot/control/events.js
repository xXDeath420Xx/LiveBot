/*
 * Stream bot control (wave 2 group A): the extra triggers and their converters. Pure apart from a small in-memory map of
 * the last title and category seen per channel (so "Title or category changed" can say which one changed).
 *
 *   CONTROL_EVENT_TYPES                 the trigger catalogue entries (registered with events.js registerEventType)
 *   normaliseControlTwitch(subType, e)  EventSub notifications the core converter does not handle → event, or null
 *   normaliseControlKick(eventType, e)  Kick webhooks the core converter does not handle → event, or null
 *
 * Moderation (W2.1): channel.ban (ban or timeout), channel.unban, channel.chat.message_delete, channel.chat.clear,
 * channel.chat.clear_user_messages, channel.chat_settings.update, channel.vip.add/remove, channel.moderator.add/remove,
 * automod.message.hold, channel.suspicious_user.message, channel.warning.send, channel.shield_mode.begin/end. Kick:
 * moderation.banned. These subscriptions are already in core/twitch-eventsub-manager.js; they start once the Stream bot
 * grant carries their scopes (core/stream-bot/scopes.js).
 * Channel points (W2.6): channel.channel_points_custom_reward_redemption.update; Kick channel.reward.redemption.updated
 * (status pending is a new redemption, so it becomes the usual "Channel points redemption" trigger on Kick).
 * Stream (W2.11): channel.update and Kick livestream.metadata.updated (title or category), channel.goal.* (creator goals).
 * Kick (W2.19): kicks.gifted.
 * First words, viewer arrived, viewer count and upcoming ad are raised by service.js (they need state or polling).
 *
 * Tested in tests/stream-bot-control.test.js.
 */
import { makeEvent, eventUser } from '../events.js';

const SAMPLE_USER = { id: '100000001', login: 'maplefan_88', name: 'MapleFan_88', roles: ['subscriber'] };
const MOD_USER = { id: '100000009', login: 'quietmod', name: 'QuietMod', roles: ['moderator'] };
const s = (o) => Object.freeze(o);
const str = (v, n = 100) => (v == null || v === '' ? null : String(v).slice(0, n));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

export const CHAT_MODES = Object.freeze(['emote', 'followers', 'slow', 'subscribers', 'unique']);
const MODE_LABEL = Object.freeze({ emote: 'emote-only', followers: 'followers-only', slow: 'slow mode', subscribers: 'subscribers-only', unique: 'unique chat' });

/** Trigger config fields shown by the editor for some triggers (validated in conditions.js validateTrigger). */
const VIEWER_STEP = [{ name: 'step', kind: 'number', label: 'Every this many viewers', min: 1, max: 100000, default: 10,
    help: 'Runs each time the count passes a multiple of this, up or down. Checked about once a minute while you are live.' }];
const AD_MINUTES = [{ name: 'minutes', kind: 'number', label: 'Minutes before the ad', min: 1, max: 15, default: 5,
    help: 'Twitch only. Checked every 30 seconds while you are live.' }];
const UPDATED_WHAT = [{ name: 'what', kind: 'select', label: 'Which change', options: ['any', 'title', 'category'], default: 'any',
    optionLabels: { any: 'Title or category', title: 'Title only', category: 'Category only' } }];
const MOD_KIND = [{ name: 'kind', kind: 'select', label: 'Which', options: ['any', 'add', 'remove'], default: 'any',
    optionLabels: { any: 'Added or removed', add: 'Added', remove: 'Removed' } }];

export const CONTROL_EVENT_TYPES = [
    // ── moderation (W2.1) ──
    { type: 'mod.ban', label: 'Viewer banned', group: 'Moderation', platforms: ['twitch', 'kick'], fields: ['user', 'message'],
        sample: s({ user: SAMPLE_USER, message: 'Spam links', metadata: { moderator: 'QuietMod', reason: 'Spam links' } }) },
    { type: 'mod.timeout', label: 'Viewer timed out', group: 'Moderation', platforms: ['twitch', 'kick'], fields: ['user', 'amount', 'message'],
        sample: s({ user: SAMPLE_USER, amount: 600, currency: 'seconds', message: 'Calm down', metadata: { moderator: 'QuietMod', reason: 'Calm down', seconds: 600 } }) },
    { type: 'mod.unban', label: 'Viewer unbanned', group: 'Moderation', platforms: ['twitch'], fields: ['user'],
        sample: s({ user: SAMPLE_USER, metadata: { moderator: 'QuietMod' } }) },
    { type: 'mod.delete', label: 'Chat message deleted', group: 'Moderation', platforms: ['twitch'], fields: ['user'],
        sample: s({ user: SAMPLE_USER, metadata: { messageId: 'demo-message' } }) },
    { type: 'mod.clear', label: 'Chat cleared', group: 'Moderation', platforms: ['twitch'], fields: ['user'],
        sample: s({ metadata: { scope: 'all' } }) },
    { type: 'mod.chat_mode', label: 'Chat mode changed', group: 'Moderation', platforms: ['twitch'], fields: ['message'],
        sample: s({ message: 'slow mode on', metadata: { emote: false, followers: false, slow: true, slowSeconds: 10, subscribers: false, unique: false } }) },
    { type: 'mod.role', label: 'Moderator or VIP added or removed', group: 'Moderation', platforms: ['twitch'], fields: ['user'], config: MOD_KIND,
        sample: s({ user: SAMPLE_USER, message: 'vip add', metadata: { role: 'vip', change: 'add' } }),
        match: (cfg, ev) => !cfg.kind || cfg.kind === 'any' || ev.metadata?.change === cfg.kind },
    { type: 'automod.held', label: 'AutoMod held a message', group: 'Moderation', platforms: ['twitch'], fields: ['user', 'message'],
        sample: s({ user: SAMPLE_USER, message: 'a message AutoMod held', metadata: { reason: 'automod', category: 'swearing', level: 2, messageId: 'demo-held' } }) },
    { type: 'mod.suspicious', label: 'Suspicious user chatted', group: 'Moderation', platforms: ['twitch'], fields: ['user', 'message'],
        sample: s({ user: SAMPLE_USER, message: 'hello', metadata: { lowTrust: 'restricted', banEvasion: 'possible', sharedBans: 0 } }) },
    { type: 'mod.warning', label: 'Viewer warned', group: 'Moderation', platforms: ['twitch'], fields: ['user', 'message'],
        sample: s({ user: SAMPLE_USER, message: 'Please read the rules', metadata: { moderator: 'QuietMod', reason: 'Please read the rules' } }) },
    { type: 'mod.shield', label: 'Shield mode turned on or off', group: 'Moderation', platforms: ['twitch'], fields: [],
        sample: s({ user: MOD_USER, message: 'on', metadata: { active: true } }) },
    // ── channel points (W2.6) ──
    { type: 'redemption.updated', label: 'Redemption done or refunded', group: 'Community', platforms: ['twitch', 'kick'], fields: ['user', 'reward'],
        sample: s({ user: SAMPLE_USER, amount: 500, currency: 'points', metadata: { reward: 'Sound alert', rewardId: 'demo-reward', redemptionId: 'demo-redemption', status: 'fulfilled' } }) },
    // ── stream (W2.11) ──
    { type: 'stream.updated', label: 'Title or category changed', group: 'Stream', platforms: ['twitch', 'kick'], fields: ['title'], config: UPDATED_WHAT,
        sample: s({ message: 'Speedruns all night', metadata: { title: 'Speedruns all night', category: 'Celeste', titleChanged: true, categoryChanged: false } }),
        match: (cfg, ev) => !cfg.what || cfg.what === 'any' || (cfg.what === 'title' ? !!ev.metadata?.titleChanged : !!ev.metadata?.categoryChanged) },
    { type: 'stream.viewers', label: 'Viewer count passed a step', group: 'Stream', platforms: ['twitch', 'kick', 'youtube'], fields: ['viewers'], config: VIEWER_STEP,
        sample: s({ amount: 50, currency: 'viewers', metadata: { viewers: 50, previous: 48 } }),
        match: (cfg, ev) => {
            const step = Number(cfg.step) || 10;
            const a = Number(ev.metadata?.previous);
            const b = Number(ev.amount);
            if (ev.test || !Number.isFinite(a)) return true;
            return Math.floor(a / step) !== Math.floor(b / step);
        } },
    { type: 'ad.upcoming', label: 'Ad break coming up', group: 'Stream', platforms: ['twitch'], fields: ['amount'], config: AD_MINUTES,
        sample: s({ amount: 300, currency: 'seconds', metadata: { minutes: 5, length: 90, snoozes: 1 } }),
        match: (cfg, ev) => ev.test || Number(ev.metadata?.minutes) === (Number(cfg.minutes) || 5) },
    { type: 'goal.begin', label: 'Creator goal started', group: 'Goals', platforms: ['twitch'], fields: ['amount', 'title'],
        sample: s({ amount: 120, currency: 'followers', message: 'Road to 1000', metadata: { goalType: 'follower', target: 1000, title: 'Road to 1000' } }) },
    { type: 'goal.progress', label: 'Creator goal progress', group: 'Goals', platforms: ['twitch'], fields: ['amount', 'title'],
        sample: s({ amount: 121, currency: 'followers', message: 'Road to 1000', metadata: { goalType: 'follower', target: 1000, title: 'Road to 1000' } }) },
    { type: 'goal.end', label: 'Creator goal ended', group: 'Goals', platforms: ['twitch'], fields: ['amount', 'title'],
        sample: s({ amount: 1000, currency: 'followers', message: 'Road to 1000', metadata: { goalType: 'follower', target: 1000, title: 'Road to 1000', achieved: true } }) },
    { type: 'chat.first_words', label: 'First words (first message ever)', group: 'Chat', platforms: ['twitch', 'kick', 'youtube'], fields: ['user', 'message'],
        sample: s({ user: { ...SAMPLE_USER, roles: [] }, message: 'hi, first time here' }) },
    { type: 'chat.arrived', label: 'Viewer arrived (first message this stream)', group: 'Chat', platforms: ['twitch', 'kick', 'youtube'], fields: ['user', 'message'],
        sample: s({ user: SAMPLE_USER, message: 'evening all' }) },
    // ── Kick (W2.19) ──
    { type: 'kicks.gifted', label: 'Kicks gifted', group: 'Support', platforms: ['kick'], fields: ['user', 'amount', 'message'],
        sample: s({ platform: 'kick', user: SAMPLE_USER, amount: 100, currency: 'kicks', message: 'GG', metadata: { gift: 'Rage Quit', tier: 'basic' } }) },
];

export const CONTROL_EVENT_NAMES = Object.freeze(CONTROL_EVENT_TYPES.map((t) => t.type));

// ── Twitch ─────────────────────────────────────────────────────────────────────────────────

const lastInfo = new Map();   // 'platform:channel' -> { title, category }
function changes(key, title, category) {
    const prev = lastInfo.get(key);
    if (lastInfo.size > 5000) lastInfo.clear();
    lastInfo.set(key, { title, category });
    if (!prev) return { titleChanged: true, categoryChanged: true };
    return { titleChanged: prev.title !== title, categoryChanged: prev.category !== category };
}
export const _resetInfo = () => lastInfo.clear();

const tu = (e, p = 'user') => eventUser(e[`${p}_id`], e[`${p}_login`], e[`${p}_name`]);
const modName = (e) => str(e.moderator_user_name || e.moderator_user_login);

export function normaliseControlTwitch(subType, e) {
    if (!e || typeof e !== 'object') return null;
    const bid = e.broadcaster_user_id ?? null;
    const base = { channelId: bid, raw: e };
    switch (subType) {
        case 'channel.ban': {
            const permanent = !!e.is_permanent || !e.ends_at;
            const seconds = permanent ? null : Math.max(1, Math.round((Date.parse(e.ends_at) - Date.parse(e.banned_at || Date.now())) / 1000));
            return makeEvent('twitch', permanent ? 'mod.ban' : 'mod.timeout', { ...base, user: tu(e), message: e.reason || null,
                amount: seconds, currency: seconds ? 'seconds' : null, occurredAt: e.banned_at,
                dedupeKey: `tw:ban:${bid}:${e.user_id}:${e.banned_at || ''}`,
                metadata: { moderator: modName(e), reason: str(e.reason, 500), seconds } });
        }
        case 'channel.unban':
            return makeEvent('twitch', 'mod.unban', { ...base, user: tu(e), metadata: { moderator: modName(e) } });
        case 'channel.chat.message_delete':
            return makeEvent('twitch', 'mod.delete', { ...base, user: eventUser(e.target_user_id, e.target_user_login, e.target_user_name),
                dedupeKey: e.message_id ? `tw:del:${e.message_id}` : null, metadata: { messageId: str(e.message_id, 64) } });
        case 'channel.chat.clear':
            return makeEvent('twitch', 'mod.clear', { ...base, metadata: { scope: 'all' } });
        case 'channel.chat.clear_user_messages':
            return makeEvent('twitch', 'mod.clear', { ...base, user: eventUser(e.target_user_id, e.target_user_login, e.target_user_name), metadata: { scope: 'user' } });
        case 'channel.chat_settings.update': {
            const m = { emote: !!e.emote_mode, followers: !!e.follower_mode, followersMinutes: num(e.follower_mode_duration_minutes),
                slow: !!e.slow_mode, slowSeconds: num(e.slow_mode_wait_time_seconds), subscribers: !!e.subscriber_mode, unique: !!e.unique_chat_mode };
            const on = CHAT_MODES.filter((k) => m[k]).map((k) => MODE_LABEL[k]);
            return makeEvent('twitch', 'mod.chat_mode', { ...base, message: on.length ? `${on.join(', ')} on` : 'all chat modes off', metadata: m });
        }
        case 'channel.vip.add': case 'channel.vip.remove': case 'channel.moderator.add': case 'channel.moderator.remove': {
            const [, role, change] = subType.split('.');
            return makeEvent('twitch', 'mod.role', { ...base, user: tu(e), message: `${role === 'vip' ? 'vip' : 'moderator'} ${change}`, metadata: { role, change } });
        }
        case 'automod.message.hold': {
            const text = e.message?.text ?? (typeof e.message === 'string' ? e.message : '');
            return makeEvent('twitch', 'automod.held', { ...base, user: tu(e), message: text,
                dedupeKey: e.message_id ? `tw:held:${e.message_id}` : null,
                metadata: { messageId: str(e.message_id, 64), reason: str(e.reason, 40), category: str(e.automod?.category || e.category, 40), level: num(e.automod?.level ?? e.level) } });
        }
        case 'channel.suspicious_user.message':
            return makeEvent('twitch', 'mod.suspicious', { ...base, user: tu(e), message: e.message?.text ?? null,
                metadata: { lowTrust: str(e.low_trust_status, 40), banEvasion: str(e.ban_evasion_evaluation, 40), sharedBans: Array.isArray(e.shared_ban_channel_ids) ? e.shared_ban_channel_ids.length : 0, messageId: str(e.message?.message_id, 64) } });
        case 'channel.warning.send':
            return makeEvent('twitch', 'mod.warning', { ...base, user: tu(e), message: e.reason || null, metadata: { moderator: modName(e), reason: str(e.reason, 500) } });
        case 'channel.shield_mode.begin': case 'channel.shield_mode.end': {
            const active = subType.endsWith('begin');
            return makeEvent('twitch', 'mod.shield', { ...base, user: eventUser(e.moderator_user_id, e.moderator_user_login, e.moderator_user_name, ['moderator']),
                message: active ? 'on' : 'off', metadata: { active } });
        }
        case 'channel.channel_points_custom_reward_redemption.update':
            return makeEvent('twitch', 'redemption.updated', { ...base, user: tu(e), amount: e.reward?.cost, currency: 'points', message: e.user_input || null,
                dedupeKey: e.id ? `tw:redeemupd:${e.id}:${e.status}` : null,
                metadata: { reward: str(e.reward?.title), rewardId: str(e.reward?.id, 64), redemptionId: str(e.id, 64), status: String(e.status || '').toLowerCase() === 'canceled' ? 'refunded' : 'fulfilled' } });
        case 'channel.update': {
            const title = str(e.title, 200) || '';
            const category = str(e.category_name, 100) || '';
            return makeEvent('twitch', 'stream.updated', { ...base, message: title, metadata: { title, category, categoryId: str(e.category_id, 32), ...changes(`twitch:${bid}`, title, category) } });
        }
        case 'channel.goal.begin': case 'channel.goal.progress': case 'channel.goal.end': {
            const phase = subType.split('.').pop();
            const type = String(e.type || '');
            const unit = { follow: 'followers', follower: 'followers', subscription: 'subs', subscription_count: 'subs', new_subscription: 'subs', new_subscription_count: 'subs', new_bit: 'bits', new_cheerer: 'cheerers' }[type] || type || null;
            return makeEvent('twitch', `goal.${phase}`, { ...base, amount: e.current_amount, currency: unit, message: e.description || null,
                dedupeKey: phase === 'progress' ? null : `tw:goal:${phase}:${e.id}`,
                metadata: { goalId: str(e.id, 64), goalType: str(type, 40), target: num(e.target_amount), title: str(e.description, 200), ...(phase === 'end' ? { achieved: !!e.is_achieved } : {}) } });
        }
        default:
            return null;
    }
}

// ── Kick ───────────────────────────────────────────────────────────────────────────────────

const ku = (u, roles = []) => (u ? eventUser(u.user_id ?? null, u.channel_slug || u.username, u.username, roles) : null);

export function normaliseControlKick(eventType, e) {
    if (!e || typeof e !== 'object') return null;
    const bid = e.broadcaster?.user_id ?? e.broadcaster_user_id ?? null;
    if (bid == null) return null;
    const base = { channelId: bid, raw: e };
    switch (eventType) {
        case 'moderation.banned': {
            const m = e.metadata || {};
            const permanent = !m.expires_at;
            const seconds = permanent ? null : Math.max(60, Math.round((Date.parse(m.expires_at) - Date.parse(m.created_at || Date.now())) / 1000));
            return makeEvent('kick', permanent ? 'mod.ban' : 'mod.timeout', { ...base, user: ku(e.banned_user), message: m.reason || null,
                amount: seconds, currency: seconds ? 'seconds' : null, occurredAt: m.created_at,
                dedupeKey: e.banned_user?.user_id != null ? `kk:ban:${bid}:${e.banned_user.user_id}:${m.created_at || ''}` : null,
                metadata: { moderator: str(e.moderator?.username), reason: str(m.reason, 500), seconds } });
        }
        case 'kicks.gifted': {
            const g = e.gift || {};
            return makeEvent('kick', 'kicks.gifted', { ...base, user: ku(e.sender), amount: g.amount, currency: 'kicks', message: g.message || null, occurredAt: e.created_at,
                metadata: { gift: str(g.name), giftType: str(g.type, 40), tier: str(g.tier, 40), pinnedSeconds: num(g.pinned_time_seconds) } });
        }
        case 'channel.reward.redemption.updated': {
            const status = String(e.status || '').toLowerCase();
            const meta = { reward: str(e.reward?.title), rewardId: str(e.reward?.id, 64), redemptionId: str(e.id, 64) };
            if (status === 'pending') {
                return makeEvent('kick', 'redemption', { ...base, user: ku(e.redeemer), amount: e.reward?.cost, currency: 'points', message: e.user_input || null,
                    occurredAt: e.redeemed_at, dedupeKey: e.id ? `kk:redeem:${e.id}` : null, metadata: { ...meta, status: 'unfulfilled' } });
            }
            return makeEvent('kick', 'redemption.updated', { ...base, user: ku(e.redeemer), amount: e.reward?.cost, currency: 'points', message: e.user_input || null,
                dedupeKey: e.id ? `kk:redeemupd:${e.id}:${status}` : null, metadata: { ...meta, status: status === 'rejected' ? 'refunded' : 'fulfilled' } });
        }
        case 'livestream.metadata.updated': {
            const m = e.metadata || {};
            const title = str(m.title, 200) || '';
            const category = str(m.category?.name, 100) || '';
            return makeEvent('kick', 'stream.updated', { ...base, message: title, metadata: { title, category, ...changes(`kick:${bid}`, title, category) } });
        }
        default:
            return null;
    }
}

/** Feed lines for the new types. */
export function describeControl(ev) {
    const who = ev.user?.name || 'Someone';
    const m = ev.metadata || {};
    switch (ev.type) {
        case 'mod.ban': return `${who} was banned${m.moderator ? ` by ${m.moderator}` : ''}`;
        case 'mod.timeout': return `${who} was timed out${ev.amount ? ` for ${ev.amount} s` : ''}`;
        case 'mod.unban': return `${who} was unbanned`;
        case 'mod.delete': return `A message from ${who} was deleted`;
        case 'mod.clear': return m.scope === 'user' ? `${who}'s messages were cleared` : 'Chat was cleared';
        case 'mod.chat_mode': return `Chat modes: ${ev.message || 'changed'}`;
        case 'mod.role': return `${who} ${m.change === 'add' ? 'is now' : 'is no longer'} ${m.role === 'vip' ? 'a VIP' : 'a moderator'}`;
        case 'automod.held': return `AutoMod held a message from ${who}`;
        case 'mod.suspicious': return `Suspicious user ${who} chatted`;
        case 'mod.warning': return `${who} was warned`;
        case 'mod.shield': return `Shield mode ${m.active ? 'on' : 'off'}`;
        case 'redemption.updated': return `${m.reward || 'A redemption'} for ${who} was ${m.status === 'refunded' ? 'refunded' : 'marked done'}`;
        case 'stream.updated': return `Stream updated: ${[m.titleChanged ? `title "${String(m.title || '').slice(0, 80)}"` : null, m.categoryChanged ? `category ${m.category || 'none'}` : null].filter(Boolean).join(', ') || 'no change'}`;
        case 'stream.viewers': return `${ev.amount} viewers`;
        case 'ad.upcoming': return `Ad break in ${m.minutes} minute${m.minutes === 1 ? '' : 's'}`;
        case 'goal.begin': return `Goal started: ${m.title || m.goalType || 'goal'}`;
        case 'goal.progress': return `Goal: ${ev.amount} of ${m.target}`;
        case 'goal.end': return `Goal ended${m.achieved ? ', reached' : ''}: ${ev.amount} of ${m.target}`;
        case 'chat.first_words': return `${who} chatted for the first time`;
        case 'chat.arrived': return `${who} arrived`;
        case 'kicks.gifted': return `${who} gifted ${ev.amount} Kicks`;
        default: return null;
    }
}

export default { CONTROL_EVENT_TYPES, CONTROL_EVENT_NAMES, CHAT_MODES, normaliseControlTwitch, normaliseControlKick, describeControl };
