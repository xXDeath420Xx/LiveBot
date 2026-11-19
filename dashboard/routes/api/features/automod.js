/**
 * Automod dashboard API. Two surfaces:
 *   • Whitelist CRUD (members automod ignores) — the users on the server's
 *     protection allowlist, shared with the Protection Settings page.
 *   • Discord-native AutoMod rule CRUD — thin shell over Discord's
 *     AutoModerationRuleManager so admins can create, edit, and remove the
 *     server's AutoMod rules from the dashboard without opening Discord's own
 *     server settings. Rule shape matches Discord's wire format one-for-one.
 */

import express from 'express';
import {
    AutoModerationRuleEventType,
    AutoModerationRuleTriggerType,
    AutoModerationActionType,
    PermissionFlagsBits,
} from 'discord.js';
import logger from '../../../../utils/logger.js';
import { getWhitelist, addToWhitelist, removeFromWhitelist } from '../../../../utils/automod-whitelist.js';

const router = express.Router({ mergeParams: true });
const SNOWFLAKE = /^\d{15,25}$/;

// ─── Discord AutoMod Rules ─────────────────────────────────────
// These mirror Discord's AutoMod payload shape and are safe to send verbatim
// to AutoModerationRuleManager.create / edit.

const EVENT_TYPE_LABELS = {
    [AutoModerationRuleEventType.MessageSend]: 'MESSAGE_SEND',
    [AutoModerationRuleEventType.MemberUpdate]: 'MEMBER_UPDATE',
};
const TRIGGER_TYPE_LABELS = {
    [AutoModerationRuleTriggerType.Keyword]: 'KEYWORD',
    [AutoModerationRuleTriggerType.Spam]: 'SPAM',
    [AutoModerationRuleTriggerType.KeywordPreset]: 'KEYWORD_PRESET',
    [AutoModerationRuleTriggerType.MentionSpam]: 'MENTION_SPAM',
    [AutoModerationRuleTriggerType.MemberProfile]: 'MEMBER_PROFILE',
};
const ACTION_TYPE_LABELS = {
    [AutoModerationActionType.BlockMessage]: 'BLOCK_MESSAGE',
    [AutoModerationActionType.SendAlertMessage]: 'SEND_ALERT_MESSAGE',
    [AutoModerationActionType.Timeout]: 'TIMEOUT',
    [AutoModerationActionType.BlockMemberInteraction]: 'BLOCK_MEMBER_INTERACTION',
};

function serialiseRule(rule) {
    return {
        id: rule.id,
        guildId: rule.guildId,
        name: rule.name,
        enabled: rule.enabled,
        creatorId: rule.creatorId,
        eventType: rule.eventType,
        eventTypeName: EVENT_TYPE_LABELS[rule.eventType] ?? String(rule.eventType),
        triggerType: rule.triggerType,
        triggerTypeName: TRIGGER_TYPE_LABELS[rule.triggerType] ?? String(rule.triggerType),
        triggerMetadata: rule.triggerMetadata,
        actions: rule.actions.map(a => ({
            type: a.type,
            typeName: ACTION_TYPE_LABELS[a.type] ?? String(a.type),
            metadata: a.metadata,
        })),
        exemptRoles: Array.isArray(rule.exemptRoles)
            ? rule.exemptRoles.map(r => r?.id ?? r)
            : [...(rule.exemptRoles?.keys?.() ?? [])],
        exemptChannels: Array.isArray(rule.exemptChannels)
            ? rule.exemptChannels.map(c => c?.id ?? c)
            : [...(rule.exemptChannels?.keys?.() ?? [])],
    };
}

/** Discord requires MANAGE_GUILD to touch AutoMod rules. */
function requireManageGuild(req, res) {
    const me = req.guildObject?.members?.me;
    if (!me?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
        res.status(403).json({ error: 'The bot is missing Manage Server; AutoMod rules cannot be read or changed.' });
        return false;
    }
    return true;
}

/** GET /rules — list every AutoMod rule on this guild. */
router.get('/rules', async (req, res) => {
    try {
        if (!requireManageGuild(req, res)) return;
        const rules = await req.guildObject.autoModerationRules.fetch();
        res.json({
            rules: [...rules.values()].map(serialiseRule),
            eventTypes: EVENT_TYPE_LABELS,
            triggerTypes: TRIGGER_TYPE_LABELS,
            actionTypes: ACTION_TYPE_LABELS,
        });
    } catch (err) {
        logger.error('[API AutoMod rules GET] failed', { err: err.message });
        res.status(500).json({ error: 'Failed to fetch rules' });
    }
});

/** Shared body validator — rejects obviously bad input before the Discord call. */
function validateRuleBody(body, { isCreate }) {
    const out = {};
    if (isCreate || body.name !== undefined) {
        if (typeof body.name !== 'string' || !body.name.trim()) return { error: 'A name is required.' };
        out.name = body.name.trim().slice(0, 100);
    }
    if (isCreate || body.eventType !== undefined) {
        const et = Number(body.eventType);
        if (!(et in EVENT_TYPE_LABELS)) return { error: 'eventType must be 1 (MESSAGE_SEND) or 2 (MEMBER_UPDATE).' };
        out.eventType = et;
    }
    if (isCreate) {
        const tt = Number(body.triggerType);
        if (!(tt in TRIGGER_TYPE_LABELS)) return { error: 'triggerType must be 1, 3, 4, 5 or 6.' };
        out.triggerType = tt;
    }
    if (body.triggerMetadata !== undefined) out.triggerMetadata = body.triggerMetadata || {};
    if (body.actions !== undefined) {
        if (!Array.isArray(body.actions) || !body.actions.length) return { error: 'actions must be a non-empty array.' };
        out.actions = body.actions.map(a => ({
            type: Number(a.type),
            metadata: a.metadata || undefined,
        }));
    } else if (isCreate) {
        return { error: 'actions is required.' };
    }
    if (body.enabled !== undefined) out.enabled = !!body.enabled;
    if (body.exemptRoles !== undefined) {
        if (!Array.isArray(body.exemptRoles)) return { error: 'exemptRoles must be an array of role IDs.' };
        out.exemptRoles = body.exemptRoles.filter(id => SNOWFLAKE.test(String(id)));
    }
    if (body.exemptChannels !== undefined) {
        if (!Array.isArray(body.exemptChannels)) return { error: 'exemptChannels must be an array of channel IDs.' };
        out.exemptChannels = body.exemptChannels.filter(id => SNOWFLAKE.test(String(id)));
    }
    if (body.reason !== undefined) out.reason = String(body.reason).slice(0, 512);
    return { data: out };
}

/** POST /rules — create a new AutoMod rule. */
router.post('/rules', async (req, res) => {
    try {
        if (!requireManageGuild(req, res)) return;
        const { data, error } = validateRuleBody(req.body || {}, { isCreate: true });
        if (error) return res.status(400).json({ error });
        const created = await req.guildObject.autoModerationRules.create(data);
        logger.info('[API AutoMod rules POST] created', {
            guildId: req.params.guildId, ruleId: created.id, name: created.name, by: req.user?.id,
        });
        res.json({ success: true, rule: serialiseRule(created) });
    } catch (err) {
        logger.error('[API AutoMod rules POST] failed', { err: err.message });
        if (err?.code === 50013) return res.status(403).json({ error: 'Discord refused: the bot lacks the permission to create this rule.' });
        res.status(500).json({ error: err?.message ?? 'Failed to create rule' });
    }
});

/** PATCH /rules/:ruleId — edit an existing rule. */
router.patch('/rules/:ruleId', async (req, res) => {
    try {
        if (!requireManageGuild(req, res)) return;
        const ruleId = req.params.ruleId;
        if (!SNOWFLAKE.test(String(ruleId))) return res.status(400).json({ error: 'Invalid rule id.' });
        const { data, error } = validateRuleBody(req.body || {}, { isCreate: false });
        if (error) return res.status(400).json({ error });
        const edited = await req.guildObject.autoModerationRules.edit(ruleId, data);
        logger.info('[API AutoMod rules PATCH] edited', {
            guildId: req.params.guildId, ruleId, by: req.user?.id,
        });
        res.json({ success: true, rule: serialiseRule(edited) });
    } catch (err) {
        if (err?.code === 10070) return res.status(404).json({ error: 'That rule no longer exists.' });
        if (err?.code === 50013) return res.status(403).json({ error: 'Discord refused: the bot lacks the permission to edit this rule.' });
        logger.error('[API AutoMod rules PATCH] failed', { err: err.message });
        res.status(500).json({ error: err?.message ?? 'Failed to edit rule' });
    }
});

/** DELETE /rules/:ruleId — remove an AutoMod rule. */
router.delete('/rules/:ruleId', async (req, res) => {
    try {
        if (!requireManageGuild(req, res)) return;
        const ruleId = req.params.ruleId;
        if (!SNOWFLAKE.test(String(ruleId))) return res.status(400).json({ error: 'Invalid rule id.' });
        await req.guildObject.autoModerationRules.delete(ruleId, req.body?.reason ? String(req.body.reason).slice(0, 512) : undefined);
        logger.info('[API AutoMod rules DELETE] removed', {
            guildId: req.params.guildId, ruleId, by: req.user?.id,
        });
        res.json({ success: true });
    } catch (err) {
        if (err?.code === 10070) return res.status(404).json({ error: 'That rule no longer exists.' });
        if (err?.code === 50013) return res.status(403).json({ error: 'Discord refused: the bot lacks the permission to delete this rule.' });
        logger.error('[API AutoMod rules DELETE] failed', { err: err.message });
        res.status(500).json({ error: err?.message ?? 'Failed to delete rule' });
    }
});

// ─── Automod User Whitelist ─────────────────────────────────────

/**
 * GET /api/guilds/:guildId/automod/whitelist
 */
router.get('/whitelist', async (req, res) => {
    try {
        res.json({ success: true, whitelist: await getWhitelist(req.params.guildId) });
    } catch (error) {
        logger.error('[API Automod Whitelist GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch whitelist' });
    }
});

/**
 * POST /api/guilds/:guildId/automod/whitelist
 */
router.post('/whitelist', async (req, res) => {
    try {
        const userId = String(req.body?.userId ?? '').replace(/[<@!>]/g, '').trim();
        if (!SNOWFLAKE.test(userId)) return res.status(400).json({ error: 'A user ID is required' });
        await addToWhitelist(req.guildObject ?? req.params.guildId, userId, req.user?.id || null, req.body?.reason || null);
        res.json({ success: true, message: 'User added to whitelist' });
    } catch (error) {
        logger.error('[API Automod Whitelist POST] Error:', error);
        res.status(500).json({ error: error.message || 'Failed to add user to whitelist' });
    }
});

/**
 * DELETE /api/guilds/:guildId/automod/whitelist/:userId
 */
router.delete('/whitelist/:userId', async (req, res) => {
    try {
        await removeFromWhitelist(req.guildObject ?? req.params.guildId, req.params.userId, req.user?.id || null);
        res.json({ success: true, message: 'User removed from whitelist' });
    } catch (error) {
        logger.warn(`[API Automod Whitelist DELETE] ${error.message}`);
        res.status(409).json({ error: error.message || 'Failed to remove user from whitelist' });
    }
});

export default router;
