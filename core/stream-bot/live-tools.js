/*
 * Stream bot: the live channel tools the OBS docks and the Overview page share (audit 2026-11-20 items 10, 11, 12).
 *
 *   createLiveTools({ store, helix, kick, streamInfo?, sendChat })
 *     modAbilities(profile)                       → { connected, delete, ban }       what the Stream bot grant allows on Twitch
 *     linked(profile)                             → { twitch, kick }                 which channels are linked (booleans)
 *     say(profile, { platform, text })            send a chat line. Twitch: as the streamer (helix.sayAsBroadcaster).
 *                                                 Kick: the existing Kick send path (the channel bot sign-in).
 *     moderate(profile, { platform, action, messageId?, userId?, seconds?, reason? })   action: delete | timeout | ban
 *     channelInfo(profile)                        → [{ platform, label, channelId, login, title, category, live }]
 *     channelUpdate(profile, { platform, title?, category? })
 *     categories(profile, { platform, q })        → [{ id, name }]   (Twitch /search/categories, Kick /categories)
 *     redemptions(profile)                        → { rows, needScope, importUrl }  recent redemptions with their live state
 *     redeem(profile, { rewardId, redemptionId, action })   action: fulfil | refund
 *
 * Every call acts only on the profile's own linked channel and its own Stream bot grant or Kick sign-in: no channel or
 * profile id comes from the caller. Failures are ToolError(status, code, message), which the routes send as JSON.
 * Helix only (no private GQL); never a follows or revenue scope.
 *
 * Tested in tests/stream-bot-live-tools.test.js.
 */
import { HelixError } from './helix.js';
import { KickError } from './kick-api.js';
import { scopeSatisfied } from './scopes.js';

export const MOD_RECONNECT = 'Reconnect Twitch to allow moderation';
export const CAPABILITIES = Object.freeze({ chat: 'chat', channel: 'channel' });
export const IMPORT_URL = '/stream/bot/import';
export const NOT_CREATED_MESSAGE = 'Twitch only lets CertiFried change rewards that CertiFried created. Use Recreate under CertiFried on the Import page, then new redemptions of the recreated reward can be marked done or refunded here.';

export class ToolError extends Error {
    constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; Object.assign(this, extra); }
}

const LABEL = { twitch: 'Twitch', kick: 'Kick' };
const MESSAGE_ID = /^[A-Za-z0-9-]{1,64}$/;
const USER_ID = /^\d{1,20}$/;
const REWARD_ID = /^[A-Za-z0-9-]{1,64}$/;
const WEEK_MS = 7 * 24 * 3600 * 1000;
export const DEFAULT_TIMEOUT_SECONDS = 600;

/** Turn Helix, Kick and grant errors into a ToolError the dock and page can show. Anything else is returned as is. */
export function translate(err) {
    if (err instanceof ToolError) return err;
    if (err?.code === 'missing_scope' && !(err instanceof KickError)) {
        const scope = (err.missing || [])[0] || null;
        const mod = /banned_users|chat_messages/.test(String(scope));
        return new ToolError(409, 'missing_scope', mod ? MOD_RECONNECT : 'Reconnect Twitch on the Connections page to turn this on.', { scope });
    }
    if ((err?.code === 'no_grant' || err?.code === 'needs_reauth') && !(err instanceof KickError)) return new ToolError(409, 'twitch_reconnect', err.message);
    if (err instanceof HelixError || err instanceof KickError) {
        const status = err.status === 429 ? 429 : err.status >= 500 ? 502 : 409;
        return new ToolError(status, String(err.code || 'upstream'), String(err.message || 'The platform refused that.').slice(0, 300), { href: err.href || undefined, scope: err.scope || undefined });
    }
    return err;
}

export function createLiveTools({ store, helix, kick, streamInfo = null, sendChat, now = () => Date.now() } = {}) {
    async function channelOf(profile, platform) {
        if (!LABEL[platform]) throw new ToolError(400, 'bad_platform', 'Choose Twitch or Kick.');
        const c = (await store.listChannels(profile.id)).find((x) => x.platform === platform);
        if (!c) throw new ToolError(403, 'no_channel', `No ${LABEL[platform]} channel is linked to this profile.`);
        return c;
    }
    const wrap = async (fn) => { try { return await fn(); } catch (err) { throw translate(err); } };

    async function grantScopes(profile) {
        const g = await store.getTwitchGrant(profile.id).catch(() => null);
        return g && g.status === 'active' ? new Set(g.scopes || []) : null;
    }

    return {
        async modAbilities(profile) {
            const have = await grantScopes(profile);
            if (!have) return { connected: false, delete: false, ban: false };
            return { connected: true, delete: scopeSatisfied(have, 'moderator:manage:chat_messages'), ban: scopeSatisfied(have, 'moderator:manage:banned_users') };
        },

        async linked(profile) {
            const list = await store.listChannels(profile.id);
            return { twitch: list.some((c) => c.platform === 'twitch'), kick: list.some((c) => c.platform === 'kick') };
        },

        async say(profile, { platform, text }) {
            const msg = String(text ?? '').trim();
            if (!msg) throw new ToolError(400, 'empty', 'Type a message first.');
            if (msg.length > 500) throw new ToolError(400, 'too_long', 'A chat message is at most 500 characters.');
            const c = await channelOf(profile, platform);
            return wrap(async () => {
                if (platform === 'twitch') {
                    await helix.sayAsBroadcaster(profile.id, msg);
                } else {
                    const r = await sendChat({ profileId: profile.id, platform: 'kick', channelId: c.platform_user_id, login: c.login, text: msg });
                    if (!r?.ok) throw new ToolError(409, 'send_failed', String(r?.error || 'Kick did not accept the message.').slice(0, 300));
                }
                return { sent: true, platform };
            });
        },

        async moderate(profile, { platform, action, messageId = null, userId = null, seconds = null, reason = '' }) {
            if (!['delete', 'timeout', 'ban'].includes(action)) throw new ToolError(400, 'bad_action', 'Choose delete, timeout or ban.');
            const c = await channelOf(profile, platform);
            if (action === 'delete') {
                if (!MESSAGE_ID.test(String(messageId || ''))) throw new ToolError(400, 'no_message', 'That line has no message to delete.');
            } else {
                if (!USER_ID.test(String(userId || ''))) throw new ToolError(400, 'no_user', 'That line has no user to act on.');
                if (String(userId) === String(c.platform_user_id)) throw new ToolError(400, 'self', 'That is your own account.');
            }
            let secs = null;
            if (action === 'timeout') {
                secs = seconds == null || seconds === '' ? DEFAULT_TIMEOUT_SECONDS : Math.floor(Number(seconds));
                if (!Number.isFinite(secs) || secs < 1 || secs > 1_209_600) throw new ToolError(400, 'bad_duration', 'A timeout is 1 second to 14 days.');
            }
            return wrap(async () => {
                if (platform === 'twitch') {
                    if (action === 'delete') await helix.deleteChat(profile.id, String(messageId));
                    else await helix.banUser(profile.id, { userId: String(userId), seconds: secs, reason });
                } else if (action === 'delete') {
                    await kick.deleteMessage(c.platform_user_id, String(messageId));
                } else {
                    await kick.ban(c.platform_user_id, String(userId), { seconds: secs });
                }
                return { done: true, platform, action };
            });
        },

        async channelInfo(profile) {
            const out = [];
            const channels = (await store.listChannels(profile.id)).filter((c) => LABEL[c.platform]).sort((a, b) => (a.platform === b.platform ? 0 : a.platform === 'twitch' ? -1 : 1));
            for (const c of channels) {
                let info = null;
                try { info = streamInfo ? await streamInfo.get({ profileId: profile.id, platform: c.platform, channelId: c.platform_user_id }) : null; } catch { info = null; }
                out.push({ platform: c.platform, label: LABEL[c.platform], channelId: String(c.platform_user_id), login: c.login, title: info?.title ?? null, category: info?.category ?? null, live: info ? !!info.live : null });
            }
            return out;
        },

        async channelUpdate(profile, { platform, title, category }) {
            const t = title == null ? null : String(title).trim();
            const g = category == null ? null : String(category).trim();
            if (!t && !g) throw new ToolError(400, 'empty', 'Enter a title or a category.');
            if (t && t.length > 140) throw new ToolError(400, 'too_long', 'A title is at most 140 characters.');
            if (g && g.length > 100) throw new ToolError(400, 'too_long', 'A category name is at most 100 characters.');
            const c = await channelOf(profile, platform);
            const applied = {};
            try {
                if (t) {
                    if (platform === 'twitch') await helix.setTitle(profile.id, t); else await kick.setTitle(c.platform_user_id, t);
                    applied.title = t;
                }
                if (g) {
                    const cat = platform === 'twitch' ? await helix.setCategory(profile.id, g) : await kick.setCategory(c.platform_user_id, g);
                    applied.category = cat.name;
                }
            } catch (err) {
                const e = translate(err);
                if (e instanceof ToolError) e.applied = applied;
                throw e;
            } finally {
                streamInfo?.forget?.(platform, c.platform_user_id);
            }
            return { platform, ...applied };
        },

        async categories(profile, { platform, q }) {
            const c = await channelOf(profile, platform);
            return wrap(() => (platform === 'twitch' ? helix.searchCategories(profile.id, q) : kick.searchCategories(c.platform_user_id, q)));
        },

        async redemptions(profile) {
            const events = (await store.listEvents(profile.id, { type: 'redemption', limit: 100, includeTest: false }))
                .filter((e) => e.platform === 'twitch' && e.metadata?.redemptionId && e.metadata?.rewardId && now() - new Date(e.occurredAt || e.createdAt).getTime() < WEEK_MS);
            const rewardIds = [...new Set(events.map((e) => String(e.metadata.rewardId)))].slice(0, 8);
            const state = new Map();   // rewardId -> { manageable, pending:Set } | { unknown:true }
            let needScope = null;
            for (const rid of rewardIds) {
                try {
                    const list = await helix.listRedemptions(profile.id, rid);
                    state.set(rid, { manageable: true, pending: new Set(list.map((x) => x.id)) });
                } catch (err) {
                    if (err?.code === 'missing_scope' && !(err instanceof KickError)) { needScope = (err.missing || [])[0] || 'channel:manage:redemptions'; break; }
                    if (err?.code === 'no_grant' || err?.code === 'needs_reauth') { needScope = 'reconnect'; break; }
                    // Twitch answers 403 for a reward another app created: CertiFried cannot change it.
                    state.set(rid, err instanceof HelixError && err.status === 403 ? { manageable: false } : { unknown: true });
                }
            }
            const rows = events.map((e) => {
                const s = state.get(String(e.metadata.rewardId));
                let st = 'unknown';
                if (s?.manageable) st = s.pending.has(String(e.metadata.redemptionId)) ? 'pending' : 'done';
                return {
                    redemptionId: String(e.metadata.redemptionId), rewardId: String(e.metadata.rewardId), reward: String(e.metadata.reward || 'A reward'),
                    user: e.user?.name || e.user?.login || 'Someone', cost: e.amount, message: e.message || '',
                    at: new Date(e.occurredAt || e.createdAt).toISOString(), state: st, manageable: s ? s.manageable === true : null,
                };
            });
            return { rows, needScope, importUrl: IMPORT_URL };
        },

        async redeem(profile, { rewardId, redemptionId, action }) {
            const status = action === 'fulfil' ? 'FULFILLED' : action === 'refund' ? 'CANCELED' : null;
            if (!status) throw new ToolError(400, 'bad_action', 'Choose Fulfil or Refund.');
            if (!REWARD_ID.test(String(rewardId || '')) || !REWARD_ID.test(String(redemptionId || ''))) throw new ToolError(400, 'bad_params', 'That redemption is not valid.');
            // Only a redemption this profile's own channel received can be acted on.
            const mine = (await store.listEvents(profile.id, { type: 'redemption', limit: 200, includeTest: false }))
                .find((e) => String(e.metadata?.redemptionId) === String(redemptionId) && String(e.metadata?.rewardId) === String(rewardId));
            if (!mine) throw new ToolError(403, 'not_yours', 'That redemption is not in your channel.');
            try {
                await helix.updateRedemption(profile.id, { rewardId: String(rewardId), redemptionId: String(redemptionId), status });
            } catch (err) {
                if (err instanceof HelixError && err.status === 403) throw new ToolError(409, 'not_created_by_certifried', NOT_CREATED_MESSAGE, { importUrl: IMPORT_URL });
                throw translate(err);
            }
            return { redemptionId: String(redemptionId), action, status };
        },
    };
}

export default { createLiveTools, ToolError, translate, MOD_RECONNECT, CAPABILITIES, IMPORT_URL, NOT_CREATED_MESSAGE, DEFAULT_TIMEOUT_SECONDS };
