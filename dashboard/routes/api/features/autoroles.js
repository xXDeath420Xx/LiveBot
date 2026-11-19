/**
 * Autoroles API — `/api/guilds/:guildId/autoroles/*` (Utilities page, "Members who are already here").
 *
 * The settings themselves are saved by the page's form (POST /manage/:guildId/update-autoroles). This only
 * drives the background run that gives the autoroles to members who joined before they were set up
 * (core/autoroles.js startBackfill): status, start / resume, stop. Gated by apiCheckGuildAdmin upstream.
 */
import express from 'express';
import logger from '../../../../utils/logger.js';
import { getBackfillStatus, startBackfill, cancelBackfill, AutoroleError } from '../../../../core/autoroles.js';

const router = express.Router({ mergeParams: true });

/** The guild as the bot that runs it sees it (a custom bot when the server has one). */
function botGuild(guildId) {
    return global.botManager?.getClientForGuild?.(guildId)?.guilds?.cache?.get(guildId) || null;
}

// GET /backfill — where the last (or current) run is.
router.get('/backfill', async (req, res) => {
    try {
        res.json({ success: true, ...(await getBackfillStatus(req.params.guildId)) });
    } catch (error) {
        logger.error('[Autoroles API] status failed', { guildId: req.params.guildId, error: error.message });
        res.status(500).json({ success: false, error: 'Could not read the progress.' });
    }
});

// POST /backfill — start a run, or carry on with one a restart interrupted.
router.post('/backfill', async (req, res) => {
    const guildId = req.params.guildId;
    const guild = botGuild(guildId);
    if (!guild) return res.status(404).json({ success: false, error: 'The bot is not in this server, or is still starting.' });
    try {
        const status = await startBackfill(guild, { startedBy: req.user?.id ? String(req.user.id) : null });
        logger.info(`[Autoroles API] existing-member run started in ${guildId} by ${req.user?.id}`, { guildId });
        res.json({ success: true, ...status });
    } catch (error) {
        if (error instanceof AutoroleError) return res.status(400).json({ success: false, error: error.message });
        logger.error('[Autoroles API] start failed', { guildId, error: error.message });
        res.status(500).json({ success: false, error: 'Could not start. Try again in a moment.' });
    }
});

// POST /backfill/cancel — stop after the member it is on.
router.post('/backfill/cancel', async (req, res) => {
    const guildId = req.params.guildId;
    try {
        const stopped = await cancelBackfill(guildId);
        res.json({ success: true, stopped, ...(await getBackfillStatus(guildId)) });
    } catch (error) {
        logger.error('[Autoroles API] cancel failed', { guildId, error: error.message });
        res.status(500).json({ success: false, error: 'Could not stop it.' });
    }
});

export default router;
