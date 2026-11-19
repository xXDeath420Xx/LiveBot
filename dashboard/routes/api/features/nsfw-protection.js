/**
 * NSFW Protection API — `/api/guilds/:guildId/nsfw-protection/*`
 *
 * The dashboard's NSFW Protection page (views/partials/manage/nsfw-protection.ejs): whether the model is
 * installed, the avatar and chat-image settings (on/off, action, thresholds, daily cap), usage against the
 * cap and the classifier's load, the test box (a member's avatar or an uploaded image; nothing stored),
 * the member scan (review-only), the review queue with Ban / Kick / Not NSFW / Skip / Overturn, the
 * pictures remembered as safe, and recent detections. Everything `/avatarfilter nsfw` and
 * `/link-filter threats nsfw-images` do. The logic lives in core/nsfw-protection.js.
 *
 * Gated by `apiCheckGuildAdmin` at the parent router. Every write re-checks the LIVE member: configure
 * access (owner, Administrator, Manage Server or a bot-manager role); banning / kicking and overturning
 * (which can unban) additionally need that permission. Member search reuses the Avatar Protection route.
 */

import express from 'express';
import multer from 'multer';
import { PermissionFlagsBits } from 'discord.js';
import logger from '../../../../utils/logger.js';
import { liveConfigAccess } from '../../../../core/protection-exempt.js';
import nsfw from '../../../../core/nsfw-protection.js';

const router = express.Router({ mergeParams: true });
const SNOWFLAKE = /^\d{15,25}$/;
const MAX_UPLOAD = 8 * 1024 * 1024;
const NEEDS = {
    ban: [PermissionFlagsBits.BanMembers, 'Ban Members'],
    kick: [PermissionFlagsBits.KickMembers, 'Kick Members'],
    flag: [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
    delete: [PermissionFlagsBits.ManageMessages, 'Manage Messages'],
    timeout: [PermissionFlagsBits.ModerateMembers, 'Timeout Members'],
};

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD, files: 1 } });
function uploadErrors(err, req, res, next) {
    if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That image is over 8 MB.' : err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    next();
}
const isImage = (file) => !!file && /^image\/(png|jpe?g|webp|gif)$/i.test(file.mimetype || '');

async function actorFor(req) {
    if (req.isSuperAdmin) return { canConfigure: true, perms: Object.fromEntries(Object.keys(NEEDS).map(k => [k, true])), superAdmin: true };
    const a = await liveConfigAccess(req.guildObject, req.user.id);
    const isOwner = a.member && req.guildObject.ownerId === a.member.id;
    const perms = Object.fromEntries(Object.entries(NEEDS).map(([k, [p]]) => [k, !!a.member && (isOwner || a.member.permissions.has(p))]));
    return { canConfigure: a.ok, perms, superAdmin: false };
}

async function writer(req, res, acts = []) {
    const actor = await actorFor(req);
    if (!actor.canConfigure) {
        res.status(403).json({ error: 'You need Manage Server, Administrator or a bot-manager role in this server.' });
        return null;
    }
    for (const action of acts) {
        if (NEEDS[action] && !actor.perms[action]) {
            res.status(403).json({ error: `You need the ${NEEDS[action][1]} permission in this server for that.` });
            return null;
        }
    }
    return actor;
}

const ids = (list) => (Array.isArray(list) ? list.map(String).filter(id => SNOWFLAKE.test(id)) : []);
const fail = (res, where, err) => {
    logger.error(`[API nsfw-protection] ${where} failed: ${err.message}`);
    res.status(500).json({ error: `Could not ${where}. Try again in a moment.` });
};

function memberBits(guild, id) {
    const m = guild.members.cache.get(id);
    const user = m?.user || guild.client.users.cache.get(id) || null;
    return {
        inServer: !!m,
        joinedAt: m?.joinedTimestamp ?? null,
        createdAt: user?.createdTimestamp ?? null,
        roles: m ? m.roles.cache.filter(x => x.id !== guild.id).map(x => x.name).slice(0, 6) : null,
    };
}

// ── overview / settings ─────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    const guild = req.guildObject;
    try {
        const [ov, actor] = await Promise.all([nsfw.overview(guild), actorFor(req)]);
        const me = guild.members.me;
        res.json({
            actor,
            ...ov,
            botPerms: Object.fromEntries(Object.entries(NEEDS).map(([k, [p]]) => [k, !!me?.permissions?.has(p)])),
        });
    } catch (err) {
        fail(res, 'load NSFW protection', err);
    }
});

router.post('/settings', async (req, res) => {
    if (!(await writer(req, res))) return;
    const b = req.body || {};
    const surface = b.surface === 'image' ? 'image' : b.surface === 'avatar' ? 'avatar' : null;
    if (!surface) return res.status(400).json({ error: 'Say which settings: avatar or image.' });
    const patch = {};
    for (const k of ['enabled', 'dm', 'reviewAlerts']) if (typeof b[k] === 'boolean') patch[k] = b[k];
    for (const k of ['act', 'review', 'dailyCap', 'timeoutMinutes']) if (b[k] !== undefined && b[k] !== null && b[k] !== '') patch[k] = Number(b[k]);
    if (typeof b.action === 'string') patch.action = b.action;
    try {
        const out = await nsfw.saveSettings(req.guildObject, surface, patch, req.user.id);
        if (!out.ok) return res.status(400).json({ error: out.error });
        logger.info(`[API nsfw-protection] ${req.user.username} saved ${surface} settings in ${req.guildObject.id}`);
        res.json({ ok: true, changed: out.changed });
    } catch (err) {
        fail(res, 'save the settings', err);
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
        res.json(await nsfw.testImage(guild, { member, surface: 'avatar' }));
    } catch (err) {
        fail(res, 'run the test', err);
    }
});

router.post('/test/upload', upload.single('image'), uploadErrors, async (req, res) => {
    if (!isImage(req.file)) return res.status(400).json({ error: 'Choose a PNG, JPEG, WebP or GIF image.' });
    try {
        // Scored in memory and dropped: the upload is never stored or sent back.
        res.json(await nsfw.testImage(req.guildObject, { buffer: req.file.buffer, surface: 'image' }));
    } catch (err) {
        fail(res, 'run the test', err);
    }
});

// ── member scan ─────────────────────────────────────────────────────────────

router.get('/scan', (req, res) => {
    res.json(nsfw.scanStatus(req.guildObject.id));
});

router.post('/scan', async (req, res) => {
    if (!(await writer(req, res))) return;
    const out = nsfw.startScan(req.guildObject, req.user.id);
    if (!out.ok) return res.status(409).json({ error: out.error });
    logger.info(`[API nsfw-protection] ${req.user.username} started an NSFW avatar scan in ${req.guildObject.id}`);
    res.json({ ok: true });
});

// ── review queue ────────────────────────────────────────────────────────────

router.get('/reviews', async (req, res) => {
    const guild = req.guildObject;
    const kind = ['avatar', 'image'].includes(req.query.kind) ? req.query.kind : 'all';
    const allowed = ['open', 'pending', 'actioned', 'failed', 'safe', 'overturned', 'banned', 'kicked', 'skipped', 'gone', 'all'];
    const status = String(req.query.status ?? 'open').split(',').filter(s => allowed.includes(s)).join(',') || 'open';
    try {
        const rows = await nsfw.listReviews(guild.id, { kind, status, limit: Number(req.query.limit) || 300 });
        res.json({
            counts: await nsfw.reviewCounts(guild.id),
            rows: rows.map(r => ({
                id: r.user_id,
                surface: r.kind === 'nsfw_avatar' ? 'avatar' : 'image',
                username: r.username,
                displayName: r.display_name,
                nickname: r.nickname,
                ...memberBits(guild, r.user_id),
                scope: r.field,
                screen: r.score == null ? null : Number(r.score),
                judge: r.judge_score == null ? null : Number(r.judge_score),
                // Discord's own copy of the avatar (never ours); the page blurs it until clicked.
                avatarUrl: r.kind === 'nsfw_avatar' ? r.avatar_url : null,
                detectionId: r.filter_id,
                actionTaken: r.action_taken,
                status: r.status,
                detail: r.detail,
                foundAt: r.found_at,
                decidedBy: r.decided_by,
                decidedAt: r.decided_at,
                // AI third opinion (core/ai-judge.js), advice only.
                ai: r.ai_verdict ? { verdict: r.ai_verdict, confidence: r.ai_confidence == null ? null : Number(r.ai_confidence), reason: r.ai_reason, at: r.ai_at } : null,
            })),
        });
    } catch (err) {
        fail(res, 'load the review queue', err);
    }
});

router.post('/reviews/decide', async (req, res) => {
    const decision = String(req.body?.decision ?? '');
    if (!['ban', 'kick', 'safe', 'skip', 'overturn'].includes(decision)) return res.status(400).json({ error: 'Pick ban, kick, not NSFW, skip or overturn.' });
    const surface = req.body?.surface === 'image' ? 'image' : 'avatar';
    const userIds = ids(req.body?.userIds);
    if (!userIds.length) return res.status(400).json({ error: 'No members given.' });
    // Overturning can unban, so it needs Ban Members like a ban does.
    const needs = decision === 'ban' || decision === 'overturn' ? ['ban'] : decision === 'kick' ? ['kick'] : [];
    if (!(await writer(req, res, needs))) return;
    try {
        const out = await nsfw.decideReviews(req.guildObject, surface, userIds, decision, req.user.id);
        logger.info(`[API nsfw-protection] ${req.user.username} decided ${decision} (${surface}) for ${userIds.length} in ${req.guildObject.id}: ${out.done} done`);
        res.json(out);
    } catch (err) {
        fail(res, 'apply the decision', err);
    }
});

// ── safe pictures, recent detections ────────────────────────────────────────

router.get('/safe', async (req, res) => {
    try {
        res.json({ safe: await nsfw.listSafe(req.guildObject.id) });
    } catch (err) {
        fail(res, 'load the safe list', err);
    }
});

router.delete('/safe/:id', async (req, res) => {
    if (!(await writer(req, res))) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Bad id.' });
    try {
        res.json({ ok: await nsfw.forgetSafe(req.guildObject, id, req.user.id) });
    } catch (err) {
        fail(res, 'forget that picture', err);
    }
});

router.get('/recent', async (req, res) => {
    const guild = req.guildObject;
    try {
        const rows = await nsfw.recent(guild.id, 80);
        res.json({
            recent: rows.map(r => ({
                ...r,
                inServer: guild.members.cache.has(r.userId),
                jump: r.surface === 'image' && r.channelId && r.messageId && r.outcome !== 'deleted' && r.outcome !== 'timeout'
                    ? `https://discord.com/channels/${guild.id}/${r.channelId}/${r.messageId}` : null,
            })),
        });
    } catch (err) {
        fail(res, 'load recent detections', err);
    }
});

export default router;
