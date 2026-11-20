/*
 * Stream bot: the live adapters — the engine's io (chat, Discord, webhooks, dispatch) and the Connections
 * page's reads of the existing connection tables. Everything here touches the running bot or the real
 * tables, so tests replace it with fakes (the engine takes `io` as a parameter).
 *
 *   createIo({ store, hub, ingest, logger })        → { sendChat, postDiscord, postWebhook, dispatch, channelsFor }
 *   linkableChannels(db, ownerId, profileId, store) → channels the user proved they own through OAuth
 *   connectionHealth(db, store, profile)            → per channel: grants, EventSub / Kick webhook state, coverage, and
 *                                                     for Kick the channel bot sign-in (kickBot: kick-scopes.js kickBotStatus)
 */
import { postWebhook } from './webhook-out.js';
import { coverage } from './scopes.js';
import { kickBotStatus, kickBotProblem, kickBotSignInUrl } from './kick-scopes.js';

const CHANNEL_CACHE_MS = 30_000;
const ACCESS_CACHE_MS = 5 * 60_000;

export function createIo({ store, hub, ingest = null, logger = null }) {
    const channelCache = new Map();
    const accessCache = new Map();
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[StreamBot] ${msg}`, meta); } catch { /* ignore */ } };

    async function channelsFor(profileId) {
        const hit = channelCache.get(profileId);
        if (hit && Date.now() - hit.at < CHANNEL_CACHE_MS) return hit.list;
        const list = await store.listChannels(profileId);
        channelCache.set(profileId, { at: Date.now(), list });
        return list;
    }

    async function sendChat({ platform, channelId, login, text }) {
        const msg = String(text).slice(0, 500);
        if (platform === 'twitch') {
            const bot = globalThis.certiFriedBot?.twitchBot;
            if (!bot?.client || !bot.isConnected) return { ok: false, error: 'the CertiFried Twitch chat bot is not connected' };
            const joined = await bot.joinChannel(login);
            if (!joined) return { ok: false, error: `could not join #${login}` };
            ingest?.noteSent('twitch', channelId, msg);
            await bot.say(login, msg);
            return { ok: true };
        }
        if (platform === 'kick') {
            const { sendChannelMessage } = await import('../../jobs/kick-timer-scheduler.js');
            const { resolveChannel } = await import('../../services/certifried-bot/defender/channel-tokens.js');
            // The Kick channel bot sign-in (not the identity-only "Sign in with Kick" that linked the channel).
            const ch = await resolveChannel(String(channelId)).catch(() => null);
            const problem = kickBotProblem(ch, 'chat:write');
            if (problem) return { ok: false, error: problem.message };
            ingest?.noteSent('kick', channelId, msg);
            const ok = await sendChannelMessage(String(channelId), msg, { resolveChannel: async () => ch }).catch(() => false);
            return ok ? { ok: true } : { ok: false, error: `Kick did not accept the chat message. If this keeps happening, sign in to Kick again: ${kickBotSignInUrl()}` };
        }
        return { ok: false, error: `no chat on ${platform}` };
    }

    async function postDiscord({ ownerId, guildId, channelId, text }) {
        const client = globalThis.botManager?.getClientForGuild?.(guildId) || globalThis.__discordClient || null;
        const guild = client?.guilds?.cache?.get(guildId);
        if (!guild) return { ok: false, error: 'CertiFried is not in that server any more' };
        const key = `${guildId}:${ownerId}`;
        let allowed = accessCache.get(key);
        if (!allowed || Date.now() - allowed.at > ACCESS_CACHE_MS) {
            const { liveConfigAccess } = await import('../protection-exempt.js');
            const access = await liveConfigAccess(guild, ownerId).catch(() => ({ ok: false }));
            allowed = { at: Date.now(), ok: !!access?.ok };
            accessCache.set(key, allowed);
        }
        if (!allowed.ok) return { ok: false, error: 'you no longer manage that server' };
        const channel = guild.channels.cache.get(channelId);
        if (!channel || channel.guildId !== guildId || typeof channel.send !== 'function') return { ok: false, error: 'that channel is gone or is not a text channel' };
        try {
            await channel.send({ content: String(text).slice(0, 2000), allowedMentions: { parse: [] } });
            return { ok: true };
        } catch (err) {
            log('warn', 'discord post failed', { guildId, channelId, error: err.message });
            return { ok: false, error: err.code === 50013 ? 'CertiFried cannot post in that channel (missing permission)' : 'Discord refused the message' };
        }
    }

    return {
        channelsFor,
        sendChat,
        postDiscord,
        postWebhook: (url, body, opts) => postWebhook(url, body, opts),
        dispatch: (d) => hub.dispatch(d),
        invalidate(profileId) { channelCache.delete(profileId); },
    };
}

/** Channels the user can link: only from connections that proved ownership through OAuth. */
export async function linkableChannels(db, ownerId, profileId, store) {
    const out = [];
    const add = (platform, id, login, via, label) => {
        if (!id) return;
        if (out.some((c) => c.platform === platform && c.id === String(id))) return;
        out.push({ platform, id: String(id), login: login ? String(login).toLowerCase() : null, displayName: login || null, via, label });
    };
    const grant = profileId ? await store.getTwitchGrant(profileId) : null;
    if (grant) add('twitch', grant.twitch_user_id, grant.twitch_login, 'stream_bot_grant', 'Stream bot grant');
    try {
        const [rows] = await db.query('SELECT twitch_user_id, twitch_username FROM twitch_oauth_accounts WHERE discord_user_id = ?', [String(ownerId)]);
        for (const r of rows) add('twitch', r.twitch_user_id, r.twitch_username, 'twitch_oauth_accounts', 'Linked Twitch account');
    } catch { /* table missing */ }
    try {
        const [rows] = await db.query("SELECT platform, platform_user_id, platform_username FROM stream_platform_accounts WHERE owner_discord_id = ? AND platform IN ('twitch', 'kick', 'youtube') AND status = 'active'", [String(ownerId)]);
        for (const r of rows) add(r.platform, r.platform_user_id, r.platform_username, 'stream_platform_accounts', ({ kick: 'Kick sign-in', youtube: 'YouTube sign-in' })[r.platform] || 'Multicast Twitch connection');
    } catch { /* table missing */ }
    return out;
}

/** Health of each linked channel, for the Connections page. */
export async function connectionHealth(db, store, profile) {
    const channels = await store.listChannels(profile.id);
    const grant = await store.getTwitchGrant(profile.id);
    const out = [];
    for (const c of channels) {
        if (c.platform === 'twitch') {
            let server = [];
            try {
                [server] = await db.query(`SELECT guild_id, token_scopes, tier_b_scopes, token_expires_at, broadcaster_token_status, tier_b_token_status FROM twitch_role_sync_config WHERE broadcaster_twitch_id = ? AND enabled = 1`, [String(c.platform_user_id)]);
            } catch { /* table missing */ }
            let subs = [];
            try {
                [subs] = await db.query('SELECT sub_type, status FROM twitch_eventsub_subscriptions WHERE broadcaster_id = ?', [String(c.platform_user_id)]);
            } catch { /* table missing */ }
            const grants = {};
            if (grant && String(grant.twitch_user_id) === String(c.platform_user_id) && grant.status === 'active') grants.streamBot = grant.scopes;
            const analytics = server.flatMap((s) => String(s.token_scopes || '').split(/[\s,]+/).filter(Boolean));
            const write = server.flatMap((s) => String(s.tier_b_scopes || '').split(/[\s,]+/).filter(Boolean));
            if (analytics.length) grants.serverAnalytics = analytics;
            if (write.length) grants.serverWrite = write;
            const enabled = subs.filter((s) => s.status === 'enabled').length;
            out.push({
                channel: c, platform: 'twitch',
                grants: {
                    streamBot: grant && String(grant.twitch_user_id) === String(c.platform_user_id) ? { status: grant.status, grantedAt: grant.granted_at, scopes: grant.scopes.length } : null,
                    serverAnalytics: server.length ? { servers: server.length, scopes: new Set(analytics).size, needsReauth: server.filter((s) => s.broadcaster_token_status === 'needs_reauth').length } : null,
                    serverWrite: write.length ? { servers: server.filter((s) => s.tier_b_scopes).length, scopes: new Set(write).size, needsReauth: server.filter((s) => s.tier_b_scopes && s.tier_b_token_status === 'needs_reauth').length } : null,
                },
                eventsub: { total: subs.length, enabled, failing: subs.length - enabled, types: subs.map((s) => ({ type: s.sub_type, status: s.status })) },
                coverage: coverage(grants),
                ok: enabled > 0,
            });
        } else if (c.platform === 'kick') {
            let webhook = { known: false, chat: null, missing: null, error: null };
            let lastChat = null;
            let chatSend = false;
            try {
                const m = await import('../../services/certifried-bot/kick-event-subscriptions.js');
                webhook = await m.subscriptionStatus(c.platform_user_id);
                lastChat = m.lastChatAt(c.platform_user_id);
            } catch (err) { webhook.error = err.message; }
            try {
                const [rows] = await db.query("SELECT defender_enabled FROM tokes_channels WHERE platform = 'kick' AND channel_id = ? AND is_enabled = 1", [String(c.platform_user_id)]);
                chatSend = !!rows[0]?.defender_enabled;
            } catch { /* table missing */ }
            // The Kick channel bot sign-in the stream bot's Kick actions use: the same join as defender/channel-tokens.js
            // resolveChannel, without its defender_enabled filter so the page can say when Kick Defender is off.
            let kickBot = null;
            try {
                const [rows] = await db.query(`SELECT c.defender_enabled, pc.scopes, pc.needs_relink, (pc.access_token IS NOT NULL AND pc.access_token <> '') AS has_token
                    FROM tokes_channels c JOIN tokes_platform_connections pc ON pc.id = c.connection_id
                    WHERE c.platform = 'kick' AND c.channel_id = ? ORDER BY c.defender_enabled DESC, pc.id DESC LIMIT 1`, [String(c.platform_user_id)]);
                const r = rows[0];
                kickBot = kickBotStatus(r ? { hasToken: !!Number(r.has_token), needsRelink: !!Number(r.needs_relink), defenderEnabled: !!Number(r.defender_enabled), scopes: r.scopes } : null);
            } catch { /* tables missing: the page says it could not check */ }
            out.push({ channel: c, platform: 'kick', webhook, lastChatAt: lastChat ? new Date(lastChat) : null, chatSend, kickBot, ok: webhook.known ? webhook.missing?.length === 0 : false });
        } else if (c.platform === 'youtube') {
            // YouTube Live (H-741): the sign-in on file for this channel (stream_platform_accounts). Live and chat state come from
            // the YouTube service (core/stream-bot/youtube), which the Connections route adds.
            let signIn = 'unknown';
            let scopes = [];
            try {
                const [rows] = await db.query("SELECT platform_user_id, status, scopes FROM stream_platform_accounts WHERE owner_discord_id = ? AND platform = 'youtube' LIMIT 1", [String(profile.ownerDiscordId)]);
                const a = rows[0];
                scopes = String(a?.scopes || '').split(/[\s,]+/).filter(Boolean);
                signIn = !a ? 'missing' : String(a.platform_user_id) !== String(c.platform_user_id) ? 'other_channel' : a.status !== 'active' ? 'needs_reconnect' : 'ok';
            } catch { /* table missing */ }
            out.push({ channel: c, platform: 'youtube', youtube: { signIn, scopes }, ok: signIn === 'ok' });
        }
    }
    return out;
}

export default { createIo, linkableChannels, connectionHealth };
