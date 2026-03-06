import express from 'express';
import pool from '../../../utils/db.js';
import { ensureAuth, ensureGuildPerms } from '../api.js';
import logger from '../../../utils/logger.js';
import { invalidateAutoTrackConfig, scanGuildForActiveStreamers } from '../../../events/presenceUpdate.js';

const router = express.Router();

// GET /api/guilds/:guildId/auto-track/configs
router.get('/:guildId/auto-track/configs', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT * FROM guild_streamer_auto_track WHERE guild_id = ? ORDER BY auto_id',
            [req.guildId]
        );
        res.json({ success: true, configs: rows });
    } catch (error) {
        logger.error('[API AutoTrack GET] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to fetch auto-track configs' });
    }
});

// POST /api/guilds/:guildId/auto-track/configs
router.post('/:guildId/auto-track/configs', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const { role_id, announcement_channel_id, live_role_id, delete_on_end, edit_on_end } = req.body;

        if (!announcement_channel_id) {
            return res.status(400).json({ error: 'announcement_channel_id is required' });
        }

        const roleId = role_id || null;
        const liveRoleId = live_role_id || null;
        const deleteOnEnd = delete_on_end !== undefined ? (delete_on_end ? 1 : 0) : 1;
        const editOnEnd = edit_on_end !== undefined ? (edit_on_end ? 1 : 0) : 0;

        // Application-layer enforcement: only one NULL-role row per guild
        if (!roleId) {
            const [existing] = await pool.execute(
                'SELECT auto_id FROM guild_streamer_auto_track WHERE guild_id = ? AND role_id IS NULL',
                [req.guildId]
            );
            if (existing.length > 0) {
                await pool.execute(
                    'UPDATE guild_streamer_auto_track SET announcement_channel_id = ?, live_role_id = ?, delete_on_end = ?, edit_on_end = ?, enabled = 1 WHERE guild_id = ? AND role_id IS NULL',
                    [announcement_channel_id, liveRoleId, deleteOnEnd, editOnEnd, req.guildId]
                );
                invalidateAutoTrackConfig(req.guildId);
                return res.json({ success: true, message: 'Updated existing "any member" mapping' });
            }
        }

        await pool.execute(`
            INSERT INTO guild_streamer_auto_track (guild_id, role_id, announcement_channel_id, live_role_id, delete_on_end, edit_on_end, enabled)
            VALUES (?, ?, ?, ?, ?, ?, 1)
            ON DUPLICATE KEY UPDATE
                announcement_channel_id = VALUES(announcement_channel_id), live_role_id = VALUES(live_role_id),
                delete_on_end = VALUES(delete_on_end), edit_on_end = VALUES(edit_on_end), enabled = 1
        `, [req.guildId, roleId, announcement_channel_id, liveRoleId, deleteOnEnd, editOnEnd]);

        invalidateAutoTrackConfig(req.guildId);

        // Scan for members already streaming right now
        const botClient = global.botManager?.getClientForGuild(req.guildId);
        if (botClient) {
            scanGuildForActiveStreamers(botClient, req.guildId).catch(() => {});
        }

        res.json({ success: true, message: 'Auto-track mapping added' });
    } catch (error) {
        logger.error('[API AutoTrack POST] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to add auto-track mapping' });
    }
});

// PATCH /api/guilds/:guildId/auto-track/configs/:autoId (edit settings)
router.patch('/:guildId/auto-track/configs/:autoId', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const { announcement_channel_id, role_id, live_role_id, delete_on_end, edit_on_end } = req.body;

        // Build dynamic SET clause from provided fields
        const updates = [];
        const params = [];

        if (announcement_channel_id !== undefined) {
            updates.push('announcement_channel_id = ?');
            params.push(announcement_channel_id);
        }
        if (role_id !== undefined) {
            updates.push('role_id = ?');
            params.push(role_id || null);
        }
        if (live_role_id !== undefined) {
            updates.push('live_role_id = ?');
            params.push(live_role_id || null);
        }
        if (delete_on_end !== undefined) {
            updates.push('delete_on_end = ?');
            params.push(delete_on_end ? 1 : 0);
        }
        if (edit_on_end !== undefined) {
            updates.push('edit_on_end = ?');
            params.push(edit_on_end ? 1 : 0);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        params.push(req.params.autoId, req.guildId);
        const [result] = await pool.execute(
            `UPDATE guild_streamer_auto_track SET ${updates.join(', ')} WHERE auto_id = ? AND guild_id = ?`,
            params
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Mapping not found' });
        }

        invalidateAutoTrackConfig(req.guildId);
        res.json({ success: true, message: 'Auto-track mapping updated' });
    } catch (error) {
        logger.error('[API AutoTrack PATCH Edit] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to update auto-track mapping' });
    }
});

// DELETE /api/guilds/:guildId/auto-track/configs/:autoId
router.delete('/:guildId/auto-track/configs/:autoId', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const [result] = await pool.execute(
            'DELETE FROM guild_streamer_auto_track WHERE auto_id = ? AND guild_id = ?',
            [req.params.autoId, req.guildId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Mapping not found' });
        }

        invalidateAutoTrackConfig(req.guildId);
        res.json({ success: true, message: 'Auto-track mapping removed' });
    } catch (error) {
        logger.error('[API AutoTrack DELETE] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to remove auto-track mapping' });
    }
});

// PATCH /api/guilds/:guildId/auto-track/configs/:autoId/toggle
router.patch('/:guildId/auto-track/configs/:autoId/toggle', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const [result] = await pool.execute(
            'UPDATE guild_streamer_auto_track SET enabled = NOT enabled WHERE auto_id = ? AND guild_id = ?',
            [req.params.autoId, req.guildId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Mapping not found' });
        }

        invalidateAutoTrackConfig(req.guildId);

        // If toggled ON, scan for currently streaming members
        const [check] = await pool.execute(
            'SELECT enabled FROM guild_streamer_auto_track WHERE auto_id = ? AND guild_id = ?',
            [req.params.autoId, req.guildId]
        );
        if (check.length > 0 && check[0].enabled) {
            const botClient = global.botManager?.getClientForGuild(req.guildId);
            if (botClient) {
                scanGuildForActiveStreamers(botClient, req.guildId).catch(() => {});
            }
        }

        res.json({ success: true, message: 'Auto-track mapping toggled' });
    } catch (error) {
        logger.error('[API AutoTrack PATCH] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to toggle auto-track mapping' });
    }
});

export default router;
