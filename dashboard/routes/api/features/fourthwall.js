import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import botManager from '../../../../core/bot-manager.js';

const router = express.Router({ mergeParams: true });

// Auth + guild access already enforced by apiCheckAuth + apiCheckGuildAdmin middleware
// mounted in api/index.js before this router.

/**
 * GET /api/guilds/:guildId/fourthwall/connections
 * List all Fourthwall shops connected to this guild.
 */
router.get('/connections', async (req, res) => {
    try {
        const { guildId } = req.params;
        const [rows] = await pool.execute(
            `SELECT id, shop_handle, shop_name, last_event_at, connected_at
             FROM fourthwall_connections
             WHERE guild_id = ?
             ORDER BY connected_at DESC`,
            [guildId]
        );
        res.json({ connections: rows });
    } catch (err) {
        logger.error('[FW API] list connections failed', { err: err.message });
        res.status(500).json({ error: 'internal error' });
    }
});

/**
 * POST /api/guilds/:guildId/fourthwall/connections
 * Connect a new Fourthwall shop to this guild.
 * Body: { handle, apiUser, apiPass, storefrontToken? }
 */
router.post('/connections', async (req, res) => {
    const { handle, apiUser, apiPass, storefrontToken } = req.body || {};
    if (!handle || !apiUser || !apiPass) {
        return res.status(400).json({ error: 'missing fields: handle, apiUser, apiPass required' });
    }
    if (!/^[a-z0-9-]{1,100}$/i.test(handle)) {
        return res.status(400).json({ error: 'invalid handle — alphanumeric and hyphens only' });
    }
    try {
        const { guildId } = req.params;
        const client = botManager.getClientForGuild(guildId);
        if (!client?.fourthwallManager) {
            return res.status(503).json({ error: 'manager not available for this guild' });
        }
        const result = await client.fourthwallManager.connectShop({
            guildId,
            shopHandle: handle,
            apiUser,
            apiPass,
            storefrontToken: storefrontToken || null,
            connectedBy: req.user?.id || 'dashboard'
        });
        res.json({ ok: true, ...result });
    } catch (err) {
        logger.error('[FW API] connect failed', { err: err.message });
        res.status(400).json({ error: err.message });
    }
});

/**
 * DELETE /api/guilds/:guildId/fourthwall/connections/:id
 * Disconnect a shop by its row ID.
 */
router.delete('/connections/:id', async (req, res) => {
    try {
        const { guildId, id } = req.params;
        const [rows] = await pool.execute(
            `SELECT shop_handle FROM fourthwall_connections WHERE id = ? AND guild_id = ?`,
            [id, guildId]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: 'connection not found' });
        }
        const client = botManager.getClientForGuild(guildId);
        if (!client?.fourthwallManager) {
            return res.status(503).json({ error: 'manager not available for this guild' });
        }
        const result = await client.fourthwallManager.disconnectShop({
            guildId,
            shopHandle: rows[0].shop_handle
        });
        res.json({ ok: true, ...result });
    } catch (err) {
        logger.error('[FW API] disconnect failed', { err: err.message });
        res.status(400).json({ error: err.message });
    }
});

/**
 * GET /api/guilds/:guildId/fourthwall/connections/:id/routing
 * Get per-category channel routing for a connection.
 */
router.get('/connections/:id/routing', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT event_category, channel_id, enabled
             FROM fourthwall_event_routing
             WHERE connection_id = ?`,
            [req.params.id]
        );
        res.json({ routing: rows });
    } catch (err) {
        logger.error('[FW API] get routing failed', { err: err.message });
        res.status(500).json({ error: 'internal error' });
    }
});

/**
 * PUT /api/guilds/:guildId/fourthwall/connections/:id/routing
 * Update per-category channel routing for a connection.
 * Body: { routing: [{ category, channelId, enabled }] }
 */
router.put('/connections/:id/routing', async (req, res) => {
    const updates = req.body.routing || [];
    if (!Array.isArray(updates)) {
        return res.status(400).json({ error: 'routing must be an array' });
    }
    try {
        const { guildId, id } = req.params;
        const client = botManager.getClientForGuild(guildId);
        if (!client?.fourthwallManager) {
            return res.status(503).json({ error: 'manager not available for this guild' });
        }
        for (const u of updates) {
            await client.fourthwallManager.setRouting({
                connectionId: Number(id),
                category: u.category,
                channelId: u.channelId || null,
                enabled: !!u.enabled
            });
        }
        res.json({ ok: true });
    } catch (err) {
        logger.error('[FW API] put routing failed', { err: err.message });
        res.status(400).json({ error: err.message });
    }
});

/**
 * GET /api/guilds/:guildId/fourthwall/config
 * Get guild-level Fourthwall config (privacy flags, default channel).
 */
router.get('/config', async (req, res) => {
    try {
        const { guildId } = req.params;
        const client = botManager.getClientForGuild(guildId);
        if (!client?.fourthwallManager) {
            return res.status(503).json({ error: 'manager not available for this guild' });
        }
        const cfg = await client.fourthwallManager.getGuildConfig(guildId);
        res.json({ config: cfg });
    } catch (err) {
        logger.error('[FW API] get config failed', { err: err.message });
        res.status(500).json({ error: 'internal error' });
    }
});

/**
 * PUT /api/guilds/:guildId/fourthwall/config
 * Update guild-level Fourthwall config.
 * Body: { show_customer_names?, show_amounts?, default_channel_id? }
 */
router.put('/config', async (req, res) => {
    try {
        const { guildId } = req.params;
        const client = botManager.getClientForGuild(guildId);
        if (!client?.fourthwallManager) {
            return res.status(503).json({ error: 'manager not available for this guild' });
        }
        await client.fourthwallManager.setGuildConfig(guildId, req.body || {});
        res.json({ ok: true });
    } catch (err) {
        logger.error('[FW API] put config failed', { err: err.message });
        res.status(400).json({ error: err.message });
    }
});



// ─── Shop-tracker subscriptions (v2 catalog tracker — migration 341) ─────────
// These manage the fourthwall_tracked_shops rows that drive the public-scraper-based
// catalog change notifications. Separate from the /connections endpoints above which
// manage merchant-authenticated webhook integrations (ptkn_).

const SHOP_HANDLE_RE = /^[a-z0-9-]{1,100}$/i;

router.get('/tracked', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT id, shop_handle, shop_name, channel_id,
                    notify_new_products, notify_price_drops, notify_price_increases,
                    notify_sold_out, notify_restocked,
                    notify_variant_added, notify_variant_restocked, notify_variant_low_stock,
                    notify_variant_sold_out, notify_name_changed, notify_image_changed,
                    notify_product_renamed, notify_on_sale,
                    added_at, last_checked_at, last_error, consecutive_failures
               FROM fourthwall_tracked_shops WHERE guild_id = ?
               ORDER BY added_at DESC`,
            [req.guildObject.id]);
        res.json({ ok: true, subscriptions: rows });
    } catch (err) {
        logger.error('[API fourthwall] list tracked failed', { err: err.message });
        res.status(500).json({ error: 'Could not load tracked shops.' });
    }
});

router.post('/tracked', async (req, res) => {
    const shopHandle = String(req.body?.shop_handle ?? '').trim().toLowerCase();
    const channelId = String(req.body?.channel_id ?? '').trim();
    if (!SHOP_HANDLE_RE.test(shopHandle)) return res.status(400).json({ error: 'Invalid shop handle.' });
    if (!/^[0-9]{17,20}$/.test(channelId)) return res.status(400).json({ error: 'Pick a valid channel.' });
    const ch = req.guildObject.channels.cache.get(channelId);
    if (!ch) return res.status(400).json({ error: 'No such channel in this server.' });
    try {
        await pool.execute(
            `INSERT INTO fourthwall_tracked_shops (guild_id, shop_handle, channel_id, added_by)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE added_by = VALUES(added_by)`,
            [req.guildObject.id, shopHandle, channelId, req.user?.id || null]);
        res.json({ ok: true });
    } catch (err) {
        logger.error('[API fourthwall] add tracked failed', { err: err.message });
        res.status(500).json({ error: 'Could not add the subscription.' });
    }
});

router.put('/tracked/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Bad id.' });
    const b = req.body || {};
    const BOOL_FIELDS = [
        'notify_new_products', 'notify_price_drops', 'notify_price_increases',
        'notify_sold_out', 'notify_restocked',
        'notify_variant_added', 'notify_variant_restocked', 'notify_variant_low_stock',
        'notify_variant_sold_out', 'notify_name_changed', 'notify_image_changed',
        'notify_product_renamed', 'notify_on_sale',
    ];
    const updates = [];
    const params = [];
    for (const f of BOOL_FIELDS) {
        if (f in b) { updates.push(`${f} = ?`); params.push(b[f] ? 1 : 0); }
    }
    if (b.channel_id && /^[0-9]{17,20}$/.test(String(b.channel_id)) && req.guildObject.channels.cache.has(String(b.channel_id))) {
        updates.push('channel_id = ?'); params.push(String(b.channel_id));
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update.' });
    params.push(id, req.guildObject.id);
    try {
        const [r] = await pool.execute(
            `UPDATE fourthwall_tracked_shops SET ${updates.join(', ')} WHERE id = ? AND guild_id = ?`,
            params);
        res.json({ ok: true, updated: r.affectedRows > 0 });
    } catch (err) {
        logger.error('[API fourthwall] update tracked failed', { err: err.message });
        res.status(500).json({ error: 'Could not update the subscription.' });
    }
});

router.delete('/tracked/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Bad id.' });
    try {
        const [r] = await pool.execute(
            `DELETE FROM fourthwall_tracked_shops WHERE id = ? AND guild_id = ?`,
            [id, req.guildObject.id]);
        res.json({ ok: true, removed: r.affectedRows > 0 });
    } catch (err) {
        logger.error('[API fourthwall] delete tracked failed', { err: err.message });
        res.status(500).json({ error: 'Could not remove.' });
    }
});

export default router;

