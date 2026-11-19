import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import crypto from 'node:crypto';

const router = express.Router({ mergeParams: true });

/** A text or announcement channel of this server, or null. */
function throneTextChannel(req, id) {
    if (!/^\d{15,25}$/.test(String(id || ''))) return null;
    const guild = req.guildObject || global.botManager?.getClientForGuild?.(req.params.guildId)?.guilds.cache.get(req.params.guildId);
    const ch = guild?.channels?.cache?.get(String(id));
    return ch && [0, 5].includes(ch.type) ? ch : null;
}

const THRONE_BOOL_SETTINGS = ['notify_item_added', 'notify_item_removed', 'notify_gift_received',
    'notify_contribution', 'notify_price_change', 'notify_milestone', 'notify_gift_thankyou',
    'auto_embed_links', 'birthday_reminder', 'monthly_spotlight', 'wishlist_role_enabled'];
const THRONE_CHANNEL_SETTINGS = ['notification_channel_id', 'birthday_channel_id', 'spotlight_channel_id'];
const THRONE_RANGE_SETTINGS = { birthday_reminder_days: [1, 14, 3], price_change_threshold: [1, 50, 10] };

/**
 * GET /api/guilds/:guildId/throne/notifications
 */
router.get('/notifications', async (req, res) => {
    try {
        const { guildId } = req.params;
        const [rows] = await pool.execute(
            'SELECT * FROM throne_notifications WHERE guild_id = ? ORDER BY added_at DESC',
            [guildId]
        );
        res.json({ success: true, notifications: rows });
    } catch (error) {
        logger.error('[API Throne] Get notifications error:', error);
        res.status(500).json({ error: 'Failed to fetch throne notifications' });
    }
});

/**
 * POST /api/guilds/:guildId/throne/notifications
 */
router.post('/notifications', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { throne_username, channel_id, notify_new_items, notify_gifts, notify_contributions } = req.body;

        if (!throne_username || !channel_id) {
            return res.status(400).json({ error: 'Throne username and channel are required' });
        }
        if (!/^[A-Za-z0-9_.-]{1,100}$/.test(String(throne_username).trim())) {
            return res.status(400).json({ error: 'That does not look like a Throne username.' });
        }
        if (!throneTextChannel(req, channel_id)) {
            return res.status(400).json({ error: 'Pick a text channel in this server.' });
        }

        await pool.execute(
            `INSERT INTO throne_notifications (guild_id, throne_username, channel_id, notify_new_items, notify_gifts, notify_contributions, added_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), notify_new_items = VALUES(notify_new_items), notify_gifts = VALUES(notify_gifts), notify_contributions = VALUES(notify_contributions)`,
            [guildId, throne_username.toLowerCase().trim(), channel_id, notify_new_items ? 1 : 0, notify_gifts ? 1 : 0, notify_contributions ? 1 : 0, req.user?.id || 'dashboard']
        );

        res.json({ success: true, message: 'Throne tracking added' });
    } catch (error) {
        logger.error('[API Throne] Add notification error:', error);
        res.status(500).json({ error: 'Failed to add throne tracking' });
    }
});

/**
 * DELETE /api/guilds/:guildId/throne/notifications/:username
 */
router.delete('/notifications/:username', async (req, res) => {
    try {
        const { guildId, username } = req.params;
        const [result] = await pool.execute(
            'DELETE FROM throne_notifications WHERE guild_id = ? AND throne_username = ?',
            [guildId, username.toLowerCase()]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Tracking not found' });
        }

        res.json({ success: true, message: 'Throne tracking removed' });
    } catch (error) {
        logger.error('[API Throne] Delete notification error:', error);
        res.status(500).json({ error: 'Failed to remove throne tracking' });
    }
});

/**
 * GET /api/guilds/:guildId/throne/featured
 */
router.get('/featured', async (req, res) => {
    try {
        const { guildId } = req.params;
        const [rows] = await pool.execute(
            'SELECT * FROM throne_guild_config WHERE guild_id = ?',
            [guildId]
        );
        res.json({ success: true, featured: rows[0] || null });
    } catch (error) {
        logger.error('[API Throne] Get featured error:', error);
        res.status(500).json({ error: 'Failed to fetch featured config' });
    }
});

/**
 * PUT /api/guilds/:guildId/throne/featured
 */
router.put('/featured', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { featured_username } = req.body;

        if (!featured_username) {
            // Clear featured
            await pool.execute('DELETE FROM throne_guild_config WHERE guild_id = ?', [guildId]);
            return res.json({ success: true, message: 'Featured wishlist cleared' });
        }

        await pool.execute(
            `INSERT INTO throne_guild_config (guild_id, featured_username, set_by)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE featured_username = VALUES(featured_username), set_by = VALUES(set_by), set_at = CURRENT_TIMESTAMP`,
            [guildId, featured_username.toLowerCase().trim(), req.user?.id || 'dashboard']
        );

        res.json({ success: true, message: 'Featured wishlist updated' });
    } catch (error) {
        logger.error('[API Throne] Update featured error:', error);
        res.status(500).json({ error: 'Failed to update featured config' });
    }
});

/**
 * GET /api/guilds/:guildId/throne/settings
 */
router.get('/settings', async (req, res) => {
    try {
        const { guildId } = req.params;
        const [rows] = await pool.execute(
            'SELECT * FROM throne_guild_settings WHERE guild_id = ?',
            [guildId]
        );
        res.json({ success: true, settings: rows[0] || null });
    } catch (error) {
        logger.error('[API Throne] Get settings error:', error);
        res.status(500).json({ error: 'Failed to fetch throne settings' });
    }
});

/**
 * PUT /api/guilds/:guildId/throne/settings
 */
router.put('/settings', async (req, res) => {
    try {
        const { guildId } = req.params;
        const fields = [
            'notify_item_added', 'notify_item_removed', 'notify_gift_received',
            'notify_contribution', 'notify_price_change', 'notify_milestone',
            'notify_gift_thankyou', 'auto_embed_links', 'birthday_reminder',
            'monthly_spotlight', 'wishlist_role_enabled', 'notification_channel_id',
            'birthday_channel_id', 'spotlight_channel_id', 'wishlist_role_id',
            'birthday_reminder_days', 'price_change_threshold'
        ];

        const updates = {};
        for (const field of fields) {
            if (req.body[field] === undefined) continue;
            const v = req.body[field];
            if (THRONE_BOOL_SETTINGS.includes(field)) {
                updates[field] = (v === true || v === 1 || v === '1' || v === 'true' || v === 'on') ? 1 : 0;
            } else if (THRONE_CHANNEL_SETTINGS.includes(field)) {
                if (v === null || v === '') { updates[field] = null; continue; }
                if (!throneTextChannel(req, v)) return res.status(400).json({ error: 'Pick a text channel in this server.' });
                updates[field] = String(v);
            } else if (THRONE_RANGE_SETTINGS[field]) {
                const [min, max, dflt] = THRONE_RANGE_SETTINGS[field];
                const n = parseInt(v, 10);
                updates[field] = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
            } else if (field === 'wishlist_role_id') {
                updates[field] = /^\d{15,25}$/.test(String(v || '')) ? String(v) : null;
            }
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'No settings provided' });
        }

        // The first saved setting creates the row, and once it exists its toggles replace every
        // tracked creator's own choices (core/throne-manager.js). Seed it with what those choices
        // already post, so changing one setting does not silence the others.
        const [haveRow] = await pool.execute('SELECT guild_id FROM throne_guild_settings WHERE guild_id = ?', [guildId]);
        if (!haveRow.length) {
            const [tracked] = await pool.execute(
                'SELECT MAX(notify_new_items) AS i, MAX(notify_gifts) AS g, MAX(notify_contributions) AS c, COUNT(*) AS n FROM throne_notifications WHERE guild_id = ?',
                [guildId]);
            const t = tracked[0] || {};
            const on = (x) => (Number(t.n) === 0 || Number(x) === 1) ? 1 : 0;
            await pool.execute(
                `INSERT IGNORE INTO throne_guild_settings (guild_id, notify_item_added, notify_gift_received, notify_contribution)
                 VALUES (?, ?, ?, ?)`,
                [guildId, on(t.i), on(t.g), on(t.c)]);
        }

        const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
        const values = Object.values(updates);

        await pool.execute(
            `INSERT INTO throne_guild_settings (guild_id, ${Object.keys(updates).join(', ')})
             VALUES (?, ${values.map(() => '?').join(', ')})
             ON DUPLICATE KEY UPDATE ${setClauses}`,
            [guildId, ...values, ...values]
        );

        res.json({ success: true, message: 'Throne settings updated' });
    } catch (error) {
        logger.error('[API Throne] Update settings error:', error);
        res.status(500).json({ error: 'Failed to update throne settings' });
    }
});

/**
 * GET /api/guilds/:guildId/throne/log
 */
router.get('/log', async (req, res) => {
    try {
        const { guildId } = req.params;
        const [rows] = await pool.execute(
            'SELECT * FROM throne_notification_log WHERE guild_id = ? ORDER BY created_at DESC LIMIT 50',
            [guildId]
        );
        res.json({ success: true, log: rows });
    } catch (error) {
        logger.error('[API Throne] Get log error:', error);
        res.status(500).json({ error: 'Failed to fetch notification log' });
    }
});



// ─── Throne webhook subscriptions (Phase 2 bot — Ed25519-signed events from Throne) ───
// Backed by throne_webhook_subscriptions + throne_webhook_events (migrations 337 + patches).
// The receiver route at /webhooks/throne/:token handles delivery + signature verification;
// these endpoints manage the per-guild subscription registry.

router.get('/webhooks', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT id, token, channel_id, throne_username, enabled, purpose,
                    created_at, last_event_at, event_count
               FROM throne_webhook_subscriptions
              WHERE guild_id = ?
              ORDER BY created_at DESC`,
            [req.guildObject.id]);
        res.json({ ok: true, subscriptions: rows });
    } catch (err) {
        logger.error('[API throne] list webhooks failed', { err: err.message });
        res.status(500).json({ error: 'Could not load webhook subscriptions.' });
    }
});

router.post('/webhooks', async (req, res) => {
    const channelId = String(req.body?.channel_id ?? '').trim();
    const throneUsername = String(req.body?.throne_username ?? '').trim().toLowerCase() || null;
    if (!/^[0-9]{17,20}$/.test(channelId)) {
        return res.status(400).json({ error: 'Pick a valid channel.' });
    }
    const ch = req.guildObject.channels.cache.get(channelId);
    if (!ch) return res.status(400).json({ error: 'No such channel in this server.' });
    try {
        const token = crypto.randomBytes(32).toString('hex');
        await pool.execute(
            `INSERT INTO throne_webhook_subscriptions
             (token, guild_id, channel_id, throne_username, purpose, enabled, created_by, notes)
             VALUES (?, ?, ?, ?, 'production', 1, ?, ?)`,
            [token, req.guildObject.id, channelId, throneUsername,
             req.user?.id || null, 'Created via dashboard']);
        res.json({
            ok: true,
            token,
            url: `https://certifriedmultitool.com/webhooks/throne/${token}`,
            instructions: 'Paste this URL into throne.com/profile/integrations/webhook as a subscriber URL, enable webhooks, then click Save settings.',
        });
    } catch (err) {
        logger.error('[API throne] create webhook failed', { err: err.message });
        res.status(500).json({ error: 'Could not create the webhook subscription.' });
    }
});

router.delete('/webhooks/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Bad id.' });
    try {
        const [r] = await pool.execute(
            `DELETE FROM throne_webhook_subscriptions WHERE id = ? AND guild_id = ?`,
            [id, req.guildObject.id]);
        res.json({ ok: true, removed: r.affectedRows > 0 });
    } catch (err) {
        logger.error('[API throne] delete webhook failed', { err: err.message });
        res.status(500).json({ error: 'Could not remove the subscription.' });
    }
});

export default router;

