// Greenhouse Tycoon (cfx v2): the bridge the Discord bot and the dashboard use (phase 4).
//
// Design: the bot and the dashboard call the game's own store and game modules directly on their shared
// database pool, not the game's HTTP API. So:
//   - the bot does not depend on the game's pm2 app being up: /arcade greenhouse daily works while the
//     game service is stopped or restarting, through the same ledger, the same UNIQUE (account, day) and
//     (sign-in, day) daily rows and the same locks as the website and the panel (one daily per account per
//     day across every surface);
//   - no service secret or loopback port has to be configured or kept in step;
//   - when the v2 tables do not exist yet (migration 437 not applied), every call answers
//     { ready: false } instead of throwing, so commands and pages show "not set up yet".
// The one difference: the game's WebSocket hints are not sent from here; open game tabs pick the change up
// on their next poll (15 s while visible).
//
//   const gh = createGreenhouseBridge({ db: pool, logger });
//   const s = await gh.status(discordUserId);       // { ready, linked, ... }
//
// Every function returns a plain object; GameErrors come back as { ready: true, error: { code, message } }.
import { createStore } from '../store/index.js';
import { createGame } from '../store/game.js';
import { TABLES, tableNames } from '../store/schema.js';
import { isGameError } from '../lib/errors.js';
import { GAME_TITLE } from '../config/copy.js';
import { DEFAULT_PUBLIC_URL } from '../config/env.js';
import { periodsAt } from '../domain/meta.js';

const READY_TTL_MS = 60_000;
const SNOWFLAKE = /^\d{17,20}$/;

export function createGreenhouseBridge({ db, logger = null, prefix = 'gh_', publicUrl = process.env.CFX2_PUBLIC_URL || DEFAULT_PUBLIC_URL, gamePath = process.env.CFX2_GAME_PATH || '/greenhouse', now = () => Date.now() }) {
    let parts = null;
    let readyCache = { ok: false, at: -Infinity };
    const t = tableNames(prefix);

    async function ready() {
        if (now() - readyCache.at < READY_TTL_MS && readyCache.at <= now()) return readyCache.ok;
        let ok = false;
        try {
            const [rows] = await db.query(
                'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)',
                [TABLES.map(n => t[n])]);
            ok = Number(rows[0].n) === TABLES.length;
        } catch (err) {
            logger?.warn?.('[greenhouse] table check failed', { error: err.message });
        }
        readyCache = { ok, at: now() };
        return ok;
    }

    function get() {
        if (!parts) {
            const store = createStore({ db, prefix, now, logger });
            const game = createGame({ store, logger });
            parts = { store, game };
        }
        return parts;
    }

    const notReady = { ready: false };
    const gameUrl = `${String(publicUrl).replace(/\/+$/, '')}${gamePath}`;

    /** Run fn when the tables exist; turn GameErrors into { error }. */
    async function guarded(fn) {
        if (!(await ready())) return notReady;
        try {
            return { ready: true, ...(await fn(get())) };
        } catch (err) {
            if (isGameError(err)) return { ready: true, error: { code: err.code, message: err.message, details: err.details } };
            throw err;
        }
    }

    function checkId(discordId) {
        if (!SNOWFLAKE.test(String(discordId))) throw new RangeError('discordId must be a Discord snowflake');
        return String(discordId);
    }

    async function accountFor(store, discordId) {
        return store.accounts.findIdentity('discord', checkId(discordId));
    }

    /** A short summary for /arcade greenhouse status. linked: false when this Discord user has no save. */
    async function status(discordId) {
        return guarded(async ({ store, game }) => {
            const who = await accountFor(store, discordId);
            if (!who || !who.accountId) return { linked: false, gameUrl, title: GAME_TITLE };
            const s = await game.state(who.accountId, { touch: false });
            const ready = s.plots.filter(p => p.status === 'ready').length;
            const growing = s.plots.filter(p => p.status === 'growing');
            const nextReadyAtMs = growing.length ? Math.min(...growing.map(p => p.readyAtMs)) : null;
            const quests = [...s.quests.daily, ...s.quests.weekly];
            return {
                linked: true, gameUrl, title: GAME_TITLE,
                account: { displayName: s.account.displayName, level: s.account.level, cash: s.account.cash, prestige: s.account.prestige, review: s.account.review },
                plots: { owned: s.plotsOwned, ready, growing: growing.length, nextReadyAtMs },
                daily: s.daily,
                quests: { done: quests.filter(q => q.completed).length, total: quests.length, toCollect: s.quests.claimable },
                season: s.season ? { number: s.season.number, score: s.season.score, rank: s.season.rank, endsAtMs: s.season.endsAtMs, challenge: s.season.challenge } : null,
                achievements: s.achievements,
                notifications: s.notifications
            };
        });
    }

    /**
     * The daily reward from Discord. Signs in with the Discord account (creating a save with the starter kit
     * the first time, as the website's Discord sign-in does) and claims through the same rule as every surface.
     */
    async function daily(discordId, displayName = null) {
        return guarded(async ({ store, game }) => {
            const signed = await store.accounts.signIn({ platform: 'discord', platformUserId: checkId(discordId), displayName });
            const r = await game.claimDaily(signed.accountId, { identityId: signed.identityId });
            const s = await game.state(signed.accountId);
            return { createdAccount: signed.createdAccount, starterGranted: signed.starterGranted, claim: r, cash: s.account.cash, gameUrl };
        });
    }

    /** Make a link code on this Discord user's save (to enter on the website or another sign-in). */
    async function linkCode(discordId) {
        return guarded(async ({ store }) => {
            const who = await accountFor(store, discordId);
            if (!who || !who.accountId) return { linked: false, gameUrl };
            const out = await store.accounts.createLinkCode({ accountId: who.accountId, identityId: who.identityId });
            return { linked: true, code: out.code, expiresAt: out.expiresAt, gameUrl };
        });
    }

    /** Join this Discord sign-in to the save that made `code` (saves are never merged; the usual rules apply). */
    async function redeem(discordId, code, displayName = null) {
        return guarded(async ({ store }) => {
            const who = await store.accounts.ensureIdentity({ platform: 'discord', platformUserId: checkId(discordId), displayName });
            const out = await store.accounts.redeemLinkCode({ identityId: who.identityId, code });
            return { linked: true, changed: out.changed, accountId: out.accountId, gameUrl };
        });
    }

    /**
     * Players among a server's members (dashboard): which of these Discord ids have a save, with their level,
     * Replants and season standing. ids: up to 5,000 snowflakes.
     */
    async function communityPlayers(discordIds) {
        return guarded(async ({ store }) => {
            const ids = [...new Set((discordIds || []).map(String).filter(x => SNOWFLAKE.test(x)))].slice(0, 5000);
            if (!ids.length) return { players: [], season: null };
            const cur = await store.meta.current();
            const seasonId = cur?.season?.id || 0;
            const out = [];
            for (let i = 0; i < ids.length; i += 500) {
                const chunk = ids.slice(i, i + 500);
                const [rows] = await db.query(
                    `SELECT i.platform_user_id AS discord_id, a.id AS account_id, a.display_name, a.level, a.prestige, a.last_seen_at,
                            st.score, s.xp_earned
                       FROM ${t.identities} i
                       JOIN ${t.accounts} a ON a.id = i.account_id
                       LEFT JOIN ${t.account_stats} s ON s.account_id = a.id
                       LEFT JOIN ${t.season_standings} st ON st.account_id = a.id AND st.season_id = ?
                      WHERE i.platform = 'discord' AND i.platform_user_id IN (?) AND a.review = 0 AND a.status = 'active'`,
                    [seasonId, chunk]);
                out.push(...rows);
            }
            out.sort((x, y) => Number(y.score || 0) - Number(x.score || 0) || Number(y.xp_earned || 0) - Number(x.xp_earned || 0));
            let rank = 0;
            let prev = null;
            const players = out.map((r, i) => {
                const score = Number(r.score || 0);
                if (score !== prev) { rank = i + 1; prev = score; }
                return {
                    discordId: r.discord_id, displayName: r.display_name, level: Number(r.level), prestige: Number(r.prestige),
                    seasonScore: score, communityRank: score > 0 ? rank : null, xpEarned: Number(r.xp_earned || 0),
                    lastSeenAtMs: r.last_seen_at ? new Date(r.last_seen_at).getTime() : null
                };
            });
            return { players, season: cur?.season ? { number: cur.season.number, endsAtMs: cur.season.endsAtMs, status: cur.season.status } : null };
        });
    }

    /** Discord ids that have a save (newest sign-in first; review saves and suspended accounts left out). */
    async function discordPlayerIds(limit = 5000) {
        return guarded(async () => {
            const n = Math.max(1, Math.min(5000, Math.floor(Number(limit)) || 5000));
            const [rows] = await db.query(
                `SELECT i.platform_user_id FROM ${t.identities} i JOIN ${t.accounts} a ON a.id = i.account_id
                  WHERE i.platform = 'discord' AND a.review = 0 AND a.status = 'active' ORDER BY i.last_used_at DESC LIMIT ?`, [n]);
            return { ids: rows.map(r => String(r.platform_user_id)).filter(x => SNOWFLAKE.test(x)) };
        });
    }

    /** A page of the public leaderboard (season or all-time). */
    async function leaderboard(board = 'season', page = 1) {
        return guarded(async ({ game }) => ({ leaderboard: await game.leaderboard({ board, page }) }));
    }

    /** Season overview for the dashboard: the season, its challenges and the top 10. */
    async function seasonSummary() {
        return guarded(async ({ store, game }) => {
            const cur = await store.meta.current();
            const top = cur?.season ? (await game.leaderboard({ board: 'season', page: 1 })).rows.slice(0, 10) : [];
            return {
                season: cur?.season || null,
                challenges: (cur?.challenges || []).map(c => ({ week: c.week, code: c.code, target: c.target, status: c.status, startsAtMs: c.startsAtMs, endsAtMs: c.endsAtMs, activePlayers: c.activePlayers, minActivePlayers: c.minActivePlayers })),
                top,
                periods: periodsAt(now())
            };
        });
    }

    // ---------------------------------------------------------------- super-admin controls (dashboard)

    /** The job kill switch and job run records. disabled: true (all), false, or a list of job names. */
    async function jobsStatus() {
        return guarded(async ({ store }) => {
            store.flags.clearCache();
            const value = await store.flags.get('jobs.disabled');
            const runs = await store.jobRuns.list();
            const review = await store.flags.get('review.enabled');
            const channels = await store.flags.get('review.channelIds');
            const lastReset = await store.flags.get('review.lastResetAt');
            return {
                disabled: value === true ? true : Array.isArray(value) ? value : false,
                envNote: 'CFX2_JOBS_DISABLED in .env also stops jobs; it needs a restart of the game service.',
                runs: runs.map(r => ({
                    name: r.name, lastStatus: r.last_status, lastStartedAtMs: r.last_started_at ? new Date(r.last_started_at).getTime() : null,
                    lastFinishedAtMs: r.last_finished_at ? new Date(r.last_finished_at).getTime() : null, lastDurationMs: r.last_duration_ms == null ? null : Number(r.last_duration_ms),
                    lastError: r.last_error, runs: Number(r.runs), failures: Number(r.failures), skips: Number(r.skips)
                })),
                review: { enabled: review === true, channelIds: Array.isArray(channels) ? channels.map(String) : [], lastResetAtMs: Number(lastReset) || null }
            };
        });
    }

    const JOB_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;

    /** Set the kill switch: true (every job), false, or a list of job names. updatedBy: who (audit). */
    async function setJobsDisabled(value, updatedBy) {
        return guarded(async ({ store }) => {
            let v;
            if (value === true || value === false) v = value;
            else if (Array.isArray(value) && value.length <= 20 && value.every(x => typeof x === 'string' && JOB_NAME.test(x))) v = [...new Set(value)];
            else throw new RangeError('value must be true, false or a list of job names');
            await store.flags.set('jobs.disabled', v, String(updatedBy || '').slice(0, 64) || null);
            return { disabled: v };
        });
    }

    /** Open or close the Twitch review save; channelIds (optional) limits it to these channel ids. */
    async function setReview({ enabled, channelIds = null }, updatedBy) {
        return guarded(async ({ store }) => {
            if (typeof enabled !== 'boolean') throw new RangeError('enabled must be true or false');
            const by = String(updatedBy || '').slice(0, 64) || null;
            await store.flags.set('review.enabled', enabled, by);
            if (channelIds !== null) {
                if (!Array.isArray(channelIds) || channelIds.length > 20 || !channelIds.every(x => /^\d{1,20}$/.test(String(x)))) throw new RangeError('channelIds must be up to 20 Twitch channel ids');
                await store.flags.set('review.channelIds', channelIds.map(String), by);
            }
            if (enabled) await store.review.ensure();
            return { enabled };
        });
    }

    /** Put the review save back now. */
    async function resetReview() {
        return guarded(async ({ store }) => {
            const r = (await store.review.find()) ? await store.review.reset() : null;
            return { reset: !!r };
        });
    }

    return {
        ready, gameUrl, status, daily, linkCode, redeem, communityPlayers, discordPlayerIds, leaderboard, seasonSummary,
        jobsStatus, setJobsDisabled, setReview, resetReview,
        /** for tests */
        _parts: get
    };
}
