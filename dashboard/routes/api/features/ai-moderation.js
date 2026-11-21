/**
 * AI moderation API — `/api/guilds/:guildId/ai-moderation/*` (core/ai-moderation.js).
 *
 * The dashboard's AI moderation page (views/partials/manage/ai-moderation.ejs): on / off, per-category actions,
 * cloud consent, network sharing, image reading, limits; the catches with the AI's reason and Confirm / This was
 * fine; the weekly precision / recall report; signal weights; model status; a "try a message" box.
 *
 * Gated by `apiCheckGuildAdmin` at the parent router. Every write re-checks the LIVE member: configure access
 * (owner, Administrator, Manage Server or a bot-manager role); a verdict on a catch needs that or Manage Messages.
 */
import express from 'express';
import { PermissionFlagsBits } from 'discord.js';
import logger from '../../../../utils/logger.js';
import ai from '../../../../core/ai-moderation.js';
import { liveConfigAccess } from '../../../../core/protection-exempt.js';

const router = express.Router({ mergeParams: true });
const tries = new Map();   // guildId -> [ms] dry runs in the last minute

async function actorFor(req) {
    if (req.isSuperAdmin) return { canConfigure: true, canReview: true, superAdmin: true };
    const a = await liveConfigAccess(req.guildObject, req.user.id);
    const canReview = a.ok || !!a.member?.permissions?.has(PermissionFlagsBits.ManageMessages);
    return { canConfigure: a.ok, canReview, superAdmin: false };
}

const fail = (res, where, err) => {
    logger.error(`[API ai-moderation] ${where} failed: ${err.message}`);
    res.status(500).json({ error: `Could not ${where}. Try again in a moment.` });
};

function userBits(guild, id) {
    const member = guild.members.cache.get(id);
    const user = member?.user || guild.client.users.cache.get(id) || null;
    return { id, name: member?.displayName ?? user?.globalName ?? user?.username ?? null, inServer: !!member };
}

router.get('/', async (req, res) => {
    const guild = req.guildObject;
    try {
        const [actor, config, catches, report, signals, usage] = await Promise.all([
            actorFor(req), ai.getConfig(guild.id), ai.listCatches(guild.id, { limit: 60, status: String(req.query.status || 'all') }).catch(() => []),
            ai.report(guild.id, 8).catch(() => ({ ai: [], older: [] })), ai.signalTable(guild.id).catch(() => []), ai.usage(guild.id),
        ]);
        res.json({
            actor,
            config: {
                enabled: config.enabled, actions: config.actions, cloudSetting: config.cloudSetting, cloudAllowed: config.cloudAllowed,
                shareNetwork: config.shareNetwork, useNetwork: config.useNetwork, scanImages: config.scanImages, dailyCap: config.dailyCap,
                minConfidence: config.minConfidence, timeoutMinutes: config.timeoutMinutes,
            },
            migrated: config.migrated || !config.hasRow,
            categories: ai.CATEGORIES.map(id => ({ id, label: ai.CATEGORY_LABEL[id], max: ai.MAX_ACTION[id] })),
            actions: ai.ACTIONS.map(id => ({ id, label: ai.ACTION_LABEL[id] })),
            catches: catches.map(c => ({ ...c, user: userBits(guild, c.userId), channelName: guild.channels.cache.get(c.channelId)?.name ?? null })),
            report, signals, usage, providers: ai.providerStatus(),
        });
    } catch (err) { fail(res, 'load AI moderation', err); }
});

router.post('/settings', async (req, res) => {
    const actor = await actorFor(req);
    if (!actor.canConfigure) return res.status(403).json({ error: 'You need Manage Server, Administrator or a bot-manager role in this server.' });
    const b = req.body || {};
    const patch = {};
    for (const k of ['enabled', 'actions', 'cloud', 'shareNetwork', 'useNetwork', 'scanImages', 'dailyCap', 'minConfidence', 'timeoutMinutes']) if (k in b) patch[k] = b[k];
    try {
        const out = await ai.saveConfig(req.guildObject, patch, req.user.id);
        if (!out.ok) return res.status(400).json({ error: out.error });
        res.json(out);
    } catch (err) { fail(res, 'save AI moderation settings', err); }
});

router.post('/catches/:id/label', async (req, res) => {
    const actor = await actorFor(req);
    if (!actor.canReview) return res.status(403).json({ error: 'You need Manage Messages, Manage Server or a bot-manager role in this server.' });
    const id = Number(req.params.id);
    const label = String(req.body?.label || '');
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Bad catch id.' });
    try {
        const out = await ai.labelDetection(req.guildObject, id, label, { by: req.user.id, source: 'dashboard' });
        if (!out.ok) return res.status(400).json({ error: out.error });
        res.json(out);
    } catch (err) { fail(res, 'save that verdict', err); }
});

router.post('/try', async (req, res) => {
    const actor = await actorFor(req);
    if (!actor.canConfigure) return res.status(403).json({ error: 'You need Manage Server, Administrator or a bot-manager role in this server.' });
    const text = String(req.body?.text || '').slice(0, 1500);
    if (!text.trim()) return res.status(400).json({ error: 'Type a message to check.' });
    const now = Date.now();
    const recent = (tries.get(req.guildObject.id) || []).filter(t => now - t < 60_000);
    if (recent.length >= 10) return res.status(429).json({ error: 'Ten checks a minute at most. Try again shortly.' });
    recent.push(now); tries.set(req.guildObject.id, recent);
    try { res.json(await ai.dryRun(req.guildObject, text)); } catch (err) { fail(res, 'check that message', err); }
});

export default router;
