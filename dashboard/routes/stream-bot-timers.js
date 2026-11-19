/*
 * Stream bot timers (/stream/bot/timers): timed chat messages on the profile's linked Twitch and Kick channels, on the
 * existing timer table and job (tokes_timers, jobs/kick-timer-scheduler.js; migration 456, core/stream-bot/timers.js).
 *
 *   GET    /stream/bot/timers                    the page: your timers, the Kick channel page timers of your linked
 *                                                Kick channels, and the editor
 *   GET    /stream/bot/api/timers                { own[], kick[] }
 *   POST   /stream/bot/api/timers                create a stream bot timer
 *   PUT    /stream/bot/api/timers/:id            update (yours, or a Kick channel page timer of a linked Kick channel)
 *   POST   /stream/bot/api/timers/:id/toggle     { enabled }
 *   DELETE /stream/bot/api/timers/:id
 *
 * Signed in only; every query is scoped to the signed-in user's profile (and, for Kick channel page timers, to the
 * Kick channels linked to it through an OAuth sign-in). Writes need the CSRF token (global middleware).
 * Literal paths before /:param paths.
 */
import express from 'express';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { getStreamBot } from '../../core/stream-bot/index.js';
import { createTimerStore, validateTimer, timerView, TIMER_LIMITS } from '../../core/stream-bot/timers.js';

const router = express.Router();
const LOG = '[StreamBotTimers]';

const signedIn = (req) => !!(req.isAuthenticated?.() && req.user?.id);
function needPage(req, res, next) {
    if (signedIn(req)) return next();
    return res.redirect('/auth/discord?returnTo=' + encodeURIComponent('/stream/bot/timers'));
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
const idOf = (v) => (/^\d{1,10}$/.test(String(v ?? '')) ? Number(v) : null);

let timerStore = null;
const timers = () => (timerStore ||= createTimerStore({ db: pool }));

async function load(req) {
    const sb = await getStreamBot();
    const profile = await sb.store.ensureProfile(req.user.id, req.user.global_name || req.user.username || null);
    const channels = await sb.store.listChannels(profile.id);
    const kickIds = channels.filter((c) => c.platform === 'kick').map((c) => String(c.platform_user_id));
    return { sb, profile, channels, kickIds };
}

async function listAll(profileId, kickIds) {
    const { own, kick } = await timers().listForProfile(profileId, kickIds);
    return { own: own.map(timerView), kick: kick.map(timerView) };
}

router.get('/stream/bot/timers', needPage, async (req, res) => {
    try {
        const { sb, profile, channels, kickIds } = await load(req);
        let list = { own: [], kick: [] };
        let schemaReady = true;
        try { list = await listAll(profile.id, kickIds); } catch (err) {
            if (err?.code !== 'ER_BAD_FIELD_ERROR') throw err;
            schemaReady = false;
        }
        const automations = (await sb.store.listAutomations(profile.id)).map((a) => ({ id: a.id, name: a.name, enabled: a.enabled }));
        const names = new Map(automations.map((a) => [a.id, a.name]));
        const decorate = (t) => ({ ...t, automationName: t.automationId ? names.get(t.automationId) || 'a deleted automation' : null });
        res.render('stream-bot/timers', {
            user: req.user, active: 'timers', pageTitle: 'Timers', profile, schemaReady,
            own: list.own.map(decorate), kick: list.kick.map(decorate),
            pageData: {
                own: list.own, kick: list.kick, automations, limits: TIMER_LIMITS,
                linkedPlatforms: [...new Set(channels.map((c) => c.platform).filter((p) => p === 'twitch' || p === 'kick'))],
            },
            linked: channels.filter((c) => c.platform === 'twitch' || c.platform === 'kick').map((c) => ({ platform: c.platform, login: c.login || c.display_name })),
        });
    } catch (err) {
        logger.error(`${LOG} page failed`, { error: err?.message });
        if (!res.headersSent) res.status(500).render('error-tailwind', { user: req.user, error: 'The timers page could not be loaded. Try again in a minute.' });
    }
});

router.get('/stream/bot/api/timers', needApi, apiRoute(async (req, res) => {
    const { profile, kickIds } = await load(req);
    res.json({ ok: true, ...(await listAll(profile.id, kickIds)) });
}));

router.post('/stream/bot/api/timers', needApi, apiRoute(async (req, res) => {
    const { sb, profile, channels } = await load(req);
    const automations = await sb.store.listAutomations(profile.id);
    const v = validateTimer(req.body || {}, {
        automationIds: new Set(automations.map((a) => a.id)),
        linkedPlatforms: channels.map((c) => c.platform),
    });
    if (!channels.some((c) => c.platform === 'twitch' || c.platform === 'kick')) v.errors.push('Link a Twitch or Kick channel first (Connections).');
    if ((await timers().countForProfile(profile.id)) >= TIMER_LIMITS.perProfile) v.errors.push(`You have ${TIMER_LIMITS.perProfile} timers, the most a profile can have.`);
    if (v.errors.length) return res.status(400).json({ ok: false, errors: v.errors });
    const id = await timers().create(profile.id, v.value, req.user.id);
    logger.info(`${LOG} timer created`, { profileId: profile.id, id });
    res.json({ ok: true, id });
}));

async function owned(req) {
    const id = idOf(req.params.id);
    const ctx = await load(req);
    const row = id ? await timers().getForProfile(ctx.profile.id, id, ctx.kickIds) : null;
    return { ...ctx, id, row };
}

router.put('/stream/bot/api/timers/:id', needApi, apiRoute(async (req, res) => {
    const { sb, profile, channels, id, row } = await owned(req);
    if (!row) return res.status(404).json({ ok: false, error: 'That timer does not exist.' });
    const kickPage = row.profile_id == null;
    const automations = await sb.store.listAutomations(profile.id);
    const v = validateTimer(req.body || {}, { kickPage, automationIds: new Set(automations.map((a) => a.id)), linkedPlatforms: channels.map((c) => c.platform) });
    if (v.errors.length) return res.status(400).json({ ok: false, errors: v.errors });
    await timers().update(id, v.value, { kickPage });
    res.json({ ok: true, id });
}));

router.post('/stream/bot/api/timers/:id/toggle', needApi, apiRoute(async (req, res) => {
    const { id, row } = await owned(req);
    if (!row) return res.status(404).json({ ok: false, error: 'That timer does not exist.' });
    await timers().setEnabled(id, !!req.body?.enabled);
    res.json({ ok: true, enabled: !!req.body?.enabled });
}));

router.delete('/stream/bot/api/timers/:id', needApi, apiRoute(async (req, res) => {
    const { id, row } = await owned(req);
    if (!row) return res.status(404).json({ ok: false, error: 'That timer does not exist.' });
    await timers().remove(id);
    res.json({ ok: true });
}));

export default router;
