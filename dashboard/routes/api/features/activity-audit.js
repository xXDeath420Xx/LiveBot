/**
 * Activity Audit API — `/api/guilds/:guildId/activity-audit/*`
 *
 * Gated by `apiCheckGuildAdmin` on the parent router, so every request here already holds
 * Manage Server on the guild in question. Every handler still re-checks that the audit it
 * is asked about belongs to THIS guild: audit ids are sequential across all guilds, so
 * without that check a valid admin of one server could read another server's roster by
 * guessing an id.
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import {
    runAudit, loadAudit, latestAudit, compareAudits,
    SEGMENTS, formatDuration, DEFAULT_WINDOW_DAYS,
} from '../../../../core/activity-audit.js';
import { buildAuditEmbeds } from '../../../../core/activity-audit-render.js';
import { normaliseFilter, applyFilter, describeFilter, FILTER_FIELDS } from '../../../../core/activity-audit-filter.js';
import {
    planAction, executeAction, recentActions, actionTargets,
    ACTIONS, MAX_TARGETS, MAX_SNAPSHOT_AGE_HOURS, DEFAULT_MIN_MEMBERSHIP_DAYS,
} from '../../../../core/activity-audit-actions.js';

const router = express.Router({ mergeParams: true });

/** In-flight runs, keyed by guild — a sweep takes minutes and must not be started twice. */
const running = new Map();

async function ownedAudit(auditId, guildId) {
    const loaded = await loadAudit(auditId);
    if (!loaded || loaded.audit.guildId !== guildId) return null;
    return loaded;
}

/** GET / — page bootstrap: audit list, segment definitions, latest snapshot id. */
router.get('/', async (req, res) => {
    try {
        const guildId = req.params.guildId;
        const [audits] = await pool.execute(
            `SELECT audit_id, window_days, status, started_at, completed_at, totals, voice_tracked, source
               FROM activity_audits WHERE guild_id = ? ORDER BY audit_id DESC LIMIT 25`,
            [guildId]
        );
        res.json({
            success: true,
            running: running.has(guildId) ? running.get(guildId) : null,
            defaultWindowDays: DEFAULT_WINDOW_DAYS,
            segments: SEGMENTS.map(s => ({ key: s.key, label: s.label, tone: s.tone, describe: s.describe })),
            filterFields: FILTER_FIELDS,
            actions: Object.entries(ACTIONS).map(([key, a]) => ({ key, ...a })),
            limits: { maxTargets: MAX_TARGETS, maxSnapshotAgeHours: MAX_SNAPSHOT_AGE_HOURS,
                      defaultMinMembershipDays: DEFAULT_MIN_MEMBERSHIP_DAYS },
            recentActions: await recentActions(guildId, 10),
            audits: audits.map(a => ({
                id: a.audit_id, windowDays: a.window_days, status: a.status,
                startedAt: a.started_at, completedAt: a.completed_at, source: a.source,
                voiceTracked: Boolean(a.voice_tracked),
                totals: a.totals ? JSON.parse(a.totals) : null,
            })),
            latestId: await latestAudit(guildId),
        });
    } catch (e) {
        logger.error('[ActivityAudit API] bootstrap failed', { error: e.message });
        res.status(500).json({ success: false, error: e.message });
    }
});

/** GET /status — progress of an in-flight sweep. */
router.get('/status', (req, res) => {
    res.json({ success: true, running: running.get(req.params.guildId) ?? null });
});

/** GET /:auditId — the full member table plus segment counts and comparison. */
router.get('/:auditId(\\d+)', async (req, res) => {
    try {
        const loaded = await ownedAudit(Number(req.params.auditId), req.params.guildId);
        if (!loaded) return res.status(404).json({ success: false, error: 'Audit not found for this server' });

        const previousId = await latestAudit(req.params.guildId, { before: loaded.audit.id });
        const diff = previousId ? await compareAudits(loaded.audit.id, previousId) : null;

        // Deltas are attached per member so the table can show movement inline rather than
        // making the reader cross-reference two screens.
        const prevById = new Map();
        if (diff) {
            for (const m of diff.risingByMessages) prevById.set(m.userId, m);
            for (const m of diff.risingByVoice) prevById.set(m.userId, { ...(prevById.get(m.userId) ?? {}), ...m });
        }

        res.json({
            success: true,
            audit: loaded.audit,
            segments: loaded.segments,
            comparedWith: diff ? {
                id: diff.previous.id,
                completedAt: diff.previous.completedAt,
                becameActive: diff.becameActive.length,
                wentQuiet: diff.wentQuiet.length,
                renamed: diff.renamed,
            } : null,
            members: loaded.members.map(m => ({
                ...m,
                voiceLabel: formatDuration(m.voiceSeconds),
                messageDelta: prevById.get(m.userId)?.messageDelta ?? null,
                voiceDelta: prevById.get(m.userId)?.voiceDelta ?? null,
            })),
        });
    } catch (e) {
        logger.error('[ActivityAudit API] load failed', { error: e.message });
        res.status(500).json({ success: false, error: e.message });
    }
});

/** POST /run — kick off a sweep. Returns immediately; the page polls /status. */
router.post('/run', async (req, res) => {
    const guildId = req.params.guildId;
    if (running.has(guildId)) {
        return res.status(409).json({ success: false, error: 'An audit is already running for this server', progress: running.get(guildId) });
    }
    const days = Math.min(365, Math.max(7, Number(req.body?.days) || DEFAULT_WINDOW_DAYS));
    const client = req.botClient;
    if (!client) return res.status(503).json({ success: false, error: 'No bot client available for this server' });

    running.set(guildId, { done: 0, total: null, startedAt: Date.now() });
    res.json({ success: true, started: true, days });

    // Deliberately not awaited: a full sweep runs for minutes and would blow past any
    // sensible HTTP timeout. Progress is exposed through /status instead.
    runAudit(client, guildId, {
        days,
        requestedBy: req.user?.id,
        source: 'dashboard',
        onProgress: (p) => running.set(guildId, { ...running.get(guildId), done: p.done, total: p.total, name: p.name }),
    })
        .then(({ auditId }) => running.set(guildId, { ...running.get(guildId), finished: true, auditId }))
        .catch((e) => {
            logger.error('[ActivityAudit API] run failed', { guildId, error: e.message });
            running.set(guildId, { ...running.get(guildId), finished: true, error: e.message });
        })
        // Held briefly after finishing so the last poll can read the outcome rather than
        // seeing the run vanish and having to guess whether it succeeded.
        .finally(() => setTimeout(() => running.delete(guildId), 60_000));
});

/** POST /:auditId/post — publish a stored audit to a Discord channel. */
router.post('/:auditId(\\d+)/post', async (req, res) => {
    try {
        const guildId = req.params.guildId;
        const loaded = await ownedAudit(Number(req.params.auditId), guildId);
        if (!loaded) return res.status(404).json({ success: false, error: 'Audit not found for this server' });

        const channelId = String(req.body?.channelId ?? '');
        if (!/^\d{17,20}$/.test(channelId)) return res.status(400).json({ success: false, error: 'A channel is required' });

        const client = req.botClient;
        const guild = client?.guilds?.cache?.get(guildId);
        const channel = guild?.channels?.cache?.get(channelId) ?? await guild?.channels?.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased?.()) return res.status(400).json({ success: false, error: 'That channel is not a text channel the bot can see' });

        const me = guild.members.me;
        if (!channel.permissionsFor(me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
            return res.status(403).json({ success: false, error: `The bot cannot post embeds in #${channel.name}` });
        }

        const previousId = await latestAudit(guildId, { before: loaded.audit.id });
        const diff = previousId ? await compareAudits(loaded.audit.id, previousId) : null;
        const embeds = buildAuditEmbeds(loaded, { diff, guildName: guild.name });

        const size = (e) => JSON.stringify(e.data ?? e).length;
        const groups = [];
        let cur = [];
        for (const e of embeds) {
            const would = cur.reduce((s, x) => s + size(x), 0) + size(e);
            if (cur.length && (would > 5500 || cur.length >= 10)) { groups.push(cur); cur = []; }
            cur.push(e);
        }
        if (cur.length) groups.push(cur);

        const messageIds = [];
        for (const g of groups) {
            const msg = await channel.send({ embeds: g, allowedMentions: { parse: [] } });
            messageIds.push(msg.id);
            if (groups.length > 1) await new Promise(r => setTimeout(r, 900));
        }

        await pool.execute('UPDATE activity_audits SET posted_messages = ? WHERE audit_id = ?',
            [JSON.stringify([{ channelId, messageIds }]), loaded.audit.id]);

        res.json({ success: true, channel: channel.name, messageIds });
    } catch (e) {
        logger.error('[ActivityAudit API] post failed', { error: e.message });
        res.status(500).json({ success: false, error: e.message });
    }
});

/** GET /:auditId/export.csv — the whole table, for anyone who wants it in a spreadsheet. */
router.get('/:auditId(\\d+)/export.csv', async (req, res) => {
    try {
        const loaded = await ownedAudit(Number(req.params.auditId), req.params.guildId);
        if (!loaded) return res.status(404).send('Audit not found for this server');

        const cols = ['user_id', 'username', 'display_name', 'in_guild', 'joined_guild_at',
            'messages', 'channels_posted', 'first_post', 'last_post',
            'voice_seconds', 'voice_hours', 'voice_sessions', 'voice_last',
            'last_active', 'days_since_active', 'segments'];
        // Excel and Sheets treat a leading =, +, - or @ as a formula, and Discord display
        // names routinely start with those. Prefixing a quote keeps them as text.
        const cell = (v) => {
            const s = v === null || v === undefined ? '' : String(v);
            const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
            return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
        };

        const keysFor = (m) => SEGMENTS.filter(s => s.key !== 'all' && s.predicate(m, loaded.ctx)).map(s => s.key).join(' ');
        const rows = loaded.members
            .sort((a, b) => b.messages - a.messages || b.voiceSeconds - a.voiceSeconds)
            .map(m => [m.userId, m.username, m.displayName, m.inGuild ? 'yes' : 'no', m.joinedGuildAt,
                m.messages, m.channelsPosted, m.firstPost, m.lastPost,
                m.voiceSeconds, m.voiceHours, m.voiceSessions, m.voiceLast,
                m.lastActive, m.daysSinceActive, keysFor(m)].map(cell).join(','));

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition',
            `attachment; filename="activity-audit-${req.params.guildId}-${loaded.audit.id}.csv"`);
        res.send([cols.join(','), ...rows].join('\n'));
    } catch (e) {
        logger.error('[ActivityAudit API] export failed', { error: e.message });
        res.status(500).send('Export failed');
    }
});

/** POST /:auditId/filter — count and list members matching a compound filter. */
router.post('/:auditId(\\d+)/filter', async (req, res) => {
    try {
        const loaded = await ownedAudit(Number(req.params.auditId), req.params.guildId);
        if (!loaded) return res.status(404).json({ success: false, error: 'Audit not found for this server' });

        const filter = normaliseFilter(req.body?.filter ?? {});
        // Role conditions need live roles. Without the guild cached they cannot be evaluated,
        // and applyFilter fails those members closed rather than guessing.
        const guild = req.botClient?.guilds?.cache?.get(req.params.guildId);
        const roleMap = guild ? new Map(guild.members.cache.map(m => [m.id, [...m.roles.cache.keys()]])) : null;

        const matched = applyFilter(loaded.members, filter, loaded.ctx, roleMap);
        res.json({
            success: true,
            label: describeFilter(filter),
            count: matched.length,
            roleDataAvailable: Boolean(roleMap),
            members: matched.map(m => ({
                userId: m.userId, displayName: m.displayName, username: m.username,
                messages: m.messages, voiceSeconds: m.voiceSeconds, voiceSessions: m.voiceSessions,
                daysSinceActive: m.daysSinceActive, joinedGuildAt: m.joinedGuildAt, inGuild: m.inGuild,
            })),
        });
    } catch (e) {
        logger.error('[ActivityAudit API] filter failed', { error: e.message });
        res.status(500).json({ success: false, error: e.message });
    }
});

/** POST /:auditId/plan-action — dry run. Never mutates anything. */
router.post('/:auditId(\\d+)/plan-action', async (req, res) => {
    try {
        const guildId = req.params.guildId;
        const loaded = await ownedAudit(Number(req.params.auditId), guildId);
        if (!loaded) return res.status(404).json({ success: false, error: 'Audit not found for this server' });
        if (!req.botClient) return res.status(503).json({ success: false, error: 'No bot client available for this server' });

        const plan = await planAction(req.botClient, guildId, {
            auditId: loaded.audit.id,
            actionType: String(req.body?.actionType ?? ''),
            roleId: req.body?.roleId ?? null,
            filter: req.body?.filter ?? {},
            actorId: req.user?.id,
            minMembershipDays: req.body?.minMembershipDays,
            reason: req.body?.reason ?? null,
        });
        res.json({ success: true, plan });
    } catch (e) {
        // A refusal here is a designed outcome (stale snapshot, missing role), not a crash.
        res.status(400).json({ success: false, error: e.message });
    }
});

/** POST /:auditId/execute-action — requires the token from an approved plan. */
router.post('/:auditId(\\d+)/execute-action', async (req, res) => {
    try {
        const guildId = req.params.guildId;
        const loaded = await ownedAudit(Number(req.params.auditId), guildId);
        if (!loaded) return res.status(404).json({ success: false, error: 'Audit not found for this server' });
        if (!req.botClient) return res.status(503).json({ success: false, error: 'No bot client available for this server' });
        if (!req.user?.id) return res.status(401).json({ success: false, error: 'Not signed in' });

        const result = await executeAction(req.botClient, guildId, {
            auditId: loaded.audit.id,
            actionType: String(req.body?.actionType ?? ''),
            roleId: req.body?.roleId ?? null,
            filter: req.body?.filter ?? {},
            actorId: req.user.id,
            token: String(req.body?.token ?? ''),
            minMembershipDays: req.body?.minMembershipDays,
            reason: req.body?.reason ?? null,
            source: 'dashboard',
        });
        res.json({ success: true, result });
    } catch (e) {
        if (e.code === 'STALE_PLAN') {
            return res.status(409).json({ success: false, error: e.message, plan: e.plan, stale: true });
        }
        logger.error('[ActivityAudit API] execute failed', { error: e.message });
        res.status(400).json({ success: false, error: e.message });
    }
});

/** GET /actions — history; GET /actions/:id — per-member outcomes. */
router.get('/actions', async (req, res) => {
    try {
        res.json({ success: true, actions: await recentActions(req.params.guildId, 25) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/actions/:actionId(\\d+)', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT guild_id FROM activity_audit_actions WHERE action_id = ?', [req.params.actionId]);
        if (!rows.length || rows[0].guild_id !== req.params.guildId) {
            return res.status(404).json({ success: false, error: 'Action not found for this server' });
        }
        res.json({ success: true, targets: await actionTargets(Number(req.params.actionId)) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

export default router;
