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
        const prefix = command_prefix != null ? String(command_prefix).slice(0, 5) : '!';
        const cg = Math.max(0, Math.min(60, parseInt(cooldown_global, 10) || 0));
        const cu = Math.max(0, Math.min(300, parseInt(cooldown_user, 10) || 0));
        const feats = features_enabled != null ? JSON.stringify(features_enabled) : null;
        await pool.execute(
            `UPDATE tokes_channels SET command_prefix = ?, cooldown_global = ?, cooldown_user = ?,
                features_enabled = COALESCE(?, features_enabled) WHERE id = ?`,
            [prefix, cg, cu, feats, owned.id]
        );
        invalidateChannelCache(owned.id);
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

export default router;
