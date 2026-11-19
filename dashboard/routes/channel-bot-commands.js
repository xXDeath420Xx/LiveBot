/*
 * Channel bot commands, shared by the Kick Defender pages (/kick/channel/:channelId/commands, dashboard/routes/kick-channel.js)
 * and the stream bot's Twitch page (/stream/bot/commands/:channelId, dashboard/routes/stream-bot-channel.js).
 * Moved here from kick-channel.js so both platforms run the same code against the same tables (tokes_channel_commands,
 * tokes_custom_commands, tokes_auto_responders), keyed by the tokes_channels row the caller resolved as the user's own.
 *
 *   commandsPageData(pool, channelRowId)   the page's data: channel, built-in commands, overrides, custom commands
 *   mountChannelCommandRoutes(router, { base, guard, resolve, createdBy, label })
 *       base      e.g. '/kick/api/channel' → routes under `${base}/:channelId/…`
 *       guard     the session check (requireKickAuth, or the stream bot's needApi)
 *       resolve   async (req) → { id } (the tokes_channels row) or null when the channel is not the user's
 *       createdBy (req) → name stored with new commands and responders
 *   Routes: POST commands/:commandKey/toggle, PUT commands/:commandKey, POST custom, PUT custom/:cmdId, DELETE custom/:cmdId,
 *           GET|POST responders, PUT|DELETE responders/:id.
 */
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { invalidateChannelCache } from '../../services/certifried-bot/command-registry.js';
import { clearAutoResponderCache } from '../../services/certifried-bot/auto-responder.js';
import {
    validateCommandName, validateCommandResponse, validateCooldown,
    validateAliases, validateBoolean
} from '../../utils/input-validation.js';

const AR_MATCH_TYPES = ['contains', 'exact', 'starts', 'word'];

/** Built-in commands offered on the page. */
export const BUILTIN_COMMANDS_SQL =
    // The !cfx commands belonged to CertiFried Tycoon, which has closed: they only answer with where the
    // game went (services/certifried-bot/commands/cfx.js), so they are not offered as commands here.
    "SELECT command_key, default_aliases, description, category, cooldown_default, mod_only FROM tokes_global_command_config WHERE is_enabled = 1 AND command_key NOT IN ('cfx', 'cfxdaily', 'cfxmarket', 'cfxleaderboard', 'cfxsell') ORDER BY category, command_key";

export async function commandsPageData(db, channelRowId) {
    const [[channel]] = await db.execute('SELECT id, channel_id, channel_name, platform, features_enabled FROM tokes_channels WHERE id = ?', [channelRowId]);
    const [commands] = await db.execute(BUILTIN_COMMANDS_SQL);
    const [channelCommands] = await db.execute(
        'SELECT command_key, is_enabled, custom_aliases, custom_response, cooldown_override, mod_only FROM tokes_channel_commands WHERE channel_id = ?', [channelRowId]);
    const [customCommands] = await db.execute(
        'SELECT id, command_name, response, cooldown, mod_only, is_enabled, use_count, created_by FROM tokes_custom_commands WHERE channel_id = ? ORDER BY command_name', [channelRowId]);
    return { channel, commands, channelCommands, customCommands };
}

export function mountChannelCommandRoutes(router, { base, guard, resolve, createdBy = () => 'owner', label = '[Channel commands]' }) {
    const owned = async (req, res) => {
        const o = await resolve(req);
        if (!o) res.status(404).json({ error: 'Channel not found' });
        return o;
    };
    const fail = (res, what, error) => {
        logger.error(`${label} ${what} error`, { error: error.message });
        res.status(500).json({ error: `Failed to ${what}` });
    };

    // ── built-in commands: on/off, and aliases / cooldown / mods only ──
    router.post(`${base}/:channelId/commands/:commandKey/toggle`, guard, async (req, res) => {
        try {
            const o = await owned(req, res); if (!o) return;
            const enabled = req.body.enabled ? 1 : 0;
            await pool.execute(
                `INSERT INTO tokes_channel_commands (channel_id, command_key, is_enabled) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled)`,
                [o.id, req.params.commandKey, enabled]
            );
            invalidateChannelCache(o.id);
            res.json({ success: true, enabled: !!enabled });
        } catch (error) { fail(res, 'toggle command', error); }
    });

    router.put(`${base}/:channelId/commands/:commandKey`, guard, async (req, res) => {
        try {
            const o = await owned(req, res); if (!o) return;
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
                [o.id, req.params.commandKey,
                    aliasesV.value.length ? JSON.stringify(aliasesV.value) : null,
                    respValue, cdV.value, modV.value ? 1 : 0]
            );
            invalidateChannelCache(o.id);
            res.json({ success: true });
        } catch (error) { fail(res, 'update command', error); }
    });

    // ── your own commands ──
    router.post(`${base}/:channelId/custom`, guard, async (req, res) => {
        try {
            const o = await owned(req, res); if (!o) return;
            const nameV = validateCommandName(req.body.command_name);
            if (!nameV.valid) return res.status(400).json({ error: nameV.error });
            const respV = validateCommandResponse(req.body.response);
            if (!respV.valid) return res.status(400).json({ error: respV.error });
            const cdV = validateCooldown(req.body.cooldown);
            const modV = validateBoolean(req.body.mod_only, false);
            if (!cdV.valid) return res.status(400).json({ error: cdV.error });
            if (!modV.valid) return res.status(400).json({ error: modV.error });
            const [[builtin]] = await pool.execute('SELECT command_key FROM tokes_global_command_config WHERE command_key = ?', [nameV.value]);
            if (builtin) return res.status(409).json({ error: 'That name is a built-in command' });
            try {
                const [result] = await pool.execute(
                    `INSERT INTO tokes_custom_commands (channel_id, command_name, response, cooldown, mod_only, created_by)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [o.id, nameV.value, respV.value, cdV.value, modV.value ? 1 : 0, createdBy(req)]
                );
                invalidateChannelCache(o.id);
                res.json({ success: true, commandId: result.insertId });
            } catch (e) {
                if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Command already exists' });
                throw e;
            }
        } catch (error) { fail(res, 'create command', error); }
    });

    router.put(`${base}/:channelId/custom/:cmdId`, guard, async (req, res) => {
        try {
            const o = await owned(req, res); if (!o) return;
            const [[existing]] = await pool.execute('SELECT id FROM tokes_custom_commands WHERE id = ? AND channel_id = ?', [req.params.cmdId, o.id]);
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
            invalidateChannelCache(o.id);
            res.json({ success: true });
        } catch (error) { fail(res, 'update command', error); }
    });

    router.delete(`${base}/:channelId/custom/:cmdId`, guard, async (req, res) => {
        try {
            const o = await owned(req, res); if (!o) return;
            const [result] = await pool.execute('DELETE FROM tokes_custom_commands WHERE id = ? AND channel_id = ?', [req.params.cmdId, o.id]);
            if (!result.affectedRows) return res.status(404).json({ error: 'Command not found' });
            invalidateChannelCache(o.id);
            res.json({ success: true });
        } catch (error) { fail(res, 'delete command', error); }
    });

    // ── auto-responders ──
    router.get(`${base}/:channelId/responders`, guard, async (req, res) => {
        try {
            const o = await owned(req, res); if (!o) return;
            const [rows] = await pool.execute(
                `SELECT id, trigger_text, match_type, response, cooldown, is_enabled, use_count
                 FROM tokes_auto_responders WHERE channel_id = ? ORDER BY id DESC`, [o.id]);
            res.json({ responders: rows });
        } catch (error) { fail(res, 'load auto-responders', error); }
    });

    router.post(`${base}/:channelId/responders`, guard, async (req, res) => {
        try {
            const o = await owned(req, res); if (!o) return;
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
                [o.id, trigger, matchType, respV.value, cdV.value, createdBy(req)]
            );
            clearAutoResponderCache(o.id);
            res.json({ success: true, id: result.insertId });
        } catch (error) { fail(res, 'create auto-responder', error); }
    });

    router.put(`${base}/:channelId/responders/:id`, guard, async (req, res) => {
        try {
            const o = await owned(req, res); if (!o) return;
            const [[existing]] = await pool.execute('SELECT id FROM tokes_auto_responders WHERE id = ? AND channel_id = ?', [req.params.id, o.id]);
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
            clearAutoResponderCache(o.id);
            res.json({ success: true });
        } catch (error) { fail(res, 'update auto-responder', error); }
    });

    router.delete(`${base}/:channelId/responders/:id`, guard, async (req, res) => {
        try {
            const o = await owned(req, res); if (!o) return;
            const [result] = await pool.execute('DELETE FROM tokes_auto_responders WHERE id = ? AND channel_id = ?', [req.params.id, o.id]);
            if (!result.affectedRows) return res.status(404).json({ error: 'Responder not found' });
            clearAutoResponderCache(o.id);
            res.json({ success: true });
        } catch (error) { fail(res, 'delete auto-responder', error); }
    });
}

export default { mountChannelCommandRoutes, commandsPageData, BUILTIN_COMMANDS_SQL };
