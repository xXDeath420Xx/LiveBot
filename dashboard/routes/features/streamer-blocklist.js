/**
 * Blocked streamers (core/streamer-blocklist.js): the accounts this server never announces.
 *
 *   GET    /api/guilds/:guildId/streamer-blocklist          the list
 *   POST   /api/guilds/:guildId/streamer-blocklist          { platform, streamer, reason? }
 *   PATCH  /api/guilds/:guildId/streamer-blocklist/:id      { reason }
 *   DELETE /api/guilds/:guildId/streamer-blocklist/:id
 *
 * Page: partials/manage/streamer-blocklist.ejs (?page=streamer-blocklist).
 */
import express from 'express';
import { ensureAuth, ensureGuildPerms } from '../api.js';
import logger from '../../../utils/logger.js';
import {
    listBlockedStreamers, addBlockedStreamer, removeBlockedStreamer, updateBlockedStreamerReason, BlocklistError,
} from '../../../core/streamer-blocklist.js';
import { parseStreamerInput } from '../../../core/streamer-blocklist-logic.js';

const router = express.Router();
const base = '/:guildId/streamer-blocklist';

function fail(res, error, tag) {
    if (error instanceof BlocklistError) return res.status(error.status).json({ error: error.message });
    logger.error(`[API StreamerBlocklist ${tag}] Error:`, { error: error.message });
    return res.status(500).json({ error: 'Something went wrong' });
}

async function resolveTwitch(login) {
    const { getTwitchUser } = await import('../../../utils/platforms/twitch-api.js');
    const user = await getTwitchUser(login);
    if (user === false) throw new BlocklistError('Twitch did not answer. Try again in a minute.', 503);
    return user || null;
}

router.get(base, ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        res.json({ success: true, entries: await listBlockedStreamers(req.guildId) });
    } catch (error) { fail(res, error, 'GET'); }
});

router.post(base, ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const b = req.body || {};
        const platform = String(b.platform || 'twitch').toLowerCase();
        const login = parseStreamerInput(b.streamer, platform);
        if (!login) throw new BlocklistError('Enter a channel name or link');
        const entry = await addBlockedStreamer({
            guildId: req.guildId, platform, login,
            reason: typeof b.reason === 'string' ? b.reason.trim() : null,
            addedBy: req.user?.id || null,
            resolveTwitch,
        });
        logger.info(`[StreamerBlocklist] ${req.user?.id} blocked ${platform}/${entry.username} in ${req.guildId}`, { category: 'streams' });
        res.json({ success: true, entry, message: `${entry.display_name || entry.username} will not be announced here` });
    } catch (error) { fail(res, error, 'POST'); }
});

router.patch(`${base}/:id`, ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        await updateBlockedStreamerReason(req.guildId, req.params.id, typeof req.body?.reason === 'string' ? req.body.reason.trim() : null);
        res.json({ success: true, message: 'Saved' });
    } catch (error) { fail(res, error, 'PATCH'); }
});

router.delete(`${base}/:id`, ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        await removeBlockedStreamer(req.guildId, req.params.id);
        res.json({ success: true, message: 'Removed. Their streams can be announced again.' });
    } catch (error) { fail(res, error, 'DELETE'); }
});

export default router;
