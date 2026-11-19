/**
 * Super-admin music pages.
 *
 *   GET /super-admin/music-health              live state + history of the music chain
 *   GET /api/super-admin/music-health?range=   24h | 7d | 30d — everything that page draws
 *   GET /super-admin/music-activity            who played what, where, how it played and how it ended
 *   GET /api/super-admin/music-activity?range=&guild=&source=&outcome=&q=&before=
 *
 * Health: the monitor's snapshot (data/music-health.json, rewritten every tick by
 * core/music-health-monitor.js) and music_health_samples / _events (migration 255).
 * Activity: music_play_log (migration 256, core/music-play-log.js).
 * Super-admin only: they show the home resolvers, tunnels, versions and every server's listening.
 */
import express from 'express';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { checkAuth, checkSuperAdmin } from '../middleware/auth.js';
import { RANGES, componentOf, componentLabel, componentsFor, buildTimelines, uptimeByCheck, buildTrends, loadHistory }
    from '../services/music-health-history.js';
import { loadActivity } from '../services/music-activity.js';
import { livePlays } from '../../core/music-play-log.js';

const router = express.Router();
const SNAPSHOT_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'music-health.json');

router.get('/super-admin/music-health', checkAuth, checkSuperAdmin, (req, res) => {
    res.render('super-admin-music-health', { user: req.user });
});

router.get('/api/super-admin/music-health', checkAuth, checkSuperAdmin, async (req, res) => {
    const rangeKey = RANGES[req.query.range] ? req.query.range : '24h';
    try {
        let snapshot = null;
        try { snapshot = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8')); } catch { /* monitor not started yet */ }

        let history = null, historyError = null;
        try { history = await loadHistory(pool, rangeKey); }
        catch (e) { historyError = e.code === 'ER_NO_SUCH_TABLE' ? 'History tables are missing (migration 255).' : e.message; }

        const currentIds = Object.keys(snapshot?.checks || {});
        const pastIds = history ? history.samples.flatMap(s => `${s.down || ''},${s.failing || ''}`.split(',')).filter(Boolean) : [];
        const components = componentsFor([...currentIds, ...pastIds]);
        const window = history ? { from: history.from, to: history.to, buckets: history.range.buckets } : null;
        const timelines = history ? buildTimelines(history.samples, components, window) : {};
        const checkUptime = history ? uptimeByCheck(history.samples, currentIds) : {};

        res.set('Cache-Control', 'no-store').json({
            now: Date.now(),
            range: rangeKey,
            bucketMs: history ? (history.to - history.from) / history.range.buckets : null,
            from: history?.from ?? null,
            historySince: history?.historySince ?? null,
            historyError,
            snapshot,
            snapshotAgeSec: snapshot?.at ? Math.round((Date.now() - Date.parse(snapshot.at)) / 1000) : null,
            components: components.map(id => ({
                id, label: componentLabel(id),
                checks: currentIds.filter(c => componentOf(c) === id),
                uptime: timelines[id]?.uptime ?? null,
                buckets: timelines[id]?.buckets ?? [],
            })),
            checkUptime,
            trends: history ? buildTrends(history.metrics, window) : null,
            events: history?.events ?? [],
        });
    } catch (error) {
        logger.error('[MusicHealthPage] API error', { error: error.message });
        res.status(500).json({ error: 'Could not load music health' });
    }
});

router.get('/super-admin/music-activity', checkAuth, checkSuperAdmin, (req, res) => {
    res.render('super-admin-music-activity', { user: req.user });
});

router.get('/api/super-admin/music-activity', checkAuth, checkSuperAdmin, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store').json({ now: Date.now(), ...(await loadActivity(pool, req.query)) });
    } catch (error) {
        if (error.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'The play log table is missing (migration 256).' });
        logger.error('[MusicActivityPage] API error', { error: error.message });
        res.status(500).json({ error: 'Could not load music activity' });
    }
});

// What is playing right now, straight from the players (the page ticks the countdown locally between polls).
router.get('/api/super-admin/music-activity/live', checkAuth, checkSuperAdmin, (req, res) => {
    try {
        const now = Date.now();
        res.set('Cache-Control', 'no-store').json({ now, plays: livePlays(now) });
    } catch (error) {
        logger.error('[MusicActivityPage] live API error', { error: error.message });
        res.status(500).json({ error: 'Could not read what is playing' });
    }
});

export default router;
