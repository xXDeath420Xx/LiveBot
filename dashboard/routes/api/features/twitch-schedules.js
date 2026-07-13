/**
 * Twitch Schedule Sync API
 *
 * Mounted at /api/guilds/:guildId/twitch-schedules
 *
 * Endpoints:
 *   GET    /                  — list all syncs for the guild
 *   POST   /sync              — create a new sync
 *   PATCH  /:id               — update any mutable field on a sync
 *   POST   /delete            — delete a sync (body: { syncId }) — matches existing view JS
 *   POST   /:id/force-sync    — manually trigger a sync, ignoring interval/cooldown
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import { getTwitchScheduleManager } from '../../../../jobs/twitch-schedule-scheduler.js';

const router = express.Router({ mergeParams: true });

const MIN_INTERVAL = 15;
const MAX_INTERVAL = 10080; // 1 week in minutes

function normalizeInterval(value, fallback = 360) {
    const n = parseInt(value, 10);
    if (Number.isFinite(n)) return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, n));
    return fallback;
}

/**
 * GET /api/guilds/:guildId/twitch-schedules
 * List all schedule syncs for the guild.
 */
router.get('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const [rows] = await pool.execute(`
            SELECT
                tss.id, tss.guild_id, tss.streamer_id, tss.discord_channel_id,
                tss.is_enabled, tss.sync_interval_minutes, tss.weekly_refresh,
                tss.last_weekly_refresh, tss.mention_role_id, tss.custom_message,
                tss.last_synced, tss.schedule_hash, tss.last_message_id, tss.view_mode,
                s.username, s.profile_image_url, s.platform
            FROM twitch_schedule_sync_config tss
            JOIN streamers s ON tss.streamer_id = s.streamer_id
            WHERE tss.guild_id = ?
            ORDER BY tss.id DESC
        `, [guildId]);

        res.json({ success: true, syncs: rows });
    } catch (error) {
        logger.error('[API TwitchSchedules GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch schedule syncs' });
    }
});

/**
 * POST /api/guilds/:guildId/twitch-schedules/sync
 * Create a new sync.
 */
router.post('/sync', async (req, res) => {
    try {
        const { guildId } = req.params;
        const {
            streamerId,
            channelId,
            syncIntervalMinutes,
            weeklyRefresh,
            mentionRoleId,
            customMessage
        } = req.body;

        if (!streamerId || !channelId) {
            return res.status(400).json({ error: 'streamerId and channelId are required' });
        }

        // Verify the streamer exists and is a Twitch streamer
        const [[streamer]] = await pool.execute(
            'SELECT streamer_id, platform FROM streamers WHERE streamer_id = ?',
            [streamerId]
        );
        if (!streamer) return res.status(404).json({ error: 'Streamer not found' });
        if (streamer.platform !== 'twitch') {
            return res.status(400).json({ error: 'Streamer must be on Twitch' });
        }

        // Upsert — one sync per (guild, streamer, channel) combo
        const [result] = await pool.execute(`
            INSERT INTO twitch_schedule_sync_config
                (guild_id, streamer_id, discord_channel_id, is_enabled,
                 sync_interval_minutes, weekly_refresh, mention_role_id, custom_message)
            VALUES (?, ?, ?, 1, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                is_enabled = 1,
                sync_interval_minutes = VALUES(sync_interval_minutes),
                weekly_refresh = VALUES(weekly_refresh),
                mention_role_id = VALUES(mention_role_id),
                custom_message = VALUES(custom_message)
        `, [
            guildId,
            streamerId,
            channelId,
            normalizeInterval(syncIntervalMinutes),
            weeklyRefresh ? 1 : 0,
            mentionRoleId || null,
            customMessage || null
        ]);

        res.json({ success: true, id: result.insertId });
    } catch (error) {
        logger.error('[API TwitchSchedules POST /sync] Error:', error);
        res.status(500).json({ error: 'Failed to create schedule sync' });
    }
});

/**
 * PATCH /api/guilds/:guildId/twitch-schedules/:id
 * Update a sync. Accepts any subset of mutable fields.
 */
router.patch('/:id', async (req, res) => {
    try {
        const { guildId, id } = req.params;
        const {
            isEnabled,
            syncIntervalMinutes,
            weeklyRefresh,
            mentionRoleId,
            customMessage,
            channelId,
            viewMode
        } = req.body;

        // Verify the sync belongs to this guild
        const [[existing]] = await pool.execute(
            'SELECT id FROM twitch_schedule_sync_config WHERE id = ? AND guild_id = ?',
            [id, guildId]
        );
        if (!existing) return res.status(404).json({ error: 'Schedule sync not found' });

        const sets = [];
        const params = [];
        if (isEnabled !== undefined) { sets.push('is_enabled = ?'); params.push(isEnabled ? 1 : 0); }
        if (syncIntervalMinutes !== undefined) {
            sets.push('sync_interval_minutes = ?');
            params.push(normalizeInterval(syncIntervalMinutes));
        }
        if (weeklyRefresh !== undefined) {
            sets.push('weekly_refresh = ?');
            params.push(weeklyRefresh ? 1 : 0);
            // When enabling weekly_refresh fresh, reset the timestamp so it fires soon
            if (weeklyRefresh) {
                sets.push('last_weekly_refresh = NULL');
            }
        }
        if (mentionRoleId !== undefined) { sets.push('mention_role_id = ?'); params.push(mentionRoleId || null); }
        if (customMessage !== undefined) { sets.push('custom_message = ?'); params.push(customMessage || null); }
        if (channelId !== undefined) { sets.push('discord_channel_id = ?'); params.push(channelId); }
        if (viewMode !== undefined) {
            const v = viewMode === 'weekly' ? 'weekly' : 'monthly';
            sets.push('view_mode = ?');
            params.push(v);
        }

        if (sets.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        params.push(id);
        await pool.execute(
            `UPDATE twitch_schedule_sync_config SET ${sets.join(', ')} WHERE id = ?`,
            params
        );

        res.json({ success: true });
    } catch (error) {
        logger.error('[API TwitchSchedules PATCH] Error:', error);
        res.status(500).json({ error: 'Failed to update schedule sync' });
    }
});

/**
 * POST /api/guilds/:guildId/twitch-schedules/delete
 * Delete a sync — body shape matches existing view JS.
 */
router.post('/delete', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { syncId } = req.body;

        if (!syncId) return res.status(400).json({ error: 'syncId is required' });

        const [result] = await pool.execute(
            'DELETE FROM twitch_schedule_sync_config WHERE id = ? AND guild_id = ?',
            [syncId, guildId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Schedule sync not found' });
        }

        res.json({ success: true });
    } catch (error) {
        logger.error('[API TwitchSchedules POST /delete] Error:', error);
        res.status(500).json({ error: 'Failed to delete schedule sync' });
    }
});

/**
 * POST /api/guilds/:guildId/twitch-schedules/:id/force-sync
 * Manually trigger a sync, ignoring the per-config interval and change cooldown.
 */
router.post('/:id/force-sync', async (req, res) => {
    try {
        const { guildId, id } = req.params;

        const [[sync]] = await pool.execute(`
            SELECT
                tss.id, tss.guild_id, tss.streamer_id, tss.discord_channel_id,
                tss.mention_role_id, tss.custom_message, tss.last_synced,
                tss.schedule_hash, tss.last_message_id, tss.change_detected_at,
                tss.sync_interval_minutes, tss.weekly_refresh, tss.last_weekly_refresh,
                tss.view_mode,
                s.platform_user_id, s.username, s.profile_image_url
            FROM twitch_schedule_sync_config tss
            JOIN streamers s ON tss.streamer_id = s.streamer_id
            WHERE tss.id = ? AND tss.guild_id = ?
        `, [id, guildId]);

        if (!sync) return res.status(404).json({ error: 'Schedule sync not found' });

        const manager = getTwitchScheduleManager(guildId);
        if (!manager) {
            return res.status(503).json({ error: 'Schedule manager not available' });
        }

        // Clear change_detected_at so the sync doesn't wait for the 10-min cooldown
        await pool.execute(
            'UPDATE twitch_schedule_sync_config SET change_detected_at = NULL WHERE id = ?',
            [id]
        );
        sync.change_detected_at = null;

        // Fire and forget — don't block the response on Twitch API latency
        manager.syncSchedule(sync, { skipCooldown: true }).catch(err => {
            logger.error('[API TwitchSchedules force-sync] Background error:', {
                error: err.message,
                syncId: id
            });
        });

        res.json({ success: true, message: 'Sync triggered' });
    } catch (error) {
        logger.error('[API TwitchSchedules POST /force-sync] Error:', error);
        res.status(500).json({ error: 'Failed to trigger sync' });
    }
});

export default router;
