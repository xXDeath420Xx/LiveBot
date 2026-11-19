// Greenhouse Tycoon (cfx v2): phase 4 routes - quests, achievements, the season and its leaderboards,
// notifications, Replant and decorations. All need a session; every POST needs an Idempotency-Key and,
// like the gameplay routes, answers { result, state }.
import { Router } from 'express';
import { v, intFromString } from '../../lib/validate.js';
import { gameError } from '../../lib/errors.js';
import { body, handler } from '../middleware.js';
import { QUESTS_CATALOG, ACHIEVEMENTS, DECORATIONS } from '../../config/catalog.js';
import { LEADERBOARD } from '../../config/game.js';

const PERIOD_KEY = /^(d\d{4}-\d{2}-\d{2}|w\d{4}-\d{2})$/;

export function metaRouter({ game }) {
    const r = Router();

    async function reply(req, res, result) {
        const state = await game.state(req.session.accountId);
        res.set('ETag', `"${state.etag}"`);
        res.json({ result, state });
    }
    const act = (fn) => handler(async (req, res) => reply(req, res, await fn(req)));

    // ---------------------------------------------------------------- reads

    r.get('/achievements', handler(async (req, res) => res.json(await game.achievements(req.session.accountId))));
    r.get('/season', handler(async (req, res) => res.json(await game.season(req.session.accountId))));

    // ?board=season|alltime&page=1..25[&season=<number>] (a closed season's final table)
    r.get('/leaderboard', handler(async (req, res) => {
        const board = req.query.board === undefined ? 'season' : req.query.board;
        if (board !== 'season' && board !== 'alltime') throw gameError('VALIDATION', { field: 'board', reason: 'must be season or alltime' });
        const page = req.query.page === undefined ? 1 : intFromString(req.query.page, { min: 1, max: LEADERBOARD.MAX_PAGES, field: 'page' });
        const seasonNumber = req.query.season === undefined ? null : intFromString(req.query.season, { min: 1, max: 100000, field: 'season' });
        if (seasonNumber && board !== 'season') throw gameError('VALIDATION', { field: 'season', reason: 'only for the season board' });
        res.json({ leaderboard: await game.leaderboard({ board, page, seasonNumber, accountId: req.session.accountId }) });
    }));

    // ?before=<id> pages back through older notifications.
    r.get('/notifications', handler(async (req, res) => {
        const before = req.query.before === undefined ? null : intFromString(req.query.before, { min: 1, max: Number.MAX_SAFE_INTEGER, field: 'before' });
        res.json(await game.notifications(req.session.accountId, { before }));
    }));

    // ---------------------------------------------------------------- actions

    r.post('/quests/claim', body({
        periodKey: v.str({ min: 8, max: 11, pattern: PERIOD_KEY }),
        code: v.oneOf(QUESTS_CATALOG.map(q => q.code))
    }), act(req => game.claimQuest(req.session.accountId, req.body)));

    r.post('/achievements/claim', body({ code: v.oneOf(ACHIEVEMENTS.map(a => a.code)) }), act(req =>
        game.claimAchievement(req.session.accountId, req.body)));

    r.post('/notifications/read', body({ upToId: v.optional(v.int({ min: 1, max: Number.MAX_SAFE_INTEGER })) }), act(req =>
        game.readNotifications(req.session.accountId, { upToId: req.body.upToId ?? null })));

    // prestige: the Replant count the player saw (0 for the first). Refused unless it matches.
    r.post('/replant', body({ prestige: v.int({ min: 0, max: 65534 }) }), act(req =>
        game.replant(req.session.accountId, req.body)));

    const decorationCode = () => v.oneOf(DECORATIONS.map(d => d.code));
    r.post('/decorations/buy', body({ code: decorationCode() }), act(req => game.buyDecoration(req.session.accountId, req.body)));
    r.post('/decorations/place', body({ code: decorationCode(), placed: v.bool() }), act(req =>
        game.placeDecoration(req.session.accountId, req.body)));

    return r;
}
