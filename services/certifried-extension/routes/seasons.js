/**
 * Season routes (H-408)
 *   GET /seasons          running season with live standings, the last ended
 *                         season with its final standings, and the season list
 *   GET /seasons/:id      one season: final standings when ended, live when running
 */

import { Router } from 'express';
import logger from '../../../utils/logger.js';
import {
    getActiveSeason, getLastEndedSeason, getSeason, listSeasons, getLiveStandings, getFinalStandings
} from '../game/season-system.js';

const router = Router();

const clampLimit = (v, d) => Math.max(1, Math.min(100, parseInt(v, 10) || d));

router.get('/', async (req, res) => {
    try {
        const limit = clampLimit(req.query.limit, 25);
        const current = await getActiveSeason();
        const last = await getLastEndedSeason();
        const live = current ? await getLiveStandings(current.id, { limit, playerId: req.player.id }) : null;
        res.json({
            success: true,
            current: current ? { ...current, standings: live.standings, me: live.me, totalRanked: live.totalRanked } : null,
            last: last ? { ...last, standings: await getFinalStandings(last.id, { limit, playerId: req.player.id }) } : null,
            seasons: await listSeasons()
        });
    } catch (error) {
        logger.error('[Seasons] Load failed', { error: error.message });
        res.status(500).json({ error: 'Failed to load seasons', code: 'ERROR' });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Invalid season', code: 'INVALID' });
        const season = await getSeason(id);
        if (!season) return res.status(404).json({ error: 'Season not found', code: 'NOT_FOUND' });
        const limit = clampLimit(req.query.limit, 50);
        if (season.status === 'active') {
            const live = await getLiveStandings(id, { limit, playerId: req.player.id });
            return res.json({ success: true, season, final: false, standings: live.standings, me: live.me });
        }
        res.json({ success: true, season, final: season.status === 'ended', standings: await getFinalStandings(id, { limit, playerId: req.player.id }) });
    } catch (error) {
        logger.error('[Seasons] Load season failed', { error: error.message });
        res.status(500).json({ error: 'Failed to load season', code: 'ERROR' });
    }
});

export default router;
