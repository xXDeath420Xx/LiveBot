/*
 * Stream bot import (docs/superpowers/specs/2026-11-19-stream-bot-design.md §6): bring Firebot and Streamer.bot
 * setups into CertiFried, for the signed-in user's own stream bot profile only.
 *
 *   Page  GET  /stream/bot/import                              upload, preview (mapping report), import, saved rewards, history
 *   API   POST /stream/bot/api/import/upload?name=…            the file (or a pasted Streamer.bot import string) as the body;
 *                                                              parsed on the server (core/stream-bot/import), kept as a preview
 *         GET  /stream/bot/api/import/preview                  the current preview
 *         DELETE /stream/bot/api/import/preview                start over
 *         POST /stream/bot/api/import/run                      { categories: [], viewers: bool } → everything created switched off
 *         GET  /stream/bot/api/import/history/:id              one past import's report
 *         POST /stream/bot/api/import/rewards/:id/recreate     the owner's explicit "Recreate under CertiFried" for one saved reward
 *         POST /stream/bot/api/import/words/:id/apply          { channelBotId } the owner's explicit "Apply to Kick automod" for a
 *                                                              saved banned word list (imports only save it: H-742)
 *         POST /stream/bot/api/import/words/:id/twitch         the owner's explicit "Add to Twitch blocked terms" for a saved
 *                                                              banned word list (H-763; Stream bot grant, moderator:manage:blocked_terms)
 *
 * Uploads: 20 MB, 20 a minute per user; ZIPs are read in memory; programs and scripts are refused or skipped unread;
 * credentials are stripped and the result scanned before it is kept. Nothing here sends chat, touches OBS or writes
 * to Twitch except the recreate and blocked-terms routes, and only when the owner presses them; Kick automod words
 * change only through the apply route. Literal paths come before /:param paths.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { getStreamBot } from '../../core/stream-bot/index.js';
import { createImportService, UPLOAD_MAX_BYTES, ImportError } from '../../core/stream-bot/import/index.js';
import { createImportStore, recreateReward, pendingWordsView, applyPendingWords } from '../../core/stream-bot/import/apply.js';
import { clearKickAutomodCache } from '../../services/certifried-bot/kick-automod.js';
import { CATEGORIES } from '../../core/stream-bot/import/catalog.js';
import { pageJson } from '../../core/stream-bot/import/report.js';
import { addBlockedTerms, BLOCKED_TERMS_SCOPE } from '../../core/stream-bot/twitch-blocked-terms.js';

const router = express.Router();
const LOG = '[StreamBotImport]';
const CATEGORY_KEYS = new Set(CATEGORIES.map((c) => c.key));

const signedIn = (req) => !!(req.isAuthenticated?.() && req.user?.id);

function needPage(req, res, next) {
    if (signedIn(req)) return next();
    return res.redirect('/auth/discord?returnTo=' + encodeURIComponent('/stream/bot/import'));
}

function needApi(req, res, next) {
    if (signedIn(req)) return next();
    return res.status(401).json({ ok: false, error: 'You are signed out. Sign in again and retry.' });
}

const pageRoute = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
        logger.error(`${LOG} page failed`, { path: req.path, error: err?.message });
        if (!res.headersSent) res.status(500).render('error-tailwind', { user: req.user, error: 'The import page could not be loaded. Try again in a minute.' });
    }
};
const apiRoute = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
        if (err instanceof ImportError) return res.status(400).json({ ok: false, error: err.message });
        logger.error(`${LOG} api failed`, { path: req.path, method: req.method, error: err?.message });
        if (!res.headersSent) res.status(500).json({ ok: false, error: 'Something went wrong. Try again.' });
    }
};

let service = null;
async function load(req) {
    const sb = await getStreamBot();
    const profile = await sb.store.ensureProfile(req.user.id, req.user.global_name || req.user.username || null);
    if (!service) {
        const importStore = createImportStore({ db: pool, prefix: sb.store.prefix });
        service = { importStore, svc: createImportService({ store: sb.store, importStore, db: pool }) };
    }
    return { sb, profile, ...service };
}

const idOf = (v) => (/^\d{1,15}$/.test(String(v ?? '')) ? Number(v) : null);
const str = (v, max) => String(v ?? '').trim().slice(0, max);

/** Where imported channel commands and timers are managed: the Kick channel page, or the stream bot's Twitch commands page. */
export function channelHrefs(bots) {
    const map = new Map();
    for (const b of bots) {
        map.set(b.id, b.platform === 'kick' ? `/kick/channel/${encodeURIComponent(b.channelId)}/commands` : `/stream/bot/commands/${encodeURIComponent(b.channelId)}`);
    }
    return (c) => map.get(c.id) || null;
}

function rewardView(it) {
    const d = it.data?.definition || {};
    return {
        id: it.id, title: d.title || it.name, kind: d.kind, cost: d.cost, costUnit: d.costUnit, prompt: d.prompt || '', enabled: d.enabled !== false,
        userInput: !!d.userInput, createdBy: d.createdBy || '', recreated: it.data?.recreated || null, source: it.source,
    };
}

/** Saved banned word lists, with what is still pending on each of the profile's Kick channels. */
async function wordLists(importStore, svc, profileId) {
    const items = (await importStore.listItems(profileId, { kind: 'moderation' })).filter((it) => it.target_kind === 'pending_words');
    if (!items.length) return [];
    const { channelBots } = await svc.context(profileId);
    const automods = new Map();
    for (const c of channelBots) if (c.platform === 'kick') automods.set(c.id, (await importStore.channelAutomod(c.id))?.features || {});
    // H-763: when the list last went to Twitch blocked terms (kept on the item next to the Kick record).
    return items.map((it) => ({ ...pendingWordsView(it, channelBots, automods), twitch: it.data?.twitch || null }));
}

// ── page ────────────────────────────────────────────────────────────────────────────────────

router.get('/stream/bot/import', needPage, pageRoute(async (req, res) => {
    const { sb, profile, importStore, svc } = await load(req);
    const [channels, history, rewardItems, preview, grant, words] = await Promise.all([
        sb.store.listChannels(profile.id), importStore.listImports(profile.id, 20), importStore.listItems(profile.id, { kind: 'reward' }),
        svc.preview(profile.id), sb.store.getTwitchGrant(profile.id), wordLists(importStore, svc, profile.id),
    ]);
    res.render('stream-bot/import', {
        user: req.user, active: 'import', pageTitle: 'Import', profile, channels,
        history, rewards: rewardItems.map(rewardView), categories: CATEGORIES, words,
        canRecreate: !!grant && (grant.scopes || []).includes('channel:manage:redemptions'),
        // H-763: "Add to Twitch blocked terms" needs the Stream bot grant with moderator:manage:blocked_terms (re-approve adds it).
        twitchTerms: { connected: !!grant && grant.status === 'active', scopeOk: !!grant && (grant.scopes || []).includes(BLOCKED_TERMS_SCOPE) },
        uploadMb: UPLOAD_MAX_BYTES / 1048576,
        importData: pageJson({ preview, categories: CATEGORIES }),
    });
}));

// ── API ─────────────────────────────────────────────────────────────────────────────────────

const uploadLimiter = rateLimit({
    windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => `sbimp:${req.user?.id || req.ip}`,
    handler: (req, res) => res.status(429).json({ ok: false, error: 'Too many uploads. Wait a minute and try again.' }),
});
const uploadBody = express.raw({ type: () => true, limit: UPLOAD_MAX_BYTES + 1024 });

router.get('/stream/bot/api/import/preview', needApi, apiRoute(async (req, res) => {
    const { profile, svc } = await load(req);
    res.json({ ok: true, preview: await svc.preview(profile.id) });
}));

router.delete('/stream/bot/api/import/preview', needApi, apiRoute(async (req, res) => {
    const { profile, svc } = await load(req);
    svc.clear(profile.id);
    res.json({ ok: true });
}));

router.post('/stream/bot/api/import/upload', needApi, uploadLimiter, (req, res, next) => uploadBody(req, res, (err) => {
    if (err?.type === 'entity.too.large' || err?.status === 413) return res.status(413).json({ ok: false, error: `The upload is larger than ${UPLOAD_MAX_BYTES / 1048576} MB.` });
    if (err) return res.status(400).json({ ok: false, error: 'The upload could not be read. Try again.' });
    return next();
}), apiRoute(async (req, res) => {
    const { profile, svc } = await load(req);
    const buffer = Buffer.isBuffer(req.body) ? req.body : null;
    const preview = await svc.upload(profile.id, { name: str(req.query.name, 200), buffer });
    const file = Object.values(preview.files).find((f) => f.name === str(req.query.name, 120)) || null;
    logger.info(`${LOG} preview`, { profileId: profile.id, size: buffer?.length || 0, kind: file?.kind || null, stripped: preview.stripped });
    res.json({ ok: true, preview });
}));

router.post('/stream/bot/api/import/run', needApi, apiRoute(async (req, res) => {
    const { profile, svc, importStore } = await load(req);
    const body = req.body || {};
    const categories = (Array.isArray(body.categories) ? body.categories : []).map(String).filter((c) => CATEGORY_KEYS.has(c));
    if (!categories.length) return res.status(400).json({ ok: false, error: 'Pick at least one thing to import.' });
    const viewers = body.viewers === true && categories.includes('viewers');
    const ctx = await svc.context(profile.id);
    const out = await svc.run(profile.id, { categories, wantViewers: viewers, channelPageHref: channelHrefs(ctx.channelBots) });
    if (!out) return res.status(409).json({ ok: false, error: 'Upload a file first (the preview expires after 30 minutes).' });
    logger.info(`${LOG} imported`, { profileId: profile.id, importId: out.importId, counts: out.counts });
    const rewards = (await importStore.listItems(profile.id, { kind: 'reward' })).map(rewardView);
    res.json({ ok: true, importId: out.importId, counts: out.counts, results: out.results, rewards });
}));

router.get('/stream/bot/api/import/history/:id', needApi, apiRoute(async (req, res) => {
    const { profile, importStore } = await load(req);
    const id = idOf(req.params.id);
    const row = id ? await importStore.getImport(profile.id, id) : null;
    if (!row) return res.status(404).json({ ok: false, error: 'That import does not exist.' });
    res.json({ ok: true, import: row });
}));

router.post('/stream/bot/api/import/rewards/:id/recreate', needApi, apiRoute(async (req, res) => {
    const { sb, profile, importStore } = await load(req);
    const id = idOf(req.params.id);
    if (!id) return res.status(404).json({ ok: false, error: 'That saved reward does not exist.' });
    const grant = await sb.store.getTwitchGrant(profile.id);
    const token = grant ? await sb.store.getTwitchGrantToken(profile.id) : null;
    const r = await recreateReward({ store: sb.store, importStore, profileId: profile.id, itemId: id,
        deps: { grant, token, clientId: process.env.TWITCH_CLIENT_ID || '', fetch: globalThis.fetch } });
    if (!r.ok) return res.status(r.status || 400).json({ ok: false, error: r.error });
    logger.info(`${LOG} reward recreated`, { profileId: profile.id, itemId: id, automationsUpdated: r.automationsUpdated });
    sb.ingest.invalidate?.(profile.id);
    res.json({ ok: true, rewardId: r.rewardId, automationsUpdated: r.automationsUpdated });
}));

router.post('/stream/bot/api/import/words/:id/apply', needApi, apiRoute(async (req, res) => {
    const { profile, importStore, svc } = await load(req);
    const id = idOf(req.params.id);
    if (!id) return res.status(404).json({ ok: false, error: 'That saved word list does not exist.' });
    const botId = idOf(req.body?.channelBotId);
    const { channelBots } = await svc.context(profile.id);
    const channelBot = channelBots.find((c) => c.id === botId && c.platform === 'kick') || null;
    if (!channelBot) return res.status(400).json({ ok: false, error: 'Pick one of your Kick channels.' });
    const r = await applyPendingWords({ importStore, profileId: profile.id, itemId: id, channelBot });
    if (!r.ok) return res.status(r.status || 400).json({ ok: false, error: r.error });
    clearKickAutomodCache(channelBot.id); // the Kick bot reads automod settings through this cache (60 s)
    logger.info(`${LOG} banned words applied to Kick automod`, { profileId: profile.id, itemId: id, channelBotId: channelBot.id, added: r.added });
    res.json({ ok: true, added: r.added, total: r.total, channelHref: `/kick/channel/${encodeURIComponent(channelBot.channelId)}` });
}));

const blockedTermsLimiter = rateLimit({
    windowMs: 60 * 1000, max: 3, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => `sbimp-bt:${req.user?.id || req.ip}`,
    handler: (req, res) => res.status(429).json({ ok: false, error: 'Wait a minute before sending words to Twitch again.' }),
});

// H-763: the owner's explicit "Add to Twitch blocked terms". Adds the saved words Twitch does not have yet; never removes one.
router.post('/stream/bot/api/import/words/:id/twitch', needApi, blockedTermsLimiter, apiRoute(async (req, res) => {
    const { sb, profile, importStore } = await load(req);
    const id = idOf(req.params.id);
    const item = id ? await importStore.getItemById(profile.id, id) : null;
    if (!item || item.target_kind !== 'pending_words' || !Array.isArray(item.data?.words)) return res.status(404).json({ ok: false, error: 'That saved word list does not exist.' });
    if (!sb.helix) return res.status(503).json({ ok: false, error: 'Twitch actions are not available right now. Try again in a minute.' });
    const r = await addBlockedTerms({ helix: sb.helix, profileId: profile.id, words: item.data.words });
    if (!r.ok) return res.status(r.status || 400).json({ ok: false, error: r.error, reapprove: !!r.reapprove, href: r.href || null });
    if (r.added || r.skipped) {
        const fresh = await importStore.getItemById(profile.id, id);
        await importStore.setItemData(profile.id, id, { ...(fresh?.data || item.data), twitch: { at: new Date().toISOString(), added: r.added, skipped: r.skipped, failed: r.failed } });
    }
    logger.info(`${LOG} banned words sent to Twitch blocked terms`, { profileId: profile.id, itemId: id, added: r.added, skipped: r.skipped, failed: r.failed, invalid: r.invalid });
    res.json({ ok: true, added: r.added, skipped: r.skipped, failed: r.failed, invalid: r.invalid, failures: r.failures.map((f) => f.error) });
}));

export default router;
