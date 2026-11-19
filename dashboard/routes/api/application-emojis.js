/**
 * Application-scope emoji administration. Not a per-guild resource — these
 * emojis belong to the Discord application itself, so this route is super-admin
 * only (`isSuperAdmin` on the session user).
 */
import express from 'express';
import logger from '../../../utils/logger.js';
import { isSuperAdmin } from '../../../utils/constants.js';
import * as appEmojis from '../../../core/application-emojis.js';
import { checkAuth } from '../../middleware/auth.js';

const router = express.Router();

function requireSuperAdmin(req, res, next) {
    if (!req.user || !isSuperAdmin(req.user.id)) {
        return res.status(403).json({ error: 'Super-admin only.' });
    }
    next();
}

router.use(checkAuth, requireSuperAdmin);

router.get('/', (req, res) => {
    const s = appEmojis.stats();
    res.json({
        count: s.count,
        loadedAt: s.loadedAt ? new Date(s.loadedAt).toISOString() : null,
        emojis: s.names.map(n => {
            const p = appEmojis.partial(n);
            return { name: n, id: p?.id ?? null, animated: !!p?.animated };
        }),
    });
});

router.post('/', express.json({ limit: '2mb' }), async (req, res) => {
    try {
        const { name, image } = req.body || {};
        if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'A name is required.' });
        if (typeof image !== 'string' || !image) return res.status(400).json({ error: 'An image (data URL or base64) is required.' });

        const client = req.botClient || req.app.locals.client;
        if (!client?.application) return res.status(503).json({ error: 'Default bot client not ready.' });

        const created = await appEmojis.upload(client, { name: name.trim().slice(0, 32), image });
        logger.info('[app-emoji] created', { name: created.name, id: created.id, by: req.user.id });
        res.json({ success: true, emoji: { id: created.id, name: created.name, animated: !!created.animated } });
    } catch (err) {
        logger.error('[app-emoji POST] failed', { err: err.message });
        res.status(500).json({ error: err?.message ?? 'Failed to create emoji' });
    }
});

router.delete('/:nameOrId', async (req, res) => {
    try {
        const client = req.botClient || req.app.locals.client;
        if (!client?.application) return res.status(503).json({ error: 'Default bot client not ready.' });
        const ok = await appEmojis.remove(client, req.params.nameOrId);
        if (!ok) return res.status(404).json({ error: 'No application emoji by that name or id.' });
        logger.info('[app-emoji] deleted', { nameOrId: req.params.nameOrId, by: req.user.id });
        res.json({ success: true });
    } catch (err) {
        logger.error('[app-emoji DELETE] failed', { err: err.message });
        res.status(500).json({ error: err?.message ?? 'Failed to delete emoji' });
    }
});

export default router;
