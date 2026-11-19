/**
 * User resolve API — `GET /api/guilds/:guildId/users/resolve?ids=1,2,3`
 *
 * Names for ids a dashboard page only has as ids (dashboard/public/js/cf-user.js batches every
 * id on a page into one call per ~100). Answers
 *   { users: { [id]: { id, username, displayName, avatar, inServer, left? } },
 *     pending?: [id], retryAfterMs? }
 * built by core/user-display.js, the same shape the feature APIs put in their own `user` fields.
 *
 * Lookup order: the member cache; ONE batched gateway member request (guild.members.fetch with a
 * list of ids and a short time limit) for ids missing from it; the client's user cache; then, for
 * ids still nameless (people who left), a Discord user lookup through core/user-lookup.js (the
 * guild's own bot client's REST, cached ~24 h, globally rate-capped, at most 50 new lookups per
 * request). Lookups that have not finished within LOOKUP_WAIT_MS come back in `pending` and the
 * page asks again after `retryAfterMs`; the page never waits for Discord to show the id.
 * `left: true` marks a named user the member fetch confirmed is not in the server (the page shows
 * a "left" marker); it is omitted when that fetch did not complete.
 *
 * Gated by `apiCheckGuildAdmin` at the parent router, like every guild route.
 */

import express from 'express';
import logger from '../../../../utils/logger.js';
import { parseIdList, resolveMany, MAX_RESOLVE } from '../../../../core/user-display.js';
import { userLookup, applyLookups, isNamed, LOOKUP_DEFAULTS } from '../../../../core/user-lookup.js';

const router = express.Router({ mergeParams: true });
const FETCH_MS = 3000;
const LOOKUP_WAIT_MS = 1200;

router.get('/resolve', async (req, res) => {
    const { ids, tooMany } = parseIdList(req.query.ids);
    if (tooMany) return res.status(400).json({ error: `At most ${MAX_RESOLVE} ids per request.` });
    if (!ids.length) return res.json({ users: {} });
    const guild = req.guildObject;
    if (!guild) return res.status(503).json({ error: 'The bot is not connected to this server right now.' });

    const missing = ids.filter((id) => !guild.members.cache.has(id));
    let membersKnown = true;   // false when the member fetch failed: "not in the cache" then proves nothing
    if (missing.length) {
        try {
            // One gateway request for every uncached id; ids that are not members are simply absent.
            await guild.members.fetch({ user: missing, time: FETCH_MS });
        } catch (err) {
            membersKnown = false;
            // Timeouts and "not a member" are expected; the cache answer below is still right.
            logger.debug(`[UserResolve] member fetch for ${missing.length} id(s) in ${guild.id}: ${err.code || err.message}`);
        }
    }
    const users = resolveMany(guild, ids);

    // People who left: ask Discord (cached, rate-capped) through the guild's own bot client.
    const nameless = ids.filter((id) => !isNamed(users[id]));
    let found = {};
    let pending = [];
    let retryAfterMs = 0;
    if (nameless.length) {
        const client = guild.client || req.botClient || req.app?.locals?.client || null;
        try {
            ({ found, pending, retryAfterMs } = await userLookup.request(client, nameless, { max: LOOKUP_DEFAULTS.perRequest, waitMs: LOOKUP_WAIT_MS }));
        } catch (err) {
            logger.debug(`[UserResolve] user lookup in ${guild.id}: ${err.message}`);
        }
    }
    applyLookups(users, found, { membersKnown });

    // A pending answer must not be cached by the browser: the next poll has to reach us.
    res.set('Cache-Control', pending.length ? 'no-store' : 'private, max-age=60');
    res.json(pending.length ? { users, pending, retryAfterMs } : { users });
});

export default router;
