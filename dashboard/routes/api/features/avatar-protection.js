/**
 * Avatar Protection API — `/api/guilds/:guildId/avatar-protection/*`
 *
 * The dashboard's Avatar Protection page (views/partials/manage/avatar-protection.ejs): settings and
 * thresholds, protected images (add from a member, a role, the server icon or an upload; remove,
 * restore), the scam-avatar list, the test box, Auto-Pilot (shared with Name Filters), the cleanse
 * (start, progress) and its review queue with bulk Ban / Kick / Not a match / Skip, and recent hits.
 * Everything `/avatarfilter` does. The logic lives in core/avatar-protection.js.
 *
 * Gated by `apiCheckGuildAdmin` at the parent router (Manage Server from the OAuth bitfield, or a
 * bot-manager role checked live). Every write re-checks the LIVE member: configure access (owner,
 * Administrator, Manage Server or a bot-manager role); acting on members (ban, kick) additionally
 * needs that permission in the server. Super-admins act with the bot's authority, as everywhere else.
 * Uploads are multipart (multer, memory, 8 MB) — /api/guilds is outside the session-CSRF check.
 */

import express from 'express';
import multer from 'multer';
import { PermissionFlagsBits } from 'discord.js';
import logger from '../../../../utils/logger.js';
import { liveConfigAccess } from '../../../../core/protection-exempt.js';
import ap from '../../../../core/avatar-protection.js';
import { AVATAR_ACTIONS, MIN_THRESHOLD, MAX_PROTECTED, VARIANT_LABELS } from '../../../../core/avatar-match-logic.js';

const router = express.Router({ mergeParams: true });
const SNOWFLAKE = /^\d{15,25}$/;
const MAX_UPLOAD = 8 * 1024 * 1024;
const NEEDS = {
    ban: [PermissionFlagsBits.BanMembers, 'Ban Members'],
    kick: [PermissionFlagsBits.KickMembers, 'Kick Members'],
    timeout: [PermissionFlagsBits.ModerateMembers, 'Timeout Members'],
    flag: [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
};

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD, files: 1 } });
function uploadErrors(err, req, res, next) {
    if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? (req.path.endsWith('/import') ? 'That file is over 4 MB.' : 'That image is over 8 MB.') : err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    next();
}
const isImage = (file) => !!file && /^image\/(png|jpe?g|webp|gif)$/i.test(file.mimetype || '');
// Import files: multipart too (JSON bodies are capped at 100 kB), at most 4 MB.
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1 } });
/** An import plan for the page: counts plus the first entries of each list. */
const importSummary = (plan) => ({
    ok: true, added: plan.added ?? null,
    counts: { add: plan.add.length, duplicates: plan.duplicates.length, rejected: plan.rejected.length, overCap: plan.overCap.length },
    add: plan.add.slice(0, 200), duplicates: plan.duplicates.slice(0, 200), rejected: plan.rejected.slice(0, 200), overCap: plan.overCap.slice(0, 50),
});


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
const fail = (res, where, err) => {
    logger.error(`[API avatar-protection] ${where} failed: ${err.message}`);
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
    const saved = await ap.getSettings(guild.id).then(s => s.flagRoleId).catch(() => null);
    if (String(saved || '') === roleId) return null;
    return role.managed
        ? 'That role is managed by an integration, so the bot cannot give it.'
        : 'That role is not below the bot\'s highest role, so the bot cannot give it. Move the bot\'s role higher, or pick another role.';
}

const roleRow = (guild, id) => {
    const r = guild.roles.cache.get(id);
    return r ? { id, name: r.name, color: r.hexColor === '#000000' ? null : r.hexColor, deleted: false } : { id, name: null, color: null, deleted: true };
};
/** From the member cache only: the image grid can name hundreds of people. */
function cachedUserBits(guild, id) {
    const member = guild.members.cache.get(id);
    const user = member?.user || guild.client.users.cache.get(id) || null;
    return { id, username: user?.username ?? null, displayName: member?.displayName ?? user?.username ?? null, inServer: !!member };
}

async function userBits(guild, id) {
    const member = guild.members.cache.get(id) || await guild.members.fetch(id).catch(() => null);
    const user = member?.user || guild.client.users.cache.get(id) || null;
    return {
        id,
        username: user?.username ?? null,
        displayName: member?.displayName ?? user?.globalName ?? user?.username ?? null,
        avatar: member?.displayAvatarURL?.({ size: 64 }) ?? user?.displayAvatarURL?.({ size: 64 }) ?? null,
        inServer: !!member,
    };
}

// ── overview / settings ─────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    const guild = req.guildObject;
    try {
        const [ov, images, scam, actor] = await Promise.all([ap.overview(guild), ap.listProtected(guild.id), ap.listScam(guild.id), actorFor(req)]);
        const people = [...new Set(images.map(i => i.protectedUserId).filter(Boolean))];
        const users = Object.fromEntries(people.map(id => [id, cachedUserBits(guild, id)]));
        const me = guild.members.me;
        res.json({
            actor,
            actions: AVATAR_ACTIONS,
            limits: { protected: MAX_PROTECTED, minThreshold: MIN_THRESHOLD },
            variantLabels: VARIANT_LABELS,
            overview: { ...ov, settings: undefined },
            settings: ov.settings,
            flagRole: ov.settings.flagRoleId ? roleRow(guild, ov.settings.flagRoleId) : null,
            autopilotRoles: ov.settings.autopilot.roles.map(id => roleRow(guild, id)),
            botPerms: Object.fromEntries(Object.entries(NEEDS).map(([k, [p]]) => [k, !!me?.permissions?.has(p)])),
            images,
            users,
            scam,
            serverIcon: guild.iconURL?.({ size: 128 }) ?? null,
            // position + the bot's highest role position let the page mark roles the bot cannot give.
            botTopPosition: me?.roles?.highest?.position ?? null,
            guildRoles: [...guild.roles.cache.values()]
                .filter(r => r.id !== guild.id && !r.managed)
                .sort((a, b) => b.position - a.position)
                .map(r => ({ id: r.id, name: r.name, color: r.hexColor === '#000000' ? null : r.hexColor, position: r.position, members: r.members.size })),
        });
    } catch (err) {
        fail(res, 'load avatar protection', err);
    }
});

router.post('/settings', async (req, res) => {
    if (!(await writer(req, res))) return;
    const b = req.body || {};
    const patch = {};
    for (const k of ['enabled', 'dm']) if (typeof b[k] === 'boolean') patch[k] = b[k];
    for (const k of ['autoThreshold', 'reviewThreshold']) {
        if (b[k] === undefined) continue;
        const n = Number(b[k]);
        if (!Number.isFinite(n) || n < MIN_THRESHOLD || n > 1) return res.status(400).json({ error: `Thresholds go from ${MIN_THRESHOLD.toFixed(2)} to 1.00.` });
        patch[k] = n;
    }
    if (patch.autoThreshold !== undefined && patch.reviewThreshold !== undefined && patch.reviewThreshold > patch.autoThreshold) {
        return res.status(400).json({ error: 'The review threshold cannot be above the act threshold.' });
    }
    if (AVATAR_ACTIONS.includes(b.action)) patch.action = b.action;
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
    if (b.scam && typeof b.scam === 'object') {
        patch.scam = {};
        if (typeof b.scam.enabled === 'boolean') patch.scam.enabled = b.scam.enabled;
        if (AVATAR_ACTIONS.includes(b.scam.action)) patch.scam.action = b.scam.action;
    }
    if (b.autopilot && typeof b.autopilot === 'object') {
        patch.autopilot = {};
        const a = b.autopilot;
        for (const k of ['enabled', 'managers', 'avatars']) if (typeof a[k] === 'boolean') patch.autopilot[k] = a[k];
        if (Array.isArray(a.roles)) patch.autopilot.roles = ids(a.roles).filter(id => req.guildObject.roles.cache.has(id));
    }
    try {
        const settings = await ap.saveSettings(req.guildObject, patch, req.user.id);
        logger.info(`[API avatar-protection] ${req.user.username} saved settings in ${req.guildObject.id}`);
        res.json({ ok: true, settings });
    } catch (err) {
        fail(res, 'save the settings', err);
    }
});

// ── protected images ────────────────────────────────────────────────────────

router.post('/protected', async (req, res) => {
    if (!(await writer(req, res))) return;
    const b = req.body || {};
    const scope = ['global', 'server', 'both'].includes(b.scope) ? b.scope : 'both';
    let spec;
    if (b.source === 'member' && SNOWFLAKE.test(String(b.userId ?? ''))) spec = { source: 'member', userId: String(b.userId), scope };
    else if (b.source === 'role' && SNOWFLAKE.test(String(b.roleId ?? ''))) spec = { source: 'role', roleId: String(b.roleId), scope };
    else if (b.source === 'server_icon') spec = { source: 'server_icon' };
    else return res.status(400).json({ error: 'Pick a member, a role or the server icon.' });
    if (b.label) spec.label = String(b.label).slice(0, 120);
    try {
        const out = await ap.addProtected(req.guildObject, spec, req.user.id);
        logger.info(`[API avatar-protection] ${req.user.username} added ${out.added.length} protected image(s) in ${req.guildObject.id} (${spec.source})`);
        if (!out.ok) return res.status(400).json({ error: out.error, skipped: out.skipped });
        res.json(out);
    } catch (err) {
        fail(res, 'add the image', err);
    }
});

router.post('/protected/upload', upload.single('image'), uploadErrors, async (req, res) => {
    if (!(await writer(req, res))) return;
    if (!isImage(req.file)) return res.status(400).json({ error: 'Choose a PNG, JPEG, WebP or GIF image.' });
    const label = String(req.body?.label ?? '').trim().slice(0, 120) || req.file.originalname?.slice(0, 120) || null;
    const asScam = req.body?.target === 'scam';
    try {
        const out = asScam
            ? await ap.addScamAvatar(req.guildObject, { buffer: req.file.buffer, label }, req.user.id)
            : await ap.addProtected(req.guildObject, { source: 'upload', buffer: req.file.buffer, label }, req.user.id);
        logger.info(`[API avatar-protection] ${req.user.username} uploaded a ${asScam ? 'scam avatar' : 'protected image'} in ${req.guildObject.id}`);
        if (!out.ok) return res.status(400).json({ error: out.error });
        res.json(out);
    } catch (err) {
        fail(res, 'add the image', err);
    }
});

router.delete('/images/:id', async (req, res) => {
    if (!(await writer(req, res))) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Bad image id.' });
    try {
        res.json({ ok: await ap.removeImage(req.guildObject, id, req.user.id) });
    } catch (err) {
        fail(res, 'remove the image', err);
    }
});

router.post('/images/:id/restore', async (req, res) => {
    if (!(await writer(req, res))) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Bad image id.' });
    try {
        res.json({ ok: await ap.restoreImage(req.guildObject, id, req.user.id) });
    } catch (err) {
        fail(res, 'restore the image', err);
    }
});

/** Find members: a name fragment, an @mention or a user ID — with both of their avatars. */
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
                id: m.id, username: m.user.username, displayName: m.displayName, bot: m.user.bot,
                globalAvatar: m.user.avatar ? m.user.avatarURL({ size: 64, extension: 'png', forceStatic: true }) : null,
                serverAvatar: m.avatar ? m.avatarURL({ size: 64, extension: 'png', forceStatic: true }) : null,
            })),
        });
    } catch (err) {
        fail(res, 'search members', err);
    }
});

// ── test ────────────────────────────────────────────────────────────────────

router.post('/test', async (req, res) => {
    const guild = req.guildObject;
    const userId = String(req.body?.userId ?? '');
    if (!SNOWFLAKE.test(userId)) return res.status(400).json({ error: 'Pick a member to test.' });
    try {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) return res.status(404).json({ error: 'They are not in this server.' });
        res.json({ member: await userBits(guild, member.id), ...(await ap.testAvatar(guild, { member })) });
    } catch (err) {
        fail(res, 'run the test', err);
    }
});

router.post('/test/upload', upload.single('image'), uploadErrors, async (req, res) => {
    if (!isImage(req.file)) return res.status(400).json({ error: 'Choose a PNG, JPEG, WebP or GIF image.' });
    try {
        res.json(await ap.testAvatar(req.guildObject, { buffer: req.file.buffer }));
    } catch (err) {
        fail(res, 'run the test', err);
    }
});

// ── Auto-Pilot ──────────────────────────────────────────────────────────────

router.post('/autopilot/sync', async (req, res) => {
    if (!(await writer(req, res))) return;
    try {
        res.json({ ok: true, ...(await ap.syncAutoPilot(req.guildObject, { fetch: true })) });
    } catch (err) {
        fail(res, 'sync Auto-Pilot', err);
    }
});

// ── cleanse & review ────────────────────────────────────────────────────────

router.get('/cleanse', (req, res) => {
    res.json(ap.cleanseStatus(req.guildObject.id));
});

router.post('/cleanse', async (req, res) => {
    const mode = req.body?.mode === 'force' ? 'force' : 'review';
    // Force mode can carry out the configured actions, so it needs every permission those can need.
    if (!(await writer(req, res, mode === 'force' ? ['ban', 'kick', 'timeout', 'flag'] : []))) return;
    const out = ap.startCleanse(req.guildObject, { mode }, req.user.id);
    if (!out.ok) return res.status(409).json({ error: out.error });
    logger.info(`[API avatar-protection] ${req.user.username} started a ${mode} avatar scan in ${req.guildObject.id}`);
    res.json({ ok: true });
});

// ── export / import of the protected list (fingerprints only; core/avatar-match-logic.js) ──

router.get('/export', async (req, res) => {
    try {
        const data = await ap.exportProtected(req.guildObject);
        res.setHeader('Content-Disposition', `attachment; filename="avatar-protection-${req.guildObject.id}.json"`);
        res.type('application/json').send(JSON.stringify(data, null, 2));
    } catch (err) {
        fail(res, 'export the list', err);
    }
});

router.post('/import', importUpload.single('file'), uploadErrors, async (req, res) => {
    if (!(await writer(req, res))) return;
    if (!req.file) return res.status(400).json({ error: 'Choose an export file.' });
    const apply = String(req.body?.apply ?? '0') === '1';
    try {
        const plan = await ap.importProtected(req.guildObject, req.file.buffer.toString('utf8'), { apply }, req.user.id);
        if (!plan.ok) return res.status(400).json({ error: plan.error });
        if (apply) logger.info(`[API avatar-protection] ${req.user.username} imported ${plan.added} image fingerprint(s) in ${req.guildObject.id}`);
        res.json(importSummary(plan));
    } catch (err) {
        fail(res, 'import the list', err);
    }
});

router.get('/reviews', async (req, res) => {
    const guild = req.guildObject;
    const allowed = ['pending', 'safe', 'banned', 'kicked', 'actioned', 'skipped', 'gone', 'failed', 'all'];
    const status = String(req.query.status ?? 'pending').split(',').filter(s => allowed.includes(s)).join(',') || 'pending';
    const minScore = req.query.minScore != null && req.query.minScore !== '' ? Number(req.query.minScore) : null;
    try {
        const rows = await ap.listReviews(guild.id, { status, limit: Number(req.query.limit) || 300, minScore });
        res.json({
            counts: await ap.reviewCounts(guild.id),
            rows: rows.map(r => {
                const m = guild.members.cache.get(r.user_id);
                return {
                    id: r.user_id,
                    username: r.username,
                    displayName: r.display_name,
                    nickname: r.nickname,
                    inServer: !!m,
                    joinedAt: m?.joinedTimestamp ?? null,
                    createdAt: m?.user?.createdTimestamp ?? null,
                    roles: m ? m.roles.cache.filter(x => x.id !== guild.id).map(x => x.name).slice(0, 8) : null,
                    scope: r.field,
                    score: r.score == null ? null : Number(r.score),
                    scam: r.detail === 'scam avatar' || r.image_kind === 'scam_avatar',
                    avatarThumb: r.avatar_thumb,
                    avatarUrl: r.avatar_url,
                    imageId: r.image_id,
                    imageLabel: r.image_label ?? r.filter_label,
                    imageThumb: r.image_thumb,
                    imageSource: r.image_source,
                    status: r.status,
                    detail: r.detail,
                    foundAt: r.found_at,
                    decidedBy: r.decided_by,
                    decidedAt: r.decided_at,
                    // AI second opinion (core/ai-judge.js).
                    ai: r.ai_verdict ? { verdict: r.ai_verdict, confidence: r.ai_confidence == null ? null : Number(r.ai_confidence), reason: r.ai_reason, at: r.ai_at } : null,
                };
            }),
        });
    } catch (err) {
        fail(res, 'load the review queue', err);
    }
});

// AI second opinion on one queued member (core/ai-judge.js): advice only, counted against the daily cap.
router.post('/reviews/:userId/ai', async (req, res) => {
    if (!/^\d{15,25}$/.test(String(req.params.userId))) return res.status(400).json({ error: 'Bad member id.' });
    if (!(await writer(req, res, []))) return;
    try {
        const out = await ap.askAiAboutReview(req.guildObject, req.params.userId);
        if (!out.ok) return res.status(409).json({ error: out.error });
        res.json(out);
    } catch (err) {
        fail(res, 'ask the AI', err);
    }
});

router.post('/reviews/decide', async (req, res) => {
    const decision = String(req.body?.decision ?? '');
    if (!['ban', 'kick', 'safe', 'skip'].includes(decision)) return res.status(400).json({ error: 'Pick ban, kick, not a match or skip.' });
    const userIds = ids(req.body?.userIds);
    if (!userIds.length) return res.status(400).json({ error: 'No members given.' });
    if (!(await writer(req, res, decision === 'ban' || decision === 'kick' ? [decision] : []))) return;
    try {
        const out = await ap.decideReviews(req.guildObject, userIds, decision, req.user.id);
        logger.info(`[API avatar-protection] ${req.user.username} decided ${decision} for ${userIds.length} in ${req.guildObject.id}: ${out.done} done`);
        res.json(out);
    } catch (err) {
        fail(res, 'apply the decision', err);
    }
});

// ── recent hits ─────────────────────────────────────────────────────────────

router.get('/hits', async (req, res) => {
    const guild = req.guildObject;
    try {
        const rows = await ap.recentHits(guild.id, 100);
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
