/**
 * Seasons: rollover, final standings, rewards and the read side used by the
 * game API and the dashboard.
 *
 * A season runs SEASON_LENGTH_DAYS. While it runs, cfx_players.season_xp
 * (XP earned, from engine.awardXp), season_earnings (cash earned, from
 * engine.awardCash and NPC sales) and season_sales (harvests, from
 * growth-system) count up for every player whose current_season_id is that
 * season. The season job (jobs/index.js) calls seasonTick() every 5 minutes:
 *
 *   1. an active season whose ends_at has passed is closed in ONE transaction:
 *      standings ranked by season XP, then season earnings, then harvests are
 *      written to cfx_season_leaderboard, rewards are paid (cash and prestige
 *      tokens, cash logged in cfx_transactions as `season_reward:<id>`), the
 *      season is marked 'ended', the next 30-day season is created and every
 *      player's season counters are reset;
 *   2. if no season is active at all, one is started.
 *
 * Rewards come from cfx_seasons.reward_config. When it is empty the default
 * below is written into the closing season's row first, so the row always
 * records what was paid:
 *
 *   rank 1      100,000 cash + 3 prestige tokens
 *   rank 2       60,000 cash + 2 prestige tokens
 *   rank 3       40,000 cash + 1 prestige token
 *   ranks 4-10   15,000 cash
 *   any other ranked player (earned season XP, cash or harvests) 2,500 cash
 *
 * reward_config format: {"ranks":[{"from":1,"to":1,"cash":100000,"prestige_tokens":3},...],
 *                        "participation":{"cash":2500,"prestige_tokens":0}}
 *
 * Seasons that ran before tracking existed (Season 1: season_xp was never
 * incremented) have no counters to rank. For those the standings are rebuilt
 * from what was logged inside the season window (NPC sales, black-market
 * sales, dispensary orders, worker auto-sales and credited transactions for
 * earnings; worker auto-harvests for harvests) and ranked by earnings, then
 * harvests. Season XP is recorded as 0 for them. `source` in the summary says
 * which method was used.
 *
 * Test and banned accounts (platform 'dev', is_banned = 1) are never ranked.
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { isFrozen } from '../freeze.js';

export const SEASON_LENGTH_DAYS = 30;
const LOCK_NAME = 'cfx_season_rollover';

export const DEFAULT_REWARD_CONFIG = Object.freeze({
    ranks: [
        { from: 1, to: 1, cash: 100000, prestige_tokens: 3 },
        { from: 2, to: 2, cash: 60000, prestige_tokens: 2 },
        { from: 3, to: 3, cash: 40000, prestige_tokens: 1 },
        { from: 4, to: 10, cash: 15000, prestige_tokens: 0 }
    ],
    participation: { cash: 2500, prestige_tokens: 0 }
});

// ---------------------------------------------------------------------------
// Optional columns (added by the cfx season-tracking migration). Code that
// writes them checks hasSeasonColumn() so it keeps working before the
// migration has run.
// ---------------------------------------------------------------------------
let seasonColumns = { season_earnings: false, season_sales: false };

export async function refreshSeasonColumns(db = pool) {
    try {
        const [rows] = await db.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cfx_players'
               AND COLUMN_NAME IN ('season_earnings', 'season_sales')`
        );
        const names = new Set(rows.map(r => r.COLUMN_NAME));
        seasonColumns = { season_earnings: names.has('season_earnings'), season_sales: names.has('season_sales') };
    } catch (error) {
        logger.warn('[Seasons] Could not read cfx_players columns', { error: error.message });
    }
    return seasonColumns;
}

export function hasSeasonColumn(name) {
    return !!seasonColumns[name];
}

/** SQL fragment for an UPDATE cfx_players that adds cash earned to the season counter ('' before the migration). */
export function seasonEarningsSql() {
    return seasonColumns.season_earnings ? ', season_earnings = season_earnings + ?' : '';
}

/** SQL fragment that adds one harvest to the season counter ('' before the migration). */
export function seasonSalesSql() {
    return seasonColumns.season_sales ? ', season_sales = season_sales + 1' : '';
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in tests/cfx/season-system.test.js)
// ---------------------------------------------------------------------------

const toInt = (v) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Normalise a reward_config value (JSON text or object). Returns null when it defines no rewards. */
export function parseRewardConfig(raw) {
    let cfg = raw;
    if (typeof raw === 'string') {
        if (!raw.trim()) return null;
        try { cfg = JSON.parse(raw); } catch { return null; }
    }
    if (!cfg || typeof cfg !== 'object') return null;
    const ranks = Array.isArray(cfg.ranks) ? cfg.ranks
        .map(r => ({ from: toInt(r.from), to: toInt(r.to ?? r.from), cash: toInt(r.cash), prestige_tokens: toInt(r.prestige_tokens) }))
        .filter(r => r.from >= 1 && r.to >= r.from && (r.cash > 0 || r.prestige_tokens > 0)) : [];
    const p = cfg.participation || {};
    const participation = { cash: toInt(p.cash), prestige_tokens: toInt(p.prestige_tokens) };
    if (!ranks.length && !participation.cash && !participation.prestige_tokens) return null;
    return { ranks, participation };
}

/** Reward for a final rank: the first matching rank band, else the participation reward. */
export function rewardForRank(config, rank) {
    const band = (config?.ranks || []).find(r => rank >= r.from && rank <= r.to);
    const r = band || config?.participation || {};
    return { cash: toInt(r.cash), prestige_tokens: toInt(r.prestige_tokens) };
}

/**
 * Rank rows of { player_id, season_xp, season_earnings, season_sales }:
 * season XP, then earnings, then harvests (all descending; earnings first for
 * primary 'season_earnings'), then the older player first. Rows with nothing
 * earned are dropped. Returns new objects with final_rank 1..n.
 */
export function rankStandings(rows, { primary = 'season_xp' } = {}) {
    const order = primary === 'season_earnings'
        ? ['season_earnings', 'season_sales', 'season_xp']
        : ['season_xp', 'season_earnings', 'season_sales'];
    return rows
        .map(r => ({
            player_id: Number(r.player_id),
            season_xp: toInt(r.season_xp),
            season_earnings: toInt(r.season_earnings),
            season_sales: toInt(r.season_sales)
        }))
        .filter(r => r.season_xp > 0 || r.season_earnings > 0 || r.season_sales > 0)
        .sort((a, b) => {
            for (const k of order) if (b[k] !== a[k]) return b[k] - a[k];
            return a.player_id - b.player_id;
        })
        .map((r, i) => ({ ...r, final_rank: i + 1 }));
}

/** Next season's name: "Season N" -> "Season N+1"; anything else -> "Season <count+1>". */
export function nextSeasonName(previousName, seasonCount) {
    const m = String(previousName || '').trim().match(/^Season\s+(\d+)$/i);
    return `Season ${m ? Number(m[1]) + 1 : (Number(seasonCount) || 0) + 1}`;
}

// ---------------------------------------------------------------------------
// Standings
// ---------------------------------------------------------------------------

const REAL_PLAYER = `p.platform <> 'dev' AND COALESCE(p.is_banned, 0) = 0`;

async function trackedStandings(db, seasonId) {
    const earn = seasonColumns.season_earnings ? 'p.season_earnings' : '0';
    const sales = seasonColumns.season_sales ? 'p.season_sales' : '0';
    const [rows] = await db.query(
        `SELECT p.id AS player_id, p.season_xp, ${earn} AS season_earnings, ${sales} AS season_sales
         FROM cfx_players p
         WHERE p.current_season_id = ? AND ${REAL_PLAYER}`,
        [seasonId]
    );
    return rankStandings(rows);
}

async function loggedStandings(db, season) {
    const w = [season.starts_at, season.ends_at];
    const [rows] = await db.query(
        `SELECT p.id AS player_id, 0 AS season_xp,
                COALESCE(npc.v, 0) + COALESCE(bm.v, 0) + COALESCE(disp.v, 0) + COALESCE(ws.v, 0) + COALESCE(tx.v, 0) AS season_earnings,
                COALESCE(wh.n, 0) AS season_sales
         FROM cfx_players p
         LEFT JOIN (SELECT player_id, SUM(total_price) v FROM cfx_npc_sales WHERE sold_at BETWEEN ? AND ? GROUP BY player_id) npc ON npc.player_id = p.id
         LEFT JOIN (SELECT player_id, SUM(sale_price) v FROM cfx_black_market_sales WHERE sold_at BETWEEN ? AND ? GROUP BY player_id) bm ON bm.player_id = p.id
         LEFT JOIN (SELECT d.player_id, SUM(COALESCE(o.sale_amount, 0) + COALESCE(o.tip_amount, 0)) v
                    FROM cfx_dispensary_orders o JOIN cfx_dispensaries d ON d.id = o.dispensary_id
                    WHERE o.status = 'served' AND o.completed_at BETWEEN ? AND ? GROUP BY d.player_id) disp ON disp.player_id = p.id
         LEFT JOIN (SELECT player_id, SUM(cash_earned) v FROM cfx_worker_logs WHERE action = 'auto_sell' AND performed_at BETWEEN ? AND ? GROUP BY player_id) ws ON ws.player_id = p.id
         LEFT JOIN (SELECT player_id, SUM(amount) v FROM cfx_transactions WHERE type = 'credit' AND source NOT LIKE 'season\\_reward:%' AND source NOT LIKE 'currency\\_merge:%' AND created_at BETWEEN ? AND ? GROUP BY player_id) tx ON tx.player_id = p.id
         LEFT JOIN (SELECT player_id, SUM(items_processed) n FROM cfx_worker_logs WHERE action = 'auto_harvest' AND performed_at BETWEEN ? AND ? GROUP BY player_id) wh ON wh.player_id = p.id
         WHERE ${REAL_PLAYER}`,
        [...w, ...w, ...w, ...w, ...w, ...w]
    );
    return rankStandings(rows, { primary: 'season_earnings' });
}

// ---------------------------------------------------------------------------
// Rollover
// ---------------------------------------------------------------------------

async function createSeason(conn, previous) {
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM cfx_seasons');
    const name = nextSeasonName(previous?.name, n);
    const [res] = await conn.query(
        `INSERT INTO cfx_seasons (name, theme, starts_at, ends_at, status, reward_config)
         VALUES (?, NULL, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY), 'active', ?)`,
        [name, SEASON_LENGTH_DAYS, JSON.stringify(DEFAULT_REWARD_CONFIG)]
    );
    const resets = ['current_season_id = ?', 'season_xp = 0'];
    if (seasonColumns.season_earnings) resets.push('season_earnings = 0');
    if (seasonColumns.season_sales) resets.push('season_sales = 0');
    await conn.query(`UPDATE cfx_players SET ${resets.join(', ')}`, [res.insertId]);
    return { id: res.insertId, name };
}

/**
 * Close one active season (if it is still active) and start the next.
 * Returns a summary, or null when it was already closed.
 */
export async function rolloverSeason(seasonId) {
    if (isFrozen()) return null; // frozen (H-636): no rollover, no payout
    await refreshSeasonColumns();
    const conn = await pool.getConnection();
    const granted = [];
    let summary = null;
    try {
        await conn.beginTransaction();
        const [[season]] = await conn.query(
            `SELECT * FROM cfx_seasons WHERE id = ? AND status = 'active' FOR UPDATE`,
            [seasonId]
        );
        if (!season) {
            await conn.rollback();
            return null;
        }

        let standings = await trackedStandings(conn, season.id);
        let source = 'tracked';
        if (!standings.length) {
            standings = await loggedStandings(conn, season);
            source = 'activity_log';
        }

        let config = parseRewardConfig(season.reward_config);
        if (!config) {
            config = parseRewardConfig(DEFAULT_REWARD_CONFIG);
            await conn.query('UPDATE cfx_seasons SET reward_config = ? WHERE id = ?', [JSON.stringify(DEFAULT_REWARD_CONFIG), season.id]);
        }

        for (const row of standings) {
            const reward = rewardForRank(config, row.final_rank);
            const paid = reward.cash > 0 || reward.prestige_tokens > 0;
            await conn.query(
                `INSERT INTO cfx_season_leaderboard
                    (season_id, player_id, final_rank, season_xp, season_earnings, season_sales, reward_claimed)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE final_rank = VALUES(final_rank), season_xp = VALUES(season_xp),
                    season_earnings = VALUES(season_earnings), season_sales = VALUES(season_sales)`,
                [season.id, row.player_id, row.final_rank, row.season_xp, row.season_earnings, row.season_sales, paid ? 1 : 0]
            );
            if (!paid) continue;
            await conn.query(
                'UPDATE cfx_players SET cash = cash + ?, prestige_tokens = prestige_tokens + ? WHERE id = ?',
                [reward.cash, reward.prestige_tokens, row.player_id]
            );
            if (reward.cash > 0) {
                await conn.query(
                    `INSERT INTO cfx_transactions (player_id, type, amount, source, balance_after)
                     SELECT id, 'credit', ?, ?, cash FROM cfx_players WHERE id = ?`,
                    [reward.cash, `season_reward:${season.id}`, row.player_id]
                );
            }
            granted.push({ ...row, ...reward });
        }

        await conn.query(`UPDATE cfx_seasons SET status = 'ended' WHERE id = ?`, [season.id]);
        const next = await createSeason(conn, season);
        await conn.commit();

        summary = {
            seasonId: season.id,
            seasonName: season.name,
            source,
            ranked: standings.length,
            rewarded: granted.length,
            nextSeason: next
        };
    } catch (error) {
        await conn.rollback().catch(() => {});
        throw error;
    } finally {
        conn.release();
    }

    // Tell the winners (outside the transaction; a failed notification must not undo the season)
    try {
        const { createNotification } = await import('../routes/notifications.js');
        for (const g of granted) {
            const parts = [];
            if (g.cash) parts.push(`$${g.cash.toLocaleString('en-US')}`);
            if (g.prestige_tokens) parts.push(`${g.prestige_tokens} prestige token${g.prestige_tokens === 1 ? '' : 's'}`);
            await createNotification(g.player_id, 'season_reward', `${summary.seasonName} has ended`,
                `You finished #${g.final_rank}. Your reward: ${parts.join(' and ')}.`,
                { seasonId: summary.seasonId, rank: g.final_rank, cash: g.cash, prestigeTokens: g.prestige_tokens });
        }
    } catch (error) {
        logger.warn('[Seasons] Reward notifications failed', { error: error.message });
    }

    logger.info('[Seasons] Season closed', summary);
    return summary;
}

/** Start a season when none is active (activating a due 'upcoming' one first). */
async function ensureActiveSeason() {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [[active]] = await conn.query(`SELECT id FROM cfx_seasons WHERE status = 'active' LIMIT 1 FOR UPDATE`);
        if (active) { await conn.commit(); return null; }
        const [[due]] = await conn.query(
            `SELECT id FROM cfx_seasons WHERE status = 'upcoming' AND starts_at <= NOW() ORDER BY starts_at LIMIT 1 FOR UPDATE`
        );
        let started;
        if (due) {
            await conn.query(`UPDATE cfx_seasons SET status = 'active' WHERE id = ?`, [due.id]);
            const resets = ['current_season_id = ?', 'season_xp = 0'];
            if (seasonColumns.season_earnings) resets.push('season_earnings = 0');
            if (seasonColumns.season_sales) resets.push('season_sales = 0');
            await conn.query(`UPDATE cfx_players SET ${resets.join(', ')}`, [due.id]);
            started = { id: due.id };
        } else {
            const [[last]] = await conn.query('SELECT name FROM cfx_seasons ORDER BY id DESC LIMIT 1');
            started = await createSeason(conn, last);
        }
        await conn.commit();
        logger.info('[Seasons] Season started', started);
        return started;
    } catch (error) {
        await conn.rollback().catch(() => {});
        throw error;
    } finally {
        conn.release();
    }
}

/**
 * Job entry point. A MySQL named lock keeps two processes from rolling the
 * same season over twice (FOR UPDATE + the status check is the second guard).
 */
export async function seasonTick() {
    if (isFrozen()) return { skipped: 'frozen' }; // H-636
    await refreshSeasonColumns();
    const lockConn = await pool.getConnection();
    let locked = false;
    try {
        const [[{ got }]] = await lockConn.query('SELECT GET_LOCK(?, 0) AS got', [LOCK_NAME]);
        locked = Number(got) === 1;
        if (!locked) return { skipped: 'locked' };

        const results = [];
        const [due] = await pool.query(
            `SELECT id FROM cfx_seasons WHERE status = 'active' AND ends_at <= NOW() ORDER BY ends_at`
        );
        for (const s of due) {
            const r = await rolloverSeason(s.id);
            if (r) results.push(r);
        }
        const started = await ensureActiveSeason();

        // Players created by a path that did not set the season join the running one
        const [[current]] = await pool.query(`SELECT id FROM cfx_seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1`);
        if (current) {
            await pool.query('UPDATE cfx_players SET current_season_id = ? WHERE current_season_id IS NULL', [current.id]);
        }
        return { closed: results, started };
    } finally {
        if (locked) await lockConn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => {});
        lockConn.release();
    }
}

// ---------------------------------------------------------------------------
// Read side
// ---------------------------------------------------------------------------

const seasonOut = (s) => s && ({
    id: s.id,
    name: s.name,
    theme: s.theme,
    status: s.status,
    startsAt: s.starts_at,
    endsAt: s.ends_at,
    rewards: parseRewardConfig(s.reward_config) || parseRewardConfig(DEFAULT_REWARD_CONFIG)
});

export async function getActiveSeason() {
    const [[s]] = await pool.query(`SELECT * FROM cfx_seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1`);
    return seasonOut(s) || null;
}

export async function getLastEndedSeason() {
    const [[s]] = await pool.query(`SELECT * FROM cfx_seasons WHERE status = 'ended' ORDER BY ends_at DESC, id DESC LIMIT 1`);
    return seasonOut(s) || null;
}

export async function getSeason(id) {
    const [[s]] = await pool.query('SELECT * FROM cfx_seasons WHERE id = ?', [id]);
    return seasonOut(s) || null;
}

export async function listSeasons() {
    const [rows] = await pool.query(
        `SELECT s.*, (SELECT COUNT(*) FROM cfx_season_leaderboard l WHERE l.season_id = s.id) AS ranked
         FROM cfx_seasons s ORDER BY s.id DESC LIMIT 50`
    );
    return rows.map(r => ({ ...seasonOut(r), ranked: Number(r.ranked) }));
}

async function playerNames(ids) {
    const map = new Map();
    if (!ids.length) return map;
    const [rows] = await pool.query(
        `SELECT id, display_name, platform, level FROM cfx_players WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids
    );
    for (const r of rows) map.set(r.id, r);
    return map;
}

/** Live standings of the running season (top `limit`) plus the asking player's own row. */
export async function getLiveStandings(seasonId, { limit = 25, playerId = null } = {}) {
    await refreshSeasonColumns();
    const all = await trackedStandings(pool, seasonId);
    const top = all.slice(0, Math.max(1, Math.min(200, Number(limit) || 25)));
    const mine = playerId ? all.find(r => r.player_id === Number(playerId)) || null : null;
    const ids = top.map(r => r.player_id);
    if (mine && !ids.includes(mine.player_id)) ids.push(mine.player_id);
    const names = await playerNames(ids);
    const shape = (r) => ({
        rank: r.final_rank,
        playerId: r.player_id,
        displayName: names.get(r.player_id)?.display_name || 'Unknown',
        platform: names.get(r.player_id)?.platform || null,
        level: names.get(r.player_id)?.level || null,
        seasonXp: r.season_xp,
        seasonEarnings: r.season_earnings,
        seasonHarvests: r.season_sales,
        isYou: playerId != null && r.player_id === Number(playerId)
    });
    return { standings: top.map(shape), me: mine ? shape(mine) : null, totalRanked: all.length };
}

/** Final standings of an ended season. */
export async function getFinalStandings(seasonId, { limit = 50, playerId = null } = {}) {
    const [rows] = await pool.query(
        `SELECT l.final_rank, l.player_id, l.season_xp, l.season_earnings, l.season_sales, l.reward_claimed,
                p.display_name, p.platform, p.level
         FROM cfx_season_leaderboard l
         LEFT JOIN cfx_players p ON p.id = l.player_id
         WHERE l.season_id = ?
         ORDER BY l.final_rank ASC
         LIMIT ?`,
        [seasonId, Math.max(1, Math.min(200, Number(limit) || 50))]
    );
    const [[season]] = await pool.query('SELECT reward_config FROM cfx_seasons WHERE id = ?', [seasonId]);
    const config = parseRewardConfig(season?.reward_config);
    return rows.map(r => ({
        rank: r.final_rank,
        playerId: r.player_id,
        displayName: r.display_name || 'Unknown',
        platform: r.platform,
        level: r.level,
        seasonXp: Number(r.season_xp) || 0,
        seasonEarnings: Number(r.season_earnings) || 0,
        seasonHarvests: Number(r.season_sales) || 0,
        reward: r.reward_claimed && config ? rewardForRank(config, r.final_rank) : null,
        isYou: playerId != null && r.player_id === Number(playerId)
    }));
}

/** "Active" = a real player whose last signed-in request was within `days`. */
export async function countActivePlayers(days = 7) {
    const [[r]] = await pool.query(
        `SELECT COUNT(*) AS n FROM cfx_players p WHERE ${REAL_PLAYER} AND p.last_online_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [days]
    );
    return Number(r.n) || 0;
}

/** Everything the dashboard page shows, in one call. */
export async function getSeasonOverview() {
    const current = await getActiveSeason();
    const last = await getLastEndedSeason();
    const [[players]] = await pool.query(
        `SELECT COUNT(*) AS total,
                SUM(p.last_online_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)) AS day,
                SUM(p.last_online_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS week,
                SUM(p.platform = 'twitch') AS twitch, SUM(p.platform = 'kick') AS kick, SUM(p.platform = 'discord') AS discord
         FROM cfx_players p WHERE ${REAL_PLAYER}`
    );
    const [tournaments] = await pool.query(
        `SELECT t.id, t.name, t.tournament_type, t.prize_pool, t.starts_at, t.ends_at,
                (SELECT COUNT(*) FROM cfx_tournament_participants tp WHERE tp.tournament_id = t.id) AS entrants
         FROM cfx_tournaments t WHERE t.status = 'active' ORDER BY t.ends_at`
    );
    return {
        current,
        currentStandings: current ? (await getLiveStandings(current.id, { limit: 10 })).standings : [],
        last,
        lastStandings: last ? await getFinalStandings(last.id, { limit: 10 }) : [],
        players: {
            total: Number(players.total) || 0,
            activeDay: Number(players.day) || 0,
            activeWeek: Number(players.week) || 0,
            byPlatform: { twitch: Number(players.twitch) || 0, kick: Number(players.kick) || 0, discord: Number(players.discord) || 0 }
        },
        tournaments: tournaments.map(t => ({
            id: t.id, name: t.name, type: t.tournament_type, prizePool: Number(t.prize_pool) || 0,
            startsAt: t.starts_at, endsAt: t.ends_at, entrants: Number(t.entrants) || 0
        }))
    };
}

export default {
    seasonTick, rolloverSeason, refreshSeasonColumns, hasSeasonColumn, seasonEarningsSql, seasonSalesSql,
    getActiveSeason, getLastEndedSeason, getSeason, listSeasons, getLiveStandings, getFinalStandings,
    getSeasonOverview, countActivePlayers, parseRewardConfig, rewardForRank, rankStandings,
    nextSeasonName, DEFAULT_REWARD_CONFIG, SEASON_LENGTH_DAYS
};
