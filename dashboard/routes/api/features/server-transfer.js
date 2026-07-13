import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import { validateTransfer, startTransfer, abortTransfer, getActiveTransfer } from '../../../../core/server-transfer-manager.js';

const router = express.Router({ mergeParams: true });

/**
 * POST /api/guilds/:guildId/transfer
 * Validate or start a transfer
 * Body: { toBotId, confirmed?: boolean }
 */
router.post('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        let { toBotId, fromBotId, confirmed } = req.body;

        if (!toBotId) return res.status(400).json({ error: 'toBotId is required' });

        // Resolve 'default' to actual default bot ID
        const mgr = global.botManager;
        if (toBotId === 'default' && mgr) {
            const dc = mgr.getDefaultClient?.();
            if (dc) toBotId = dc.user.id;
            else return res.status(400).json({ error: 'Default bot not available' });
        }
        if (fromBotId === 'default' && mgr) {
            const dc = mgr.getDefaultClient?.();
            if (dc) fromBotId = dc.user.id;
        }

        // Validate first
        const validation = await validateTransfer(guildId, toBotId, fromBotId || null);
        if (!validation.valid) return res.status(400).json({ error: validation.error });

        // If not confirmed, return preview
        if (!confirmed) return res.json({ success: true, preview: true, ...validation });

        // Start transfer
        const result = await startTransfer(guildId, toBotId, req.user?.id || 'dashboard', fromBotId || null);
        if (result.error) return res.status(400).json({ error: result.error });

        res.json({ success: true, ...result });
    } catch (error) {
        logger.error('[API Transfer] Start error:', error);
        res.status(500).json({ error: 'Failed to start transfer' });
    }
});

/**
 * GET /api/guilds/:guildId/transfer/status
 */
router.get('/status', async (req, res) => {
    try {
        const { guildId } = req.params;

        // Check in-memory first (active transfer)
        const active = getActiveTransfer(guildId);
        if (active) return res.json({ success: true, active: true, ...active });

        // Check DB for completed/failed
        const [rows] = await pool.execute(
            'SELECT * FROM server_transfers WHERE guild_id = ? ORDER BY started_at DESC LIMIT 1',
            [guildId]
        );

        if (rows.length === 0) return res.json({ success: true, active: false, transfer: null });

        const transfer = rows[0];
        transfer.progress = transfer.progress ? JSON.parse(transfer.progress) : null;

        res.json({ success: true, active: false, transfer });
    } catch (error) {
        logger.error('[API Transfer] Status error:', error);
        res.status(500).json({ error: 'Failed to get transfer status' });
    }
});

/**
 * POST /api/guilds/:guildId/transfer/abort
 */
router.post('/abort', async (req, res) => {
    try {
        const { guildId } = req.params;
        const aborted = abortTransfer(guildId);
        res.json({ success: true, aborted });
    } catch (error) {
        logger.error('[API Transfer] Abort error:', error);
        res.status(500).json({ error: 'Failed to abort transfer' });
    }
});

export default router;
