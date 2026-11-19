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
import { plan, apply, postPanels, postTwitchLinkPanel, postForestFire, executeAll, profileFor, KNOWN_BOTS, WEBHOOK_ONLY, resolveBotMeta, needsEvidence, presentBotNames, featuresOf, FEATURES } from '../../../../core/takeover-manager.js';
import { deriveProfile, getProfile, approveProfile, needsReview } from '../../../../core/takeover-profile.js';
import { evaluate, retire, autoAttribute, acknowledgeExtraction, acknowledgeParity, DATA_HOLDERS, DEFAULT_SOAK_HOURS } from '../../../../core/bot-retirement.js';
import { QUESTIONS, CATALOGUE } from '../../../../core/takeover-questions.js';
import { classifyTemplate, summariseBot, asList } from '../../../../core/takeover-classifier.js';
import { catalogueWork, applyCatalogue } from '../../../../core/takeover-catalogue.js';
import { loadDecisions } from '../../../../core/takeover-decisions.js';
import { getQuestionnaire } from '../../../../core/takeover-questionnaire.js';
import { resolveOwner } from '../../../../core/takeover-owner.js';
import { createLink } from '../../kabster.js';
import { logFeatureEvent, userLabel } from '../../../../core/feature-log.js';

const router = express.Router({ mergeParams: true });

/**
 * The owner's questionnaire URL.
 *
 * `/owner/<token>` — named after the ROLE, not after the first person we ever built it for. The
 * original `/kabster/<token>` path is still served for links already handed out, but nothing mints
 * one any more: sending someone a link with a stranger's name in it is a bad first impression of a
 * page that is asking them to trust it.
 */
const ownerLink = (token) =>
    `${(process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/$/, '')}/owner/${token}`;

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

        // What each speaker was actually caught doing here, read from its own messages. One query
        // for the whole scan; the bot list would otherwise have to describe bots by what they are
        // CAPABLE of, which is how a server running Dyno purely for voice logs ends up being told
        // about its starboard.
        const [allTemplates] = scan
            ? await pool.execute(
                `SELECT id, bot_id, sample, occurrences, attributed, triggers, channels
                   FROM guild_scan_templates WHERE scan_id = ?`,
                [scan.id])
            : [[]];
        const templatesByBot = new Map();
        for (const t of allTemplates) {
            const withNames = {
                ...t,
                channelNames: asList(t.channels).map(id => guild.channels.cache.get(id)?.name).filter(Boolean),
            };
            (templatesByBot.get(t.bot_id) ?? templatesByBot.set(t.bot_id, []).get(t.bot_id)).push(withNames);
        }

        const [retired] = await pool.execute(
            'SELECT bot_id, retired_at, method FROM guild_retire_state WHERE guild_id = ? AND retired_at IS NOT NULL',
            [guild.id]);

        res.json({
            guildName: guild.name,
            botName: req.botClient?.user?.username ?? 'the bot',
            // Who this server belongs to. The page talks about this person constantly; it addresses
            // them by the name their own server shows, and never by a pronoun nobody told us.
            owner: await resolveOwner(guild),
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
                    // Every job this bot does, in the words a human uses for them. The big
                    // all-rounders do six at once and naming only the first one made removing them
                    // look far safer than it is.
                    features: featuresOf(meta).map(f => ({ key: f, label: FEATURES[f]?.label ?? f })),
                    // 'self' | 'full' | 'partial' | 'none'. Defaults to full when a feature is set,
                    // so an entry that simply omits it is never mislabelled as unreplaceable.
                    coverage: meta ? (meta.coverage ?? (meta.feature ? 'full' : 'none')) : null,
                    // Whether this bot's message shapes have to be explained before anything happens.
                    // False for bots we keep, our own bots, and Discord system personas.
                    gated: needsEvidence(meta, presentNames),
                    why: meta?.why ?? null,
                    holdsData: DATA_HOLDERS[b.bot_id] ?? null,
                    retired: retired.find(r => r.bot_id === b.bot_id) ?? null,
                    // A one-line answer to "what is this thing doing in my server?".
                    did: summariseBot(templatesByBot.get(b.bot_id) ?? [], featuresOf(meta))
                        .families.filter(f => f.kind === 'feature')
                        .slice(0, 4)
                        .map(f => ({ says: f.says, occurrences: f.occurrences })),
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

/**
 * What this bot actually did here.
 *
 * Returns BOTH the behaviour families and the raw shapes. The families are what a person reads —
 * "Go-live announcements ×174" instead of 174 near-identical lines that differ only by which game
 * somebody was streaming. The raw list stays because the families are a reading of the evidence and
 * the evidence itself must remain inspectable; a summary nobody can drill into is just a claim.
 */
router.get('/bots/:botId/templates', async (req, res) => {
    try {
        const scan = await getLatestScan(req.params.guildId);
        if (!scan) return res.status(404).json({ error: 'Run a scan first.' });
        const rows = await getTemplates(scan.id, req.params.botId);

        const bot = (await getBots(scan.id)).find(b => b.bot_id === req.params.botId);
        const meta = resolveBotMeta(req.params.botId, bot?.name ?? null, req.botClient?.user?.id ?? null);
        const candidates = featuresOf(meta);

        // Channel NAMES, not ids. "#server-logs" is a hint the classifier can use; a snowflake is
        // not. Resolved here because this is where a live guild is in scope.
        const withContext = rows.map(t => ({
            ...t,
            channelNames: asList(t.channels).map(id => guild.channels.cache.get(id)?.name).filter(Boolean),
        }));

        const summary = summariseBot(withContext, candidates);
        res.json({
            scanId: scan.id,
            families: summary.families,
            explained: summary.explained,
            unexplained: summary.unexplained,
            // Command → reply pairs we caught. For a custom-command system this is the takeover:
            // nothing else anywhere holds a copy.
            customCommands: summary.customCommands,
            templates: withContext.map(t => {
                const triggers = safeJson(t.triggers, []);
                const v = classifyTemplate(t.sample, candidates, {
                    triggers, channelNames: t.channelNames,
                });
                return {
                    ...t,
                    triggers,
                    channels: asList(t.channels),
                    // Why we think this is what it is — so a person can disagree with the reasoning
                    // rather than with a checkbox.
                    verdict: {
                        feature: v.feature, kind: v.kind, confidence: v.confidence,
                        says: v.says, matched: v.matched, command: v.command,
                        replacement: v.kind === 'feature' ? (FEATURES[v.feature]?.replacement ?? null) : null,
                    },
                };
            }),
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
        const guild = req.botClient?.guilds?.cache?.get(req.params.guildId) ?? null;
        res.json(await autoAttribute(scan.id, req.params.botId, bot?.name ?? null,
            req.botClient?.user?.id ?? null, guild));
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
        const guild = req.botClient?.guilds?.cache?.get(req.params.guildId) ?? null;
        for (const b of bots) {
            const meta = resolveBotMeta(b.bot_id, b.name, selfId);
            const r = await autoAttribute(scan.id, b.bot_id, b.name, selfId, guild);
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

/**
 * Tick (or untick) a whole behaviour family at once.
 *
 * 174 go-live announcements are one decision, not 174. Making a person express that decision 174
 * times is not extra safety — it is the thing that makes people click "select all" without reading,
 * which is strictly worse than one informed click.
 */
router.post('/bots/:botId/attribute-family', async (req, res) => {
    try {
        const scan = await getLatestScan(req.params.guildId);
        if (!scan) return res.status(404).json({ error: 'Run a scan first.' });

        const ids = (Array.isArray(req.body?.templateIds) ? req.body.templateIds : [])
            .map(Number).filter(Number.isInteger);
        if (!ids.length) return res.status(400).json({ error: 'No shapes given.' });

        const attributed = !!req.body?.attributed;
        const feature = String(req.body?.feature ?? 'manual').slice(0, 64);

        // Scoped to THIS scan and THIS bot. The ids arrive from the client, and without both
        // clauses a crafted request could clear the evidence gate on a bot nobody was looking at.
        const [result] = await pool.query(
            `UPDATE guild_scan_templates
                SET attributed = ?, attributed_to = ?, attributed_by = ?
              WHERE scan_id = ? AND bot_id = ? AND id IN (?)`,
            [attributed ? 1 : 0, attributed ? feature : null, attributed ? (req.user?.id ?? null) : null,
                scan.id, req.params.botId, ids]);

        logger.info(`[Takeover] ${req.user?.id} ${attributed ? 'attributed' : 'cleared'} `
            + `${result.affectedRows} shape(s) on ${req.params.botId} as "${feature}"`);
        res.json({ success: true, changed: result.affectedRows });
    } catch (err) {
        logger.error(`[API takeover] attribute-family failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to update those shapes' });
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

// ── Profile: the things we can only learn by reading this server's history ────

/** The stored profile, plus the list of fields derivation is NOT sure about. */
router.get('/profile', async (req, res) => {
    try {
        const profile = await getProfile(req.params.guildId);
        res.json({
            profile,
            review: profile ? needsReview(profile) : [],
            // A hand-written profile always wins over a derived one, so where a guild has one the UI
            // must not offer to overwrite something it cannot actually overwrite.
            handVerified: !!(await profileFor(req.params.guildId))?.source?.startsWith('hand'),
        });
    } catch (err) {
        logger.error(`[API takeover] get profile failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to load the profile' });
    }
});

/**
 * Read the guild's history and propose a profile. Read-only — posts nothing, changes nothing.
 * Always lands as `proposed`; a human still has to approve it before apply() will touch it.
 */
router.post('/profile/derive', async (req, res) => {
    try {
        const guild = resolveGuild(req, res);
        if (!guild) return;
        const profile = await deriveProfile(guild);
        logger.info(`[Takeover] ${req.user?.id} derived a profile for ${guild.name}`);
        res.json({ profile, review: needsReview(profile) });
    } catch (err) {
        logger.error(`[API takeover] derive failed: ${err.message}`, { stack: err.stack });
        res.status(500).json({ error: err.message });
    }
});

/**
 * Sign it off. Owner-only: an approved profile is what apply() is allowed to write into the server,
 * so approving is the moment a machine's guess becomes a human's decision.
 */
router.post('/profile/approve', ownerOnly, async (req, res) => {
    try {
        const guild = resolveGuild(req, res);
        if (!guild) return;
        const merged = await approveProfile(guild.id, req.user.id, req.body?.edits ?? null);
        res.json({ success: true, profile: merged });
    } catch (err) {
        logger.error(`[API takeover] approve failed: ${err.message}`);
        res.status(400).json({ error: err.message });
    }
});

/**
 * What the server owner has told us they want, on their own questionnaire.
 *
 * This is the admin side of the owner link. A server owner usually has no dashboard account, so
 * their answers land in the DB and this is where we read them — next to the plan they are answers
 * to, rather than in a shell somewhere.
 *
 * Minting is idempotent: one live link per guild. We never silently issue a second URL, because two
 * live capability URLs means one of them is loose and nobody knows which.
 */
router.get('/questionnaire', async (req, res) => {
    try {
        const guild = resolveGuild(req, res);
        if (!guild) return;

        const [[link]] = await pool.execute(
            'SELECT token FROM takeover_questionnaire_links WHERE guild_id = ? AND revoked = 0 LIMIT 1',
            [guild.id]);
        const [rows] = await pool.execute(
            'SELECT item_key, value, note, updated_at FROM takeover_questionnaire WHERE guild_id = ?',
            [guild.id]);

        const answers = {};
        for (const r of rows) answers[r.item_key] = { value: r.value, note: r.note, updatedAt: r.updated_at };

        // Generated per-guild from this guild's own scan (core/takeover-questionnaire.js). `questions`
        // keeps its name so the manage UI renderer is unchanged; `scanned:false` → run-scan prompt.
        const set = await getQuestionnaire(guild.id);
        res.json({
            questions: set.decisions,
            catalogue: set.catalogue,
            scanned: set.scanned,
            answers,
            url: link ? ownerLink(link.token) : null,
            answered: rows.filter(r => r.value || r.note?.trim()).length,
        });
    } catch (err) {
        logger.error(`[API takeover] questionnaire failed: ${err.message}`, { stack: err.stack });
        res.status(500).json({ error: 'Failed to load the questionnaire' });
    }
});

/** Mint the link. Owner-only: it is a key to a page that speaks for this server. */
router.post('/questionnaire/link', ownerOnly, async (req, res) => {
    try {
        const guild = resolveGuild(req, res);
        if (!guild) return;

        const [[existing]] = await pool.execute(
            'SELECT token FROM takeover_questionnaire_links WHERE guild_id = ? AND revoked = 0 LIMIT 1',
            [guild.id]);

        const token = existing?.token ?? await createLink(guild.id, req.body?.label ?? null);
        if (!existing) logger.info(`[Takeover] ${req.user?.id} minted a questionnaire link for ${guild.name}`);

        res.json({ url: ownerLink(token) });
    } catch (err) {
        logger.error(`[API takeover] mint link failed: ${err.message}`, { stack: err.stack });
        res.status(500).json({ error: 'Failed to create a link' });
    }
});

/** Revoke the link. Instantly 404s the page — the way you take a key back. */
router.post('/questionnaire/revoke', ownerOnly, async (req, res) => {
    try {
        const guild = resolveGuild(req, res);
        if (!guild) return;
        await pool.execute('UPDATE takeover_questionnaire_links SET revoked = 1 WHERE guild_id = ?', [guild.id]);
        logger.info(`[Takeover] ${req.user?.id} revoked the questionnaire link for ${guild.name}`);
        res.json({ success: true });
    } catch (err) {
        logger.error(`[API takeover] revoke failed: ${err.message}`, { stack: err.stack });
        res.status(500).json({ error: 'Failed to revoke the link' });
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
        const appliedSteps = results.filter(r => r.outcome === 'applied');
        if (appliedSteps.length) {
            const notApplied = results.filter(r => r.outcome === 'failed' || r.outcome === 'blocked');
            void logFeatureEvent(() => (guild), 'system.setupApplied', () => ({
                title: '🛠️ Setup Applied',
                description: `A takeover plan was applied from the dashboard: ${appliedSteps.length} step(s) set up.`,
                fields: [
                    ['Source', 'Dashboard → Takeover'],
                    ['By', userLabel(req.user)],
                    ['Set up', appliedSteps.map(r => r.label).join(', '), false],
                    ['Not applied', notApplied.length ? notApplied.map(r => `${r.label}${r.error ? ` — ${r.error}` : ''}`).join('\n') : null, false],
                ],
            }));
        }
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
/**
 * Post the "Link your Twitch" button. Like /panels, this WRITES A MESSAGE to the guild, so it is
 * owner-only, asked for by name, and never rides along with a config apply.
 */
router.post('/twitch-link-panel', ownerOnly, async (req, res) => {
    try {
        const guild = resolveGuild(req, res);
        if (!guild) return;

        const channelId = String(req.body?.channelId ?? '');
        if (!/^\d{17,20}$/.test(channelId)) return res.status(400).json({ error: 'Pick a channel first.' });

        const result = await postTwitchLinkPanel(guild, channelId);
        logger.info(`[Takeover] ${req.user?.id} posted the Twitch link panel in ${guild.name}`);
        res.json({ success: true, ...result });
    } catch (err) {
        logger.error(`[API takeover] twitch link panel failed: ${err.message}`);
        res.status(400).json({ error: err.message });
    }
});

/**
 * The Fire. Burns the guild's tree and plants a sapling, with the story.
 *
 * One-off, owner-only, and typed-confirmation. It is destructive and it is a SURPRISE to everyone in
 * the server who is not the person clicking, which is exactly why it must never be an ordinary step
 * that rides along with a config apply.
 */
router.post('/forest-fire', ownerOnly, async (req, res) => {
    try {
        const guild = resolveGuild(req, res);
        if (!guild) return;
        if (req.body?.confirm !== 'BURN') {
            return res.status(400).json({ error: 'Type BURN to confirm. The tree does not come back.' });
        }

        const result = await postForestFire(guild, req.body?.channelId ?? null, { name: req.body?.name ?? null });
        logger.info(`[Takeover] ${req.user?.id} burned the tree in ${guild.name}`);
        res.json({ success: true, ...result });
    } catch (err) {
        logger.error(`[API takeover] forest fire failed: ${err.message}`);
        res.status(400).json({ error: err.message });
    }
});

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

/**
 * The whole takeover, in one call: stand each replacement up, then remove the bot it replaces.
 *
 * This engine has existed since the beginning and was reachable only from `/utilities takeover execute` in
 * Discord. The dashboard could write config and nothing else — so "Apply selected" reported success,
 * the old bots stayed, the old panels stayed, and the page gave no way to finish the job it had just
 * finished auditing. Every gate still applies; this is a route to the engine, not a way around it.
 *
 * `dryRun` is the default and it genuinely predicts: it calls the same `evaluate()` the live run
 * does, so what it lists is what will happen rather than an optimistic guess.
 */
router.post('/execute', ownerOnly, async (req, res) => {
    try {
        const guild = resolveGuild(req, res);
        if (!guild) return;

        const dryRun = req.body?.dryRun !== false;
        const norm = (v) => String(v ?? '').replace(/[’‘‛]/g, "'").replace(/[“”]/g, '"').trim();

        // Going live needs the server's name typed. A real barrier — this removes bots — but a
        // forgiving one: plenty of server names carry a curly apostrophe.
        if (!dryRun && norm(req.body?.confirm) !== norm(guild.name)) {
            return res.status(400).json({ error: `Type the server name exactly to run for real: ${guild.name}` });
        }

        const scan = await getLatestScan(guild.id);
        const result = await executeAll(guild, {
            scanId: scan?.id ?? null,
            userId: req.user?.id ?? null,
            dryRun,
            overrideSoak: !!req.body?.overrideSoak,
            exclude: Array.isArray(req.body?.exclude) ? req.body.exclude : [],
        });

        logger.info(`[Takeover] ${req.user?.id} ran a ${dryRun ? 'DRY RUN' : 'LIVE takeover'} on ${guild.name}`);
        if (!dryRun) {
            void logFeatureEvent(() => (guild), 'system.setupApplied', () => ({
                title: '🛠️ Setup Applied',
                description: `A full takeover ran from the dashboard: ${result.willRunCount} of ${result.order.length} action(s) ran.`,
                fields: [
                    ['Source', 'Dashboard → Takeover (execute)'],
                    ['By', userLabel(req.user)],
                    ['Soak', req.body?.overrideSoak ? 'Waived' : 'Enforced'],
                    ['Left alone', result.kept?.length ? result.kept.join(', ') : null, false],
                    ['Manual follow-ups', result.followUps?.length ? result.followUps.map(f => `• ${f}`).join('\n') : null, false],
                ],
            }));
        }
        res.json({ success: true, dryRun, ...result });
    } catch (err) {
        logger.error(`[API takeover] execute failed: ${err.message}`, { stack: err.stack });
        res.status(500).json({ error: err.message });
    }
});

/**
 * Everything the owner ticked on their questionnaire, and what it would take to make it true.
 *
 * The answers have been collected since this feature was written and acted on by nothing: an owner
 * could say yes to two dozen features, watch the plan report success, and find none of them on.
 */
router.get('/catalogue', async (req, res) => {
    try {
        const guild = resolveGuild(req, res);
        if (!guild) return;
        const decisions = await loadDecisions(guild.id);
        res.json({ items: await catalogueWork(guild, decisions) });
    } catch (err) {
        logger.error(`[API takeover] catalogue failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

/** Set them up. Creates channels and roles where a feature needs one, and says which it made. */
router.post('/catalogue/apply', ownerOnly, async (req, res) => {
    try {
        const guild = resolveGuild(req, res);
        if (!guild) return;
        const decisions = await loadDecisions(guild.id);
        const only = Array.isArray(req.body?.only) && req.body.only.length ? req.body.only : null;
        const results = await applyCatalogue(guild, decisions, { only });
        logger.info(`[Takeover] ${req.user?.id} set up `
            + `${results.filter(r => r.outcome === 'set up').length} requested feature(s) on ${guild.name}`);
        const setUp = results.filter(r => r.outcome === 'set up');
        if (setUp.length) {
            const failed = results.filter(r => r.outcome === 'failed');
            void logFeatureEvent(() => (guild), 'system.setupApplied', () => ({
                title: '🛠️ Setup Applied',
                description: `${setUp.length} feature(s) the owner asked for were set up from the dashboard's takeover catalogue.`,
                fields: [
                    ['Source', 'Dashboard → Takeover (catalogue)'],
                    ['By', userLabel(req.user)],
                    ['Set up', setUp.map(r => r.label).join(', '), false],
                    ['Failed', failed.length ? failed.map(r => `${r.label}${r.detail ? ` — ${r.detail}` : ''}`).join('\n') : null, false],
                ],
            }));
        }
        res.json({ success: true, results });
    } catch (err) {
        logger.error(`[API takeover] catalogue apply failed: ${err.message}`, { stack: err.stack });
        res.status(500).json({ error: err.message });
    }
});

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
/**
 * "I have set up the parts you cannot check."
 *
 * Some replacements cannot be machine-verified — a welcome message and an auto-role need a person to
 * choose a channel and a role, and no amount of waiting makes that checkable. Without this, a bot
 * that does one of those alongside six things we CAN verify was permanently un-retirable.
 */
router.post('/bots/:botId/parity-ack', ownerOnly, async (req, res) => {
    try {
        const guild = resolveGuild(req, res);
        if (!guild) return;
        const features = Array.isArray(req.body?.features) ? req.body.features.map(String).slice(0, 20) : [];
        await acknowledgeParity(guild.id, req.params.botId, req.user?.id ?? null, features);
        logger.info(`[Takeover] ${req.user?.id} confirmed hand-set-up parity for ${req.params.botId} `
            + `on ${guild.name}: ${features.join(', ') || '(unspecified)'}`);
        res.json({ success: true });
    } catch (err) {
        logger.error(`[API takeover] parity-ack failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

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

        // Waiving the 24h soak is its own deliberate act, with its own confirmation — never a silent
        // rider on the removal. The route is already owner-only, but the waiver additionally demands
        // the caller type the acknowledgement, so it cannot be flipped on by a default-true checkbox
        // or a replayed request. It waives ONLY the soak; core/bot-retirement enforces the rest.
        let overrideSoak = false;
        if (req.body?.overrideSoak === true) {
            if (String(req.body?.acknowledgeSoakWaiver ?? '') !== 'SKIP SOAK') {
                return res.status(400).json({
                    error: 'To skip the 24h soak, type exactly: SKIP SOAK. Every other gate is still enforced.',
                });
            }
            overrideSoak = true;
            logger.warn(`[Takeover] ${req.user?.id} is removing ${req.params.botId} from ${guild.name} `
                + 'WITH THE SOAK WAIVED — the 24h parity proof is being skipped.');
        }

        const result = await retire(guild, req.params.botId, { scanId: scan.id, userId: req.user?.id, overrideSoak });
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
