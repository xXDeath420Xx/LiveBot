// Greenhouse Tycoon (cfx v2): gameplay routes. All need a session; every POST needs an Idempotency-Key and
// answers { result, state } so the client never waits for a poll. Everything acts on the session's
// account only: ids in bodies (orders, crosses) are looked up WHERE account_id = <session account>, so
// another account's id is simply NOT_FOUND.
import { Router } from 'express';
import { v, intFromString } from '../../lib/validate.js';
import { gameError } from '../../lib/errors.js';
import { body, handler } from '../middleware.js';
import { LIMITS, QUALITY_BANDS } from '../../config/game.js';
import { STAFF_TYPES, UPGRADE_NODES, BOOSTS } from '../../config/catalog.js';

const slot = () => v.int({ min: 1, max: LIMITS.MAX_PLOTS });
const varietyId = () => v.int({ min: 1, max: LIMITS.MAX_ITEM_ID });
const seq = () => v.optional(v.int({ min: 0, max: 2_147_483_647 }));
const quality = () => v.int({ min: 0, max: QUALITY_BANDS - 1 });
const rowId = () => v.int({ min: 1, max: Number.MAX_SAFE_INTEGER });
const ETAG = /^\d{1,16}\.\d{1,7}(\.\d{1,12})?$/;

export function gameRouter({ game }) {
    const r = Router();

    async function reply(req, res, result, status = 200) {
        const state = await game.state(req.session.accountId);
        res.set('ETag', `"${state.etag}"`);
        res.status(status).json({ result, state });
    }
    const act = (fn) => handler(async (req, res) => reply(req, res, await fn(req)));

    // ---------------------------------------------------------------- reads

    // Poll with ?v=<etag> (or If-None-Match): 304 and no body when nothing changed. The version comes with
    // the session check, so a 304 costs no query beyond authentication.
    r.get('/state', handler(async (req, res) => {
        const v = req.query.v;
        if (v !== undefined && (typeof v !== 'string' || !ETAG.test(v))) throw gameError('VALIDATION', { field: 'v', reason: 'must be the etag from the last state' });
        const inm = typeof req.get('if-none-match') === 'string' ? req.get('if-none-match').replace(/^W\//, '').replace(/"/g, '') : null;
        const current = game.etagFor(req.session.stateVersion, await game.metaVersion());
        if (v === current || inm === current) {
            res.set('ETag', `"${current}"`);
            return res.status(304).end();
        }
        const state = await game.state(req.session.accountId);
        res.set('ETag', `"${state.etag}"`);
        res.json({ state });
    }));

    r.get('/shop', handler(async (req, res) => res.json({ shop: await game.shop(req.session.accountId) })));
    r.get('/varieties', handler(async (req, res) => res.json(await game.varieties(req.session.accountId))));
    r.get('/stats', handler(async (req, res) => res.json({ stats: await game.stats(req.session.accountId) })));
    r.get('/market', handler(async (req, res) => {
        const days = req.query.days === undefined ? 7 : intFromString(req.query.days, { min: 1, max: 30, field: 'days' });
        res.json({ market: await game.marketHistory(req.session.accountId, { days }) });
    }));

    // ---------------------------------------------------------------- plots

    r.post('/plots/plant', body({ slot: slot(), varietyId: varietyId() }), act(req =>
        game.plant(req.session.accountId, { ...req.body, key: req.idempotencyKey })));
    r.post('/plots/water', body({ slot: slot(), plantSeq: seq() }), act(req =>
        game.water(req.session.accountId, req.body)));
    r.post('/plots/harvest', body({ slot: slot(), plantSeq: seq() }), act(req =>
        game.harvest(req.session.accountId, req.body)));
    r.post('/plots/harvest-all', body({}), act(req =>
        game.harvestAll(req.session.accountId)));
    r.post('/plots/remove', body({ slot: slot(), plantSeq: seq() }), act(req =>
        game.removePlant(req.session.accountId, req.body)));
    r.post('/plots/boost', body({ slot: slot(), boostId: v.oneOf(BOOSTS.map(b => b.id)), plantSeq: seq() }), act(req =>
        game.useBoost(req.session.accountId, req.body)));

    // ---------------------------------------------------------------- selling and the shop

    r.post('/sell', body({
        lines: v.array(v.object({ varietyId: varietyId(), quality: quality(), quantity: v.quantity({ max: LIMITS.MAX_ITEM_DELTA }) }), { min: 1, max: LIMITS.MAX_LINES_PER_OP })
    }), act(req => game.sell(req.session.accountId, { lines: req.body.lines, key: req.idempotencyKey })));

    r.post('/shop/buy', body({
        kind: v.oneOf(['seed', 'boost']),
        itemId: varietyId(),
        quantity: v.quantity({ max: 1000 })
    }), act(req => game.buy(req.session.accountId, { ...req.body, key: req.idempotencyKey })));

    // Plot expansion is the Extra bench upgrade (one plot per level); this is the shop's door to it.
    r.post('/shop/plot', body({ level: v.optional(v.int({ min: 1, max: 1000 })) }), act(req =>
        game.buyUpgrade(req.session.accountId, { code: 'extra_bench', level: req.body.level })));

    // ---------------------------------------------------------------- upgrades and staff

    r.post('/upgrades/buy', body({ code: v.oneOf(UPGRADE_NODES.map(n => n.code)), level: v.optional(v.int({ min: 1, max: 1000 })) }), act(req =>
        game.buyUpgrade(req.session.accountId, req.body)));

    const staffCode = () => v.oneOf(STAFF_TYPES.map(s => s.code));
    r.post('/staff/hire', body({ code: staffCode(), count: v.optional(v.int({ min: 1, max: 1000 })) }), act(req =>
        game.hireStaff(req.session.accountId, { ...req.body, key: req.idempotencyKey })));
    r.post('/staff/fire', body({ code: staffCode(), count: v.optional(v.int({ min: 0, max: 1000 })) }), act(req =>
        game.fireStaff(req.session.accountId, req.body)));
    r.post('/staff/claim', body({}), act(req => game.claimStaff(req.session.accountId)));

    // ---------------------------------------------------------------- breeding

    r.post('/breeding/start', body({ parentA: varietyId(), parentB: varietyId() }), act(req =>
        game.startBreeding(req.session.accountId, { ...req.body, key: req.idempotencyKey })));
    r.post('/breeding/claim', body({ breedingId: rowId() }), act(req =>
        game.claimBreeding(req.session.accountId, req.body)));

    // ---------------------------------------------------------------- orders and the daily reward

    r.post('/orders/fill', body({ orderId: rowId() }), act(req => game.fillOrder(req.session.accountId, req.body)));
    r.post('/orders/decline', body({ orderId: rowId() }), act(req => game.declineOrder(req.session.accountId, req.body)));
    r.post('/daily', body({}), act(req => game.claimDaily(req.session.accountId, { identityId: req.session.identityId })));

    return r;
}
