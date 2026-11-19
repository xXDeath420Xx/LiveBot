/**
 * Verification API — `/api/guilds/:guildId/verification/*`
 *
 * The dashboard's Verification page (views/partials/manage/verification.ejs): verification settings
 * (on/off, I agree vs CAPTCHA, tries, time limit, fail action, DMs, panel text, roles, channel,
 * "still unverified after N days"), panel re-post, the setup wizard (preview, apply with progress,
 * undo), 30-day stats with the verification rate, the activity log (GET /log: every verification, auto-prune and
 * inactivity event plus staff queue actions, filtered, searched, keyset-paged, polled live, CSV export), the CAPTCHA clock, auto-prune
 * (settings, bypass roles, the queue with "remove from queue") and the inactivity prune (settings,
 * exempt roles, preview of who each rule would warn / remove, run now, history, last sweep). Everything
 * `/systems verification` and `/systems auto-prune` do. The logic lives in core/verification.js,
 * core/auto-prune.js and core/inactivity-prune.js.
 *
 * Gated by `apiCheckGuildAdmin` at the parent router (Manage Server from the OAuth bitfield, or a
 * bot-manager role checked live). Every write re-checks the LIVE member: configure access (owner,
 * Administrator, Manage Server or a bot-manager role); choosing a punitive action additionally needs
 * that permission in the server, and the wizard needs Manage Roles + Manage Channels (it creates roles
 * and channels and rewrites channel permissions). Super-admins act with the bot's authority.
 */

import express from 'express';
import { PermissionFlagsBits, ChannelType } from 'discord.js';
import logger from '../../../../utils/logger.js';
import { liveConfigAccess } from '../../../../core/protection-exempt.js';
import { logFeatureEvent, userLabel } from '../../../../core/feature-log.js';
import v from '../../../../core/verification.js';
import prune from '../../../../core/auto-prune.js';
import { validateSettings, LIMITS, DEFAULTS, MODES, FAIL_ACTIONS, LOCK_STRATEGIES } from '../../../../core/verification-logic.js';
import { PRUNE_LIMITS, PRUNE_ACTIONS, MAX_BYPASS_ROLES } from '../../../../core/auto-prune-logic.js';
import { closeDeadline } from '../../../../core/temp-access-manager.js';
import inactivity from '../../../../core/inactivity-prune.js';
import { INACTIVE_LIMITS, INACTIVE_DEFAULTS, MAX_EXEMPT_ROLES, MAX_EXEMPT_USERS, validateInactivitySettings, normaliseInactivityConfig } from '../../../../core/inactivity-prune-logic.js';
import { getConfig as getJoinGateConfig } from '../../../../core/join-gate.js';
import { readLog, logCounts } from '../../../../core/verification-log.js';
import { parseLogQuery, matchMemberIds, toCsv, MAX_EXPORT } from '../../../../core/verification-log-logic.js';
import { userBits } from '../../../../core/user-display.js';

const router = express.Router({ mergeParams: true });
const SNOWFLAKE = /^\d{15,25}$/;
const NEEDS = {
    ban: [PermissionFlagsBits.BanMembers, 'Ban Members'],
    kick: [PermissionFlagsBits.KickMembers, 'Kick Members'],
    timeout: [PermissionFlagsBits.ModerateMembers, 'Timeout Members'],
    roles: [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
    channels: [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
};

/** What this request may do, judged live. */
async function actorFor(req) {
    if (req.isSuperAdmin) return { canConfigure: true, perms: Object.fromEntries(Object.keys(NEEDS).map(k => [k, true])), superAdmin: true };
    const a = await liveConfigAccess(req.guildObject, req.user.id);
    const isOwner = a.member && req.guildObject.ownerId === a.member.id;
    const perms = Object.fromEntries(Object.entries(NEEDS).map(([k, [p]]) => [k, !!a.member && (isOwner || a.member.permissions.has(p))]));
    return { canConfigure: a.ok, perms, superAdmin: false };
}

/** Refuse a write the live member can't make. Sends the response itself; returns the actor or null. */
async function writer(req, res, needs = []) {
    const actor = await actorFor(req);
    if (!actor.canConfigure) {
        res.status(403).json({ error: 'You need Manage Server, Administrator or a bot-manager role in this server.' });
        return null;
    }
    for (const need of needs) {
        if (NEEDS[need] && !actor.perms[need]) {
            res.status(403).json({ error: `You need the ${NEEDS[need][1]} permission in this server for that.` });
            return null;
        }
    }
    return actor;
}

const fail = (res, where, err) => {
    if (err instanceof v.VerificationError || err instanceof prune.PruneError || err instanceof inactivity.InactivityError) return res.status(400).json({ error: err.message });
    logger.error(`[API verification] ${where} failed: ${err.message}`);
    res.status(500).json({ error: `Could not ${where}. Try again in a moment.` });
};
const userBitsForInactivity = (guild, id) => {
    const m = guild.members.cache.get(id);
    if (m) return { id, username: m.user?.username || null, displayName: m.displayName, avatar: m.user?.displayAvatarURL({ size: 64 }) || null, inServer: true };
    const u = guild.client.users.cache.get(id);
    if (u) return { id, username: u.username || null, displayName: u.globalName || u.username || null, avatar: u.displayAvatarURL({ size: 64 }) || null, inServer: false };
    return { id, username: null, displayName: null, avatar: null, inServer: false };
};
const roleRow = (guild, id) => {
    const r = id ? guild.roles.cache.get(id) : null;
    return id ? (r ? { id, name: r.name, color: r.hexColor === '#000000' ? null : r.hexColor, members: r.members.size } : { id, name: null, deleted: true }) : null;
};
/** The wizard record without the per-overwrite bitfields (the page shows counts and channel names). */
function wizardSummary(w) {
    if (!w) return null;
    return {
        status: w.status, at: w.at, by: w.by, strategy: w.strategy, hideGate: w.hideGate, runs: w.runs || 1,
        created: w.created, granted: w.granted || null, editCount: (w.edits || []).length,
        channels: [...new Set((w.edits || []).map(e => e.name))].slice(0, 200),
        failures: w.failures || [], undoneAt: w.undoneAt || null, undoneBy: w.undoneBy || null, undoFailures: w.undoFailures || [],
    };
}

// ── overview ────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    const guild = req.guildObject;
    try {
        const [cfg, stats, pruneCfg, systemRoles, actor, inactive] = await Promise.all([
            v.getVerifyConfig(guild.id), v.verificationStats(guild.id, 30),
            prune.getPruneConfig(guild.id), prune.systemRoleIds(guild.id), actorFor(req), inactivity.inactivityStatus(guild),
        ]);
        const me = guild.members.me;
        res.json({
            actor,
            limits: { ...LIMITS, prune: PRUNE_LIMITS, maxBypass: MAX_BYPASS_ROLES, inactive: INACTIVE_LIMITS, maxExempt: MAX_EXEMPT_ROLES, maxExemptUsers: MAX_EXEMPT_USERS },
            inactiveDefaults: INACTIVE_DEFAULTS,
            choices: { modes: MODES, failActions: FAIL_ACTIONS, strategies: LOCK_STRATEGIES, pruneActions: PRUNE_ACTIONS },
            defaults: DEFAULTS,
            config: cfg ? { ...cfg, wizard: undefined } : null,
            describe: v.describeConfig(cfg),
            roles: cfg ? { verified: roleRow(guild, cfg.verifiedRoleId), unverified: roleRow(guild, cfg.unverifiedRoleId) } : null,
            channel: cfg?.channelId ? (guild.channels.cache.get(cfg.channelId) ? { id: cfg.channelId, name: guild.channels.cache.get(cfg.channelId).name } : { id: cfg.channelId, deleted: true }) : null,
            wizard: wizardSummary(cfg?.wizard),
            wizardJob: v.wizardProgress(guild.id),
            stats,
            prune: { ...pruneCfg, bypassRoles: pruneCfg.bypassRoleIds.map(id => roleRow(guild, id)) },
            inactivity: { ...inactive, exemptRoles: inactive.exemptRoleIds.map(id => roleRow(guild, id)), exemptUsers: (inactive.exemptUserIds || []).map(id => userBitsForInactivity(guild, id)) },
            staffRoleIds: inactivity.staffRoleIds(guild),
            systemRoles: systemRoles.map(id => roleRow(guild, id)).filter(Boolean),
            botPerms: {
                manageRoles: !!me?.permissions.has(PermissionFlagsBits.ManageRoles),
                manageChannels: !!me?.permissions.has(PermissionFlagsBits.ManageChannels),
                kick: !!me?.permissions.has(PermissionFlagsBits.KickMembers),
                ban: !!me?.permissions.has(PermissionFlagsBits.BanMembers),
                timeout: !!me?.permissions.has(PermissionFlagsBits.ModerateMembers),
                topRolePosition: me?.roles.highest.position ?? 0,
            },
            guildRoles: [...guild.roles.cache.values()]
                .filter(r => r.id !== guild.id && !r.managed)
                .sort((a, b) => b.position - a.position)
                .map(r => ({ id: r.id, name: r.name, color: r.hexColor === '#000000' ? null : r.hexColor, members: r.members.size, position: r.position })),
            textChannels: [...guild.channels.cache.values()]
                .filter(c => c.type === ChannelType.GuildText)
                .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
                .map(c => ({ id: c.id, name: c.name })),
        });
    } catch (err) {
        fail(res, 'load verification', err);
    }
});

router.get('/attempts', async (req, res) => {
    try {
        const rows = await v.recentAttempts(req.guildObject.id, Number(req.query.limit) || 50);
        res.json({ attempts: rows.map(a => ({ ...a, user: userBits(req.guildObject, a.user_id) })) });
    } catch (err) {
        fail(res, 'load recent attempts', err);
    }
});

// ── activity log ────────────────────────────────────────────────────────────

/** Cached members whose name matches the search (ids and plain names are handled by the SQL). */
function searchIds(guild, q) {
    if (!q || /^\d{15,25}$/.test(q)) return [];
    const members = (function* () {
        for (const m of guild.members.cache.values()) yield { id: m.id, username: m.user?.username, globalName: m.user?.globalName, displayName: m.displayName };
    })();
    return matchMemberIds(members, q);
}
const withUser = (guild, r) => ({
    ...r, user: userBits(guild, r.userId),
    ...(r.answer?.channelId ? { answer: { ...r.answer, channelName: guild.channels.cache.get(r.answer.channelId)?.name || null } } : {}),
});
/** Byte-order mark so Excel opens the UTF-8 CSV with names intact. */
const BOM = String.fromCharCode(0xfeff);

/**
 * GET /log?type=all|verification|prune|inactivity|failures&range=24h|7d|30d|all&q=&before=<cursor>&limit=
 * One page, newest first, with the counts per filter. With since=<cursor>: only newer rows (the page polls this).
 */
router.get('/log', async (req, res) => {
    const parsed = parseLogQuery(req.query);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const p = parsed.params;
    const guild = req.guildObject;
    try {
        const memberIds = searchIds(guild, p.q);
        if (p.since) {
            const out = await readLog(guild.id, p, { memberIds });
            return res.json({ rows: out.rows.map(r => withUser(guild, r)), truncated: out.truncated, latestCursor: out.latestCursor });
        }
        const [page, counts] = await Promise.all([readLog(guild.id, p, { memberIds }), p.before ? null : logCounts(guild.id, p, { memberIds })]);
        res.json({ rows: page.rows.map(r => withUser(guild, r)), hasMore: page.hasMore, nextCursor: page.nextCursor, counts });
    } catch (err) {
        fail(res, 'load the activity log', err);
    }
});

/** The same filters as a CSV download (newest MAX_EXPORT rows). */
router.get('/log/export', async (req, res) => {
    const parsed = parseLogQuery({ ...req.query, before: undefined, since: undefined });
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const guild = req.guildObject;
    try {
        const page = await readLog(guild.id, parsed.params, { memberIds: searchIds(guild, parsed.params.q), export: true });
        const stamp = new Date().toISOString().slice(0, 10);
        logger.info(`[API verification] ${req.user.username} exported ${page.rows.length} activity rows (${parsed.params.type}, ${parsed.params.range}) in ${guild.id}`);
        res.set('Content-Type', 'text/csv; charset=utf-8');
        res.set('Content-Disposition', `attachment; filename="verification-activity-${guild.id}-${stamp}.csv"`);
        res.set('Cache-Control', 'no-store');
        if (page.hasMore) res.set('X-Truncated', String(MAX_EXPORT));
        res.send(BOM + toCsv(page.rows.map(r => withUser(guild, r))));
    } catch (err) {
        fail(res, 'export the activity log', err);
    }
});

router.get('/stats', async (req, res) => {
    try {
        res.json({ stats: await v.verificationStats(req.guildObject.id, Number(req.query.days) || 30) });
    } catch (err) {
        fail(res, 'load the stats', err);
    }
});

// ── settings ────────────────────────────────────────────────────────────────

router.post('/settings', async (req, res) => {
    const b = req.body || {};
    const needs = ['kick', 'ban', 'timeout'].includes(b.failAction) ? [b.failAction] : [];
    if (b.unverifiedKickDays > 0) needs.push('kick');
    const actor = await writer(req, res, needs);
    if (!actor) return;
    const guild = req.guildObject;
    const input = {};
    for (const k of ['enabled', 'mode', 'attempts', 'windowMinutes', 'failAction', 'timeoutMinutes', 'failDm',
        'verifiedRoleId', 'unverifiedRoleId', 'channelId', 'panelTitle', 'panelText', 'unverifiedKickDays']) {
        if (b[k] !== undefined) input[k] = b[k];
    }
    const { patch, errors } = validateSettings(input);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    for (const [col, label] of [['verified_role_id', 'verified'], ['unverified_role_id', 'unverified']]) {
        if (!patch[col]) continue;
        const role = guild.roles.cache.get(patch[col]);
        if (!role || role.managed || role.id === guild.id) return res.status(400).json({ error: `Pick a normal role for the ${label} role.` });
        if ((guild.members.me?.roles.highest.position ?? 0) <= role.position) return res.status(400).json({ error: `My highest role must be above ${role.name}.` });
    }
    if (patch.gate_channel_id) {
        const ch = guild.channels.cache.get(patch.gate_channel_id);
        if (!ch || ch.type !== ChannelType.GuildText) return res.status(400).json({ error: 'Pick a text channel in this server.' });
    }
    try {
        const cfg = await v.saveVerifyConfig(guild.id, patch);
        logger.info(`[API verification] ${req.user.username} saved verification settings in ${guild.id}`);
        void logFeatureEvent(() => (guild), 'join-gate.verifySettings', () => ({
            title: '⚙️ Verification Settings Changed',
            fields: [['By', userLabel(req.user.id)], ['Verification', v.describeConfig(cfg)],
                ['Still-unverified cleanup', cfg.unverifiedKickDays ? `after ${cfg.unverifiedKickDays} days` : 'off']],
        }));
        res.json({ ok: true, config: { ...cfg, wizard: undefined }, describe: v.describeConfig(cfg) });
    } catch (err) {
        fail(res, 'save the settings', err);
    }
});

router.post('/panel', async (req, res) => {
    if (!(await writer(req, res))) return;
    const channelId = req.body?.channelId && SNOWFLAKE.test(String(req.body.channelId)) ? String(req.body.channelId) : null;
    try {
        const msg = await v.postPanel(req.guildObject, { channelId });
        logger.info(`[API verification] ${req.user.username} posted the verification panel in ${req.guildObject.id}`);
        res.json({ ok: true, url: msg.url, channelId: msg.channelId });
    } catch (err) {
        fail(res, 'post the panel', err);
    }
});

// ── setup wizard ────────────────────────────────────────────────────────────

router.post('/wizard/preview', async (req, res) => {
    if (!(await writer(req, res))) return;
    try {
        res.json(await v.wizardPreview(req.guildObject, req.body || {}));
    } catch (err) {
        fail(res, 'preview the setup', err);
    }
});

router.post('/wizard/apply', async (req, res) => {
    if (!(await writer(req, res, ['roles', 'channels']))) return;
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Confirm the preview first.' });
    try {
        const job = await v.wizardApply(req.guildObject, req.body || {}, { id: req.user.id, username: req.user.username });
        logger.info(`[API verification] ${req.user.username} started the verification wizard in ${req.guildObject.id}`);
        res.json({ ok: true, job });
    } catch (err) {
        fail(res, 'start the setup', err);
    }
});

router.post('/wizard/undo', async (req, res) => {
    if (!(await writer(req, res, ['roles', 'channels']))) return;
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Confirm the undo first.' });
    try {
        const job = await v.wizardUndo(req.guildObject, { deleteCreated: req.body?.deleteCreated === true }, { id: req.user.id, username: req.user.username });
        logger.info(`[API verification] ${req.user.username} started the verification undo in ${req.guildObject.id}`);
        res.json({ ok: true, job });
    } catch (err) {
        fail(res, 'start the undo', err);
    }
});

router.get('/wizard/progress', (req, res) => {
    res.json({ job: v.wizardProgress(req.guildObject.id) });
});

// ── queues ──────────────────────────────────────────────────────────────────

router.get('/queue', async (req, res) => {
    const guild = req.guildObject;
    try {
        const [verifyRows, pruneRows] = await Promise.all([v.verifyQueue(guild.id), prune.pruneQueue(guild)]);
        res.json({
            verify: verifyRows.map(r => ({ userId: r.user_id, attempts: r.attempts, startedAt: r.started_ms, deadline: r.expires_ms, user: userBits(guild, r.user_id) })),
            prune: pruneRows.map(r => ({ ...r, user: userBits(guild, r.userId) })),
        });
    } catch (err) {
        fail(res, 'load the queues', err);
    }
});

/** Stop someone's CAPTCHA clock (they can still verify; nothing happens at the deadline). */
router.delete('/queue/verify/:userId', async (req, res) => {
    if (!(await writer(req, res))) return;
    const userId = String(req.params.userId);
    if (!SNOWFLAKE.test(userId)) return res.status(400).json({ error: 'Not a user id.' });
    try {
        const ok = await closeDeadline(req.guildObject.id, userId, 'verify', 'exempt', `removed by ${req.user.username}`.slice(0, 255));
        if (!ok) return res.status(404).json({ error: 'That member is not waiting to verify.' });
        logger.info(`[API verification] ${req.user.username} stopped the verification clock for ${userId} in ${req.guildObject.id}`);
        res.json({ ok: true });
    } catch (err) {
        fail(res, 'update the queue', err);
    }
});

// ── auto-prune ──────────────────────────────────────────────────────────────

router.post('/prune', async (req, res) => {
    const b = req.body || {};
    const actor = await writer(req, res, b.enabled === true && b.action !== 'log' ? ['kick'] : []);
    if (!actor) return;
    const guild = req.guildObject;
    const input = {};
    for (const k of ['enabled', 'minutes', 'action', 'dm']) if (b[k] !== undefined) input[k] = b[k];
    if (b.bypassRoleIds !== undefined) {
        if (!Array.isArray(b.bypassRoleIds)) return res.status(400).json({ error: 'bypassRoleIds must be a list.' });
        const list = b.bypassRoleIds.map(String).filter(id => SNOWFLAKE.test(id));
        if (list.some(id => !guild.roles.cache.has(id))) return res.status(400).json({ error: 'One of the bypass roles is not in this server.' });
        input.bypassRoleIds = list;
    }
    try {
        const { cfg, cleared } = await prune.savePruneSettings(guild, input, { id: req.user.id, username: req.user.username });
        logger.info(`[API verification] ${req.user.username} saved auto-prune settings in ${guild.id}`);
        res.json({ ok: true, prune: { ...cfg, bypassRoles: cfg.bypassRoleIds.map(id => roleRow(guild, id)) }, cleared });
    } catch (err) {
        fail(res, 'save auto-prune', err);
    }
});

// ── inactivity prune ────────────────────────────────────────────────────────

/** Only keys the settings form sends; the exempt roles must be roles of this server. */
function inactivityInput(req, res) {
    const b = req.body || {};
    const input = {};
    for (const k of ['neverEnabled', 'neverDays', 'neverAction', 'quietEnabled', 'quietDays', 'quietAction', 'exemptBoosters',
        'exemptStaff', 'minMemberDays', 'warnDays', 'maxPerSweep', 'dailyCap']) {
        if (b[k] !== undefined) input[k] = b[k];
    }
    if (b.exemptRoleIds !== undefined) {
        if (!Array.isArray(b.exemptRoleIds)) { res.status(400).json({ error: 'exemptRoleIds must be a list.' }); return null; }
        const list = b.exemptRoleIds.map(String).filter(id => SNOWFLAKE.test(id));
        if (list.some(id => !req.guildObject.roles.cache.has(id))) { res.status(400).json({ error: 'One of the exempt roles is not in this server.' }); return null; }
        input.exemptRoleIds = list;
    }
    if (b.exemptUserIds !== undefined) {
        if (!Array.isArray(b.exemptUserIds)) { res.status(400).json({ error: 'exemptUserIds must be a list.' }); return null; }
        input.exemptUserIds = b.exemptUserIds.map(String).filter(id => SNOWFLAKE.test(id));
    }
    return input;
}

/** Would these settings (merged over the saved ones) kick anybody? */
async function wouldKick(guildId, input) {
    const { patch } = validateInactivitySettings(input);
    return normaliseInactivityConfig({ ...((await getJoinGateConfig(guildId)) || {}), ...patch }).kicks;
}


router.get('/inactivity/user-search', async (req, res) => {
    const guild = req.guildObject;
    const q = String(req.query.q ?? '').replace(/[<@!>]/g, '').trim().slice(0, 64);
    if (!q) return res.json({ members: [] });
    try {
        const found = new Map();
        if (/^\d{15,25}$/.test(q)) {
            const m = await guild.members.fetch(q).catch(() => null);
            if (m) found.set(m.id, m);
            else {
                const u = await guild.client.users.fetch(q).catch(() => null);
                if (u) return res.json({ members: [{ id: u.id, username: u.username, displayName: u.globalName ?? u.username, avatar: u.displayAvatarURL({ size: 64 }), inServer: false }] });
            }
        } else {
            const hits = await guild.members.search({ query: q, limit: 10 }).catch(() => null);
            for (const m of hits?.values() ?? []) found.set(m.id, m);
        }
        res.json({
            members: [...found.values()].slice(0, 10).map(m => ({
                id: m.id, username: m.user.username, displayName: m.displayName,
                avatar: m.user.displayAvatarURL({ size: 64 }), inServer: true, bot: m.user.bot,
            })),
        });
    } catch (err) {
        logger.warn(`[API verification] user-search failed in ${guild.id}: ${err.message}`);
        res.status(500).json({ error: 'Search failed.' });
    }
});

router.post('/inactivity', async (req, res) => {
    const input = inactivityInput(req, res);
    if (!input) return;
    const actor = await writer(req, res, (await wouldKick(req.guildObject.id, input).catch(() => true)) ? ['kick'] : []);
    if (!actor) return;
    const guild = req.guildObject;
    try {
        await inactivity.saveInactivitySettings(guild, input, { id: req.user.id, username: req.user.username });
        logger.info(`[API verification] ${req.user.username} saved inactivity prune settings in ${guild.id}`);
        const st = await inactivity.inactivityStatus(guild);
        res.json({ ok: true, inactivity: { ...st, exemptRoles: st.exemptRoleIds.map(id => roleRow(guild, id)), exemptUsers: (st.exemptUserIds || []).map(id => userBitsForInactivity(guild, id)) } });
    } catch (err) {
        fail(res, 'save the inactivity prune', err);
    }
});

/** Who each rule would warn / remove now. `settings` previews unsaved form values. Read-only. */
router.post('/inactivity/preview', async (req, res) => {
    const b = req.body || {};
    let settings = null;
    if (b.settings && typeof b.settings === 'object') {
        req.body = b.settings;
        settings = inactivityInput(req, res);
        if (!settings) return;
    }
    try {
        const out = await inactivity.previewInactivity(req.guildObject, {
            page: Number(b.page) || 1, pageSize: Number(b.pageSize) || 50, fresh: b.fresh === true, settings,
        });
        res.json(out);
    } catch (err) {
        fail(res, 'preview the inactivity prune', err);
    }
});

router.post('/inactivity/run', async (req, res) => {
    const cfg = await inactivity.getInactivityConfig(req.guildObject.id).catch(() => null);
    if (!(await writer(req, res, cfg?.kicks ? ['kick'] : []))) return;
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Confirm the run first.' });
    try {
        const out = await inactivity.runInactivityNow(req.guildObject, { id: req.user.id, username: req.user.username });
        logger.info(`[API verification] ${req.user.username} ran the inactivity prune in ${req.guildObject.id}`);
        res.json({ ok: true, ...out });
    } catch (err) {
        fail(res, 'run the inactivity prune', err);
    }
});

router.get('/inactivity/status', async (req, res) => {
    try {
        const st = await inactivity.inactivityStatus(req.guildObject);
        res.json({ inactivity: { ...st, exemptRoles: st.exemptRoleIds.map(id => roleRow(req.guildObject, id)) } });
    } catch (err) {
        fail(res, 'load the inactivity prune', err);
    }
});

router.get('/inactivity/history', async (req, res) => {
    try {
        const rows = await inactivity.inactivityHistory(req.guildObject.id, Number(req.query.limit) || 100);
        res.json({ history: rows.map(r => ({ ...r, user: userBits(req.guildObject, r.user_id) })) });
    } catch (err) {
        fail(res, 'load the inactivity history', err);
    }
});

router.delete('/prune/queue/:userId', async (req, res) => {
    if (!(await writer(req, res))) return;
    const userId = String(req.params.userId);
    if (!SNOWFLAKE.test(userId)) return res.status(400).json({ error: 'Not a user id.' });
    try {
        await prune.removeFromQueue(req.guildObject, userId, { id: req.user.id, username: req.user.username });
        logger.info(`[API verification] ${req.user.username} took ${userId} off the auto-prune queue in ${req.guildObject.id}`);
        res.json({ ok: true });
    } catch (err) {
        fail(res, 'update the queue', err);
    }
});

export default router;
