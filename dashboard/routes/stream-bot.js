/*
 * Stream bot dashboard (docs/superpowers/specs/2026-11-19-stream-bot-design.md §2.7): the /stream/bot pages
 * and the /stream/bot/api JSON API, for the signed-in CertiFried user only.
 *
 *   Pages   GET /stream/bot                     overview: channels, devices online, today, latest events, live feed
 *           GET /stream/bot/events              event log (text, type, platform, before-cursor paging)
 *           GET /stream/bot/automations         list with on/off and last run
 *           GET /stream/bot/automations/new     editor (new)
 *           GET /stream/bot/automations/:id     editor (existing)
 *           GET /stream/bot/runs                run history (status and automation filters)
 *           GET /stream/bot/runs/:id            one run: checks, steps, dispatches
 *           GET /stream/bot/connections         channels, Twitch grant, coverage, tip sources, settings
 *           GET /stream/bot/devices             paired devices, pairing code, overlay token
 *           GET /stream/bot/sounds              the sound library CertiFried Studio syncs (Phase 2)
 *   API     /stream/bot/api/...                 see each route below; 401 JSON without a session
 *           POST /stream/bot/api/pair           the only session-less route (CSRF-exempt in server.js):
 *                                               10 tries a minute per IP, and no more than 60 failed tries a
 *                                               minute in total
 *           GET /stream/bot/api/device/sounds/:id  CertiFried Studio downloads a library sound with its device token
 *                                               (Authorization: Bearer sbd_...); no session, rate-limited per IP
 *
 * Every query goes through core/stream-bot/store.js with the profile id of the signed-in user; no profile id is
 * ever read from a request. Literal paths are registered before /:param paths (tests/stream-bot-pages.test.js).
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { getStreamBot } from '../../core/stream-bot/index.js';
import { EVENT_TYPES, ROLES, PLATFORMS, TIP_SOURCES, eventType, isEventType, sampleEvent, publicEvent, describeEvent } from '../../core/stream-bot/events.js';
import { CONDITION_TYPES, validateTrigger, validateConditions } from '../../core/stream-bot/conditions.js';
import { ACTION_TYPES, actionType, validateActions, childLists } from '../../core/stream-bot/actions.js';
import { reapproveNeeded } from '../../core/stream-bot/scopes.js';
import { templateWarnings } from '../../core/stream-bot/render.js';
import { linkableChannels, connectionHealth } from '../../core/stream-bot/live.js';
import { normaliseAllowList } from '../../core/stream-bot/webhook-out.js';
import { newPairingCode, newDeviceToken, hashSecret, tokenHint, normaliseCode, isTokenShape, CODE_TTL_MS } from '../../core/stream-bot/pairing.js';
import { SOUND_LIMITS } from '../../core/stream-bot/sounds.js';
import { closeDockStreams } from '../../core/stream-bot/dock.js';

/** Phase 2c: connected Studios refresh their automation list and voice phrases. */
const automationsChanged = (sb, profileId) => { try { sb.hub.notify(profileId, 'studio', { type: 'automations_changed' }); } catch { /* not attached */ } };
import fs from 'node:fs';
import {
    PLATFORM_LABEL, TIP_LABEL, managedGuilds, eventView, catalog, guildIdsIn, automationSummary, runView, dispatchView, deviceView,
    tipSourceView, connectionNotice, scopeRows, studioView, soundView, youtubePanel,
} from '../services/stream-bot-view.js';

const router = express.Router();
const LOG = '[StreamBotUI]';
const DASHBOARD_URL = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/+$/, '');
export const WS_URL = (() => {
    try { return `wss://${new URL(DASHBOARD_URL).host}/stream/bot/ws`; } catch { return 'wss://certifriedmultitool.com/stream/bot/ws'; }
})();

export const MAX_AUTOMATIONS = 200;
const RUN_STATUSES = Object.freeze(['ok', 'partial', 'failed', 'skipped', 'running']);
const TEST_WAIT_MS = 10_000;
const SNOWFLAKE = /^\d{17,20}$/;
const onlineOf = (sb, profileId) => ({ studio: sb.hub.hasDevice(profileId, 'studio'), overlay: sb.hub.hasDevice(profileId, 'overlay') });

// ── session gates ───────────────────────────────────────────────────────────────────────────

const signedIn = (req) => !!(req.isAuthenticated?.() && req.user?.id);

/** Pages: sign in with Discord, then come back here. */
function needPage(req, res, next) {
    if (signedIn(req)) return next();
    const back = /^\/stream\/bot(\/|$|\?)/.test(req.originalUrl || '') ? req.originalUrl.slice(0, 300) : '/stream/bot';
    return res.redirect('/auth/discord?returnTo=' + encodeURIComponent(back));
}

/** API: 401 JSON, no redirect. */
function needApi(req, res, next) {
    if (signedIn(req)) return next();
    return res.status(401).json({ ok: false, error: 'You are signed out. Sign in again and retry.' });
}

const pageRoute = (fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (err) {
        logger.error(`${LOG} page failed`, { path: req.path, error: err?.message });
        if (!res.headersSent) res.status(500).render('error-tailwind', { user: req.user, error: 'The stream bot page could not be loaded. Try again in a minute.' });
    }
};
const apiRoute = (fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (err) {
        logger.error(`${LOG} api failed`, { path: req.path, method: req.method, error: err?.message });
        if (!res.headersSent) res.status(500).json({ ok: false, error: 'Something went wrong. Try again.' });
    }
};

async function load(req) {
    const sb = await getStreamBot();
    const profile = await sb.store.ensureProfile(req.user.id, req.user.global_name || req.user.username || null);
    return { sb, profile };
}

const idOf = (v) => (/^\d{1,15}$/.test(String(v ?? '')) ? Number(v) : null);
const str = (v, max) => String(v ?? '').trim().slice(0, max);

// ── Discord servers the user manages ────────────────────────────────────────────────────────

const botIn = (guildId) => {
    try { return !!globalThis.botManager?.getClientForGuild?.(guildId)?.guilds?.cache?.has(guildId); } catch { return false; }
};

/** Servers the user manages and CertiFried is in (the Discord post action's picker). */
function postableGuilds(user) {
    return managedGuilds(user).filter((g) => botIn(g.id)).sort((a, b) => a.name.localeCompare(b.name));
}

/** Text and announcement channels the bot can see and post in. */
function postableChannels(guildId) {
    const guild = globalThis.botManager?.getClientForGuild?.(guildId)?.guilds?.cache?.get(guildId);
    if (!guild) return [];
    const me = guild.members?.me || null;
    const out = [];
    for (const c of guild.channels.cache.values()) {
        if (c.type !== 0 && c.type !== 5) continue;
        try { if (me && !c.permissionsFor(me)?.has(['ViewChannel', 'SendMessages'])) continue; } catch { continue; }
        out.push({ id: String(c.id), name: String(c.name), position: c.rawPosition ?? 0 });
    }
    return out.sort((a, b) => a.position - b.position).map(({ id, name }) => ({ id, name }));
}

// ── reads for the pages ─────────────────────────────────────────────────────────────────────

/** Linked channels with the newest live / offline event from the log (test events left out). */
async function liveState(store, profileId, channels) {
    const [on, off] = await Promise.all([
        store.listEvents(profileId, { type: 'stream.online', limit: 50, includeTest: false }),
        store.listEvents(profileId, { type: 'stream.offline', limit: 50, includeTest: false }),
    ]);
    const latest = new Map();
    for (const e of [...on, ...off]) {
        const k = `${e.platform}:${e.channelId}`;
        const prev = latest.get(k);
        if (!prev || e.id > prev.id) latest.set(k, e);
    }
    return channels.map((c) => {
        const e = latest.get(`${c.platform}:${c.platform_user_id}`);
        return { ...c, live: e ? e.type === 'stream.online' : null, liveSince: e ? new Date(e.occurredAt).toISOString() : null };
    });
}

/** Run a slow read with a time limit; null on timeout or error. */
async function within(ms, promise) {
    let t;
    try {
        return await Promise.race([promise, new Promise((r) => { t = setTimeout(() => r(null), ms); t.unref?.(); })]);
    } catch {
        return null;
    } finally {
        clearTimeout(t);
    }
}

function startOfTodayUtc() {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ── tip sources ─────────────────────────────────────────────────────────────────────────────

const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SOCKET_TOKEN = /^[A-Za-z0-9._-]{20,2000}$/;

/** What the user can add as each tip source (servers with Ko-fi / Fourthwall, their Throne and BMC links). */
async function tipOptions(user) {
    const managed = managedGuilds(user);
    const ids = managed.map((g) => g.id);
    const name = new Map(managed.map((g) => [g.id, g.name]));
    const out = { kofi: [], fourthwall: [], throne: null, bmac: false };
    if (ids.length) {
        try {
            const [rows] = await pool.query('SELECT guild_id FROM kofi_config WHERE enabled = 1 AND guild_id IN (?)', [ids]);
            out.kofi = rows.map((r) => ({ id: String(r.guild_id), name: name.get(String(r.guild_id)) || String(r.guild_id) }));
        } catch { /* table missing */ }
        try {
            const [rows] = await pool.query('SELECT DISTINCT guild_id FROM fourthwall_connections WHERE guild_id IN (?)', [ids]);
            out.fourthwall = rows.map((r) => ({ id: String(r.guild_id), name: name.get(String(r.guild_id)) || String(r.guild_id) }));
        } catch { /* table missing */ }
    }
    try {
        const [rows] = await pool.query('SELECT throne_username FROM throne_user_links WHERE user_id = ?', [String(user.id)]);
        out.throne = rows[0]?.throne_username ? String(rows[0].throne_username).toLowerCase() : null;
    } catch { /* table missing */ }
    try {
        const [rows] = await pool.query('SELECT 1 AS ok FROM bmc_user_links WHERE user_id = ? LIMIT 1', [String(user.id)]);
        out.bmac = rows.length > 0;
    } catch { /* table missing */ }
    return out;
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// Pages
// ════════════════════════════════════════════════════════════════════════════════════════════

router.get('/stream/bot', needPage, pageRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    const { store } = sb;
    const [channels, events, counts, automations, grant] = await Promise.all([
        store.listChannels(profile.id), store.listEvents(profile.id, { limit: 20 }), store.eventCountsSince(profile.id, startOfTodayUtc()),
        store.listAutomations(profile.id), store.getTwitchGrant(profile.id),
    ]);
    const health = (await within(4000, connectionHealth(pool, store, profile))) || [];
    const okById = new Map(health.map((h) => [h.channel.id, h.ok]));
    const withLive = await liveState(store, profile.id, channels);
    res.render('stream-bot/overview', {
        user: req.user, active: 'overview', pageTitle: 'Overview', profile,
        channels: withLive.map((c) => ({ id: c.id, platform: c.platform, platformLabel: PLATFORM_LABEL[c.platform] || c.platform, login: c.login, displayName: c.display_name || c.login,
            live: c.live, liveSince: c.liveSince, ok: okById.has(c.id) ? okById.get(c.id) : null })),
        devicesOnline: sb.hub.connected(profile.id).map((d) => ({ ...d, connectedAt: d.connectedAt.toISOString() })),
        counts: counts.map((c) => ({ type: c.type, label: eventType(c.type)?.label || c.type, n: Number(c.n), total: c.total == null ? null : Number(c.total) })),
        events: events.map(eventView),
        automationCount: automations.length, enabledCount: automations.filter((a) => a.enabled).length,
        grant: grant ? { login: grant.twitch_login, status: grant.status } : null,
    });
}));

router.get('/stream/bot/events', needPage, pageRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    const filters = {
        q: str(req.query.q, 100),
        type: isEventType(String(req.query.type || '')) ? String(req.query.type) : '',
        platform: PLATFORMS.includes(String(req.query.platform || '')) ? String(req.query.platform) : '',
        before: idOf(req.query.before),
    };
    const PAGE = 50;
    const events = await sb.store.listEvents(profile.id, { ...filters, limit: PAGE });
    const qs = (extra) => {
        const p = new URLSearchParams();
        for (const k of ['q', 'type', 'platform']) if (filters[k]) p.set(k, filters[k]);
        for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
        const s = p.toString();
        return `/stream/bot/events${s ? `?${s}` : ''}`;
    };
    res.render('stream-bot/events', {
        user: req.user, active: 'events', pageTitle: 'Events', profile,
        events: events.map(eventView), filters,
        types: EVENT_TYPES.map((t) => ({ type: t.type, label: t.label })),
        platforms: PLATFORMS.map((p) => ({ id: p, label: PLATFORM_LABEL[p] || p })),
        olderHref: events.length === PAGE ? qs({ before: events[events.length - 1].id }) : null,
        newestHref: filters.before ? qs({}) : null,
    });
}));

router.get('/stream/bot/automations', needPage, pageRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    const list = await sb.store.listAutomations(profile.id);
    const online = onlineOf(sb, profile.id);
    res.render('stream-bot/automations', {
        user: req.user, active: 'automations', pageTitle: 'Automations', profile,
        automations: list.map((a) => automationSummary(a, online)), max: MAX_AUTOMATIONS,
    });
}));

async function renderEditor(req, res, automation) {
    const { sb, profile } = await load(req);
    const list = await sb.store.listAutomations(profile.id);
    const channels = await sb.store.listChannels(profile.id);
    const guilds = postableGuilds(req.user);
    const allowed = new Set(guilds.map((g) => g.id));
    const guildChannels = {};
    for (const gid of guildIdsIn(automation?.actions)) if (allowed.has(gid)) guildChannels[gid] = postableChannels(gid);
    res.render('stream-bot/automation-edit', {
        user: req.user, active: 'automations', pageTitle: automation ? automation.name : 'New automation', profile, automation,
        editorData: {
            automation: automation ? { id: automation.id, name: automation.name, enabled: automation.enabled, trigger_type: automation.trigger_type,
                trigger_config: automation.trigger_config || {}, conditions: automation.conditions || [], actions: automation.actions || [] } : null,
            catalog: catalog(onlineOf(sb, profile.id)),
            automations: list.map((a) => ({ id: a.id, name: a.name })),
            guilds: guilds.map(({ id, name }) => ({ id, name })), guildChannels,
            linkedPlatforms: [...new Set(channels.map((c) => c.platform))],
            atLimit: !automation && list.length >= MAX_AUTOMATIONS, max: MAX_AUTOMATIONS,
            studio: await studioSuggestions(sb, profile),
        },
    });
}

/** What the editor offers in the OBS and sound fields: the newest state a Studio reported (live first, else saved). */
async function studioSuggestions(sb, profile) {
    const live = sb.hub.connected(profile.id).find((d) => d.kind === 'studio' && d.state);
    const saved = profile.settings?.studio || null;
    const state = live?.state || saved || null;
    let library = [];
    try { library = (await sb.sounds.list(profile.id)).map((x) => x.name); } catch { /* no library yet */ }
    return {
        online: sb.hub.hasDevice(profile.id, 'studio'),
        reportedAt: live ? new Date().toISOString() : (saved?.reportedAt || null),
        obs: state?.obs || null,
        sounds: [...new Set([...library, ...(state?.sounds || [])])].slice(0, 500),
    };
}

router.get('/stream/bot/automations/new', needPage, pageRoute(async (req, res) => renderEditor(req, res, null)));

router.get('/stream/bot/automations/:id', needPage, pageRoute(async (req, res) => {
    const id = idOf(req.params.id);
    const { sb, profile } = await load(req);
    const a = id ? await sb.store.getAutomation(profile.id, id) : null;
    if (!a) return res.status(404).render('error-tailwind', { user: req.user, error: 'That automation does not exist. It may have been deleted.' });
    return renderEditor(req, res, a);
}));

router.get('/stream/bot/runs', needPage, pageRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    const filters = {
        status: RUN_STATUSES.includes(String(req.query.status || '')) ? String(req.query.status) : '',
        automation: idOf(req.query.automation),
        before: idOf(req.query.before),
    };
    const PAGE = 50;
    const [runs, automations] = await Promise.all([
        sb.store.listRuns(profile.id, { automationId: filters.automation, status: filters.status, before: filters.before, limit: PAGE }),
        sb.store.listAutomations(profile.id),
    ]);
    const qs = (extra) => {
        const p = new URLSearchParams();
        if (filters.status) p.set('status', filters.status);
        if (filters.automation) p.set('automation', String(filters.automation));
        for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
        const s = p.toString();
        return `/stream/bot/runs${s ? `?${s}` : ''}`;
    };
    res.render('stream-bot/runs', {
        user: req.user, active: 'runs', pageTitle: 'Run history', profile,
        runs: runs.map(runView), filters, statuses: RUN_STATUSES,
        automations: automations.map((a) => ({ id: a.id, name: a.name })),
        olderHref: runs.length === PAGE ? qs({ before: runs[runs.length - 1].id }) : null,
        newestHref: filters.before ? qs({}) : null,
    });
}));

router.get('/stream/bot/runs/:id', needPage, pageRoute(async (req, res) => {
    const id = idOf(req.params.id);
    const { sb, profile } = await load(req);
    const run = id ? await sb.store.getRun(profile.id, id) : null;
    if (!run) return res.status(404).render('error-tailwind', { user: req.user, error: 'That run does not exist. Runs are kept for 30 days.' });
    const [dispatches, automation] = await Promise.all([
        sb.store.dispatchesForRun(profile.id, run.id),
        run.automationId ? sb.store.getAutomation(profile.id, run.automationId) : null,
    ]);
    res.render('stream-bot/run', {
        user: req.user, active: 'runs', pageTitle: `Run ${run.id}`, profile,
        run: runView(run), dispatches: dispatches.map(dispatchView), automationExists: !!automation,
        stepLabels: Object.fromEntries(ACTION_TYPES.map((a) => [a.type, a.label]).concat([['random', 'Pick one at random']])),
        conditionLabels: Object.fromEntries(CONDITION_TYPES.map((c) => [c.type, c.label])),
    });
}));

router.get('/stream/bot/connections', needPage, pageRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    const { store } = sb;
    const [linkable, grant, tipSources, options, health] = await Promise.all([
        linkableChannels(pool, req.user.id, profile.id, store), store.getTwitchGrant(profile.id), store.listTipSources(profile.id),
        tipOptions(req.user), within(8000, connectionHealth(pool, store, profile)),
    ]);
    const linked = await store.listChannels(profile.id);
    const linkedKeys = new Set(linked.map((c) => `${c.platform}:${c.platform_user_id}`));
    const healthById = new Map((health || []).map((h) => [h.channel.id, h]));
    const guildNames = new Map(managedGuilds(req.user).map((g) => [g.id, g.name]));
    res.render('stream-bot/connections', {
        user: req.user, active: 'connections', pageTitle: 'Connections', profile,
        notice: connectionNotice(req.query),
        channels: linked.map((c) => {
            const h = healthById.get(c.id) || null;
            return {
                id: c.id, platform: c.platform, platformLabel: PLATFORM_LABEL[c.platform] || c.platform, login: c.login, displayName: c.display_name || c.login,
                channelId: c.platform_user_id, verifiedVia: c.verified_via, linkedAt: c.linked_at ? new Date(c.linked_at).toISOString() : null,
                health: h ? {
                    ok: h.ok, grants: h.grants || null, eventsub: h.eventsub ? { total: h.eventsub.total, enabled: h.eventsub.enabled, failing: h.eventsub.failing } : null,
                    coverage: h.coverage || null, webhook: h.webhook ? { known: h.webhook.known, chat: h.webhook.chat, missing: h.webhook.missing, error: h.webhook.error ? 'Kick did not answer' : null } : null,
                    lastChatAt: h.lastChatAt ? new Date(h.lastChatAt).toISOString() : null, chatSend: h.chatSend ?? null, kickBot: h.kickBot ?? null, youtube: h.youtube ?? null,
                } : null,
            };
        }),
        linkable: linkable.filter((c) => !linkedKeys.has(`${c.platform}:${c.id}`)).map((c) => ({ platform: c.platform, platformLabel: PLATFORM_LABEL[c.platform] || c.platform, id: c.id, login: c.login, label: c.label })),
        grant: grant ? { login: grant.twitch_login, status: grant.status, grantedAt: grant.granted_at ? new Date(grant.granted_at).toISOString() : null, scopes: grant.scopes } : null,
        scopes: scopeRows(),
        // Scopes added after this grant was made (stream actions): what re-approving turns on.
        reapprove: grant && grant.status === 'active' ? reapproveNeeded(grant.scopes) : [],
        tipSources: tipSources.map((s) => tipSourceView(s, guildNames)),
        tipOptions: options,
        botSettings: { storeChat: profile.storeChat, webhookAllowHosts: profile.webhookAllowHosts || [] },
        youtube: youtubePanel(sb.youtube, profile.id),   // YouTube Live (H-741): off and why, or live state and quota
    });
}));

router.get('/stream/bot/devices', needPage, pageRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    const devices = await sb.store.listDevices(profile.id);
    const connected = sb.hub.connected(profile.id);
    const onlineIds = new Set(connected.map((d) => d.deviceId));
    const live = new Map(connected.map((d) => [d.deviceId, d]));
    // Phase 5: Lights, Audio (Voicemeeter) and Stream Deck sections (core/stream-bot/devices; API in stream-bot-devices.js).
    const hardware = sb.devices ? await sb.devices.service.pageData(profile.id).catch((err) => { logger.warn(`${LOG} hardware data failed`, { error: err?.message }); return null; }) : null;
    res.render('stream-bot/devices', {
        user: req.user, active: 'devices', pageTitle: 'Devices', profile,
        devices: devices.map((d) => ({ ...deviceView(d, onlineIds), studio: studioView(live.get(d.id)) })), wsUrl: WS_URL, hardware,
    });
}));

router.get('/stream/bot/sounds', needPage, pageRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    const sounds = await sb.sounds.list(profile.id);
    res.render('stream-bot/sounds', {
        user: req.user, active: 'sounds', pageTitle: 'Sounds', profile,
        sounds: sounds.map(soundView), limits: { fileMb: SOUND_LIMITS.fileBytes / 1048576, count: SOUND_LIMITS.count, totalMb: SOUND_LIMITS.totalBytes / 1048576 },
        usedBytes: sounds.reduce((n, x) => n + (Number(x.size) || 0), 0),
    });
}));

// ════════════════════════════════════════════════════════════════════════════════════════════
// API (signed in; owner-scoped)
// ════════════════════════════════════════════════════════════════════════════════════════════

// ── live feed (Server-Sent Events) ──
router.get('/stream/bot/api/feed', needApi, apiRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    res.write('retry: 5000\n\n');
    let closed = false;
    const write = (s) => { if (!closed) { try { res.write(s); } catch { /* socket gone */ } } };
    const off = sb.feed.subscribe(profile.id, (ev) => {
        if (ev?.type === '_closed') { write('event: closed\ndata: {}\n\n'); cleanup(); try { res.end(); } catch { /* gone */ } return; }
        write(`data: ${JSON.stringify({ ...ev, text: describeEvent(ev), typeLabel: eventType(ev.type)?.label || ev.type, platformLabel: PLATFORM_LABEL[ev.platform] || ev.platform })}\n\n`);
    });
    const beat = setInterval(() => write(': ping\n\n'), 25_000);
    function cleanup() {
        if (closed) return;
        closed = true;
        clearInterval(beat);
        try { off(); } catch { /* already gone */ }
    }
    req.on('close', cleanup);
    res.on('close', cleanup);
}));

// ── events ──
router.get('/stream/bot/api/events', needApi, apiRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    const events = await sb.store.listEvents(profile.id, {
        q: str(req.query.q, 100),
        type: isEventType(String(req.query.type || '')) ? String(req.query.type) : '',
        platform: PLATFORMS.includes(String(req.query.platform || '')) ? String(req.query.platform) : '',
        before: idOf(req.query.before),
        limit: Math.min(200, Math.max(1, Number(req.query.limit) || 50)),
    });
    res.json({ ok: true, events: events.map((e) => ({ ...publicEvent(e, e.id), text: describeEvent(e) })) });
}));

router.get('/stream/bot/api/catalog', needApi, apiRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    res.json({ ok: true, ...catalog(onlineOf(sb, profile.id)) });
}));

// ── automations ──

/** Validate a dashboard save. Returns { errors[], warnings[], value }. */
async function checkAutomation(req, sb, profile, body, selfId = null) {
    const errors = [];
    const b = body && typeof body === 'object' ? body : {};
    const name = str(b.name, 200);
    if (!name || name.length > 100) errors.push('Give the automation a name of 1 to 100 characters.');
    const trigger = validateTrigger(String(b.trigger_type || ''), b.trigger_config && typeof b.trigger_config === 'object' ? b.trigger_config : {});
    errors.push(...trigger.errors);
    const conditions = validateConditions(Array.isArray(b.conditions) ? b.conditions : []);
    errors.push(...conditions.errors);
    const list = await sb.store.listAutomations(profile.id);
    const actions = validateActions(b.actions, {
        automationIds: new Set(list.map((a) => a.id)), selfId,
        guildIds: new Set(managedGuilds(req.user).map((g) => g.id)), allowHosts: profile.webhookAllowHosts || [],
    });
    errors.push(...actions.errors);
    const warnings = [];
    (function walk(steps) {
        for (const s of steps || []) {
            const def = actionType(s.type);
            for (const field of def?.templates || []) {
                for (const w of templateWarnings(s[field] || '')) warnings.push(`${def.label}: ${w}`);
            }
            for (const inner of childLists(s)) walk(inner);
        }
    })(actions.value);
    return {
        errors: [...new Set(errors)], warnings: [...new Set(warnings)], count: list.length,
        value: { name, enabled: b.enabled !== false, trigger_type: String(b.trigger_type || ''), trigger_config: trigger.value || {}, conditions: conditions.value, actions: actions.value },
    };
}

router.get('/stream/bot/api/automations', needApi, apiRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    res.json({ ok: true, automations: await sb.store.listAutomations(profile.id) });
}));

router.post('/stream/bot/api/automations', needApi, apiRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    const r = await checkAutomation(req, sb, profile, req.body);
    if (r.count >= MAX_AUTOMATIONS) r.errors.push(`You have ${MAX_AUTOMATIONS} automations, the most a profile can have. Delete one first.`);
    if (r.errors.length) return res.status(400).json({ ok: false, errors: r.errors, warnings: r.warnings });
    const id = await sb.store.createAutomation(profile.id, r.value);
    automationsChanged(sb, profile.id);
    logger.info(`${LOG} automation created`, { profileId: profile.id, id, trigger: r.value.trigger_type });
    res.json({ ok: true, id, warnings: r.warnings });
}));

router.get('/stream/bot/api/automations/:id', needApi, apiRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    const a = idOf(req.params.id) ? await sb.store.getAutomation(profile.id, idOf(req.params.id)) : null;
    if (!a) return res.status(404).json({ ok: false, error: 'That automation does not exist.' });
    res.json({ ok: true, automation: a });
}));

router.put('/stream/bot/api/automations/:id', needApi, apiRoute(async (req, res) => {
    const id = idOf(req.params.id);
    const { sb, profile } = await load(req);
    const existing = id ? await sb.store.getAutomation(profile.id, id) : null;
    if (!existing) return res.status(404).json({ ok: false, error: 'That automation does not exist.' });
    const r = await checkAutomation(req, sb, profile, req.body, id);
    if (r.errors.length) return res.status(400).json({ ok: false, errors: r.errors, warnings: r.warnings });
    await sb.store.updateAutomation(profile.id, id, r.value);
    automationsChanged(sb, profile.id);
    res.json({ ok: true, id, warnings: r.warnings });
}));

router.delete('/stream/bot/api/automations/:id', needApi, apiRoute(async (req, res) => {
    const id = idOf(req.params.id);
    const { sb, profile } = await load(req);
    const ok = id ? await sb.store.deleteAutomation(profile.id, id) : false;
    if (!ok) return res.status(404).json({ ok: false, error: 'That automation does not exist.' });
    automationsChanged(sb, profile.id);
    res.json({ ok: true });
}));

router.post('/stream/bot/api/automations/:id/toggle', needApi, apiRoute(async (req, res) => {
    const id = idOf(req.params.id);
    const { sb, profile } = await load(req);
    const ok = id ? await sb.store.setAutomationEnabled(profile.id, id, !!req.body?.enabled) : false;
    if (!ok) return res.status(404).json({ ok: false, error: 'That automation does not exist.' });
    automationsChanged(sb, profile.id);
    res.json({ ok: true, enabled: !!req.body?.enabled });
}));

/** Test overrides from the editor: only these fields, cleaned. */
function testOverrides(o) {
    const out = {};
    if (!o || typeof o !== 'object') return out;
    if (o.amount !== undefined && o.amount !== '' && Number.isFinite(Number(o.amount))) out.amount = Number(o.amount);
    if (typeof o.message === 'string') out.message = o.message.slice(0, 500);
    if (typeof o.userName === 'string' && o.userName.trim()) out.userName = o.userName.trim().slice(0, 50);
    if (Array.isArray(o.roles)) out.roles = o.roles.filter((r) => ROLES.includes(r));
    return out;
}

router.post('/stream/bot/api/automations/:id/test', needApi, apiRoute(async (req, res) => {
    const id = idOf(req.params.id);
    const { sb, profile } = await load(req);
    const a = id ? await sb.store.getAutomation(profile.id, id) : null;
    if (!a) return res.status(404).json({ ok: false, error: 'That automation does not exist. Save it first.' });
    const def = eventType(a.trigger_type);
    if (!def) return res.status(400).json({ ok: false, error: 'This automation has no valid trigger.' });
    const channels = await sb.store.listChannels(profile.id);
    const filter = Array.isArray(a.trigger_config?.platforms) && a.trigger_config.platforms.length ? a.trigger_config.platforms : def.platforms;
    let platform = null;
    let channelId = null;
    for (const p of filter) {
        const c = channels.find((ch) => ch.platform === p);
        if (c) { platform = p; channelId = String(c.platform_user_id); break; }
    }
    if (!platform) platform = filter[0] || def.platforms[0];
    const overrides = testOverrides(req.body?.overrides);
    const match = a.trigger_config?.match;
    if (a.trigger_type === 'chat' && match?.text && match.mode !== 'regex' && overrides.message === undefined) {
        overrides.message = match.mode === 'command' ? (match.text.startsWith('!') ? match.text : `!${match.text}`) : match.text;
    }
    const ev = sampleEvent(a.trigger_type, { platform, channelId, overrides });
    if (!ev) return res.status(400).json({ ok: false, error: 'There is no sample event for this trigger.' });
    const dryRun = !!req.body?.dryRun;
    const eventId = await sb.ingest.recordTest(profile, ev);
    const running = sb.engine.runAutomation(profile, a, ev, { source: 'test', eventId, test: true, dryRun, skipTrigger: true });
    running.catch((err) => logger.warn(`${LOG} test run failed`, { profileId: profile.id, id, error: err?.message }));
    let timer;
    const result = await Promise.race([running, new Promise((r) => { timer = setTimeout(() => r(null), TEST_WAIT_MS); timer.unref?.(); })]);
    clearTimeout(timer);
    if (!result) return res.json({ ok: true, status: 'running', eventId });
    const run = result.runId ? await sb.store.getRun(profile.id, result.runId) : null;
    res.json({
        ok: true, runId: result.runId, status: result.status, dryRun, eventId,
        steps: run?.steps || result.steps || [], checks: run?.checks || [], skipReason: run?.skipReason || null, error: result.error ? 'The run stopped with an error.' : null,
    });
}));

// ── runs ──
router.get('/stream/bot/api/runs', needApi, apiRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    const runs = await sb.store.listRuns(profile.id, {
        automationId: idOf(req.query.automation),
        status: RUN_STATUSES.includes(String(req.query.status || '')) ? String(req.query.status) : '',
        before: idOf(req.query.before), limit: 50,
    });
    res.json({ ok: true, runs: runs.map(runView) });
}));

router.get('/stream/bot/api/runs/:id', needApi, apiRoute(async (req, res) => {
    const id = idOf(req.params.id);
    const { sb, profile } = await load(req);
    const run = id ? await sb.store.getRun(profile.id, id) : null;
    if (!run) return res.status(404).json({ ok: false, error: 'That run does not exist.' });
    const dispatches = await sb.store.dispatchesForRun(profile.id, run.id);
    res.json({ ok: true, run: runView(run), dispatches: dispatches.map(dispatchView) });
}));

// ── channels ──
router.post('/stream/bot/api/channels/link', needApi, apiRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    const platform = String(req.body?.platform || '');
    const id = String(req.body?.id || '');
    const idOk = platform === 'youtube' ? /^UC[A-Za-z0-9_-]{22}$/.test(id) : /^\d{1,20}$/.test(id);
    if (!['twitch', 'kick', 'youtube'].includes(platform) || !idOk) return res.status(400).json({ ok: false, error: 'Pick a channel to link.' });
    const list = await linkableChannels(pool, req.user.id, profile.id, sb.store);
    const c = list.find((x) => x.platform === platform && x.id === id);
    if (!c) return res.status(400).json({ ok: false, error: 'You can only link a channel you signed in with. Connect it first.' });
    const r = await sb.store.linkChannel(profile.id, { platform, platformUserId: c.id, login: c.login, displayName: c.displayName, verifiedVia: c.via });
    if (!r.ok) return res.status(409).json({ ok: false, error: 'That channel is linked to another CertiFried account.' });
    let kick = null;
    if (platform === 'youtube') {
        sb.youtube?.service?.checkNow(profile.id).catch((err) => logger.warn(`${LOG} YouTube check after link failed`, { error: err?.message }));
    } else if (platform === 'twitch') {
        import('../../core/twitch-eventsub-manager.js').then((m) => m.subscribeBroadcaster(c.id, c.login))
            .catch((err) => logger.warn(`${LOG} EventSub subscribe after link failed`, { error: err?.message }));
    } else {
        try {
            const m = await import('../../services/certifried-bot/kick-event-subscriptions.js');
            const k = await m.ensureSubscribed(c.id);
            kick = { ok: !!k?.ok, already: !!k?.already, error: k?.ok ? null : (k?.error || 'Kick did not accept the subscription.') };
        } catch (err) {
            kick = { ok: false, already: false, error: 'Could not reach Kick to subscribe.' };
            logger.warn(`${LOG} Kick subscribe after link failed`, { error: err?.message });
        }
    }
    sb.ingest.invalidate(profile.id);
    sb.io.invalidate(profile.id);
    logger.info(`${LOG} channel linked`, { profileId: profile.id, platform, via: c.via });
    res.json({ ok: true, platform, kick });
}));

router.delete('/stream/bot/api/channels/:id', needApi, apiRoute(async (req, res) => {
    const id = idOf(req.params.id);
    const { sb, profile } = await load(req);
    const before = id ? await sb.store.getChannel(profile.id, id).catch(() => null) : null;
    const ok = id ? await sb.store.unlinkChannel(profile.id, id) : false;
    if (!ok) return res.status(404).json({ ok: false, error: 'That channel is not linked.' });
    sb.ingest.invalidate(profile.id);
    sb.io.invalidate(profile.id);
    if (before?.platform === 'youtube') {
        // YouTube Live (H-741): stop reading it now, and drop the sign-in (revoked at Google) unless multicast still uses it.
        sb.youtube?.service?.reload().catch(() => {});
        await sb.youtube?.forget?.(req.user.id).catch((err) => logger.warn(`${LOG} YouTube sign-in removal failed`, { error: err?.message }));
    }
    res.json({ ok: true });
}));

// ── YouTube Live (H-741): look for a live broadcast now (1 quota unit; once a minute per profile) ──
const youtubeChecks = new Map();
router.post('/stream/bot/api/youtube/check', needApi, apiRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    const svc = sb.youtube?.service;
    if (!svc) return res.status(409).json({ ok: false, error: 'YouTube is not set up on this server yet.' });
    const last = youtubeChecks.get(profile.id) || 0;
    if (Date.now() - last < 60_000) return res.status(429).json({ ok: false, error: 'Checked less than a minute ago. Try again shortly.' });
    if (youtubeChecks.size > 5000) youtubeChecks.clear();
    youtubeChecks.set(profile.id, Date.now());
    const status = await svc.checkNow(profile.id);
    res.json({ ok: true, channels: status.channels, quota: status.quota });
}));

// ── tip sources ──
router.post('/stream/bot/api/tip-sources', needApi, apiRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    const source = String(req.body?.source || '');
    if (!TIP_SOURCES.includes(source)) return res.status(400).json({ ok: false, error: 'Pick a tip service.' });
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    const wantRef = String(req.body?.ref ?? '').trim();
    let ref = '';
    let secret = null;
    if (source === 'streamelements') {
        if (!JWT.test(token) || token.length > 2000) return res.status(400).json({ ok: false, error: 'Paste your StreamElements JWT token (three parts separated by dots).' });
        secret = token;
    } else if (source === 'streamlabs') {
        if (!SOCKET_TOKEN.test(token)) return res.status(400).json({ ok: false, error: 'Paste your Streamlabs Socket API token.' });
        secret = token;
    } else if (source === 'kofi' || source === 'fourthwall') {
        const options = await tipOptions(req.user);
        if (!options[source].some((g) => g.id === wantRef)) {
            return res.status(400).json({ ok: false, error: `Pick a server you manage that has ${TIP_LABEL[source]} set up.` });
        }
        ref = wantRef;
    } else if (source === 'throne') {
        const options = await tipOptions(req.user);
        if (!options.throne) return res.status(400).json({ ok: false, error: 'Link your Throne account first with /creator throne link in Discord.' });
        ref = options.throne;
    } else if (source === 'bmac') {
        const options = await tipOptions(req.user);
        if (!options.bmac) return res.status(400).json({ ok: false, error: 'Link your Buy Me a Coffee account first on the Buy Me a Coffee page or with /creator buymeacoffee link.' });
        ref = String(req.user.id);
    }
    const id = await sb.store.addTipSource(profile.id, { source, ref: ref.toLowerCase(), secret });
    if (source === 'streamelements' || source === 'streamlabs') sb.tipFeeds?.refresh?.()?.catch?.(() => {});
    logger.info(`${LOG} tip source added`, { profileId: profile.id, source });
    res.json({ ok: true, id });
}));

async function tipSourceRow(store, profileId, id) {
    return (await store.listTipSources(profileId)).find((s) => s.id === id) || null;
}

router.post('/stream/bot/api/tip-sources/:id/toggle', needApi, apiRoute(async (req, res) => {
    const id = idOf(req.params.id);
    const { sb, profile } = await load(req);
    const row = id ? await tipSourceRow(sb.store, profile.id, id) : null;
    if (!row) return res.status(404).json({ ok: false, error: 'That tip source does not exist.' });
    await sb.store.setTipSourceEnabled(profile.id, id, !!req.body?.enabled);
    if (row.source === 'streamelements' || row.source === 'streamlabs') sb.tipFeeds?.refresh?.()?.catch?.(() => {});
    res.json({ ok: true, enabled: !!req.body?.enabled });
}));

router.delete('/stream/bot/api/tip-sources/:id', needApi, apiRoute(async (req, res) => {
    const id = idOf(req.params.id);
    const { sb, profile } = await load(req);
    const row = id ? await tipSourceRow(sb.store, profile.id, id) : null;
    if (!row) return res.status(404).json({ ok: false, error: 'That tip source does not exist.' });
    await sb.store.deleteTipSource(profile.id, id);
    if (row.source === 'streamelements' || row.source === 'streamlabs') sb.tipFeeds?.refresh?.()?.catch?.(() => {});
    res.json({ ok: true });
}));

// ── settings ──
router.post('/stream/bot/api/settings', needApi, apiRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    const patch = {};
    if (req.body?.storeChat !== undefined) patch.storeChat = !!req.body.storeChat;
    if (req.body?.webhookAllowHosts !== undefined) {
        const { hosts, errors } = normaliseAllowList(req.body.webhookAllowHosts);
        if (errors.length) return res.status(400).json({ ok: false, errors });
        patch.webhookAllowHosts = hosts;
    }
    await sb.store.updateSettings(profile.id, patch);
    sb.ingest.invalidate(profile.id);
    const fresh = await sb.store.getProfile(profile.id);
    res.json({ ok: true, settings: { storeChat: fresh.storeChat, webhookAllowHosts: fresh.webhookAllowHosts } });
}));

// ── sound library (Phase 2) ──
router.get('/stream/bot/api/sounds', needApi, apiRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    res.json({ ok: true, sounds: (await sb.sounds.list(profile.id)).map(soundView) });
}));

const soundBody = express.raw({ type: () => true, limit: SOUND_LIMITS.fileBytes + 1024 });
router.post('/stream/bot/api/sounds', needApi, (req, res, next) => soundBody(req, res, (err) => {
    if (err?.type === 'entity.too.large' || err?.status === 413) return res.status(413).json({ ok: false, error: `A sound can be at most ${SOUND_LIMITS.fileBytes / 1048576} MB.` });
    if (err) return res.status(400).json({ ok: false, error: 'The upload could not be read. Try again.' });
    return next();
}), apiRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    const r = await sb.sounds.add(profile.id, { name: str(req.query.name, 200), buffer: Buffer.isBuffer(req.body) ? req.body : null });
    if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
    logger.info(`${LOG} sound added`, { profileId: profile.id, size: r.sound.size });
    sb.hub.notify(profile.id, 'studio', { type: 'sounds_changed' });
    res.json({ ok: true, sound: soundView(r.sound) });
}));

router.get('/stream/bot/api/sounds/:id/file', needApi, apiRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    const sound = await sb.sounds.get(profile.id, String(req.params.id || ''));
    if (!sound) return res.status(404).json({ ok: false, error: 'That sound does not exist.' });
    sendSound(res, sb.sounds.filePath(profile.id, sound), sound);
}));

router.delete('/stream/bot/api/sounds/:id', needApi, apiRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    const ok = await sb.sounds.remove(profile.id, String(req.params.id || ''));
    if (!ok) return res.status(404).json({ ok: false, error: 'That sound does not exist.' });
    sb.hub.notify(profile.id, 'studio', { type: 'sounds_changed' });
    res.json({ ok: true });
}));

/** Stream one stored sound file (404 JSON when the file went missing). */
function sendSound(res, file, sound) {
    fs.stat(file || '', (err, st) => {
        if (err || !st.isFile()) { if (!res.headersSent) res.status(404).json({ ok: false, error: 'That sound file is missing. Upload it again.' }); return; }
        res.status(200).set({
            'Content-Type': sound.mime || 'application/octet-stream', 'Content-Length': String(st.size), 'Cache-Control': 'private, max-age=0',
            'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline',
        });
        const stream = fs.createReadStream(file);
        stream.on('error', () => { try { res.destroy(); } catch { /* gone */ } });
        stream.pipe(res);
    });
}

// ── devices ──
router.get('/stream/bot/api/devices', needApi, apiRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    const onlineIds = new Set(sb.hub.connected(profile.id).map((d) => d.deviceId));
    res.json({ ok: true, devices: (await sb.store.listDevices(profile.id)).map((d) => deviceView(d, onlineIds)) });
}));

router.post('/stream/bot/api/devices/pairing-code', needApi, apiRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    const name = str(req.body?.name, 100) || null;
    const code = newPairingCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await sb.store.createPairingCode(profile.id, { codeHash: hashSecret(code), kind: 'studio', name, expiresAt });
    res.json({ ok: true, code, expiresAt: expiresAt.toISOString() });
}));

router.post('/stream/bot/api/devices/token', needApi, apiRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    const kind = req.body?.kind === 'studio' ? 'studio' : req.body?.kind === 'overlay' ? 'overlay' : null;
    if (!kind) return res.status(400).json({ ok: false, error: 'Pick overlay or studio.' });
    const name = str(req.body?.name, 100) || (kind === 'overlay' ? 'Overlay' : 'CertiFried Studio');
    const token = newDeviceToken();
    const deviceId = await sb.store.createDevice(profile.id, { kind, name, tokenHash: hashSecret(token), tokenHint: tokenHint(token), capabilities: [] });
    logger.info(`${LOG} device token made`, { profileId: profile.id, deviceId, kind });
    res.json({ ok: true, token, deviceId, wsUrl: WS_URL });
}));

router.post('/stream/bot/api/devices/:id/revoke', needApi, apiRoute(async (req, res) => {
    const id = idOf(req.params.id);
    const { sb, profile } = await load(req);
    const device = id ? await sb.store.getDevice(profile.id, id) : null;
    if (!device) return res.status(404).json({ ok: false, error: 'That device does not exist.' });
    await sb.store.revokeDevice(profile.id, id);
    sb.hub.disconnectDevice(id);
    closeDockStreams(id);
    res.json({ ok: true });
}));

router.delete('/stream/bot/api/devices/:id', needApi, apiRoute(async (req, res) => {
    const id = idOf(req.params.id);
    const { sb, profile } = await load(req);
    const device = id ? await sb.store.getDevice(profile.id, id) : null;
    if (!device) return res.status(404).json({ ok: false, error: 'That device does not exist.' });
    // Remove (H-765): revoke first, so the token is dead even if the delete fails, then delete the row.
    await sb.store.revokeDevice(profile.id, id);
    await sb.store.deleteDevice(profile.id, id);
    sb.hub.disconnectDevice(id);
    closeDockStreams(id);
    res.json({ ok: true });
}));

// ── Discord post picker ──
router.get('/stream/bot/api/guilds', needApi, apiRoute(async (req, res) => {
    res.json({ ok: true, guilds: postableGuilds(req.user).map(({ id, name }) => ({ id, name })) });
}));

router.get('/stream/bot/api/guilds/:guildId/channels', needApi, apiRoute(async (req, res) => {
    const gid = String(req.params.guildId || '');
    if (!SNOWFLAKE.test(gid) || !postableGuilds(req.user).some((g) => g.id === gid)) {
        return res.status(404).json({ ok: false, error: 'You do not manage that server, or CertiFried is not in it.' });
    }
    res.json({ ok: true, channels: postableChannels(gid) });
}));

// ── CertiFried Studio downloads a library sound (device token; no session) ──
const deviceLimiter = rateLimit({
    windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip,
    message: { error: 'rate_limited', message: 'Too many downloads. Wait a minute.' },
});
const BEARER = /^Bearer\s+(\S+)$/;
/** The device download handler; `getSb` resolves to { store, sounds } (tests pass throwaway ones). */
export function deviceSoundHandler(getSb = getStreamBot) {
    return async (req, res) => {
        try {
            const m = String(req.headers.authorization || '').match(BEARER);
            if (!m || !isTokenShape(m[1])) return res.status(401).json({ error: 'auth_failed' });
            const sb = await getSb();
            const device = await sb.store.deviceByTokenHash(hashSecret(m[1]));
            if (!device) return res.status(401).json({ error: 'auth_failed' });
            const sound = await sb.sounds.get(device.profileId, String(req.params.id || ''));
            if (!sound) return res.status(404).json({ error: 'not_found' });
            return sendSound(res, sb.sounds.filePath(device.profileId, sound), sound);
        } catch (err) {
            logger.error(`${LOG} device sound download failed`, { error: err?.message });
            if (!res.headersSent) return res.status(500).json({ error: 'server_error' });
            return undefined;
        }
    };
}
router.get('/stream/bot/api/device/sounds/:id', deviceLimiter, deviceSoundHandler());

// ── pairing (CertiFried Studio; no session) ──

const clientIp = (req) => req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
const pairLimiter = rateLimit({
    windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: clientIp,
    message: { error: 'rate_limited', message: 'Too many tries. Wait a minute.' },
});
const PAIR_FAIL_WINDOW_MS = 60 * 1000;
const PAIR_FAIL_MAX = 60;
const pairFailures = [];
function pairBusy(now = Date.now()) {
    while (pairFailures.length && now - pairFailures[0] > PAIR_FAIL_WINDOW_MS) pairFailures.shift();
    return pairFailures.length >= PAIR_FAIL_MAX;
}
const CAPABILITY = /^[a-z0-9_.-]{1,20}$/;

router.post('/stream/bot/api/pair', pairLimiter, async (req, res) => {
    try {
        if (pairBusy()) return res.status(429).json({ error: 'busy', message: 'Pairing is paused for a minute. Try again shortly.' });
        const code = normaliseCode(req.body?.code);
        const sb = await getStreamBot();
        const row = code ? await sb.store.consumePairingCode(hashSecret(code)) : null;
        if (!row) {
            pairFailures.push(Date.now());
            return res.status(400).json({ error: 'invalid_code' });
        }
        const caps = [...new Set((Array.isArray(req.body?.capabilities) ? req.body.capabilities : []).map((c) => String(c).toLowerCase()).filter((c) => CAPABILITY.test(c)))].slice(0, 20);
        const kind = row.kind === 'overlay' ? 'overlay' : 'studio';
        const name = str(req.body?.name, 100) || row.name || (kind === 'overlay' ? 'Overlay' : 'CertiFried Studio');
        const token = newDeviceToken();
        const deviceId = await sb.store.createDevice(row.profileId, { kind, name, tokenHash: hashSecret(token), tokenHint: tokenHint(token), capabilities: caps });
        logger.info(`${LOG} device paired`, { profileId: row.profileId, deviceId, kind });
        return res.json({ token, deviceId, kind, wsUrl: WS_URL, proto: 1 });
    } catch (err) {
        logger.error(`${LOG} pairing failed`, { error: err?.message });
        if (!res.headersSent) return res.status(500).json({ error: 'server_error' });
        return undefined;
    }
});

export default router;
