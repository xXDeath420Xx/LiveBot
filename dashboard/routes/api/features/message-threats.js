/**
 * Message Threats API — `/api/guilds/:guildId/message-threats/*`
 *
 * The dashboard's Message Threats page (views/partials/manage/message-threats.ejs): settings for the
 * obfuscated-URL scam, AutoMod escalation, anti-everyone, QR codes and image-text rules; the server's
 * AutoMod rules with per-rule enforce switches and the one-click "Obfuscated URL" rule install; the
 * circuit breaker (state + reset); the URL checker; the image-text rule editor; the ignore list for
 * channels and categories; the flagged-member queue (Ban / Dismiss); recent detections with evidence.
 * Everything `/link-filter threats` and `/tools checkurl` do. The logic lives in core/message-threats.js.
 *
 * Gated by `apiCheckGuildAdmin` at the parent router (Manage Server from the OAuth bitfield, or a
 * bot-manager role checked live). Every write re-checks the LIVE member: configure access (owner,
 * Administrator, Manage Server or a bot-manager role); banning from the queue additionally needs Ban
 * Members in the server. Super-admins act with the bot's authority, as everywhere else.
 */

import express from 'express';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import logger from '../../../../utils/logger.js';
import mt from '../../../../core/message-threats.js';
import { liveConfigAccess, listIgnored, addIgnored, removeIgnored, MAX_IGNORED } from '../../../../core/protection-exempt.js';
import { qrDecoderAvailable } from '../../../../core/scam-image-ocr.js';
import {
    OBF_ACTIONS, ESC_ACTIONS, QR_ACTIONS, OCR_ACTIONS, OCR_TYPES, WEBHOOK_MODES, MAX_OCR_RULES, AUTOMOD_REGEXES, AUTOMOD_RULE_NAME,
} from '../../../../core/message-threat-logic.js';

const router = express.Router({ mergeParams: true });
const SNOWFLAKE = /^\d{15,25}$/;

/** What this request may do, judged live. */
async function actorFor(req) {
    if (req.isSuperAdmin) return { canConfigure: true, canBan: true, superAdmin: true };
    const a = await liveConfigAccess(req.guildObject, req.user.id);
    const isOwner = !!a.member && req.guildObject.ownerId === a.member.id;
    return { canConfigure: a.ok, canBan: !!a.member && (isOwner || a.member.permissions.has(PermissionFlagsBits.BanMembers)), superAdmin: false };
}

/** Refuse a write the live member can't make. Sends the response itself; returns the actor or null. */
async function writer(req, res, { ban = false } = {}) {
    const actor = await actorFor(req);
    if (!actor.canConfigure) {
        res.status(403).json({ error: 'You need Manage Server, Administrator or a bot-manager role in this server.' });
        return null;
    }
    if (ban && !actor.canBan) {
        res.status(403).json({ error: 'You need the Ban Members permission in this server to ban members.' });
        return null;
    }
    return actor;
}

const fail = (res, where, err) => {
    logger.error(`[API message-threats] ${where} failed: ${err.message}`);
    res.status(500).json({ error: `Could not ${where}. Try again in a moment.` });
};

function channelRows(guild) {
    const textish = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildMedia]);
    const all = [...guild.channels.cache.values()].filter(c => textish.has(c.type) || c.type === ChannelType.GuildCategory);
    return all
        .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
        .map(c => ({
            id: c.id, name: c.name, category: c.type === ChannelType.GuildCategory, text: c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement,
            parentName: c.parent?.name ?? null,
        }));
}

function userBits(guild, id) {
    const member = guild.members.cache.get(id);
    const user = member?.user || guild.client.users.cache.get(id) || null;
    return {
        id, username: user?.username ?? null, displayName: member?.displayName ?? user?.globalName ?? user?.username ?? null,
        avatar: member?.displayAvatarURL?.({ size: 64 }) ?? user?.displayAvatarURL?.({ size: 64 }) ?? null, inServer: !!member,
    };
}

// ── overview / settings ─────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    const guild = req.guildObject;
    try {
        const [{ row, settings }, actor, ignored, rules, counts, stats, qr] = await Promise.all([
            mt.getSettings(guild.id), actorFor(req), listIgnored(guild.id).catch(() => []), mt.listOcrRules(guild.id).catch(() => []),
            mt.reviewCounts(guild.id).catch(() => ({})), mt.detectionStats(guild.id).catch(() => []), qrDecoderAvailable(),
        ]);
        const me = guild.members.me;
        const has = (p) => !!me?.permissions?.has(p);
        res.json({
            actor,
            migrated: !row || 'obf_enabled' in row,
            settings,
            options: { obf: OBF_ACTIONS, esc: ESC_ACTIONS, qr: QR_ACTIONS, ocr: OCR_ACTIONS, ocrTypes: OCR_TYPES, webhooks: WEBHOOK_MODES },
            limits: { ocrRules: MAX_OCR_RULES, ignored: MAX_IGNORED },
            breaker: mt.breakerState(guild.id, settings),
            qrDecoder: qr,
            botPerms: {
                ban: has(PermissionFlagsBits.BanMembers), timeout: has(PermissionFlagsBits.ModerateMembers),
                delete: has(PermissionFlagsBits.ManageMessages), manageGuild: has(PermissionFlagsBits.ManageGuild),
            },
            automodRule: { name: AUTOMOD_RULE_NAME, patterns: AUTOMOD_REGEXES.length },
            channels: channelRows(guild),
            // Colour and position for the pickers, and the bot's highest role position.
            botTopPosition: me?.roles?.highest?.position ?? null,
            roles: [...guild.roles.cache.values()].filter(r => r.id !== guild.id && !r.managed)
                .sort((a, b) => b.position - a.position)
                .map(r => ({ id: r.id, name: r.name, color: r.hexColor === '#000000' ? null : r.hexColor, position: r.position })),
            ignored: ignored.map(r => ({ kind: r.kind, id: r.target_id, name: guild.channels.cache.get(r.target_id)?.name ?? null, addedBy: r.added_by, addedAt: r.added_at })),
            ocrRules: rules,
            counts,
            stats,
        });
    } catch (err) {
        fail(res, 'load message threats', err);
    }
});

router.post('/settings', async (req, res) => {
    if (!(await writer(req, res))) return;
    const b = req.body || {};
    const patch = {};
    const allowed = ['obf_enabled', 'obf_action', 'obf_timeout_minutes', 'obf_review_alerts', 'everyone_enabled', 'everyone_timeout_minutes',
        'everyone_strict', 'everyone_allowed_roles', 'everyone_webhooks', 'qr_enabled', 'qr_strict', 'qr_action', 'qr_timeout_minutes',
        'ocr_rules_enabled', 'ocr_timeout_minutes', 'esc_enabled', 'esc_action', 'esc_review_alerts', 'threat_channel_id'];
    for (const k of allowed) if (k in b) patch[k] = b[k];
    if (patch.threat_channel_id && !req.guildObject.channels.cache.has(String(patch.threat_channel_id))) {
        return res.status(400).json({ error: 'That channel is not in this server.' });
    }
    if (Array.isArray(patch.everyone_allowed_roles)) patch.everyone_allowed_roles = patch.everyone_allowed_roles.map(String).filter(id => req.guildObject.roles.cache.has(id));
    try {
        const out = await mt.saveSettings(req.guildObject, patch, req.user.id);
        if (!out.ok) return res.status(400).json({ error: out.error });
        logger.info(`[API message-threats] ${req.user.username} saved settings in ${req.guildObject.id}`);
        res.json(out);
    } catch (err) {
        fail(res, 'save the settings', err);
    }
});

// ── AutoMod rules, install, breaker ─────────────────────────────────────────

router.get('/automod-rules', async (req, res) => {
    try {
        const out = await mt.listAutomodRules(req.guildObject);
        res.json(out);
    } catch (err) {
        res.json({ ok: false, error: err.message, rules: [] });
    }
});

router.post('/automod-rules/:ruleId/enforce', async (req, res) => {
    if (!(await writer(req, res))) return;
    const ruleId = String(req.params.ruleId);
    if (!SNOWFLAKE.test(ruleId)) return res.status(400).json({ error: 'Unknown rule.' });
    try {
        const out = await mt.setRuleEnforced(req.guildObject, ruleId, !!req.body?.enforce, req.user.id);
        if (!out.ok) return res.status(400).json({ error: out.error });
        logger.info(`[API message-threats] ${req.user.username} set rule ${ruleId} enforce=${!!req.body?.enforce} in ${req.guildObject.id}`);
        res.json({ ok: true });
    } catch (err) {
        fail(res, 'change the rule', err);
    }
});

router.post('/automod-rules/install', async (req, res) => {
    if (!(await writer(req, res))) return;
    try {
        const out = await mt.installAutomodRule(req.guildObject, req.user.id);
        if (!out.ok) return res.status(400).json({ error: out.error });
        logger.info(`[API message-threats] ${req.user.username} installed the AutoMod rule in ${req.guildObject.id}`);
        res.json(out);
    } catch (err) {
        fail(res, 'install the AutoMod rule', err);
    }
});

router.post('/breaker/reset', async (req, res) => {
    if (!(await writer(req, res))) return;
    try {
        await mt.resetBreaker(req.guildObject, req.user.id);
        logger.info(`[API message-threats] ${req.user.username} reset the circuit breaker in ${req.guildObject.id}`);
        res.json({ ok: true });
    } catch (err) {
        fail(res, 'reset the circuit breaker', err);
    }
});

// ── URL checker ─────────────────────────────────────────────────────────────

const checks = new Map();   // userId -> [ms], 20 a minute like /tools checkurl
router.post('/checkurl', async (req, res) => {
    const url = String(req.body?.url ?? '').trim();
    if (!url) return res.status(400).json({ error: 'Paste a link or a domain.' });
    const now = Date.now();
    const uses = (checks.get(req.user.id) || []).filter(t => now - t < 60_000);
    if (uses.length >= 20) return res.status(429).json({ error: 'You can check 20 links a minute.' });
    uses.push(now);
    checks.set(req.user.id, uses);
    try {
        res.json(await mt.checkUrl(url, req.guildObject.id));
    } catch (err) {
        fail(res, 'check the link', err);
    }
});

// ── image-text rules ────────────────────────────────────────────────────────

router.post('/ocr-rules', async (req, res) => {
    if (!(await writer(req, res))) return;
    const b = req.body || {};
    try {
        const out = await mt.addOcrRule(req.guildObject, {
            type: String(b.type ?? ''), pattern: String(b.pattern ?? ''), action: String(b.action ?? 'log'), reason: b.reason ? String(b.reason) : null,
        }, req.user.id);
        if (!out.ok) return res.status(400).json({ error: out.error });
        logger.info(`[API message-threats] ${req.user.username} added image-text rule #${out.id} in ${req.guildObject.id}`);
        res.json(out);
    } catch (err) {
        fail(res, 'add the rule', err);
    }
});

router.patch('/ocr-rules/:id', async (req, res) => {
    if (!(await writer(req, res))) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Unknown rule.' });
    const b = req.body || {};
    try {
        const out = await mt.updateOcrRule(req.guildObject, id, {
            enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined, action: b.action !== undefined ? String(b.action) : undefined,
        }, req.user.id);
        if (!out.ok) return res.status(400).json({ error: out.error });
        res.json(out);
    } catch (err) {
        fail(res, 'change the rule', err);
    }
});

router.delete('/ocr-rules/:id', async (req, res) => {
    if (!(await writer(req, res))) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Unknown rule.' });
    try {
        const ok = await mt.removeOcrRule(req.guildObject, id, req.user.id);
        if (!ok) return res.status(404).json({ error: 'No such rule.' });
        logger.info(`[API message-threats] ${req.user.username} removed image-text rule #${id} in ${req.guildObject.id}`);
        res.json({ ok: true });
    } catch (err) {
        fail(res, 'remove the rule', err);
    }
});

// ── ignore list ─────────────────────────────────────────────────────────────

router.post('/ignore', async (req, res) => {
    if (!(await writer(req, res))) return;
    const id = String(req.body?.id ?? '');
    const channel = req.guildObject.channels.cache.get(id);
    if (!channel) return res.status(400).json({ error: 'Pick a channel or category from this server.' });
    const kind = channel.type === ChannelType.GuildCategory ? 'category' : 'channel';
    try {
        const out = await addIgnored(req.guildObject, kind, id, req.user.id);
        if (!out.ok) return res.status(400).json({ error: out.error });
        logger.info(`[API message-threats] ${req.user.username} ignored ${kind} ${id} in ${req.guildObject.id}`);
        res.json({ ok: true, kind });
    } catch (err) {
        fail(res, 'ignore that channel', err);
    }
});

router.delete('/ignore/:kind/:id', async (req, res) => {
    if (!(await writer(req, res))) return;
    const { kind, id } = req.params;
    if (!['channel', 'category'].includes(kind) || !SNOWFLAKE.test(id)) return res.status(400).json({ error: 'Unknown entry.' });
    try {
        const ok = await removeIgnored(req.guildObject, kind, id, req.user.id);
        res.json({ ok: true, removed: ok });
    } catch (err) {
        fail(res, 'stop ignoring that channel', err);
    }
});

// ── review queue + detections ───────────────────────────────────────────────

router.get('/reviews', async (req, res) => {
    const status = ['pending', 'banned', 'safe', 'all'].includes(req.query.status) ? req.query.status : 'pending';
    try {
        const rows = await mt.listReviews(req.guildObject.id, { status, limit: 200 });
        res.json({
            reviews: rows.map(r => ({
                ...r,
                evidence: (() => { try { return r.evidence ? JSON.parse(r.evidence) : null; } catch { return null; } })(),
                user: userBits(req.guildObject, r.user_id),
            })),
        });
    } catch (err) {
        fail(res, 'load the queue', err);
    }
});

// AI second opinion on one flagged member (core/ai-judge.js): advice only, counted against the daily cap.
router.post('/reviews/:userId/ai', async (req, res) => {
    if (!SNOWFLAKE.test(String(req.params.userId))) return res.status(400).json({ error: 'Bad member id.' });
    if (!(await writer(req, res))) return;
    try {
        const out = await mt.askAiAboutReview(req.guildObject, req.params.userId);
        if (!out.ok) return res.status(409).json({ error: out.error });
        res.json(out);
    } catch (err) {
        fail(res, 'ask the AI', err);
    }
});

router.post('/reviews/decide', async (req, res) => {
    const decision = req.body?.decision === 'ban' ? 'ban' : req.body?.decision === 'dismiss' ? 'dismiss' : null;
    if (!decision) return res.status(400).json({ error: 'Choose Ban or Dismiss.' });
    if (!(await writer(req, res, { ban: decision === 'ban' }))) return;
    const userIds = (Array.isArray(req.body?.userIds) ? req.body.userIds : []).map(String).filter(id => SNOWFLAKE.test(id)).slice(0, 200);
    if (!userIds.length) return res.status(400).json({ error: 'Select at least one member.' });
    try {
        const out = await mt.decideReviews(req.guildObject, userIds, decision, req.user.id);
        logger.info(`[API message-threats] ${req.user.username} ${decision} ${out.done.length} flagged member(s) in ${req.guildObject.id}`);
        res.json(out);
    } catch (err) {
        fail(res, 'apply the decision', err);
    }
});

router.get('/detections', async (req, res) => {
    const sources = ['obfuscated_url', 'automod_escalation', 'anti_everyone', 'qr', 'image_rule', 'auto-list', 'image-domain', 'image-genre', 'evidence_flagged'];
    const source = sources.includes(req.query.source) ? req.query.source : null;
    try {
        const rows = await mt.recentDetections(req.guildObject.id, { limit: Math.min(100, Number(req.query.limit) || 50), source });
        const users = Object.fromEntries([...new Set(rows.map(r => r.user_id))].map(id => [id, userBits(req.guildObject, id)]));
        res.json({ detections: rows, users });
    } catch (err) {
        fail(res, 'load recent detections', err);
    }
});

export default router;
