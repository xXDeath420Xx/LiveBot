/**
 * /kick/channel/* — per-channel settings + command management for Kick.
 * Re-homes the proven /tokes-bot channel/command operations under /kick,
 * resolving the Kick channel_id to the tokes_channels PK on every call.
 */
import express from 'express';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { requireKickAuth } from './auth-tokes-bot.js';
import { resolveOwnedChannel } from '../../services/certifried-bot/defender/owned-channel.js';
import { invalidateChannelCache } from '../../services/certifried-bot/command-registry.js';
import { clearAutoResponderCache } from '../../services/certifried-bot/auto-responder.js';
import { clearKickAutomodCache } from '../../services/certifried-bot/kick-automod.js';
import { dailyActivity } from '../../services/certifried-bot/defender/enforcement-log.js';
import { resolveChannel } from '../../services/certifried-bot/defender/channel-tokens.js';
import { resolveKickUser } from '../../services/certifried-bot/defender/resolve-kick-user.js';
import { banUser, unbanUser } from '../../services/certifried-bot/defender/kick-moderation.js';
import { log as logEnforcement } from '../../services/certifried-bot/defender/enforcement-log.js';
import {
    validateCommandName, validateCommandResponse, validateCooldown,
    validateAliases, validateBoolean
} from '../../utils/input-validation.js';

const router = express.Router();

// ── Page: per-channel settings ──────────────────────────────────────────────
router.get('/kick/channel/:channelId', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).send('Channel not found.');
        const [[channel]] = await pool.execute(
            `SELECT c.id, c.channel_id, c.channel_name, c.platform, c.is_enabled,
                    c.command_prefix, c.cooldown_global, c.cooldown_user, c.features_enabled
             FROM tokes_channels c WHERE c.id = ?`, [owned.id]
        );
        res.render('kick/channel', {
            user: req.session.tokesUser,
            channel,
            csrfToken: req.csrfToken ? req.csrfToken() : (res.locals.csrfToken || '')
        });
    } catch (error) {
        logger.error('[Kick Channel] settings page error', { error: error.message });
        res.status(500).send('Failed to load channel settings.');
    }
});

// ── API: update channel settings ────────────────────────────────────────────
router.patch('/kick/api/channel/:channelId', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const { command_prefix, cooldown_global, cooldown_user, features_enabled } = req.body;
        // Partial update: only fields present in the body are changed; COALESCE
        // leaves the existing column value when a field is omitted (null param).
        const prefix = command_prefix != null ? String(command_prefix).slice(0, 5) : null;
        const cg = cooldown_global != null ? Math.max(0, Math.min(60, parseInt(cooldown_global, 10) || 0)) : null;
        const cu = cooldown_user != null ? Math.max(0, Math.min(300, parseInt(cooldown_user, 10) || 0)) : null;
        const feats = features_enabled != null ? JSON.stringify(features_enabled) : null;
        await pool.execute(
            `UPDATE tokes_channels SET
                command_prefix = COALESCE(?, command_prefix),
                cooldown_global = COALESCE(?, cooldown_global),
                cooldown_user = COALESCE(?, cooldown_user),
                features_enabled = COALESCE(?, features_enabled)
             WHERE id = ?`,
            [prefix, cg, cu, feats, owned.id]
        );
        invalidateChannelCache(owned.id);
        // features_enabled holds the automod sub-config too — bust its cache so
        // the live bot picks up filter changes on the next message.
        if (features_enabled != null) clearKickAutomodCache(owned.id);
        res.json({ success: true });
    } catch (error) {
        logger.error('[Kick Channel] settings save error', { error: error.message });
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

// ── Page: command management ────────────────────────────────────────────────
router.get('/kick/channel/:channelId/commands', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).send('Channel not found.');
        const [[channel]] = await pool.execute(
            'SELECT id, channel_id, channel_name FROM tokes_channels WHERE id = ?', [owned.id]
        );
        const [commands] = await pool.execute(
            'SELECT command_key, default_aliases, description, category, cooldown_default, mod_only FROM tokes_global_command_config WHERE is_enabled = 1 ORDER BY category, command_key'
        );
        const [channelCommands] = await pool.execute(
            'SELECT command_key, is_enabled, custom_aliases, custom_response, cooldown_override, mod_only FROM tokes_channel_commands WHERE channel_id = ?', [owned.id]
        );
        const [customCommands] = await pool.execute(
            'SELECT id, command_name, response, cooldown, mod_only, is_enabled, use_count FROM tokes_custom_commands WHERE channel_id = ? ORDER BY command_name', [owned.id]
        );
        res.render('kick/channel-commands', {
            user: req.session.tokesUser, channel, commands, channelCommands, customCommands,
            csrfToken: req.csrfToken ? req.csrfToken() : (res.locals.csrfToken || '')
        });
    } catch (error) {
        logger.error('[Kick Channel] commands page error', { error: error.message });
        res.status(500).send('Failed to load commands.');
    }
});

// ── API: toggle a built-in command ──────────────────────────────────────────
router.post('/kick/api/channel/:channelId/commands/:commandKey/toggle', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const enabled = req.body.enabled ? 1 : 0;
        await pool.execute(
            `INSERT INTO tokes_channel_commands (channel_id, command_key, is_enabled) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled)`,
            [owned.id, req.params.commandKey, enabled]
        );
        invalidateChannelCache(owned.id);
        res.json({ success: true, enabled: !!enabled });
    } catch (error) {
        logger.error('[Kick Channel] toggle error', { error: error.message });
        res.status(500).json({ error: 'Failed to toggle command' });
    }
});

// ── API: override a built-in command ────────────────────────────────────────
router.put('/kick/api/channel/:channelId/commands/:commandKey', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const aliasesV = validateAliases(req.body.custom_aliases);
        if (!aliasesV.valid) return res.status(400).json({ error: aliasesV.error });
        let respValue = null;
        if (req.body.custom_response) {
            const respV = validateCommandResponse(req.body.custom_response);
            if (!respV.valid) return res.status(400).json({ error: respV.error });
            respValue = respV.value;
        }
        const cdV = validateCooldown(req.body.cooldown_override);
        const modV = validateBoolean(req.body.mod_only, false);
        if (!cdV.valid) return res.status(400).json({ error: cdV.error });
        if (!modV.valid) return res.status(400).json({ error: modV.error });
        await pool.execute(
            `INSERT INTO tokes_channel_commands
                (channel_id, command_key, custom_aliases, custom_response, cooldown_override, mod_only)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE custom_aliases = VALUES(custom_aliases),
                custom_response = VALUES(custom_response), cooldown_override = VALUES(cooldown_override),
                mod_only = VALUES(mod_only), updated_at = CURRENT_TIMESTAMP`,
            [owned.id, req.params.commandKey,
             aliasesV.value.length ? JSON.stringify(aliasesV.value) : null,
             respValue, cdV.value, modV.value ? 1 : 0]
        );
        invalidateChannelCache(owned.id);
        res.json({ success: true });
    } catch (error) {
        logger.error('[Kick Channel] override error', { error: error.message });
        res.status(500).json({ error: 'Failed to update command' });
    }
});

// ── API: custom commands CRUD ───────────────────────────────────────────────
router.post('/kick/api/channel/:channelId/custom', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const nameV = validateCommandName(req.body.command_name);
        if (!nameV.valid) return res.status(400).json({ error: nameV.error });
        const respV = validateCommandResponse(req.body.response);
        if (!respV.valid) return res.status(400).json({ error: respV.error });
        const cdV = validateCooldown(req.body.cooldown);
        const modV = validateBoolean(req.body.mod_only, false);
        if (!cdV.valid) return res.status(400).json({ error: cdV.error });
        if (!modV.valid) return res.status(400).json({ error: modV.error });
        const [[builtin]] = await pool.execute(
            'SELECT command_key FROM tokes_global_command_config WHERE command_key = ?', [nameV.value]
        );
        if (builtin) return res.status(409).json({ error: 'That name is a built-in command' });
        try {
            const [result] = await pool.execute(
                `INSERT INTO tokes_custom_commands (channel_id, command_name, response, cooldown, mod_only, created_by)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [owned.id, nameV.value, respV.value, cdV.value, modV.value ? 1 : 0, req.session.tokesUser.name || 'owner']
            );
            invalidateChannelCache(owned.id);
            res.json({ success: true, commandId: result.insertId });
        } catch (e) {
            if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Command already exists' });
            throw e;
        }
    } catch (error) {
        logger.error('[Kick Channel] custom create error', { error: error.message });
        res.status(500).json({ error: 'Failed to create command' });
    }
});

router.put('/kick/api/channel/:channelId/custom/:cmdId', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const [[existing]] = await pool.execute(
            'SELECT id FROM tokes_custom_commands WHERE id = ? AND channel_id = ?', [req.params.cmdId, owned.id]
        );
        if (!existing) return res.status(404).json({ error: 'Command not found' });
        const respV = validateCommandResponse(req.body.response);
        if (!respV.valid) return res.status(400).json({ error: respV.error });
        const cdV = validateCooldown(req.body.cooldown);
        const modV = validateBoolean(req.body.mod_only, false);
        const enV = validateBoolean(req.body.is_enabled, true);
        if (!cdV.valid) return res.status(400).json({ error: cdV.error });
        if (!modV.valid) return res.status(400).json({ error: modV.error });
        if (!enV.valid) return res.status(400).json({ error: enV.error });
        await pool.execute(
            'UPDATE tokes_custom_commands SET response = ?, cooldown = ?, mod_only = ?, is_enabled = ? WHERE id = ?',
            [respV.value, cdV.value, modV.value ? 1 : 0, enV.value ? 1 : 0, req.params.cmdId]
        );
        invalidateChannelCache(owned.id);
        res.json({ success: true });
    } catch (error) {
        logger.error('[Kick Channel] custom update error', { error: error.message });
        res.status(500).json({ error: 'Failed to update command' });
    }
});

router.delete('/kick/api/channel/:channelId/custom/:cmdId', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const [result] = await pool.execute(
            'DELETE FROM tokes_custom_commands WHERE id = ? AND channel_id = ?', [req.params.cmdId, owned.id]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Command not found' });
        invalidateChannelCache(owned.id);
        res.json({ success: true });
    } catch (error) {
        logger.error('[Kick Channel] custom delete error', { error: error.message });
        res.status(500).json({ error: 'Failed to delete command' });
    }
});

// ── Live moderation: ban / unban / timeout a user by name ───────────────────
// The streamer types a username; we resolve it to a Kick user id, use the
// channel owner's token (resolveChannel) to call the Kick moderation API, and
// record the action in the enforcement log so it shows in the activity feed.
router.post('/kick/api/channel/:channelId/moderate', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });

        const action = String(req.body.action || '');
        const username = String(req.body.username || '').trim();
        if (!['ban', 'unban', 'timeout'].includes(action)) {
            return res.status(400).json({ error: 'action must be ban, unban or timeout' });
        }
        if (!username) return res.status(400).json({ error: 'username required' });

        // The channel's own Kick id is the URL param; get a valid owner token + scopes.
        const channelId = String(req.params.channelId);
        const ch = await resolveChannel(channelId);
        if (!ch || !ch.token) {
            return res.status(409).json({ error: 'Channel is not enrolled or its Kick token is unavailable. Enable the defender and re-authorize.' });
        }
        if (!ch.scopes.includes('moderation:ban')) {
            return res.status(403).json({ error: 'This channel has not granted ban permissions. Re-authorize with Kick.' });
        }

        // Username → Kick user id.
        const target = await resolveKickUser(username);
        if (!target) return res.status(404).json({ error: `No Kick user found for "${username}"` });

        // Attribute the action to the dashboard user who clicked it — once
        // managers exist, "who banned this person" matters for the audit trail.
        const actor = String(req.session.tokesUser.name || `user#${userId}`).slice(0, 40);

        let result, reasonText;
        if (action === 'unban') {
            result = await unbanUser(ch.broadcasterId, target.userId, ch.token);
            reasonText = `manual unban by ${actor}`;
        } else {
            // ban (permanent) or timeout (minutes from req.body.minutes, default 10)
            const opts = { reason: req.body.reason ? String(req.body.reason).slice(0, 100) : `Manual action by ${actor} via dashboard` };
            if (action === 'timeout') {
                const mins = Math.min(Math.max(parseInt(req.body.minutes, 10) || 10, 1), 10080); // 1 min … 1 week
                opts.durationMin = mins;
                reasonText = `manual timeout ${mins}m by ${actor}`;
            } else {
                reasonText = `manual ban by ${actor}`;
            }
            result = await banUser(ch.broadcasterId, target.userId, opts, ch.token);
        }

        // Audit it (best-effort) so the activity feed reflects manual actions.
        // NB: kbd_enforcement_log.action is ENUM('ban','delete','detected_no_scope')
        // — 'unban' is not valid, so we record manual actions as 'ban' and keep the
        // real action in the reason text. (The feed renders the reason.)
        try {
            await logEnforcement({
                channelId,
                targetUserId: target.userId,
                targetUsername: target.slug,
                action: 'ban',
                reason: reasonText,
                success: !!result?.ok
            });
        } catch (_) { /* logging must never fail the action */ }

        if (!result?.ok) {
            return res.status(502).json({ error: `Kick API rejected the ${action} (status ${result?.status || '?'}).` });
        }
        res.json({ success: true, action, user: target.slug });
    } catch (error) {
        logger.error('[Kick Channel] moderate error', { error: error.message });
        res.status(500).json({ error: 'Moderation action failed' });
    }
});

// ── Auto-responders CRUD ────────────────────────────────────────────────────
const AR_MATCH_TYPES = ['contains', 'exact', 'starts', 'word'];

router.get('/kick/api/channel/:channelId/responders', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const [rows] = await pool.execute(
            `SELECT id, trigger_text, match_type, response, cooldown, is_enabled, use_count
             FROM tokes_auto_responders WHERE channel_id = ? ORDER BY id DESC`,
            [owned.id]
        );
        res.json({ responders: rows });
    } catch (error) {
        logger.error('[Kick Channel] responders list error', { error: error.message });
        res.status(500).json({ error: 'Failed to load auto-responders' });
    }
});

router.post('/kick/api/channel/:channelId/responders', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });

        const trigger = String(req.body.trigger_text || '').trim().slice(0, 100);
        if (!trigger) return res.status(400).json({ error: 'trigger_text required' });
        const matchType = AR_MATCH_TYPES.includes(req.body.match_type) ? req.body.match_type : 'contains';
        const respV = validateCommandResponse(req.body.response);
        if (!respV.valid) return res.status(400).json({ error: respV.error });
        const cdV = validateCooldown(req.body.cooldown);
        if (!cdV.valid) return res.status(400).json({ error: cdV.error });

        const [result] = await pool.execute(
            `INSERT INTO tokes_auto_responders (channel_id, trigger_text, match_type, response, cooldown, created_by)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [owned.id, trigger, matchType, respV.value, cdV.value, req.session.tokesUser.name || 'owner']
        );
        clearAutoResponderCache(owned.id);
        res.json({ success: true, id: result.insertId });
    } catch (error) {
        logger.error('[Kick Channel] responder create error', { error: error.message });
        res.status(500).json({ error: 'Failed to create auto-responder' });
    }
});

router.put('/kick/api/channel/:channelId/responders/:id', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const [[existing]] = await pool.execute(
            'SELECT id FROM tokes_auto_responders WHERE id = ? AND channel_id = ?', [req.params.id, owned.id]
        );
        if (!existing) return res.status(404).json({ error: 'Responder not found' });

        const trigger = String(req.body.trigger_text || '').trim().slice(0, 100);
        if (!trigger) return res.status(400).json({ error: 'trigger_text required' });
        const matchType = AR_MATCH_TYPES.includes(req.body.match_type) ? req.body.match_type : 'contains';
        const respV = validateCommandResponse(req.body.response);
        if (!respV.valid) return res.status(400).json({ error: respV.error });
        const cdV = validateCooldown(req.body.cooldown);
        if (!cdV.valid) return res.status(400).json({ error: cdV.error });
        const enV = validateBoolean(req.body.is_enabled, true);

        await pool.execute(
            `UPDATE tokes_auto_responders SET trigger_text = ?, match_type = ?, response = ?, cooldown = ?, is_enabled = ?
             WHERE id = ?`,
            [trigger, matchType, respV.value, cdV.value, enV.value ? 1 : 0, req.params.id]
        );
        clearAutoResponderCache(owned.id);
        res.json({ success: true });
    } catch (error) {
        logger.error('[Kick Channel] responder update error', { error: error.message });
        res.status(500).json({ error: 'Failed to update auto-responder' });
    }
});

router.delete('/kick/api/channel/:channelId/responders/:id', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const [result] = await pool.execute(
            'DELETE FROM tokes_auto_responders WHERE id = ? AND channel_id = ?', [req.params.id, owned.id]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Responder not found' });
        clearAutoResponderCache(owned.id);
        res.json({ success: true });
    } catch (error) {
        logger.error('[Kick Channel] responder delete error', { error: error.message });
        res.status(500).json({ error: 'Failed to delete auto-responder' });
    }
});

// ── Per-channel activity trend (time-series) ────────────────────────────────
router.get('/kick/api/channel/:channelId/trend', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        // Scope by the Kick channel_id (the URL param), which is what the log stores.
        const series = await dailyActivity({ channelId: String(req.params.channelId), days: req.query.days || 14 });
        res.json({ series });
    } catch (error) {
        logger.error('[Kick Channel] trend error', { error: error.message });
        res.status(500).json({ error: 'Failed to load trend' });
    }
});

// ── Timers (scheduled messages) CRUD ────────────────────────────────────────
router.get('/kick/api/channel/:channelId/timers', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const [rows] = await pool.execute(
            `SELECT id, message, interval_min, is_enabled, send_count, last_sent_at
             FROM tokes_timers WHERE channel_id = ? ORDER BY id DESC`,
            [owned.id]
        );
        res.json({ timers: rows });
    } catch (error) {
        logger.error('[Kick Channel] timers list error', { error: error.message });
        res.status(500).json({ error: 'Failed to load timers' });
    }
});

router.post('/kick/api/channel/:channelId/timers', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const respV = validateCommandResponse(req.body.message);
        if (!respV.valid) return res.status(400).json({ error: respV.error });
        // Interval in minutes: clamp to [1, 1440] (1 min … 1 day).
        const interval = Math.min(Math.max(parseInt(req.body.interval_min, 10) || 30, 1), 1440);
        const [result] = await pool.execute(
            `INSERT INTO tokes_timers (channel_id, message, interval_min, created_by) VALUES (?, ?, ?, ?)`,
            [owned.id, respV.value, interval, req.session.tokesUser.name || 'owner']
        );
        res.json({ success: true, id: result.insertId });
    } catch (error) {
        logger.error('[Kick Channel] timer create error', { error: error.message });
        res.status(500).json({ error: 'Failed to create timer' });
    }
});

router.put('/kick/api/channel/:channelId/timers/:id', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const [[existing]] = await pool.execute(
            'SELECT id FROM tokes_timers WHERE id = ? AND channel_id = ?', [req.params.id, owned.id]
        );
        if (!existing) return res.status(404).json({ error: 'Timer not found' });
        const respV = validateCommandResponse(req.body.message);
        if (!respV.valid) return res.status(400).json({ error: respV.error });
        const interval = Math.min(Math.max(parseInt(req.body.interval_min, 10) || 30, 1), 1440);
        const enV = validateBoolean(req.body.is_enabled, true);
        await pool.execute(
            'UPDATE tokes_timers SET message = ?, interval_min = ?, is_enabled = ? WHERE id = ?',
            [respV.value, interval, enV.value ? 1 : 0, req.params.id]
        );
        res.json({ success: true });
    } catch (error) {
        logger.error('[Kick Channel] timer update error', { error: error.message });
        res.status(500).json({ error: 'Failed to update timer' });
    }
});

router.delete('/kick/api/channel/:channelId/timers/:id', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const [result] = await pool.execute(
            'DELETE FROM tokes_timers WHERE id = ? AND channel_id = ?', [req.params.id, owned.id]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Timer not found' });
        res.json({ success: true });
    } catch (error) {
        logger.error('[Kick Channel] timer delete error', { error: error.message });
        res.status(500).json({ error: 'Failed to delete timer' });
    }
});

export default router;
