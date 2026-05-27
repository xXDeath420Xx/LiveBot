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

export default router;
