/**
 * Name Filters API — `/api/guilds/:guildId/name-filters/*`
 *
 * The dashboard's Name Filters page (views/partials/manage/name-filters.ejs): settings, the filter
 * list (add with a preview of who it would hit, edit, switch off, remove, restore), the test box,
 * template packs, the generated-username check, Auto-Pilot, the cleanse (start, progress) and its
 * review queue with bulk Ban / Kick / Mark safe / Skip, marked-safe members and recent hits.
 * Everything `/moderation namefilter` does. The logic lives in core/name-filters.js.
 *
 * Gated by `apiCheckGuildAdmin` at the parent router (Manage Server from the OAuth bitfield, or a
 * bot-manager role checked live). Every write re-checks the LIVE member: configure access (owner,
 * Administrator, Manage Server or a bot-manager role); acting on members (ban, kick, timeout, flag)
 * additionally needs that permission in the server, as on the Security page. Super-admins act with
 * the bot's authority, as everywhere else on the dashboard.
 */

import express from 'express';
import multer from 'multer';
import { PermissionFlagsBits } from 'discord.js';
import logger from '../../../../utils/logger.js';
import { liveConfigAccess } from '../../../../core/protection-exempt.js';
import nf from '../../../../core/name-filters.js';
import {
    NAME_ACTIONS, NAME_FILTER_TYPES, FIELD_LABEL, MAX_MANUAL_FILTERS, MAX_NAME_FILTERS,
} from '../../../../core/name-filter-logic.js';

const router = express.Router({ mergeParams: true });
const SNOWFLAKE = /^\d{15,25}$/;
const NEEDS = {
    ban: [PermissionFlagsBits.BanMembers, 'Ban Members'],
    kick: [PermissionFlagsBits.KickMembers, 'Kick Members'],
    timeout: [PermissionFlagsBits.ModerateMembers, 'Timeout Members'],
    flag: [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
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
async function writer(req, res, acts = []) {
    const actor = await actorFor(req);
    if (!actor.canConfigure) {
        res.status(403).json({ error: 'You need Manage Server, Administrator or a bot-manager role in this server.' });
        return null;
    }
    for (const action of acts) {
        if (NEEDS[action] && !actor.perms[action]) {
            res.status(403).json({ error: `You need the ${NEEDS[action][1]} permission in this server to ${action} members.` });
            return null;
        }
    }
    return actor;
}

const ids = (list) => (Array.isArray(list) ? list.map(String).filter(id => SNOWFLAKE.test(id)) : []);

// Import files are multipart (JSON bodies are capped at 100 kB): at most 2 MB, one file.
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
function uploadErrors(err, req, res, next) {
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That file is over 2 MB.' : err.message });
    if (err) return res.status(400).json({ error: err.message });
    next();
}
/** An import plan for the page: counts plus the first entries of each list. */
const importSummary = (plan) => ({
    ok: true, added: plan.added ?? null,
    counts: { add: plan.add.length, duplicates: plan.duplicates.length, rejected: plan.rejected.length, overCap: plan.overCap.length },
    add: plan.add.slice(0, 200), duplicates: plan.duplicates.slice(0, 200), rejected: plan.rejected.slice(0, 200), overCap: plan.overCap.slice(0, 50),
});

const fail = (res, where, err) => {
    logger.error(`[API name-filters] ${where} failed: ${err.message}`);
    res.status(500).json({ error: `Could not ${where}. Try again in a moment.` });
};

/**
 * Why the bot cannot use a role as the flag role (managed by an integration, or at/above the bot's highest
 * role), or null. A role already saved may be re-saved unchanged, so saving other settings never fails on it.
 */
async function flagRoleRefusal(guild, roleId) {
    const role = guild.roles.cache.get(roleId);
    const top = guild.members.me?.roles?.highest?.position;
    if (!role || !(role.managed || (typeof top === 'number' && role.position >= top))) return null;
    const saved = await nf.getSettings(guild.id).then(s => s.flagRoleId).catch(() => null);
    if (String(saved || '') === roleId) return null;
    return role.managed
        ? 'That role is managed by an integration, so the bot cannot give it.'
        : 'That role is not below the bot\'s highest role, so the bot cannot give it. Move the bot\'s role higher, or pick another role.';
}

const roleRow = (guild, id) => {
    const r = guild.roles.cache.get(id);
    return r ? { id, name: r.name, color: r.hexColor === '#000000' ? null : r.hexColor, deleted: false } : { id, name: null, color: null, deleted: true };
};

async function userBits(guild, id) {
    const member = guild.members.cache.get(id) || await guild.members.fetch(id).catch(() => null);
    const user = member?.user || guild.client.users.cache.get(id) || null;
    return {
        id,
        username: user?.username ?? null,
        displayName: member?.displayName ?? user?.globalName ?? user?.username ?? null,
        avatar: user?.displayAvatarURL?.({ size: 64 }) ?? null,
        inServer: !!member,
    };
}

// ── overview / settings ─────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    const guild = req.guildObject;
    try {
        const [ov, filters, templates, actor] = await Promise.all([
            nf.overview(guild), nf.listFilters(guild.id), nf.listTemplates(guild.id), actorFor(req)]);
        const autoUsers = [...new Set(filters.filter(f => f.autoUserId).map(f => f.autoUserId))];
        const autoNames = Object.fromEntries(await Promise.all(autoUsers.map(async id => [id, await userBits(guild, id)])));
        const me = guild.members.me;
        res.json({
            actor,
            limits: { manual: MAX_MANUAL_FILTERS, total: MAX_NAME_FILTERS },
            actions: NAME_ACTIONS,
            types: NAME_FILTER_TYPES,
            overview: { ...ov, settings: undefined },
            settings: ov.settings,
            flagRole: ov.settings.flagRoleId ? roleRow(guild, ov.settings.flagRoleId) : null,
            autopilotRoles: ov.settings.autopilot.roles.map(id => roleRow(guild, id)),
            botPerms: Object.fromEntries(Object.entries(NEEDS).map(([k, [p]]) => [k, !!me?.permissions?.has(p)])),
            filters,
            autoUsers: autoNames,
            templates,
            // position + the bot's highest role position let the page mark roles the bot cannot give.
            botTopPosition: me?.roles?.highest?.position ?? null,
            guildRoles: [...guild.roles.cache.values()]
                .filter(r => r.id !== guild.id && !r.managed)
                .sort((a, b) => b.position - a.position)
                .map(r => ({ id: r.id, name: r.name, color: r.hexColor === '#000000' ? null : r.hexColor, position: r.position })),
        });
    } catch (err) {
        fail(res, 'load the name filters', err);
    }
});

router.post('/settings', async (req, res) => {
    if (!(await writer(req, res))) return;
    const b = req.body || {};
    const patch = {};
    for (const k of ['enabled', 'fuzzy', 'collapse', 'dm']) if (typeof b[k] === 'boolean') patch[k] = b[k];
    if (b.flagRoleId !== undefined) {
        if (b.flagRoleId && !req.guildObject.roles.cache.has(String(b.flagRoleId))) return res.status(400).json({ error: 'That role is not in this server.' });
        const refusal = b.flagRoleId ? await flagRoleRefusal(req.guildObject, String(b.flagRoleId)) : null;
        if (refusal) return res.status(400).json({ error: refusal });
        patch.flagRoleId = b.flagRoleId ? String(b.flagRoleId) : null;
    }
    if (b.timeoutMinutes !== undefined) {
        const n = Number(b.timeoutMinutes);
        if (!Number.isFinite(n) || n < 1 || n > 40320) return res.status(400).json({ error: 'Timeout must be 1 to 40320 minutes (28 days).' });
        patch.timeoutMinutes = n;
    }
    if (b.generated && typeof b.generated === 'object') {
        patch.generated = {};
        if (typeof b.generated.enabled === 'boolean') patch.generated.enabled = b.generated.enabled;
        if (NAME_ACTIONS.includes(b.generated.action)) patch.generated.action = b.generated.action;
    }
    if (b.autopilot && typeof b.autopilot === 'object') {
        patch.autopilot = {};
        const a = b.autopilot;
        if (typeof a.enabled === 'boolean') patch.autopilot.enabled = a.enabled;
        if (typeof a.managers === 'boolean') patch.autopilot.managers = a.managers;
        if (NAME_ACTIONS.includes(a.action)) patch.autopilot.action = a.action;
        if (Array.isArray(a.roles)) patch.autopilot.roles = ids(a.roles).filter(id => req.guildObject.roles.cache.has(id));
    }
    try {
        const settings = await nf.saveSettings(req.guildObject, patch, req.user.id);
        logger.info(`[API name-filters] ${req.user.username} saved settings in ${req.guildObject.id}`);
        res.json({ ok: true, settings });
    } catch (err) {
        fail(res, 'save the settings', err);
    }
});

// ── filters ─────────────────────────────────────────────────────────────────

router.post('/preview', async (req, res) => {
    if (!(await writer(req, res))) return;
    const { type, pattern, caseSensitive } = req.body || {};
    try {
        const out = await nf.previewFilter(req.guildObject, { type, pattern: String(pattern ?? ''), caseSensitive: !!caseSensitive });
        if (!out.ok) return res.status(400).json({ error: out.error });
        res.json(out);
    } catch (err) {
        fail(res, 'preview the filter', err);
    }
});

router.post('/filters', async (req, res) => {
    const b = req.body || {};
    const action = NAME_ACTIONS.includes(b.action) ? b.action : 'log';
    const actOn = ids(b.actOn);
    if (!(await writer(req, res, actOn.length && action !== 'log' ? [action] : []))) return;
    try {
        const saved = await nf.addFilter(req.guildObject, {
            type: b.type, pattern: String(b.pattern ?? ''), action, caseSensitive: !!b.caseSensitive, note: b.note || null,
        }, req.user.id);
        if (!saved.ok) return res.status(400).json({ error: saved.error });
        let acted = null;
        if (actOn.length) acted = await nf.actOnPreview(req.guildObject, saved.id, actOn, req.user.id);
        logger.info(`[API name-filters] ${req.user.username} added filter #${saved.id} in ${req.guildObject.id}${acted ? ` and acted on ${actOn.length}` : ''}`);
        res.json({ ok: true, id: saved.id, acted });
    } catch (err) {
        fail(res, 'save the filter', err);
    }
});

router.patch('/filters/:id', async (req, res) => {
    if (!(await writer(req, res))) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Bad filter id.' });
    const b = req.body || {};
    const patch = {};
    if (b.pattern !== undefined) patch.pattern = String(b.pattern);
    if (NAME_FILTER_TYPES.includes(b.type)) patch.type = b.type;
    if (typeof b.caseSensitive === 'boolean') patch.caseSensitive = b.caseSensitive;
    if (NAME_ACTIONS.includes(b.action)) patch.action = b.action;
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
    if (b.note !== undefined) patch.note = b.note ? String(b.note) : null;
    try {
        const out = await nf.updateFilter(req.guildObject, id, patch, req.user.id);
        if (!out.ok) return res.status(400).json({ error: out.error });
        res.json({ ok: true });
    } catch (err) {
        fail(res, 'update the filter', err);
    }
});

// ── export / import (versioned JSON; core/name-filter-logic.js) ─────────────

router.get('/export', async (req, res) => {
    try {
        const data = await nf.exportFilters(req.guildObject);
        res.setHeader('Content-Disposition', `attachment; filename="name-filters-${req.guildObject.id}.json"`);
        res.type('application/json').send(JSON.stringify(data, null, 2));
    } catch (err) {
        fail(res, 'export the filters', err);
    }
});

// apply=0: preview what would be added / skipped / rejected; apply=1: import (send the same file again).
router.post('/import', importUpload.single('file'), uploadErrors, async (req, res) => {
    if (!(await writer(req, res))) return;
    if (!req.file) return res.status(400).json({ error: 'Choose an export file.' });
    const apply = String(req.body?.apply ?? '0') === '1';
    try {
        const plan = await nf.importFilters(req.guildObject, req.file.buffer.toString('utf8'), { apply }, req.user.id);
        if (!plan.ok) return res.status(400).json({ error: plan.error });
        if (apply) logger.info(`[API name-filters] ${req.user.username} imported ${plan.added} filter(s) in ${req.guildObject.id}`);
        res.json(importSummary(plan));
    } catch (err) {
        fail(res, 'import the filters', err);
    }
});

router.delete('/filters/:id', async (req, res) => {
    if (!(await writer(req, res))) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Bad filter id.' });
    try {
        res.json({ ok: await nf.removeFilter(req.guildObject, id, req.user.id) });
    } catch (err) {
        fail(res, 'remove the filter', err);
    }
});

router.post('/filters/:id/restore', async (req, res) => {
    if (!(await writer(req, res))) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Bad filter id.' });
    try {
        res.json({ ok: await nf.restoreFilter(req.guildObject, id, req.user.id) });
    } catch (err) {
        fail(res, 'restore the filter', err);
    }
});

// ── test ────────────────────────────────────────────────────────────────────

router.post('/test', async (req, res) => {
    const guild = req.guildObject;
    const { text, userId } = req.body || {};
    try {
        if (userId) {
            if (!SNOWFLAKE.test(String(userId))) return res.status(400).json({ error: 'Bad user id.' });
            const member = await guild.members.fetch(String(userId)).catch(() => null);
            if (!member) return res.status(404).json({ error: 'They are not in this server.' });
            return res.json({ member: await userBits(guild, member.id), ...(await nf.testNames(guild, { member })) });
        }
        const t = String(text ?? '').trim();
        if (!t) return res.status(400).json({ error: 'Type a name to test.' });
        res.json(await nf.testNames(guild, { text: t.slice(0, 100) }));
    } catch (err) {
        fail(res, 'run the test', err);
    }
});

/** Find members: a name fragment, an @mention or a user ID. */
router.get('/members', async (req, res) => {
    const guild = req.guildObject;
    const q = String(req.query.q ?? '').replace(/[<@!>]/g, '').trim().slice(0, 64);
    if (!q) return res.json({ members: [] });
    try {
        const found = new Map();
        if (SNOWFLAKE.test(q)) {
            const m = await guild.members.fetch(q).catch(() => null);
            if (m) found.set(m.id, m);
        } else {
            const hits = await guild.members.search({ query: q, limit: 10 }).catch(() => null);
            for (const m of hits?.values() ?? []) found.set(m.id, m);
        }
        res.json({
            members: [...found.values()].slice(0, 10).map(m => ({
                id: m.id, username: m.user.username, displayName: m.displayName, avatar: m.displayAvatarURL({ size: 64 }), bot: m.user.bot,
            })),
        });
    } catch (err) {
        fail(res, 'search members', err);
    }
});

// ── templates ───────────────────────────────────────────────────────────────

router.post('/templates/:packId', async (req, res) => {
    if (!(await writer(req, res))) return;
    const action = NAME_ACTIONS.includes(req.body?.action) ? req.body.action : 'log';
    try {
        const out = await nf.applyTemplate(req.guildObject, String(req.params.packId), action, req.user.id);
        if (!out.ok) return res.status(400).json({ error: out.error });
        res.json(out);
    } catch (err) {
        fail(res, 'apply the template', err);
    }
});

router.delete('/templates/:packId', async (req, res) => {
    if (!(await writer(req, res))) return;
    try {
        const out = await nf.removeTemplate(req.guildObject, String(req.params.packId), req.user.id);
        if (!out.ok) return res.status(400).json({ error: out.error });
        res.json(out);
    } catch (err) {
        fail(res, 'remove the template', err);
    }
});

// ── Auto-Pilot ──────────────────────────────────────────────────────────────

router.post('/autopilot/sync', async (req, res) => {
    if (!(await writer(req, res))) return;
    try {
        res.json({ ok: true, ...(await nf.syncAutoPilot(req.guildObject, { fetch: true })) });
    } catch (err) {
        fail(res, 'sync Auto-Pilot', err);
    }
});

// ── cleanse & review ────────────────────────────────────────────────────────

router.get('/cleanse', (req, res) => {
    res.json(nf.cleanseStatus(req.guildObject.id));
});

router.post('/cleanse', async (req, res) => {
    const mode = req.body?.mode === 'force' ? 'force' : 'review';
    // Force mode can carry out any filter's action, so it needs every permission those can need.
    if (!(await writer(req, res, mode === 'force' ? ['ban', 'kick', 'timeout', 'flag'] : []))) return;
    const out = nf.startCleanse(req.guildObject, { mode }, req.user.id);
    if (!out.ok) return res.status(409).json({ error: out.error });
    logger.info(`[API name-filters] ${req.user.username} started a ${mode} cleanse in ${req.guildObject.id}`);
    res.json({ ok: true });
});

router.get('/reviews', async (req, res) => {
    const guild = req.guildObject;
    const allowed = ['pending', 'safe', 'banned', 'kicked', 'skipped', 'gone', 'failed', 'all'];
    const status = String(req.query.status ?? 'pending').split(',').filter(s => allowed.includes(s)).join(',') || 'pending';
    try {
        const rows = await nf.listReviews(guild.id, { status, limit: Number(req.query.limit) || 300 });
        res.json({
            counts: await nf.reviewCounts(guild.id),
            rows: rows.map(r => {
                const m = guild.members.cache.get(r.user_id);
                return {
                    id: r.user_id,
                    username: r.username,
                    displayName: r.display_name,
                    nickname: r.nickname,
                    avatar: m?.displayAvatarURL({ size: 64 }) ?? null,
                    inServer: !!m,
                    joinedAt: m?.joinedTimestamp ?? null,
                    createdAt: m?.user?.createdTimestamp ?? null,
                    roles: m ? m.roles.cache.filter(x => x.id !== guild.id).size : null,
                    filterId: r.filter_id,
                    filterLabel: r.filter_label,
                    field: r.field,
                    fieldLabel: FIELD_LABEL[r.field] ?? r.field,
                    status: r.status,
                    detail: r.detail,
                    foundAt: r.found_at,
                    decidedBy: r.decided_by,
                    decidedAt: r.decided_at,
                };
            }),
        });
    } catch (err) {
        fail(res, 'load the review queue', err);
    }
});

router.post('/reviews/decide', async (req, res) => {
    const decision = String(req.body?.decision ?? '');
    if (!['ban', 'kick', 'safe', 'skip'].includes(decision)) return res.status(400).json({ error: 'Pick ban, kick, safe or skip.' });
    const userIds = ids(req.body?.userIds);
    if (!userIds.length) return res.status(400).json({ error: 'No members given.' });
    if (!(await writer(req, res, decision === 'ban' || decision === 'kick' ? [decision] : []))) return;
    try {
        const out = await nf.decideReviews(req.guildObject, userIds, decision, req.user.id);
        logger.info(`[API name-filters] ${req.user.username} decided ${decision} for ${userIds.length} in ${req.guildObject.id}: ${out.done} done`);
        res.json(out);
    } catch (err) {
        fail(res, 'apply the decision', err);
    }
});

router.post('/safe', async (req, res) => {
    if (!(await writer(req, res))) return;
    const id = String(req.body?.userId ?? '');
    if (!SNOWFLAKE.test(id)) return res.status(400).json({ error: 'Bad user id.' });
    try {
        const out = await nf.markSafe(req.guildObject, id, req.user.id);
        if (!out.ok) return res.status(400).json({ error: out.error });
        res.json(out);
    } catch (err) {
        fail(res, 'mark them safe', err);
    }
});

router.delete('/safe/:userId', async (req, res) => {
    if (!(await writer(req, res))) return;
    if (!SNOWFLAKE.test(req.params.userId)) return res.status(400).json({ error: 'Bad user id.' });
    try {
        res.json({ ok: await nf.unmarkSafe(req.guildObject, req.params.userId, req.user.id) });
    } catch (err) {
        fail(res, 'remove the safe mark', err);
    }
});

// ── recent hits ─────────────────────────────────────────────────────────────

router.get('/hits', async (req, res) => {
    const guild = req.guildObject;
    try {
        const rows = await nf.recentHits(guild.id, 100);
        res.json({
            hits: rows.map(r => {
                const m = guild.members.cache.get(r.user_id);
                return { id: r.id, userId: r.user_id, username: r.username, action: r.action, detail: r.detail, at: r.created_at,
                    inServer: !!m, avatar: m?.displayAvatarURL({ size: 64 }) ?? null };
            }),
        });
    } catch (err) {
        fail(res, 'load recent hits', err);
    }
});

export default router;
