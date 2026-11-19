/**
 * Domain Reports API — `/api/guilds/:guildId/domain-reports/*`
 *
 * The dashboard's Domain Reports page (views/partials/manage/domain-reports.ejs): check a link, report a phishing
 * link or dispute a block, and this server's reports with their status and history. Bot owners / super-admins
 * (req.isSuperAdmin) also get the global review queue (approve / reject, with a note the reporter is sent) and the
 * list of manual blocks and global allows, each removable. The logic lives in core/domain-reports.js.
 *
 * Gated by `apiCheckGuildAdmin` at the parent router. Submitting re-checks the LIVE member (configure access:
 * owner, Administrator, Manage Server or a bot-manager role); members without dashboard access report from
 * `/tools checkurl`. Deciding and removing overrides are super-admin only: they change what the bot blocks in
 * every server.
 */

import express from 'express';
import logger from '../../../../utils/logger.js';
import reports from '../../../../core/domain-reports.js';
import { checkUrl } from '../../../../core/message-threats.js';
import { liveConfigAccess } from '../../../../core/protection-exempt.js';
import { STATUSES, KIND_LABEL, STATUS_LABEL } from '../../../../core/domain-report-logic.js';

const router = express.Router({ mergeParams: true });

async function actorFor(req) {
    if (req.isSuperAdmin) return { canSubmit: true, superAdmin: true };
    const a = await liveConfigAccess(req.guildObject, req.user.id);
    return { canSubmit: a.ok, superAdmin: false };
}

const fail = (res, where, err) => {
    logger.error(`[API domain-reports] ${where} failed: ${err.message}`);
    res.status(500).json({ error: `Could not ${where}. Try again in a moment.` });
};

function guildName(req, id) {
    const bm = global.botManager;
    const g = bm?.getClientForGuild?.(id)?.guilds?.cache?.get(id) || req.guildObject.client.guilds.cache.get(id);
    return g?.name ?? null;
}

router.get('/', async (req, res) => {
    const guild = req.guildObject;
    try {
        const actor = await actorFor(req);
        const [mine, mineCounts] = await Promise.all([reports.list({ guildId: guild.id, limit: 200 }), reports.counts({ guildId: guild.id })]);
        const out = { actor, statuses: STATUSES, statusLabels: STATUS_LABEL, kindLabels: KIND_LABEL, mine, mineCounts };
        if (actor.superAdmin) {
            const status = STATUSES.includes(String(req.query.status)) || req.query.status === 'all' ? String(req.query.status) : 'pending';
            const [queue, counts, overrides] = await Promise.all([reports.list({ status, limit: 300 }), reports.counts(), reports.overrides()]);
            out.review = { status, counts, rows: queue.map(r => ({ ...r, guildName: guildName(req, r.guildId) })), overrides };
        }
        res.json(out);
    } catch (err) {
        fail(res, 'load domain reports', err);
    }
});

router.get('/check', async (req, res) => {
    try {
        const result = await checkUrl(String(req.query.url ?? ''), req.guildObject.id);
        res.json(result);
    } catch (err) {
        fail(res, 'check that link', err);
    }
});

router.post('/submit', async (req, res) => {
    const actor = await actorFor(req);
    if (!actor.canSubmit) return res.status(403).json({ error: 'You need Manage Server, Administrator or a bot-manager role here. Members can report from /tools checkurl.' });
    const b = req.body || {};
    try {
        const out = await reports.submit({
            guild: req.guildObject, user: { id: req.user.id, username: req.user.username }, kind: String(b.kind ?? ''),
            url: String(b.url ?? ''), reason: String(b.reason ?? ''), source: 'dashboard',
        });
        if (!out.ok) return res.status(400).json({ error: out.error });
        logger.info(`[API domain-reports] ${req.user.username} filed #${out.id} (${b.kind} ${out.host}) from ${req.guildObject.id}`);
        res.json(out);
    } catch (err) {
        fail(res, 'send the report', err);
    }
});

router.post('/:id/decide', async (req, res) => {
    if (!req.isSuperAdmin) return res.status(403).json({ error: 'Only the bot owner can decide domain reports.' });
    const decision = String(req.body?.decision ?? '');
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Bad report number.' });
    try {
        const out = await reports.decide(id, decision, { by: req.user.id, note: req.body?.note ?? null });
        if (!out.ok) return res.status(400).json({ error: out.error });
        logger.info(`[API domain-reports] ${req.user.username} decided #${id}: ${out.status} (${out.decided} entries, ${out.notified} told)`);
        res.json(out);
    } catch (err) {
        fail(res, 'apply the decision', err);
    }
});

router.delete('/overrides/:kind/:domain', async (req, res) => {
    if (!req.isSuperAdmin) return res.status(403).json({ error: 'Only the bot owner can change the global lists.' });
    try {
        const out = await reports.removeOverride(String(req.params.kind), String(req.params.domain), req.user.id);
        if (!out.ok) return res.status(400).json({ error: out.error });
        logger.info(`[API domain-reports] ${req.user.username} removed the ${req.params.kind} override for ${req.params.domain}`);
        res.json(out);
    } catch (err) {
        fail(res, 'remove that entry', err);
    }
});

export default router;
