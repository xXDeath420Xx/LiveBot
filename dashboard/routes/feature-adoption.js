/**
 * Super-admin feature adoption page.
 *
 *   GET /super-admin/feature-adoption            every bot feature ranked by how many servers use it
 *   GET /api/super-admin/feature-adoption?range=  24h | 7d | 30d | 90d — the activity window
 *
 * Read live from the database on each request (dashboard/services/feature-adoption.js), with a
 * 30-second cache per range so a page left open and auto-refreshing does not re-run ~200 queries.
 * Super-admin only: it lists every server the bots are in.
 */
import express from 'express';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { checkAuth, checkSuperAdmin } from '../middleware/auth.js';
import { RANGES, loadAdoption } from '../services/feature-adoption.js';

const router = express.Router();
const CACHE_MS = 30_000;
const cache = new Map(); // range → { at, promise }

router.get('/super-admin/feature-adoption', checkAuth, checkSuperAdmin, (req, res) => {
    res.render('super-admin-feature-adoption', { user: req.user });
});

router.get('/api/super-admin/feature-adoption', checkAuth, checkSuperAdmin, async (req, res) => {
    const range = RANGES[req.query.range] ? req.query.range : '30d';
    try {
        let hit = cache.get(range);
        if (!hit || Date.now() - hit.at > CACHE_MS || req.query.fresh === '1') {
            hit = {
                at: Date.now(),
                promise: loadAdoption(pool, range, {
                    log: (sql, e) => logger.warn('[FeatureAdoption] query failed', { table: sql.match(/FROM `?(\w+)/)?.[1], error: e.message }),
                }),
            };
            cache.set(range, hit);
            hit.promise.catch(() => cache.delete(range));
        }
        res.set('Cache-Control', 'no-store').json(await hit.promise);
    } catch (error) {
        logger.error('[FeatureAdoption] API error', { error: error.message });
        res.status(500).json({ error: 'Could not load feature adoption' });
    }
});

export default router;
