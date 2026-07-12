/**
 * Takeover API — `/api/guilds/:guildId/takeover/*`
 *
 * Parent router already applied `apiCheckGuildAdmin` + `botContext`, so `req.botClient` is the
 * bot that actually serves this guild (a custom bot, if one is mapped).
 *
 * Three phases, deliberately separated:
 *   scan    — read-only, background, resumable
 *   apply   — writes config rows only; never posts, edits or deletes a message
 *   retire  — removes a bot. Owner-only, typed confirmation, every gate re-checked live.
 */
import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import { isSuperAdmin } from '../../../../utils/constants.js';
import {
    startScan, resumeScan, cancelScan, isScanning,
    getScan, getLatestScan, getBots, getTemplates, attribute, scannableChannels,
} from '../../../../core/guild-analyzer.js';
import { plan, apply, postPanels, KNOWN_BOTS, WEBHOOK_ONLY, resolveBotMeta, needsEvidence, presentBotNames } from '../../../../core/takeover-manager.js';
import { evaluate, retire, autoAttribute, acknowledgeExtraction, DATA_HOLDERS, DEFAULT_SOAK_HOURS } from '../../../../core/bot-retirement.js';

const router = express.Router({ mergeParams: true });

/** Resolve the live guild for the bot that serves it. */
function resolveGuild(req, res) {
    const guild = req.botClient?.guilds?.cache?.get(req.params.guildId);
    if (!guild) {
        res.status(503).json({ error: 'The bot is not connected to this server right now.' });
        return null;
    }
    return guild;
}

/** Removal is irreversible and outward-facing: the server owner does it, not any admin. */
function ownerOnly(req, res, next) {
    const guild = req.botClient?.guilds?.cache?.get(req.params.guildId);
    if (!guild) return res.status(503).json({ error: 'The bot is not connected to this server right now.' });
    if (req.user?.id !== guild.ownerId && !isSuperAdmin(req.user?.id)) {
        return res.status(403).json({ error: 'Only the server owner can remove a bot.' });
    }
    next();
}

// ── Scan ─────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    try {
        const guild = resolveGuild(req, res);
        if (!guild) return;

        const scan = await getLatestScan(guild.id);
        const bots = scan ? await getBots(scan.id) : [];
        const { skipped } = scannableChannels(guild);
        const selfId = req.botClient?.user?.id ?? null;
        const presentNames = presentBotNames(bots);

        const [retired] = await pool.execute(
            'SELECT bot_id, retired_at, method FROM guild_retire_state WHERE guild_id = ? AND retired_at IS NOT NULL',
            [guild.id]);

        res.json({
            guildName: guild.name,
            botName: req.botClient?.user?.username ?? 'the bot',
            isOwner: req.user?.id === guild.ownerId || isSuperAdmin(req.user?.id),
            scanning: isScanning(guild.id),
            unreadableChannels: skipped,
            soakHours: DEFAULT_SOAK_HOURS,
            scan: scan && {
                ...scan,
                pct: scan.channels_total ? Math.round((scan.channels_done / scan.channels_total) * 100) : 0,
            },
            bots: bots.map(b => {
                // resolveBotMeta also matches webhook personas (`wh:<name>`) and flags our own bot.
                const meta = resolveBotMeta(b.bot_id, b.name, selfId);
                return {
                    ...b,
                    channels: safeJson(b.channels, []),
                    known: !!meta,
                    feature: meta?.feature ?? null,
                    // 'self' | 'full' | 'partial' | 'none'. Defaults to full when a feature is set,
                    // so an entry that simply omits it is never mislabelled as unreplaceable.
                    coverage: meta ? (meta.coverage ?? (meta.feature ? 'full' : 'none')) : null,
                    // Whether this bot's message shapes have to be explained before anything happens.
                    // False for bots we keep, our own bots, and Discord system personas.
                    gated: needsEvidence(meta, presentNames),
                    why: meta?.why ?? null,
                    holdsData: DATA_HOLDERS[b.bot_id] ?? null,
                    retired: retired.find(r => r.bot_id === b.bot_id) ?? null,
                };
            }),
            webhookOnly: WEBHOOK_ONLY,
        });
    } catch (err) {
        logger.error(`[API takeover] get failed: ${err.message}`, { stack: err.stack });
        res.status(500).json({ error: 'Failed to load takeover state' });
    }
});

router.post('/scan', async (req, res) => {
    try {
        const guild = resolveGuild(req, res);
        if (!guild) return;
        const depth = ['quick', 'standard', 'deep'].includes(req.body?.depth) ? req.body.depth : 'deep';
        const result = await startScan(guild, { depth, startedBy: req.user?.id ?? null });
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(409).json({ error: err.message });
    }
});

router.post('/scan/resume', async (req, res) => {
    try {
        const guild = resolveGuild(req, res);
        if (!guild) return;
        const scan = await getLatestScan(guild.id);
        if (!scan) return res.status(404).json({ error: 'No scan to resume.' });
        res.json({ success: true, ...(await resumeScan(guild, scan.id)) });
    } catch (err) {
        res.status(409).json({ error: err.message });
    }
});

router.post('/scan/cancel', (req, res) => {
    res.json({ success: cancelScan(req.params.guildId) });
});

// ── Evidence ─────────────────────────────────────────────────────────────────

router.get('/bots/:botId/templates', async (req, res) => {
    try {
        const scan = await getLatestScan(req.params.guildId);
        if (!scan) return res.status(404).json({ error: 'Run a scan first.' });
        const rows = await getTemplates(scan.id, req.params.botId);
        res.json({
            scanId: scan.id,
            templates: rows.map(t => ({ ...t, triggers: safeJson(t.triggers, []), channels: safeJson(t.channels, []) })),
        });
    } catch (err) {
        logger.error(`[API takeover] templates failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to load evidence' });
    }
});

router.post('/bots/:botId/auto-attribute', async (req, res) => {
    try {
        const scan = await getLatestScan(req.params.guildId);
        if (!scan) return res.status(404).json({ error: 'Run a scan first.' });
        const bot = (await getBots(scan.id)).find(b => b.bot_id === req.params.botId);
        res.json(await autoAttribute(scan.id, req.params.botId, bot?.name ?? null, req.botClient?.user?.id ?? null));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * Auto-attribute every bot in one pass. The per-bot button already existed, but with ~700 template
 * shapes across 19 bots that is a lot of clicking to establish something the signatures already
 * know. Returns what it cleared and, crucially, what it did NOT — the leftovers are the whole point
 * of the evidence gate and must stay visible.
 */
router.post('/auto-attribute-all', async (req, res) => {
    try {
        const scan = await getLatestScan(req.params.guildId);
        if (!scan) return res.status(404).json({ error: 'Run a scan first.' });

        const selfId = req.botClient?.user?.id ?? null;
        const bots = await getBots(scan.id);
        const presentNames = presentBotNames(bots);
        const results = [];
        for (const b of bots) {
            const meta = resolveBotMeta(b.bot_id, b.name, selfId);
            const r = await autoAttribute(scan.id, b.bot_id, b.name, selfId);
            // Only a bot we intend to REMOVE has to have every shape explained. A bot we keep, one
            // of ours, or a Discord system persona is not gated on anything, so its leftovers are
            // not a to-do — counting them just makes a finished takeover look unfinished.
            results.push({ botId: b.bot_id, name: b.name, ...r, gated: needsEvidence(meta, presentNames) });
        }
        const matched = results.reduce((s, r) => s + (r.matched ?? 0), 0);
        const outstanding = results.filter(r => r.gated && r.remaining > 0);
        const remaining = outstanding.reduce((s, r) => s + r.remaining, 0);
        res.json({ success: true, matched, remaining, results: outstanding });
    } catch (err) {
        logger.error(`[API takeover] auto-attribute-all failed: ${err.message}`, { stack: err.stack });
        res.status(500).json({ error: err.message });
    }
});

router.post('/templates/:id/attribute', async (req, res) => {
    try {
        const scan = await getLatestScan(req.params.guildId);
        if (!scan) return res.status(404).json({ error: 'Run a scan first.' });
        const ok = await attribute(scan.id, Number(req.params.id), {
            attributed: !!req.body?.attributed,
            feature: req.body?.feature ?? 'manual',
            userId: req.user?.id ?? null,
        });
        if (!ok) return res.status(404).json({ error: 'No such template in the latest scan.' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Parity ───────────────────────────────────────────────────────────────────

router.get('/plan', async (req, res) => {
    try {
        const guild = resolveGuild(req, res);
        if (!guild) return;
        res.json(await plan(guild));
    } catch (err) {
        logger.error(`[API takeover] plan failed: ${err.message}`, { stack: err.stack });
        res.status(500).json({ error: 'Failed to build a plan' });
    }
});

router.post('/apply', async (req, res) => {
    try {
        const guild = resolveGuild(req, res);
        if (!guild) return;
        const planned = await plan(guild);
        const only = Array.isArray(req.body?.only) && req.body.only.length ? req.body.only : undefined;
        const results = await apply(guild, planned, only);
        logger.info(`[Takeover] ${req.user?.id} applied ${results.filter(r => r.outcome === 'applied').length} step(s) to ${guild.name}`);
        res.json({ success: true, results });
    } catch (err) {
        logger.error(`[API takeover] apply failed: ${err.message}`, { stack: err.stack });
        res.status(500).json({ error: 'Failed to apply the plan' });
    }
});

/**
 * Post the self-assign role panels. Deliberately NOT a step in /apply: it is the only action that
 * creates messages in the server, so it must be asked for by name and never ride along with a
 * config sweep. Carl-bot's originals are left where they are.
 */
router.post('/panels', ownerOnly, async (req, res) => {
    try {
        const guild = resolveGuild(req, res);
        if (!guild) return;

        const planned = await plan(guild);
        const step = planned.steps.find(s => s.key === 'platform_emoji');
        if (step && !step.done) {
            return res.status(409).json({
                error: 'The platform emoji are not in this server yet — apply the "Platform emoji" step first, ' +
                       'or the platform panel will render blank buttons.',
            });
        }

        const results = await postPanels(guild);
        logger.info(`[Takeover] ${req.user?.id} posted ${results.filter(r => r.outcome === 'posted').length} panel(s) to ${guild.name}`);
        res.json({ success: true, results });
    } catch (err) {
        logger.error(`[API takeover] panels failed: ${err.message}`, { stack: err.stack });
        res.status(500).json({ error: err.message });
    }
});

// ── Retire ───────────────────────────────────────────────────────────────────

router.get('/bots/:botId/gates', async (req, res) => {
    try {
        const guild = resolveGuild(req, res);
        if (!guild) return;
        const scan = await getLatestScan(guild.id);
        const usable = scan?.status === 'complete' ? scan.id : null;
        res.json(await evaluate(guild, req.params.botId, usable));
    } catch (err) {
        logger.error(`[API takeover] gates failed: ${err.message}`, { stack: err.stack });
        res.status(500).json({ error: 'Failed to evaluate gates' });
    }
});

router.post('/bots/:botId/extraction-ack', ownerOnly, async (req, res) => {
    try {
        await acknowledgeExtraction(req.params.guildId, req.params.botId, req.user?.id ?? null);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/** Typed-confirmation removal. The guild name must match exactly. */
router.post('/bots/:botId/retire', ownerOnly, async (req, res) => {
    try {
        const guild = resolveGuild(req, res);
        if (!guild) return;
        if (String(req.body?.confirm ?? '') !== guild.name) {
            return res.status(400).json({ error: `Type the server name exactly to confirm: ${guild.name}` });
        }

        const scan = await getLatestScan(guild.id);
        if (scan?.status !== 'complete') {
            return res.status(409).json({ error: 'A completed scan is required before removing a bot.' });
        }

        const result = await retire(guild, req.params.botId, { scanId: scan.id, userId: req.user?.id });
        if (!result.ok) return res.status(409).json(result);
        res.json(result);
    } catch (err) {
        logger.error(`[API takeover] retire failed: ${err.message}`, { stack: err.stack });
        res.status(500).json({ error: 'Failed to remove the bot' });
    }
});

const safeJson = (v, fallback) => {
    if (v == null) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return fallback; }
};

export default router;
