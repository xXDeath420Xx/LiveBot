/*
 * OBS docks for the stream bot (core/stream-bot/dock.js, design §5.10): small pages OBS shows as custom browser docks.
 * OBS docks do not share the person's browser session, so each page is opened with a dock key (?key=sbk_…) that
 * CertiFried Studio asked for and put into OBS. The key can only read this profile's live feed, automations and
 * counters, and run an automation; it is revoked on the Devices page or replaced from Studio.
 *
 *   GET  /stream/bot/dock/activity        live events (chat left out)            ?key=  &theme=light|sand
 *   GET  /stream/bot/dock/controls        enabled automations with Run, channel counters
 *   GET  /stream/bot/dock/chat            Twitch and Kick chat (and YouTube once it is set up, §13.10); an input row and per-line
 *                                         delete, timeout and ban when the key has the 'chat' capability
 *   GET  /stream/bot/dock/api/feed        SSE (?key=, because EventSource cannot send headers) &kind=activity|chat
 *   GET  /stream/bot/dock/api/state       automations and counters (X-Dock-Key)
 *   POST /stream/bot/dock/api/run         { automationId } (X-Dock-Key); CSRF-exempt in server.js: no session, no cookie
 *   POST /stream/bot/dock/api/chat        { platform, text }                                  capability 'chat'
 *   POST /stream/bot/dock/api/moderate    { platform, action: delete|timeout|ban, messageId?, userId?, seconds? }   capability 'chat'
 *   GET  /stream/bot/dock/api/channel     title and category of the linked channels (X-Dock-Key)
 *   POST /stream/bot/dock/api/channel     { platform, title?, category? }                     capability 'channel'
 *   GET  /stream/bot/dock/api/categories  ?platform=&q=  autocomplete                         capability 'channel'
 *   (the four writes are CSRF-exempt in server.js like run: the dock key header is the credential)
 *
 * Capabilities live on the dock key's device row (core/stream-bot/dock.js). A key made before chat existed has neither, so
 * it never silently gains them: the owner switches them on per key on the Devices page (stream-bot-live.js). 403 without.
 * Chat and moderation act as the streamer on their own linked channels only (core/stream-bot/live-tools.js).
 *
 * Rate limits per key and IP: pages and state 60 a minute, run 20 a minute, chat 20 a minute, moderation 30 a minute,
 * channel edits 20 a minute, feed connections 30 a minute; at most 3 open feeds per key (the oldest is closed).
 * Responses carry no-store, no-referrer and noindex.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import logger from '../../utils/logger.js';
import { getStreamBot } from '../../core/stream-bot/index.js';
import { createDockKeys, isDockKey, trackDockStream, DOCK_CHAT, DOCK_CHANNEL } from '../../core/stream-bot/dock.js';
import { createLiveTools, ToolError, MOD_RECONNECT } from '../../core/stream-bot/live-tools.js';
import { eventType, describeEvent } from '../../core/stream-bot/events.js';
import { hashSecret } from '../../core/stream-bot/pairing.js';
import { PLATFORM_LABEL } from '../services/stream-bot-view.js';
import { youtubeBotConfig } from '../../core/stream-bot/youtube/config.js';

const LOG = '[StreamBotDock]';
const clientIp = (req) => req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
const keyOf = (req) => String(req.get('x-dock-key') || req.query.key || '');
const THEMES = new Set(['dark', 'light', 'sand']);

export function createDockRouter({ getSb = getStreamBot, limits: limitOverrides = {}, heartbeatMs = 25_000, recheckMs = 60_000, runWaitMs = 10_000 } = {}) {
    const router = express.Router();
    const limits = { page: 60, run: 20, feed: 30, chat: 20, mod: 30, channel: 20, ...limitOverrides };
    const json = express.json({ limit: '2kb' });
    const limiter = (max, message) => rateLimit({
        windowMs: 60_000, max, standardHeaders: true, legacyHeaders: false,
        keyGenerator: (req) => `${clientIp(req)}|${isDockKey(keyOf(req)) ? hashSecret(keyOf(req)).slice(0, 16) : '-'}`,
        message: { ok: false, error: 'rate_limited', message },
    });
    const pageLimiter = limiter(limits.page, 'Too many requests. Wait a minute.');
    const runLimiter = limiter(limits.run, 'Too many runs. Wait a minute.');
    const feedLimiter = limiter(limits.feed, 'Reconnecting too often. Wait a minute.');
    const chatLimiter = limiter(limits.chat, 'Too many chat messages. Wait a minute.');
    const modLimiter = limiter(limits.mod, 'Too many moderation actions. Wait a minute.');
    const channelLimiter = limiter(limits.channel, 'Too many changes. Wait a minute.');

    let keys = null;
    async function resolve(req) {
        const sb = await getSb();
        keys ||= createDockKeys({ store: sb.store });
        const r = await keys.resolve(keyOf(req));
        if (r) sb.store.touchDevice(r.device.id, {}).catch(() => {});
        return r ? { sb, ...r } : null;
    }

    const toolsFor = (sb) => createLiveTools({ store: sb.store, helix: sb.helix, kick: sb.kick, streamInfo: sb.streamInfo, sendChat: (m) => sb.io.sendChat(m) });
    /** The dock key's own capabilities (the device row), never anything the page sends. */
    const can = (r, cap) => Array.isArray(r.device.capabilities) && r.device.capabilities.includes(cap);
    const within = (ms, p) => Promise.race([p, new Promise((ok) => { const t = setTimeout(() => ok(null), ms); t.unref?.(); })]);
    function toolFail(res, err) {
        if (err instanceof ToolError) {
            return res.status(err.status).json({ ok: false, error: err.code, message: err.message, ...(err.applied ? { applied: err.applied } : {}), ...(err.scope ? { scope: err.scope } : {}) });
        }
        logger.error(`${LOG} tool failed`, { error: err?.message });
        return res.status(500).json({ ok: false, error: 'server_error', message: 'Something went wrong. Try again.' });
    }
    const needCap = (res, cap) => res.status(403).json({ ok: false, error: 'capability_off', message: cap === DOCK_CHAT
        ? 'Chat is off for this dock key. Turn it on for this key on the Devices page.'
        : 'Title and category editing is off for this dock key. Turn it on for this key on the Devices page.' });

    function headers(req, res, next) {
        res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' });
        next();
    }
    const theme = (req) => (THEMES.has(String(req.query.theme)) ? String(req.query.theme) : 'dark');

    function denied(req, res, api = false) {
        if (api) return res.status(401).json({ ok: false, error: 'dock_key', message: 'This dock key was replaced or removed.' });
        return res.status(401).render('stream-bot/dock', { theme: theme(req), page: 'denied', title: 'CertiFried', data: null });
    }

    const eventItem = (e) => ({
        id: e.id ?? null, type: e.type, typeLabel: eventType(e.type)?.label || e.type, platform: e.platform,
        platformLabel: PLATFORM_LABEL[e.platform] || e.platform, text: describeEvent(e), user: e.user?.name || null,
        message: e.message || null, at: new Date(e.occurredAt || e.createdAt || Date.now()).toISOString(),
        // Chat lines carry what the per-line actions need. Both ids are public chat data of the owner's own channel.
        ...(e.type === 'chat' ? { messageId: e.metadata?.messageId ? String(e.metadata.messageId).slice(0, 64) : null, userId: e.user?.id ? String(e.user.id).slice(0, 20) : null } : {}),
    });

    async function controlsData(store, profileId) {
        const [automations, counters] = await Promise.all([store.listAutomations(profileId), store.listVariables(profileId, { owner: 'server', limit: 50 })]);
        return {
            automations: automations.filter((a) => a.enabled).slice(0, 100).map((a) => ({ id: a.id, name: a.name, trigger: eventType(a.trigger_type)?.label || a.trigger_type })),
            counters: counters.map((v) => ({ key: v.key_name, value: String(v.value_text ?? '').slice(0, 60) })),
        };
    }

    /** What the chat dock shows beyond the feed: the input row and the per-line actions, only for a key with the chat capability. */
    async function chatPanel(r) {
        if (!can(r, DOCK_CHAT)) return { enabled: false };
        const tools = toolsFor(r.sb);
        const [linked, mod] = await Promise.all([tools.linked(r.profile), tools.modAbilities(r.profile)]);
        return { enabled: true, platforms: ['twitch', 'kick'].filter((p) => linked[p]), mod: { delete: mod.delete, ban: mod.ban, connected: mod.connected }, reconnect: MOD_RECONNECT };
    }

    /** Title and category editor on the Controls dock: current values (best effort, 4 s) and whether this key may change them. */
    async function channelPanel(r) {
        const enabled = can(r, DOCK_CHANNEL);
        const channels = r.sb.streamInfo ? ((await within(4000, toolsFor(r.sb).channelInfo(r.profile).catch(() => []))) || []) : [];
        return { enabled, channels: channels.map(({ platform, label, title, category }) => ({ platform, label, title: title || '', category: category || '' })) };
    }

    async function page(req, res, kind) {
        try {
            const r = await resolve(req);
            if (!r) return denied(req, res);
            const { store } = r.sb;
            let data;
            if (kind === 'activity') {
                data = { events: (await store.listEvents(r.profile.id, { limit: 80 })).filter((e) => e.type !== 'chat').slice(0, 50).map(eventItem) };
            } else if (kind === 'chat') {
                data = { events: (await store.listEvents(r.profile.id, { type: 'chat', limit: 50 })).map(eventItem), storeChat: !!r.profile.storeChat, youtube: youtubeBotConfig().enabled,
                    chat: await chatPanel(r) };
            } else {
                data = { ...(await controlsData(store, r.profile.id)), channel: await channelPanel(r) };
            }
            const titles = { activity: 'Activity', controls: 'Controls', chat: 'Chat' };
            return res.render('stream-bot/dock', { theme: theme(req), page: kind, title: titles[kind], data });
        } catch (err) {
            logger.error(`${LOG} page failed`, { page: kind, error: err?.message });
            return res.status(500).render('stream-bot/dock', { theme: theme(req), page: 'error', title: 'CertiFried', data: null });
        }
    }

    router.get('/stream/bot/dock/activity', pageLimiter, headers, (req, res) => page(req, res, 'activity'));
    router.get('/stream/bot/dock/controls', pageLimiter, headers, (req, res) => page(req, res, 'controls'));
    router.get('/stream/bot/dock/chat', pageLimiter, headers, (req, res) => page(req, res, 'chat'));

    router.get('/stream/bot/dock/api/state', pageLimiter, headers, async (req, res) => {
        try {
            const r = await resolve(req);
            if (!r) return denied(req, res, true);
            return res.json({ ok: true, ...(await controlsData(r.sb.store, r.profile.id)) });
        } catch (err) {
            logger.error(`${LOG} state failed`, { error: err?.message });
            return res.status(500).json({ ok: false, error: 'server_error' });
        }
    });

    router.post('/stream/bot/dock/api/run', runLimiter, headers, json, async (req, res) => {
        try {
            const r = await resolve(req);
            if (!r) return denied(req, res, true);
            const id = Number(req.body?.automationId);
            if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'bad_params', message: 'Pick an automation.' });
            const a = await r.sb.store.getAutomation(r.profile.id, id);
            if (!a) return res.status(404).json({ ok: false, error: 'not_found', message: 'That automation does not exist.' });
            if (!a.enabled) return res.status(409).json({ ok: false, error: 'disabled', message: 'That automation is turned off.' });
            const ev = { platform: 'studio', type: a.trigger_type, channelId: null, user: null, amount: null, currency: null, message: null,
                metadata: { via: 'dock' }, raw: null, occurredAt: new Date(), dedupeKey: null };
            const running = r.sb.engine.runAutomation(r.profile, a, ev, { source: 'dock', manual: true });
            running.catch((e) => logger.warn(`${LOG} run failed`, { error: e?.message }));
            let timer;
            const out = await Promise.race([running, new Promise((ok) => { timer = setTimeout(() => ok(null), runWaitMs); timer.unref?.(); })]);
            clearTimeout(timer);
            return res.json({ ok: true, runId: out?.runId ?? null, status: out ? out.status : 'running' });
        } catch (err) {
            logger.error(`${LOG} run failed`, { error: err?.message });
            return res.status(500).json({ ok: false, error: 'server_error', message: 'Something went wrong. Try again.' });
        }
    });

    router.post('/stream/bot/dock/api/chat', chatLimiter, headers, json, async (req, res) => {
        try {
            const r = await resolve(req);
            if (!r) return denied(req, res, true);
            if (!can(r, DOCK_CHAT)) return needCap(res, DOCK_CHAT);
            const out = await toolsFor(r.sb).say(r.profile, { platform: String(req.body?.platform || ''), text: req.body?.text });
            return res.json({ ok: true, ...out });
        } catch (err) {
            return toolFail(res, err);
        }
    });

    router.post('/stream/bot/dock/api/moderate', modLimiter, headers, json, async (req, res) => {
        try {
            const r = await resolve(req);
            if (!r) return denied(req, res, true);
            if (!can(r, DOCK_CHAT)) return needCap(res, DOCK_CHAT);
            const b = req.body || {};
            const out = await toolsFor(r.sb).moderate(r.profile, { platform: String(b.platform || ''), action: String(b.action || ''), messageId: b.messageId, userId: b.userId, seconds: b.seconds });
            return res.json({ ok: true, ...out });
        } catch (err) {
            return toolFail(res, err);
        }
    });

    router.get('/stream/bot/dock/api/channel', pageLimiter, headers, async (req, res) => {
        try {
            const r = await resolve(req);
            if (!r) return denied(req, res, true);
            return res.json({ ok: true, enabled: can(r, DOCK_CHANNEL), channels: await toolsFor(r.sb).channelInfo(r.profile) });
        } catch (err) {
            return toolFail(res, err);
        }
    });

    router.post('/stream/bot/dock/api/channel', channelLimiter, headers, json, async (req, res) => {
        try {
            const r = await resolve(req);
            if (!r) return denied(req, res, true);
            if (!can(r, DOCK_CHANNEL)) return needCap(res, DOCK_CHANNEL);
            const b = req.body || {};
            const out = await toolsFor(r.sb).channelUpdate(r.profile, { platform: String(b.platform || ''), title: b.title, category: b.category });
            return res.json({ ok: true, ...out });
        } catch (err) {
            return toolFail(res, err);
        }
    });

    router.get('/stream/bot/dock/api/categories', pageLimiter, headers, async (req, res) => {
        try {
            const r = await resolve(req);
            if (!r) return denied(req, res, true);
            if (!can(r, DOCK_CHANNEL)) return needCap(res, DOCK_CHANNEL);
            return res.json({ ok: true, categories: await toolsFor(r.sb).categories(r.profile, { platform: String(req.query.platform || ''), q: String(req.query.q || '') }) });
        } catch (err) {
            return toolFail(res, err);
        }
    });

    router.get('/stream/bot/dock/api/feed', feedLimiter, headers, async (req, res) => {
        let r;
        try { r = await resolve(req); } catch { r = null; }
        if (!r) return denied(req, res, true);
        const kind = req.query.kind === 'chat' ? 'chat' : 'activity';
        res.status(200).set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.flushHeaders?.();
        res.write('retry: 5000\n\n');
        let closed = false;
        const write = (s) => { if (!closed) { try { res.write(s); } catch { /* gone */ } } };
        const off = r.sb.feed.subscribe(r.profile.id, (ev) => {
            if (ev?.type === '_closed') return close();
            if ((kind === 'chat') !== (ev?.type === 'chat')) return undefined;
            write(`data: ${JSON.stringify(eventItem(ev))}\n\n`);
            return undefined;
        });
        const untrack = trackDockStream(r.device.id, () => close());
        const beat = setInterval(() => write(': ping\n\n'), heartbeatMs);
        const recheck = setInterval(async () => {
            try { if (!(await keys.resolve(keyOf(req)))) close(); } catch { /* try again next time */ }
        }, recheckMs);
        function close() {
            if (closed) return;
            closed = true;
            clearInterval(beat);
            clearInterval(recheck);
            try { off(); } catch { /* ignore */ }
            untrack();
            try { res.write('event: closed\ndata: {}\n\n'); res.end(); } catch { /* gone */ }
        }
        req.on('close', close);
        res.on('close', close);
        return undefined;
    });

    return router;
}

export default createDockRouter();
