/**
 * Invite Link Filter API
 *
 * Mounted at /api/guilds/:guildId/invite-filter
 *
 * Endpoints:
 *   GET    /                             — fetch config + all whitelist entries
 *   PATCH  /                             — update config (enabled, use_whitelist, action, log_channel_id)
 *   POST   /whitelist                    — add a whitelist entry (body: type, id, reason)
 *   DELETE /whitelist/:type/:id          — remove a whitelist entry
 */

import express from 'express';
import logger from '../../../../utils/logger.js';
import {
    getConfig,
    setConfig,
    addEntry,
    removeEntry,
    listEntries
} from '../../../../utils/link-whitelist.js';

const router = express.Router({ mergeParams: true });

const VALID_ACTIONS = new Set(['delete', 'delete_warn', 'log_only']);
const VALID_TYPES = new Set(['user', 'role', 'channel']);

/**
 * GET /api/guilds/:guildId/invite-filter
 */
router.get('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const [config, entries] = await Promise.all([
            getConfig(guildId),
            listEntries(guildId)
        ]);
        res.json({ success: true, config, entries });
    } catch (error) {
        logger.error('[API InviteFilter GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch invite filter config' });
    }
});

/**
 * PATCH /api/guilds/:guildId/invite-filter
 */
router.patch('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { enabled, use_whitelist, action, log_channel_id } = req.body;

        const patch = {};
        if (enabled !== undefined) patch.enabled = enabled ? 1 : 0;
        if (use_whitelist !== undefined) patch.use_whitelist = use_whitelist ? 1 : 0;
        if (action !== undefined) {
            if (!VALID_ACTIONS.has(action)) {
                return res.status(400).json({ error: `action must be one of: ${[...VALID_ACTIONS].join(', ')}` });
            }
            patch.action = action;
        }
        if (log_channel_id !== undefined) patch.log_channel_id = log_channel_id || null;

        if (Object.keys(patch).length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        const updated = await setConfig(guildId, patch);
        res.json({ success: true, config: updated });
    } catch (error) {
        logger.error('[API InviteFilter PATCH] Error:', error);
        res.status(500).json({ error: 'Failed to update invite filter config' });
    }
});

/**
 * POST /api/guilds/:guildId/invite-filter/whitelist
 */
router.post('/whitelist', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { type, id, reason } = req.body;

        if (!VALID_TYPES.has(type)) {
            return res.status(400).json({ error: `type must be one of: ${[...VALID_TYPES].join(', ')}` });
        }
        if (!id) {
            return res.status(400).json({ error: 'id is required' });
        }

        await addEntry(guildId, type, id, req.user?.id || null, reason || null);
        res.json({ success: true });
    } catch (error) {
        logger.error('[API InviteFilter POST /whitelist] Error:', error);
        res.status(500).json({ error: 'Failed to add whitelist entry' });
    }
});

/**
 * DELETE /api/guilds/:guildId/invite-filter/whitelist/:type/:id
 */
router.delete('/whitelist/:type/:id', async (req, res) => {
    try {
        const { guildId, type, id } = req.params;

        if (!VALID_TYPES.has(type)) {
            return res.status(400).json({ error: `type must be one of: ${[...VALID_TYPES].join(', ')}` });
        }

        await removeEntry(guildId, type, id);
        res.json({ success: true });
    } catch (error) {
        logger.error('[API InviteFilter DELETE /whitelist] Error:', error);
        res.status(500).json({ error: 'Failed to remove whitelist entry' });
    }
});

export default router;
