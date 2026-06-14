import express from 'express';
import BuyMeACoffeeManager from '../../../../core/buymeacoffee-manager.js';
import logger from '../../../../utils/logger.js';

/**
 * User-scoped Buy Me a Coffee API.
 *
 * Every endpoint operates ONLY on req.user.id (the logged-in Discord user),
 * so a user can never touch another user's row. Gated by the global
 * `apiCheckAuth` (login required) applied in routes/api/index.js — NO
 * guild-admin gating, because this is a per-USER resource, not per-guild.
 *
 * Scope: LINK / UNLINK / STATUS only. Announce-channel selection stays on the
 * Discord `/buymeacoffee announce` command; we only SHOW current targets here.
 *
 * The manager's linkUser/unlinkUser/getUserStatus only need DB + an HTTP fetch
 * (no Discord client), so `new BuyMeACoffeeManager(null)` is safe.
 */
const router = express.Router();

// Manager with no Discord client — these methods never dereference this.client.
const bmc = new BuyMeACoffeeManager(null);

// GET / → current link status + read-only announce targets for the caller.
router.get('/', async (req, res) => {
    try {
        const status = await bmc.getUserStatus(req.user.id);
        res.json({
            linked: status.linked,
            accountId: status.accountId,
            targets: status.targets || [],
        });
    } catch (error) {
        logger.error('[API /me/buymeacoffee GET] Error', { userId: req.user.id, error: error.message });
        res.status(500).json({ error: 'Failed to load Buy Me a Coffee status.' });
    }
});

// POST /link { apiKey } → validate + store (encrypted) the caller's read-only key.
router.post('/link', async (req, res) => {
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
    if (!apiKey) {
        return res.status(400).json({ error: 'Provide your Buy Me a Coffee read-only API key.' });
    }
    try {
        const { accountId } = await bmc.linkUser(req.user.id, apiKey);
        res.json({ ok: true, accountId });
    } catch (error) {
        // linkUser throws a clear, user-facing Error on an invalid/unreachable key.
        res.status(400).json({ error: error.message || 'Could not link that API key.' });
    }
});

// DELETE /link → remove the caller's link AND all of their announce targets.
router.delete('/link', async (req, res) => {
    try {
        await bmc.unlinkUser(req.user.id);
        res.json({ ok: true });
    } catch (error) {
        logger.error('[API /me/buymeacoffee DELETE] Error', { userId: req.user.id, error: error.message });
        res.status(500).json({ error: 'Failed to unlink Buy Me a Coffee.' });
    }
});

export default router;
