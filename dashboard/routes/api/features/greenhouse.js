/**
 * Greenhouse Tycoon (the v2 game) — `/api/guilds/:guildId/greenhouse`
 *
 * Read-only overview for the manage page `?page=greenhouse` (the old `?page=cfx` is an alias of it):
 * which members of THIS server play with their Discord account, the running season (top of this
 * community, the global top 10, the weekly challenge) and the game link. The game itself is one world.
 * Mounted behind apiCheckGuildAdmin + botContext in routes/api/index.js.
 *
 * Data comes from services/cfx/integrations/bot.js (the game's own store on this pool), loaded lazily and
 * guarded: before migration 437 the answer is { ready: false } and the page says "not set up yet".
 *
 * Members, without fetching big member lists: the candidates are the Discord sign-ins that have a game
 * save (a small table), not the server's members. Ids already in the member cache count at once; the rest
 * are checked with guild.members.fetch({ user: [...] }) in batches of 100, at most MAX_FETCH_BATCHES per
 * request, and the result is cached per server for CACHE_MS. If a server has more candidate players than
 * that, the page says the list may be incomplete (`partial`).
 */
import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';

const CACHE_MS = 60_000;
const MAX_CANDIDATES = 5000;
const MAX_FETCH_BATCHES = 10;
const SNOWFLAKE = /^\d{17,20}$/;

/** Router factory (tests pass their own bridge, pool and table prefix). */
export function createGreenhouseRouter({ getBridge, db = pool, prefix = 'gh_', now = () => Date.now() } = {}) {
    const router = express.Router({ mergeParams: true });
    const memberCache = new Map(); // guildId -> { at, ids, partial, candidates }
    let metaMod = null;

    async function titles() {
        if (!metaMod) {
            const [m, c] = await Promise.all([
                import('../../../../services/cfx/domain/meta.js'),
                import('../../../../services/cfx/config/catalog.js')
            ]);
            metaMod = { questTitle: m.questTitle, questDef: c.questDef };
        }
        return metaMod;
    }

    async function membersWhoPlay(guild) {
        const hit = memberCache.get(guild.id);
        if (hit && now() - hit.at < CACHE_MS) return hit;
        // The Discord sign-ins that have a save, from the game module (services/cfx/integrations/bot.js).
        const bridge = await getBridge();
        const list = bridge ? await bridge.discordPlayerIds(MAX_CANDIDATES) : null;
        const candidates = (list?.ids || []).filter(id => SNOWFLAKE.test(id));
        const found = new Set(candidates.filter(id => guild.members?.cache?.has?.(id)));
        const missing = candidates.filter(id => !found.has(id));
        let batches = 0;
        let partial = false;
        for (let i = 0; i < missing.length; i += 100) {
            if (batches >= MAX_FETCH_BATCHES) { partial = true; break; }
            batches++;
            try {
                const fetched = await guild.members.fetch({ user: missing.slice(i, i + 100) });
                for (const id of fetched.keys()) found.add(String(id));
            } catch (err) {
                logger.debug(`[API greenhouse] member fetch failed: ${err.message}`);
                partial = true;
                break;
            }
        }
        const out = { at: now(), ids: [...found], partial, candidates: candidates.length };
        memberCache.set(guild.id, out);
        if (memberCache.size > 500) memberCache.delete(memberCache.keys().next().value);
        return out;
    }

    router.get('/', async (req, res) => {
        try {
            const bridge = await getBridge();
            if (!bridge || !(await bridge.ready())) return res.json({ ready: false });
            const guildId = req.params.guildId;
            const guild = req.botClient?.guilds?.cache?.get(guildId)
                || global.botManager?.getClientForGuild?.(guildId)?.guilds?.cache?.get(guildId) || null;
            const [summary, members] = await Promise.all([bridge.seasonSummary(), guild ? membersWhoPlay(guild) : null]);
            if (!summary.ready) return res.json({ ready: false });
            const community = members ? await bridge.communityPlayers(members.ids) : { players: [] };
            const { questTitle, questDef } = await titles();
            const t0 = now();
            const challenge = (summary.challenges || []).find(c => c.startsAtMs <= t0 && t0 < c.endsAtMs) || null;
            const nameFor = (id, fallback) => guild?.members?.cache?.get(id)?.displayName || fallback;
            res.json({
                ready: true,
                gameUrl: bridge.gameUrl,
                season: summary.season ? {
                    number: summary.season.number, status: summary.season.status,
                    startsAtMs: summary.season.startsAtMs, endsAtMs: summary.season.endsAtMs
                } : null,
                challenge: challenge ? {
                    week: challenge.week,
                    title: (() => { const d = questDef(challenge.code); return d ? questTitle(d.metric, challenge.target) : challenge.code; })(),
                    status: challenge.status, endsAtMs: challenge.endsAtMs,
                    activePlayers: challenge.activePlayers, minActivePlayers: challenge.minActivePlayers
                } : null,
                globalTop: (summary.top || []).map(r => ({ rank: r.rank, displayName: r.displayName, level: r.level, score: r.score })),
                players: (community.players || []).slice(0, 100).map(p => ({
                    displayName: nameFor(p.discordId, p.displayName), gameName: p.displayName, level: p.level, prestige: p.prestige,
                    seasonScore: p.seasonScore, communityRank: p.communityRank, lastSeenAtMs: p.lastSeenAtMs
                })),
                playersTotal: (community.players || []).length,
                partial: !!members?.partial,
                botInServer: !!guild
            });
        } catch (err) {
            logger.error(`[API greenhouse] overview failed: ${err.message}`);
            res.status(500).json({ error: 'Could not load the game overview' });
        }
    });

    return router;
}

// The production router: one bridge, created on first use (shared code with the /arcade greenhouse commands).
let bridgePromise = null;
function defaultBridge() {
    if (!bridgePromise) {
        bridgePromise = import('../../../../services/cfx/integrations/bot.js')
            .then(m => m.createGreenhouseBridge({ db: pool, logger }))
            .catch((err) => {
                logger.warn(`[API greenhouse] game bridge could not be loaded: ${err.message}`);
                bridgePromise = null;
                return null;
            });
    }
    return bridgePromise;
}

export default createGreenhouseRouter({ getBridge: defaultBridge });
