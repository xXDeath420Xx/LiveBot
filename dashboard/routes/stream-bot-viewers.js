/*
 * Stream bot Viewers (/stream/bot/viewers; H-747): viewer records, loyalty points and ranks for the profile's Twitch and
 * Kick channels (core/stream-bot/viewers, migration 464).
 *
 *   GET    /stream/bot/viewers                       the table: search, platform, last seen, sort, pages (plain GET form)
 *   GET    /stream/bot/viewers/export.csv            every record as CSV
 *   GET    /stream/bot/viewers/settings              points name, earning, ranks, give and gamble, not counted, the commands
 *   GET    /stream/bot/viewers/:id                   one viewer: totals, linked account, point history, edit points
 *   GET    /stream/bot/api/viewers                   the table as JSON (same filters)
 *   POST   /stream/bot/api/viewers/settings          save the settings
 *   POST   /stream/bot/api/viewers/commands          add the chat commands as automations (switched off)
 *   POST   /stream/bot/api/viewers/:id/points        { mode: add|remove|set, amount, note }
 *   POST   /stream/bot/api/viewers/:id/link          { login }   link their account on the other platform (by hand only)
 *   POST   /stream/bot/api/viewers/:id/unlink
 *   DELETE /stream/bot/api/viewers/:id               delete the record (and its history)
 *
 * Signed in only; every query carries the signed-in user's profile id. Writes need the CSRF token (global middleware).
 * Literal paths before /:id paths. Until migration 464 has run the pages say so and the API answers 503.
 */
import express from 'express';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { getStreamBot } from '../../core/stream-bot/index.js';
import { createViewerStore } from '../../core/stream-bot/viewers/store.js';
import { withDefaults, validateSettings, currencyCommand } from '../../core/stream-bot/viewers/settings.js';
import { seedCommands, commandDrafts } from '../../core/stream-bot/viewers/seed.js';
import { CHATTERS_SCOPE } from '../../core/stream-bot/viewers/service.js';
import * as V from '../services/stream-bot-viewers-view.js';

const router = express.Router();
const LOG = '[StreamBotViewers]';

const signedIn = (req) => !!(req.isAuthenticated?.() && req.user?.id);
function needPage(req, res, next) {
    if (signedIn(req)) return next();
    return res.redirect('/auth/discord?returnTo=' + encodeURIComponent(req.originalUrl.startsWith('/stream/bot/viewers') ? req.originalUrl : '/stream/bot/viewers'));
}
function needApi(req, res, next) {
    if (signedIn(req)) return next();
    return res.status(401).json({ ok: false, error: 'You are signed out. Sign in again and retry.' });
}
const apiRoute = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
        logger.error(`${LOG} api failed`, { path: req.path, method: req.method, error: err?.message });
        if (!res.headersSent) res.status(500).json({ ok: false, error: 'Something went wrong. Try again.' });
    }
};
const idOf = (v) => (/^\d{1,15}$/.test(String(v ?? '')) ? Number(v) : null);

let vstoreRef = null;
const vstore = () => (vstoreRef ||= createViewerStore({ db: pool }));

async function load(req) {
    const sb = await getStreamBot();
    const profile = await sb.store.ensureProfile(req.user.id, req.user.global_name || req.user.username || null);
    const settings = withDefaults(profile.settings?.viewers);
    return { sb, profile, settings, ready: await vstore().available() };
}

/** What the page says about watch time: the grant's chatters scope, and the last sample. */
async function watchState(sb, profile) {
    const channels = await sb.store.listChannels(profile.id);
    const twitch = channels.find((c) => c.platform === 'twitch');
    let grant = null;
    try { grant = await sb.store.getTwitchGrant(profile.id); } catch { grant = null; }
    const chatters = !!(grant && grant.status === 'active' && grant.scopes.includes(CHATTERS_SCOPE) && twitch && String(grant.twitch_user_id) === String(twitch.platform_user_id));
    return {
        linked: channels.filter((c) => ['twitch', 'kick', 'youtube'].includes(c.platform)).map((c) => ({ platform: c.platform, login: c.login || c.display_name })),
        twitch: !!twitch, kick: channels.some((c) => c.platform === 'kick'), youtube: channels.some((c) => c.platform === 'youtube'), chatters, needsReapprove: !!(twitch && grant && !grant.scopes.includes(CHATTERS_SCOPE)),
        sample: V.sampleLines(sb.viewers?.service?.status(profile.id) || null), running: !!sb.viewers,
    };
}

async function commandState(sb, profile, settings) {
    const names = new Map((await sb.store.listAutomations(profile.id)).map((a) => [a.name, a]));
    return commandDrafts({ currency: currencyCommand(settings) }).map((d) => {
        const a = names.get(d.name);
        return { name: d.name, command: d.trigger_config.match.text.startsWith('^') ? `!points, !${currencyCommand(settings)}` : d.trigger_config.match.text, id: a?.id || null, enabled: !!a?.enabled };
    });
}

// ── pages ──

router.get('/stream/bot/viewers', needPage, async (req, res) => {
    try {
        const { sb, profile, settings, ready } = await load(req);
        const f = V.listQuery(req.query);
        const list = ready ? await vstore().list(profile.id, { q: f.q, platform: f.platform, seenDays: f.seen, sort: f.sort, dir: f.dir, page: f.page, perPage: V.PER_PAGE }) : { total: 0, rows: [], page: 1, perPage: V.PER_PAGE };
        const pages = Math.max(1, Math.ceil(list.total / V.PER_PAGE));
        res.render('stream-bot/viewers', {
            user: req.user, active: 'viewers', pageTitle: 'Viewers', ready, settings, filters: f,
            rows: list.rows.map((r) => V.rowView(r, settings)), total: list.total, pages,
            count: ready ? await vstore().count(profile.id) : 0, watch: await watchState(sb, profile),
            hrefs: {
                sort: Object.fromEntries(Object.keys(V.SORT_LABEL).map((k) => [k, V.listHref(f, { sort: k, dir: f.sort === k ? (f.dir === 'asc' ? 'desc' : 'asc') : (k === 'name' ? 'asc' : 'desc') })])),
                prev: f.page > 1 ? V.listHref(f, { page: f.page - 1 }) : null, next: f.page < pages ? V.listHref(f, { page: f.page + 1 }) : null,
            },
            seenChoices: V.SEEN_CHOICES, sortLabels: V.SORT_LABEL,
        });
    } catch (err) {
        logger.error(`${LOG} page failed`, { error: err?.message });
        if (!res.headersSent) res.status(500).render('error-tailwind', { user: req.user, error: 'The Viewers page could not be loaded. Try again in a minute.' });
    }
});

router.get('/stream/bot/viewers/export.csv', needPage, async (req, res) => {
    try {
        const { profile, settings, ready } = await load(req);
        if (!ready) return res.status(503).type('text/plain').send('Viewer records are not switched on yet.');
        res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="certifried-viewers-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
        res.write(`${V.CSV_HEADER.join(',')}\r\n`);
        let after = 0;
        for (;;) {
            const rows = await vstore().page(profile.id, after, 2000);
            if (!rows.length) break;
            res.write(rows.map((r) => V.csvLine(r, settings)).join('\r\n') + '\r\n');
            after = rows[rows.length - 1].id;
        }
        res.end();
    } catch (err) {
        logger.error(`${LOG} export failed`, { error: err?.message });
        if (!res.headersSent) res.status(500).type('text/plain').send('The export failed. Try again.'); else res.end();
    }
});

router.get('/stream/bot/viewers/settings', needPage, async (req, res) => {
    try {
        const { sb, profile, settings, ready } = await load(req);
        res.render('stream-bot/viewers-settings', {
            user: req.user, active: 'viewers', pageTitle: 'Viewer settings', ready, settings, form: V.settingsView(settings),
            commands: await commandState(sb, profile, settings), watch: await watchState(sb, profile),
        });
    } catch (err) {
        logger.error(`${LOG} settings page failed`, { error: err?.message });
        if (!res.headersSent) res.status(500).render('error-tailwind', { user: req.user, error: 'The Viewers settings could not be loaded. Try again in a minute.' });
    }
});

router.get('/stream/bot/viewers/:id', needPage, async (req, res) => {
    try {
        const { profile, settings, ready } = await load(req);
        const id = idOf(req.params.id);
        const person = ready && id ? await vstore().person(profile.id, id) : null;
        if (!person) return res.status(404).render('error-tailwind', { user: req.user, error: 'That viewer is not in your records.' });
        const history = await vstore().history(profile.id, person.rows.map((r) => r.id), 100);
        res.render('stream-bot/viewer', { user: req.user, active: 'viewers', pageTitle: person.primary.name, viewer: V.personView(person, settings, history) });
    } catch (err) {
        logger.error(`${LOG} viewer page failed`, { error: err?.message });
        if (!res.headersSent) res.status(500).render('error-tailwind', { user: req.user, error: 'That viewer could not be loaded. Try again in a minute.' });
    }
});

// ── API ──

const notReady = (res) => res.status(503).json({ ok: false, error: 'Viewer records are not switched on yet. Try again after the next CertiFried update.' });

router.get('/stream/bot/api/viewers', needApi, apiRoute(async (req, res) => {
    const { profile, settings, ready } = await load(req);
    if (!ready) return notReady(res);
    const f = V.listQuery(req.query);
    const list = await vstore().list(profile.id, { q: f.q, platform: f.platform, seenDays: f.seen, sort: f.sort, dir: f.dir, page: f.page, perPage: V.PER_PAGE });
    res.json({ ok: true, total: list.total, page: list.page, rows: list.rows.map((r) => V.rowView(r, settings)) });
}));

router.post('/stream/bot/api/viewers/settings', needApi, apiRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    const v = validateSettings(req.body || {});
    if (!v.ok) return res.status(400).json({ ok: false, errors: v.errors });
    if (sb.viewers?.service) await sb.viewers.service.saveSettings(profile.id, v.value);
    else await sb.store.setSettingsKey(profile.id, 'viewers', v.value);
    logger.info(`${LOG} settings saved`, { profileId: profile.id });
    res.json({ ok: true, settings: v.value });
}));

router.post('/stream/bot/api/viewers/commands', needApi, apiRoute(async (req, res) => {
    const { sb, profile, settings } = await load(req);
    const r = await seedCommands(sb.store, profile.id, { currency: currencyCommand(settings), enabled: false });
    logger.info(`${LOG} commands added`, { profileId: profile.id, created: r.created });
    res.json({ ok: true, created: r.created, existing: r.existing });
}));

async function owned(req) {
    const ctx = await load(req);
    const id = idOf(req.params.id);
    const row = ctx.ready && id ? await vstore().get(ctx.profile.id, id) : null;
    return { ...ctx, id, row };
}

router.post('/stream/bot/api/viewers/:id/points', needApi, apiRoute(async (req, res) => {
    const { sb, profile, ready, row } = await owned(req);
    if (!ready) return notReady(res);
    if (!row) return res.status(404).json({ ok: false, error: 'That viewer is not in your records.' });
    const mode = ['add', 'remove', 'set'].includes(req.body?.mode) ? req.body.mode : null;
    const amount = /^\d{1,12}$/.test(String(req.body?.amount ?? '').replace(/,/g, '').trim()) ? Number(String(req.body.amount).replace(/,/g, '').trim()) : null;
    if (!mode) return res.status(400).json({ ok: false, error: 'Choose add, remove or set.' });
    if (amount === null || amount > 999_999_999_999) return res.status(400).json({ ok: false, error: 'Enter a whole number of 0 or more.' });
    const note = String(req.body?.note ?? '').trim().slice(0, 150) || (mode === 'set' ? 'Set on the dashboard' : mode === 'add' ? 'Added on the dashboard' : 'Removed on the dashboard');
    const opts = { mode: mode === 'set' ? 'set' : 'add', kind: 'edit', note, actor: `dashboard:${req.user.id}` };
    const delta = mode === 'remove' ? -amount : amount;
    const r = sb.viewers?.service ? await sb.viewers.service.changePoints(profile.id, row.id, delta, opts) : await vstore().changePoints(profile.id, row.id, delta, opts);
    if (!r.ok) return res.status(400).json({ ok: false, error: 'The points could not be changed.' });
    res.json({ ok: true, balance: r.balance, change: r.change });
}));

router.post('/stream/bot/api/viewers/:id/link', needApi, apiRoute(async (req, res) => {
    const { profile, ready, row } = await owned(req);
    if (!ready) return notReady(res);
    if (!row) return res.status(404).json({ ok: false, error: 'That viewer is not in your records.' });
    const other = row.platform === 'twitch' ? 'kick' : 'twitch';
    const target = await vstore().byLogin(profile.id, String(req.body?.login || ''), other);
    if (!target) return res.status(400).json({ ok: false, error: `No ${other === 'kick' ? 'Kick' : 'Twitch'} viewer with that name is in your records yet.` });
    const r = await vstore().link(profile.id, row.personId || row.id, target.id, { actor: `dashboard:${req.user.id}` });
    const why = { same_platform: 'Both accounts are on the same platform.', already_linked: 'One of the two accounts is already linked.', no_viewer: 'That viewer is not in your records.', same: 'That is the same account.' };
    if (!r.ok) return res.status(400).json({ ok: false, error: why[r.error] || 'The accounts could not be linked.' });
    logger.info(`${LOG} accounts linked`, { profileId: profile.id });
    res.json({ ok: true, primaryId: r.primaryId, moved: r.moved });
}));

router.post('/stream/bot/api/viewers/:id/unlink', needApi, apiRoute(async (req, res) => {
    const { profile, ready, row } = await owned(req);
    if (!ready) return notReady(res);
    if (!row) return res.status(404).json({ ok: false, error: 'That viewer is not in your records.' });
    const r = await vstore().unlink(profile.id, row.id, { actor: `dashboard:${req.user.id}` });
    if (!r.ok) return res.status(400).json({ ok: false, error: 'These accounts are not linked.' });
    res.json({ ok: true, primaryId: r.primaryId });
}));

router.delete('/stream/bot/api/viewers/:id', needApi, apiRoute(async (req, res) => {
    const { profile, ready, row } = await owned(req);
    if (!ready) return notReady(res);
    if (!row) return res.status(404).json({ ok: false, error: 'That viewer is not in your records.' });
    await vstore().remove(profile.id, row.id);
    logger.info(`${LOG} viewer record deleted`, { profileId: profile.id });
    res.json({ ok: true });
}));

export default router;
