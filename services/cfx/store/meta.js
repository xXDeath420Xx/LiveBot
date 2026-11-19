// Greenhouse Tycoon (cfx v2): the meta game on the database (phase 4). Quests, weekly challenges,
// achievements, season standings and rollover, notifications, leaderboards and cosmetics.
//
// Two kinds of functions:
//   - in-transaction hooks, called by store/game.js action() with its ctx (the account row is already
//     locked, so everything here for that account is serialised): progress(), seasonPoints(), notify(),
//     checkAchievements(), claimQuest(), claimAchievement();
//   - reads and jobs that run on their own: questsView(), seasonView(), leaderboard(), rollover(), ...
//
// Paying exactly once (each also behind a conditional UPDATE on the row it settles):
//   quest:<period key>:<code>      quest reward            account_quests.claimed_at IS NULL
//   ach:<code>                     achievement reward      account_achievements.claimed_at IS NULL
//   challenge:<id>                 weekly challenge        account_quests (period c<id>) completed once
//   challenge:<id>:podium          first three finishers   ledger key only (job, resumable)
//   season:<season id>             season reward           season_standings.reward_claimed_at IS NULL
import { gameError } from '../lib/errors.js';
import { withTx } from './tx.js';
import { SEASON, SEASON_SCORE, NOTIFICATIONS, LEADERBOARD, DAY_MS, FIRST_HYBRID_ID } from '../config/game.js';
import { ACHIEVEMENTS, achievement as achievementDef, questDef, CHALLENGES_CATALOG, SEASON_TIERS } from '../config/catalog.js';
import { ACHIEVEMENT_TEXT, SEASON_TIER_NAMES, badgeName, notificationText, DECORATION_NAMES } from '../config/copy.js';
import {
    periodsAt, questsFor, advance, questTitle, questSeasonPoints, achievementProgress, seasonWindow,
    challengesFor, seasonRewardFor, challengePodium, SOLD_DECORATIONS
} from '../domain/meta.js';
import { addPoints, rankStandings, challengeShouldRun } from '../domain/season-score.js';

const SOLD_CODES = SOLD_DECORATIONS.map(d => d.code);
const ms = (d) => (d == null ? null : new Date(d).getTime());
const json = (v) => (v == null ? null : typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v);

export function createMeta({ db, t, ledger, now = () => Date.now(), flags = null, logger = null }) {
    const date = (x = now()) => new Date(x);
    const cache = { season: null, at: -Infinity, boards: new Map() };

    // ------------------------------------------------------------------ the current season and challenge

    function seasonRow(r) {
        if (!r) return null;
        return {
            id: Number(r.id), number: Number(r.number), status: r.status,
            startsAtMs: ms(r.starts_at), endsAtMs: ms(r.ends_at), ranked: r.ranked == null ? null : Number(r.ranked)
        };
    }

    function challengeRow(r) {
        if (!r) return null;
        const def = questDef(r.quest_code);
        return {
            id: Number(r.id), seasonId: Number(r.season_id), week: Number(r.week), code: r.quest_code,
            metric: def ? def.metric : null, target: Number(r.target), status: r.status,
            startsAtMs: ms(r.starts_at), endsAtMs: ms(r.ends_at),
            minActivePlayers: Number(r.min_active_players), activePlayers: r.active_players == null ? null : Number(r.active_players)
        };
    }

    /** { season, challenges } for the season in play (active or being paid out), cached 30 s. */
    async function current() {
        if (cache.season && now() - cache.at < 30_000 && cache.at <= now()) return cache.season;
        const [rows] = await db.query(`SELECT * FROM ${t.seasons} WHERE status IN ('active','closing') ORDER BY number DESC LIMIT 1`);
        const season = seasonRow(rows[0]);
        let challenges = [];
        if (season) {
            const [c] = await db.query(`SELECT * FROM ${t.challenges} WHERE season_id = ? ORDER BY week`, [season.id]);
            challenges = c.map(challengeRow);
        }
        cache.season = { season, challenges };
        cache.at = now();
        return cache.season;
    }

    function invalidate() {
        cache.season = null;
        cache.boards.clear();
    }

    /** The challenge running now, or null. */
    function runningChallenge(cur, at = now()) {
        if (!cur?.season || cur.season.status !== 'active') return null;
        return cur.challenges.find(c => c.status === 'active' && c.startsAtMs <= at && at < c.endsAtMs) || null;
    }

    // ------------------------------------------------------------------ notifications

    async function notify(conn, accountId, kind, payload = null) {
        await conn.query(`INSERT INTO ${t.notifications} (account_id, kind, payload, created_at) VALUES (?, ?, ?, ?)`,
            [accountId, kind, payload ? JSON.stringify(payload) : null, date()]);
    }

    async function unreadCount(accountId, conn = db) {
        const [rows] = await conn.query(
            `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${t.notifications} WHERE account_id = ? AND read_at IS NULL LIMIT ?) x`,
            [accountId, NOTIFICATIONS.MAX_UNREAD_SHOWN + 1]);
        return Number(rows[0].n);
    }

    async function listNotifications(accountId, { before = null, limit = NOTIFICATIONS.PAGE } = {}) {
        const n = Math.max(1, Math.min(50, limit));
        const [rows] = await db.query(
            `SELECT id, kind, payload, created_at, read_at FROM ${t.notifications}
              WHERE account_id = ?${before ? ' AND id < ?' : ''} ORDER BY id DESC LIMIT ?`,
            before ? [accountId, before, n + 1] : [accountId, n + 1]);
        const page = rows.slice(0, n);
        return {
            notifications: page.map(r => ({
                id: Number(r.id), kind: r.kind, text: notificationText(r.kind, json(r.payload)),
                createdAtMs: ms(r.created_at), read: r.read_at != null
            })),
            nextBefore: rows.length > n ? Number(page[page.length - 1].id) : null,
            unread: await unreadCount(accountId)
        };
    }

    /** Mark notifications read (all, or up to an id). Returns how many changed. */
    async function markRead(conn, accountId, upToId = null) {
        const [r] = await conn.query(
            `UPDATE ${t.notifications} SET read_at = ? WHERE account_id = ? AND read_at IS NULL${upToId ? ' AND id <= ?' : ''}`,
            upToId ? [date(), accountId, upToId] : [date(), accountId]);
        return r.affectedRows;
    }

    async function sweepNotifications() {
        const [r] = await db.query(`DELETE FROM ${t.notifications} WHERE created_at < ? LIMIT 5000`, [date(now() - NOTIFICATIONS.KEEP_DAYS * DAY_MS)]);
        return r.affectedRows;
    }

    // ------------------------------------------------------------------ quests

    function questRow(r, periods) {
        const def = questDef(r.quest_code);
        const periodKey = r.period_key;
        const period = periodKey[0] === 'd' ? 'daily' : periodKey[0] === 'w' ? 'weekly' : 'challenge';
        const target = Number(r.target);
        return {
            code: r.quest_code, periodKey, period, metric: def ? def.metric : null,
            title: def ? questTitle(def.metric, target) : r.quest_code,
            target, progress: Math.min(Number(r.progress), target),
            completed: r.completed_at != null, claimed: r.claimed_at != null,
            reward: { cash: Number(r.reward_cash || 0), xp: Number(r.reward_xp || 0) },
            previous: periods ? (periodKey !== periods.daily && periodKey !== periods.weekly && period !== 'challenge') : false
        };
    }

    /** Create this day's and week's quests for an account if it has none yet (inside a transaction). */
    async function ensureQuestRows(conn, accountId, level, periods) {
        const [have] = await conn.query(
            `SELECT period_key, COUNT(*) AS n FROM ${t.account_quests} WHERE account_id = ? AND period_key IN (?, ?) GROUP BY period_key`,
            [accountId, periods.daily, periods.weekly]);
        const got = new Set(have.map(r => r.period_key));
        const rows = [];
        if (!got.has(periods.daily)) for (const qd of questsFor({ accountId, period: 'daily', index: periods.dayIndex, level })) rows.push([periods.daily, qd]);
        if (!got.has(periods.weekly)) for (const qd of questsFor({ accountId, period: 'weekly', index: periods.weekIndex, level })) rows.push([periods.weekly, qd]);
        if (!rows.length) return 0;
        await conn.query(
            `INSERT IGNORE INTO ${t.account_quests} (account_id, quest_code, period_key, progress, target, reward_cash, reward_xp) VALUES ?`,
            [rows.map(([key, qd]) => [accountId, qd.code, key, 0, qd.target, qd.reward.cash, qd.reward.xp])]);
        return rows.length;
    }

    /**
     * Count `amounts` ({ metric: n }) towards today's and this week's quests and the running challenge.
     * In the action's transaction. A finished challenge pays at once.
     */
    async function progress(ctx, amounts) {
        const entries = Object.entries(amounts).filter(([, n]) => Number.isSafeInteger(n) && n > 0);
        if (!entries.length) return;
        const { conn, accountId } = ctx;
        const at = now();
        const periods = periodsAt(at);
        await ensureQuestRows(conn, accountId, ctx.account.level, periods);
        const cur = await current();
        const challenge = runningChallenge(cur, at);
        const keys = [periods.daily, periods.weekly];
        if (challenge) keys.push(`c${challenge.id}`);
        const [rows] = await conn.query(
            `SELECT quest_code, period_key, progress, target, completed_at FROM ${t.account_quests}
              WHERE account_id = ? AND period_key IN (?) AND completed_at IS NULL FOR UPDATE`, [accountId, keys]);
        const byCode = new Map(rows.map(r => [`${r.period_key}|${r.quest_code}`, r]));
        if (challenge && !byCode.has(`c${challenge.id}|${challenge.code}`)) {
            const [have] = await conn.query(`SELECT 1 FROM ${t.account_quests} WHERE account_id = ? AND period_key = ? LIMIT 1`, [accountId, `c${challenge.id}`]);
            if (!have.length) {
                await conn.query(
                    `INSERT IGNORE INTO ${t.account_quests} (account_id, quest_code, period_key, progress, target, reward_cash, reward_xp) VALUES (?, ?, ?, 0, ?, ?, ?)`,
                    [accountId, challenge.code, `c${challenge.id}`, challenge.target, SEASON.CHALLENGE_REWARD.cash, SEASON.CHALLENGE_REWARD.xp]);
                byCode.set(`c${challenge.id}|${challenge.code}`, { quest_code: challenge.code, period_key: `c${challenge.id}`, progress: 0, target: challenge.target, completed_at: null });
            }
        }
        const metricOf = new Map(entries);
        for (const r of byCode.values()) {
            const def = questDef(r.quest_code);
            const amount = def ? metricOf.get(def.metric) : null;
            if (!amount) continue;
            const step = advance({ progress: Number(r.progress), target: Number(r.target), completed: false }, amount);
            await conn.query(
                `UPDATE ${t.account_quests} SET progress = ?, completed_at = ? WHERE account_id = ? AND quest_code = ? AND period_key = ? AND completed_at IS NULL`,
                [step.progress, step.justCompleted ? date(at) : null, accountId, r.quest_code, r.period_key]);
            if (!step.justCompleted) continue;
            const title = questTitle(def.metric, Number(r.target));
            if (r.period_key[0] === 'c') await finishChallenge(ctx, challenge, title);
            else await notify(conn, accountId, 'quest', { code: r.quest_code, periodKey: r.period_key, title });
        }
    }

    /** A player finished the running weekly challenge: pay the finisher reward once. */
    async function finishChallenge(ctx, challenge, title) {
        const { conn, accountId } = ctx;
        const key = `challenge:${challenge.id}`;
        if (await ledger.findEntry(conn, accountId, key, { lock: true })) return;
        await ledger.applyInTx(conn, { accountId, key, reason: 'challenge', ref: `c${challenge.id}`, cash: SEASON.CHALLENGE_REWARD.cash });
        await conn.query(`UPDATE ${t.account_quests} SET claimed_at = ? WHERE account_id = ? AND period_key = ? AND claimed_at IS NULL`,
            [date(), accountId, `c${challenge.id}`]);
        await ctx.addXp(SEASON.CHALLENGE_REWARD.xp);
        await ctx.addStats({ challenges_completed: 1 });
        await seasonPoints(ctx, questSeasonPoints('challenge'));
        await notify(conn, accountId, 'challenge', { title, cash: SEASON.CHALLENGE_REWARD.cash, week: challenge.week });
    }

    /** Claim a finished daily or weekly quest. In the action's transaction. */
    async function claimQuest(ctx, { periodKey, code }) {
        const { conn, accountId } = ctx;
        if (!/^[dw]/.test(periodKey)) throw gameError('NOT_FOUND', { what: 'quest' });
        const key = `quest:${periodKey}:${code}`;
        const [rows] = await conn.query(
            `SELECT * FROM ${t.account_quests} WHERE account_id = ? AND quest_code = ? AND period_key = ? FOR UPDATE`, [accountId, code, periodKey]);
        const r = rows[0];
        if (!r) throw gameError('NOT_FOUND', { what: 'quest' });
        if (r.claimed_at) {
            if (await ledger.findEntry(conn, accountId, key, { lock: true })) return { replayed: true, code, periodKey };
            throw gameError('ALREADY_CLAIMED');
        }
        if (!r.completed_at) throw gameError('QUEST_NOT_DONE', { progress: Number(r.progress), target: Number(r.target) });
        const [u] = await conn.query(
            `UPDATE ${t.account_quests} SET claimed_at = ? WHERE account_id = ? AND quest_code = ? AND period_key = ? AND claimed_at IS NULL AND completed_at IS NOT NULL`,
            [date(), accountId, code, periodKey]);
        if (u.affectedRows !== 1) throw gameError('ALREADY_CLAIMED');
        const cash = Number(r.reward_cash || 0);
        const xp = Number(r.reward_xp || 0);
        if (cash > 0) await ledger.applyInTx(conn, { accountId, key, reason: 'quest', ref: code, cash });
        const gained = await ctx.addXp(xp);
        await ctx.addStats({ quests_claimed: 1 });
        const period = periodKey[0] === 'w' ? 'weekly' : 'daily';
        await seasonPoints(ctx, questSeasonPoints(period));
        return { replayed: false, code, periodKey, cash, xp: gained };
    }

    /** Today's and this week's quests (and yesterday's / last week's that are done but not collected). */
    async function questsView(accountId, level) {
        const at = now();
        const periods = periodsAt(at);
        const prev = periodsAt(Math.max(0, at - DAY_MS));
        const prevWeek = periodsAt(Math.max(0, at - 7 * DAY_MS));
        const [some] = await db.query(
            `SELECT COUNT(DISTINCT period_key) AS n FROM ${t.account_quests} WHERE account_id = ? AND period_key IN (?, ?)`,
            [accountId, periods.daily, periods.weekly]);
        if (Number(some[0].n) < 2) {
            await withTx(db, async (conn) => {
                await ledger.lockAccount(conn, accountId);
                await ensureQuestRows(conn, accountId, level, periods);
            });
        }
        const [rows] = await db.query(
            `SELECT * FROM ${t.account_quests} WHERE account_id = ? AND (period_key IN (?, ?) OR (period_key IN (?, ?) AND completed_at IS NOT NULL AND claimed_at IS NULL))
              ORDER BY period_key, quest_code`,
            [accountId, periods.daily, periods.weekly, prev.daily, prevWeek.weekly]);
        const list = rows.map(r => questRow(r, periods));
        return {
            daily: list.filter(x => x.period === 'daily'),
            weekly: list.filter(x => x.period === 'weekly'),
            dailyKey: periods.daily,
            weeklyKey: periods.weekly,
            dailyResetsAtMs: periods.dailyEndsAtMs,
            weeklyResetsAtMs: periods.weeklyEndsAtMs,
            claimable: list.filter(x => x.completed && !x.claimed).length
        };
    }

    // ------------------------------------------------------------------ season score

    /** Add season points for an action (capped per day). Review saves are never ranked. */
    async function seasonPoints(ctx, points) {
        if (!points || points <= 0 || ctx.account.review) return 0;
        const cur = await current();
        const s = cur?.season;
        const at = now();
        if (!s || s.status !== 'active' || at < s.startsAtMs || at >= s.endsAtMs) return 0;
        const day = new Date(at).toISOString().slice(0, 10);
        const [rows] = await ctx.conn.query(
            `SELECT score, DATE_FORMAT(score_day, '%Y-%m-%d') AS score_day, score_today FROM ${t.season_standings}
              WHERE season_id = ? AND account_id = ? FOR UPDATE`, [s.id, ctx.accountId]);
        const r = rows[0];
        const next = addPoints(r ? { score: Number(r.score), scoreDay: r.score_day, scoreToday: Number(r.score_today) } : null, points, day, SEASON_SCORE.DAILY_CAP);
        if (!next.added) return 0;
        await ctx.conn.query(
            `INSERT INTO ${t.season_standings} (season_id, account_id, score, score_day, score_today) VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE score = VALUES(score), score_day = VALUES(score_day), score_today = VALUES(score_today)`,
            [s.id, ctx.accountId, next.score, next.scoreDay, next.scoreToday]);
        return next.added;
    }

    async function seasonView(accountId) {
        const cur = await current();
        const s = cur?.season;
        if (!s) return null;
        const at = now();
        const [rows] = await db.query(
            `SELECT score, DATE_FORMAT(score_day, '%Y-%m-%d') AS score_day, score_today, final_rank FROM ${t.season_standings} WHERE season_id = ? AND account_id = ?`,
            [s.id, accountId]);
        const r = rows[0];
        const score = r ? Number(r.score) : 0;
        const today = new Date(at).toISOString().slice(0, 10);
        let rank = null;
        if (score > 0) {
            const [c] = await db.query(`SELECT COUNT(*) AS n FROM ${t.season_standings} WHERE season_id = ? AND score > ?`, [s.id, score]);
            rank = Number(c[0].n) + 1;
        }
        const ch = runningChallenge(cur, at);
        let challenge = null;
        const shown = ch || cur.challenges.find(c => c.startsAtMs <= at && at < c.endsAtMs) || null;
        if (shown) {
            const [p] = await db.query(
                `SELECT progress, completed_at FROM ${t.account_quests} WHERE account_id = ? AND period_key = ?`, [accountId, `c${shown.id}`]);
            challenge = {
                id: shown.id, week: shown.week, code: shown.code, title: shown.metric ? questTitle(shown.metric, shown.target) : shown.code,
                target: shown.target, progress: p[0] ? Math.min(Number(p[0].progress), shown.target) : 0, completed: !!p[0]?.completed_at,
                status: shown.status, startsAtMs: shown.startsAtMs, endsAtMs: shown.endsAtMs,
                minActivePlayers: shown.minActivePlayers, activePlayers: shown.activePlayers,
                reward: { ...SEASON.CHALLENGE_REWARD }, podium: { ...SEASON.CHALLENGE_PODIUM }
            };
        }
        const nextChallenge = cur.challenges.find(c => c.startsAtMs > at) || null;
        return {
            id: s.id, number: s.number, status: s.status, startsAtMs: s.startsAtMs, endsAtMs: s.endsAtMs,
            score, scoreToday: r && r.score_day === today ? Number(r.score_today) : 0, dailyCap: SEASON_SCORE.DAILY_CAP, rank,
            challenge,
            nextChallengeAtMs: nextChallenge ? nextChallenge.startsAtMs : null
        };
    }

    /** Season details for GET /season: the current season, its challenges, reward tiers, last season's result. */
    async function seasonDetail(accountId) {
        const cur = await current();
        const view = await seasonView(accountId);
        const at = now();
        const challenges = (cur?.challenges || []).map(c => ({
            id: c.id, week: c.week, title: c.metric ? questTitle(c.metric, c.target) : c.code, status: c.status,
            startsAtMs: c.startsAtMs, endsAtMs: c.endsAtMs, minActivePlayers: c.minActivePlayers, activePlayers: c.activePlayers,
            running: c.status === 'active' && c.startsAtMs <= at && at < c.endsAtMs
        }));
        const [last] = await db.query(
            `SELECT s.id, s.number, s.ends_at, s.ranked, st.final_rank, st.score FROM ${t.seasons} s
               LEFT JOIN ${t.season_standings} st ON st.season_id = s.id AND st.account_id = ?
              WHERE s.status = 'closed' ORDER BY s.number DESC LIMIT 1`, [accountId]);
        let lastSeason = null;
        if (last[0]) {
            const l = last[0];
            const rank = l.final_rank == null ? null : Number(l.final_rank);
            const reward = rank ? seasonRewardFor({ seasonNumber: Number(l.number), rank, ranked: Math.max(1, Number(l.ranked || 1)), score: Number(l.score || 0) }) : null;
            lastSeason = {
                number: Number(l.number), endedAtMs: ms(l.ends_at), ranked: Number(l.ranked || 0), rank, score: Number(l.score || 0),
                reward: reward ? { tier: reward.tier, tierName: SEASON_TIER_NAMES[reward.tier], cash: reward.cash, badge: badgeName(reward.badge) } : null
            };
        }
        return {
            season: view,
            challenges,
            tiers: SEASON_TIERS.map(x => ({
                tier: x.tier, name: SEASON_TIER_NAMES[x.tier], cash: x.cash,
                decoration: x.decoration ? DECORATION_NAMES[x.decoration] : null,
                rule: x.maxRank != null ? { maxRank: x.maxRank } : x.topPct != null ? { topPct: x.topPct } : { minScore: x.minScore }
            })),
            participationMinScore: SEASON.PARTICIPATION_MIN_SCORE,
            dailyCap: SEASON_SCORE.DAILY_CAP,
            lastSeason
        };
    }

    // ------------------------------------------------------------------ achievements

    /** Lifetime stats the achievements count, plus the codes already unlocked. One query. */
    async function statsFor(conn, accountId) {
        const [rows] = await conn.query(
            `SELECT s.*, a.prestige,
                    (SELECT COUNT(*) FROM ${t.account_varieties} v WHERE v.account_id = a.id AND v.variety_id < ? AND v.harvested > 0) AS base_varieties,
                    (SELECT COUNT(*) FROM ${t.account_cosmetics} c WHERE c.account_id = a.id AND c.kind = 'decoration' AND c.code IN (?)) AS decorations,
                    (SELECT GROUP_CONCAT(achievement_code) FROM ${t.account_achievements} x WHERE x.account_id = a.id) AS unlocked
               FROM ${t.accounts} a LEFT JOIN ${t.account_stats} s ON s.account_id = a.id WHERE a.id = ?`,
            [FIRST_HYBRID_ID, SOLD_CODES, accountId]);
        const r = rows[0] || {};
        const n = (k) => Number(r[k] || 0);
        return {
            stats: {
                harvests: n('harvests'), units_sold: n('units_sold'), cash_earned: n('cash_earned'), orders_filled: n('orders_filled'),
                hybrids_bred: n('hybrids_bred'), base_varieties: n('base_varieties'), best_level: Math.max(1, n('best_level')),
                staff_claims: n('staff_claims'), quests_claimed: n('quests_claimed'), best_streak: n('best_streak'),
                replants: n('prestige'), decorations: n('decorations'), challenges_completed: n('challenges_completed')
            },
            unlocked: new Set(String(r.unlocked || '').split(',').filter(Boolean))
        };
    }

    /** Unlock every achievement the stats now meet (in the action's transaction). Returns the new codes. */
    async function checkAchievements(ctx) {
        const { conn, accountId } = ctx;
        const { stats, unlocked } = await statsFor(conn, accountId);
        const fresh = achievementProgress(stats).filter(p => p.met && !unlocked.has(p.code));
        for (const p of fresh) {
            const [r] = await conn.query(
                `INSERT IGNORE INTO ${t.account_achievements} (account_id, achievement_code, unlocked_at) VALUES (?, ?, ?)`, [accountId, p.code, date()]);
            if (r.affectedRows === 1) await notify(conn, accountId, 'achievement', { code: p.code, name: (ACHIEVEMENT_TEXT[p.code] || [p.code])[0] });
        }
        return fresh.map(p => p.code);
    }

    async function claimAchievement(ctx, { code }) {
        const { conn, accountId } = ctx;
        const def = achievementDef(code);
        if (!def) throw gameError('NOT_FOUND', { what: 'achievement' });
        await checkAchievements(ctx);
        const [rows] = await conn.query(
            `SELECT unlocked_at, claimed_at FROM ${t.account_achievements} WHERE account_id = ? AND achievement_code = ? FOR UPDATE`, [accountId, code]);
        if (!rows.length) throw gameError('ACHIEVEMENT_LOCKED');
        if (rows[0].claimed_at) return { replayed: true, code };
        const [u] = await conn.query(
            `UPDATE ${t.account_achievements} SET claimed_at = ? WHERE account_id = ? AND achievement_code = ? AND claimed_at IS NULL`, [date(), accountId, code]);
        if (u.affectedRows !== 1) return { replayed: true, code };
        if (def.cash > 0) await ledger.applyInTx(conn, { accountId, key: `ach:${code}`, reason: 'achievement', ref: code, cash: def.cash });
        if (def.badge) await grantCosmetic(conn, accountId, 'badge', def.badge, 'achievement');
        await conn.query(`UPDATE ${t.accounts} SET state_version = state_version + 1 WHERE id = ?`, [accountId]);
        return { replayed: false, code, cash: def.cash, badge: def.badge ? badgeName(def.badge) : null };
    }

    async function achievementsView(accountId) {
        const { stats } = await statsFor(db, accountId);
        const [rows] = await db.query(`SELECT achievement_code, unlocked_at, claimed_at FROM ${t.account_achievements} WHERE account_id = ?`, [accountId]);
        const got = new Map(rows.map(r => [r.achievement_code, r]));
        const progress = new Map(achievementProgress(stats).map(p => [p.code, p]));
        const list = ACHIEVEMENTS.map(a => {
            const r = got.get(a.code);
            const p = progress.get(a.code);
            const [name, description] = ACHIEVEMENT_TEXT[a.code] || [a.code, ''];
            return {
                code: a.code, name, description, target: a.target, progress: p.progress,
                unlocked: !!r, unlockedAtMs: r ? ms(r.unlocked_at) : null, claimed: !!r?.claimed_at,
                reward: { cash: a.cash, badge: a.badge ? badgeName(a.badge) : null }
            };
        });
        return {
            achievements: list,
            unlocked: list.filter(x => x.unlocked).length,
            total: list.length,
            claimable: list.filter(x => x.unlocked && !x.claimed).length,
            badges: await badges(accountId)
        };
    }

    async function achievementSummary(accountId) {
        const [rows] = await db.query(
            `SELECT COUNT(*) AS n, SUM(claimed_at IS NULL) AS c FROM ${t.account_achievements} WHERE account_id = ?`, [accountId]);
        return { unlocked: Number(rows[0].n || 0), total: ACHIEVEMENTS.length, claimable: Number(rows[0].c || 0) };
    }

    // ------------------------------------------------------------------ cosmetics

    async function grantCosmetic(conn, accountId, kind, code, source, placed = false) {
        const [r] = await conn.query(
            `INSERT IGNORE INTO ${t.account_cosmetics} (account_id, kind, code, source, placed, acquired_at) VALUES (?, ?, ?, ?, ?, ?)`,
            [accountId, kind, code, source, placed ? 1 : 0, date()]);
        return r.affectedRows === 1;
    }

    async function badges(accountId, conn = db) {
        const [rows] = await conn.query(
            `SELECT code, acquired_at FROM ${t.account_cosmetics} WHERE account_id = ? AND kind = 'badge' ORDER BY acquired_at, code`, [accountId]);
        return rows.map(r => ({ code: r.code, name: badgeName(r.code) || r.code, acquiredAtMs: ms(r.acquired_at) }));
    }

    async function decorations(accountId, conn = db) {
        const [rows] = await conn.query(
            `SELECT code, placed, acquired_at FROM ${t.account_cosmetics} WHERE account_id = ? AND kind = 'decoration' ORDER BY acquired_at, code`, [accountId]);
        return rows.map(r => ({ code: r.code, placed: !!r.placed, acquiredAtMs: ms(r.acquired_at) }));
    }

    // ------------------------------------------------------------------ leaderboards

    /**
     * A page of a leaderboard. board 'season' (current season, or `seasonNumber`) or 'alltime' (Replants,
     * then lifetime XP). Review saves and suspended accounts are left out. Pages are cached for 60 s; `me` is not.
     */
    async function leaderboard({ board, page = 1, accountId = null, seasonNumber = null }) {
        const size = LEADERBOARD.PAGE_SIZE;
        const offset = (page - 1) * size;
        let season = null;
        if (board === 'season') {
            if (seasonNumber) {
                const [s] = await db.query(`SELECT * FROM ${t.seasons} WHERE number = ?`, [seasonNumber]);
                season = seasonRow(s[0]);
                if (!season) throw gameError('NOT_FOUND', { what: 'season' });
            } else {
                season = (await current())?.season || null;
            }
            if (!season) return { board, page, pageSize: size, season: null, total: 0, rows: [], me: null };
        }
        const cacheKey = `${board}:${season?.id || 0}:${page}`;
        let hit = cache.boards.get(cacheKey);
        if (!hit || now() - hit.at > LEADERBOARD.CACHE_MS || hit.at > now()) {
            hit = { at: now(), ...(board === 'season' ? await seasonPage(season, offset, size) : await alltimePage(offset, size)) };
            if (cache.boards.size > 200) cache.boards.clear();
            cache.boards.set(cacheKey, hit);
        }
        let me = null;
        if (accountId) me = board === 'season' ? await seasonMe(season, accountId) : await alltimeMe(accountId);
        return {
            board, page, pageSize: size,
            season: season ? { number: season.number, status: season.status, endsAtMs: season.endsAtMs } : null,
            total: hit.total, rows: hit.rows, me
        };
    }

    const nameRow = (r, rank, score) => ({ rank, displayName: r.display_name, level: Number(r.level), prestige: Number(r.prestige), score });

    async function seasonPage(season, offset, size) {
        const closed = season.status === 'closed';
        const [[c]] = await db.query(
            `SELECT COUNT(*) AS n FROM ${t.season_standings} st JOIN ${t.accounts} a ON a.id = st.account_id
              WHERE st.season_id = ? AND st.score > 0 AND a.review = 0 AND a.status = 'active'`, [season.id]);
        const [rows] = await db.query(
            `SELECT st.account_id, st.score, st.final_rank, a.display_name, a.level, a.prestige FROM ${t.season_standings} st
               JOIN ${t.accounts} a ON a.id = st.account_id
              WHERE st.season_id = ? AND st.score > 0 AND a.review = 0 AND a.status = 'active'
              ORDER BY st.score DESC, st.account_id ASC LIMIT ? OFFSET ?`, [season.id, size, offset]);
        const out = [];
        let prevScore = null;
        let prevRank = null;
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            const score = Number(r.score);
            let rank;
            if (closed && r.final_rank != null) rank = Number(r.final_rank);
            else if (prevScore === score) rank = prevRank;
            else if (i === 0) rank = await higherCount(season.id, score) + 1;
            else rank = offset + i + 1;
            out.push(nameRow(r, rank, score));
            prevScore = score;
            prevRank = rank;
        }
        return { total: Number(c.n), rows: out };
    }

    async function higherCount(seasonId, score) {
        const [[c]] = await db.query(
            `SELECT COUNT(*) AS n FROM ${t.season_standings} st JOIN ${t.accounts} a ON a.id = st.account_id
              WHERE st.season_id = ? AND st.score > ? AND a.review = 0 AND a.status = 'active'`, [seasonId, score]);
        return Number(c.n);
    }

    async function seasonMe(season, accountId) {
        const [rows] = await db.query(`SELECT score, final_rank FROM ${t.season_standings} WHERE season_id = ? AND account_id = ?`, [season.id, accountId]);
        const score = rows[0] ? Number(rows[0].score) : 0;
        if (!score) return { rank: null, score: 0 };
        if (season.status === 'closed' && rows[0].final_rank != null) return { rank: Number(rows[0].final_rank), score };
        return { rank: (await higherCount(season.id, score)) + 1, score };
    }

    // All-time: Replants first (the long-term goal), then lifetime XP. Ties share a rank.
    async function alltimePage(offset, size) {
        const [[c]] = await db.query(
            `SELECT COUNT(*) AS n FROM ${t.account_stats} s JOIN ${t.accounts} a ON a.id = s.account_id
              WHERE s.xp_earned > 0 AND a.review = 0 AND a.status = 'active'`);
        const [rows] = await db.query(
            `SELECT s.account_id, s.xp_earned, a.display_name, a.level, a.prestige FROM ${t.account_stats} s
               JOIN ${t.accounts} a ON a.id = s.account_id
              WHERE s.xp_earned > 0 AND a.review = 0 AND a.status = 'active'
              ORDER BY a.prestige DESC, s.xp_earned DESC, s.account_id ASC LIMIT ? OFFSET ?`, [size, offset]);
        const out = [];
        let prev = null;
        let prevRank = null;
        for (let i = 0; i < rows.length; i++) {
            const score = Number(rows[i].xp_earned);
            const prestige = Number(rows[i].prestige);
            const key = `${prestige}:${score}`;
            let rank;
            if (prev === key) rank = prevRank;
            else if (i === 0) rank = (await alltimeHigher(prestige, score)) + 1;
            else rank = offset + i + 1;
            out.push(nameRow(rows[i], rank, score));
            prev = key;
            prevRank = rank;
        }
        return { total: Number(c.n), rows: out };
    }

    async function alltimeHigher(prestige, score) {
        const [[c]] = await db.query(
            `SELECT COUNT(*) AS n FROM ${t.account_stats} s JOIN ${t.accounts} a ON a.id = s.account_id
              WHERE a.review = 0 AND a.status = 'active' AND s.xp_earned > 0
                AND (a.prestige > ? OR (a.prestige = ? AND s.xp_earned > ?))`, [prestige, prestige, score]);
        return Number(c.n);
    }

    async function alltimeMe(accountId) {
        const [rows] = await db.query(
            `SELECT s.xp_earned, a.review, a.prestige FROM ${t.accounts} a LEFT JOIN ${t.account_stats} s ON s.account_id = a.id WHERE a.id = ?`, [accountId]);
        const score = rows[0] ? Number(rows[0].xp_earned || 0) : 0;
        if (!score || Number(rows[0].review)) return { rank: null, score };
        return { rank: (await alltimeHigher(Number(rows[0].prestige), score)) + 1, score };
    }

    // ------------------------------------------------------------------ the rollover job

    async function minActivePlayers() {
        const v = flags ? await flags.get('challenges.minActivePlayers') : null;
        return Number.isSafeInteger(v) && v >= 1 && v <= 10000 ? v : SEASON.MIN_ACTIVE_PLAYERS;
    }

    /** Start the next season (and its challenges) from today. Safe to race: UNIQUE (number). */
    async function startSeason() {
        const at = now();
        const [[m]] = await db.query(`SELECT COALESCE(MAX(number), 0) AS n FROM ${t.seasons}`);
        const number = Number(m.n) + 1;
        const w = seasonWindow(Math.floor(at / DAY_MS));
        const minActive = await minActivePlayers();
        try {
            return await withTx(db, async (conn) => {
                const [ins] = await conn.query(
                    `INSERT INTO ${t.seasons} (number, starts_at, ends_at, status, reward_config) VALUES (?, ?, ?, 'active', ?)`,
                    [number, date(w.startsAtMs), date(w.endsAtMs), JSON.stringify({ tiers: 'catalog.SEASON_TIERS', version: 1 })]);
                const seasonId = Number(ins.insertId);
                for (const c of challengesFor({ seasonNumber: number, startsAtMs: w.startsAtMs })) {
                    await conn.query(
                        `INSERT INTO ${t.challenges} (season_id, week, quest_code, starts_at, ends_at, min_active_players, target, status)
                         VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled')`,
                        [seasonId, c.week, c.code, date(c.startsAtMs), date(c.endsAtMs), minActive, c.target]);
                }
                return { id: seasonId, number };
            });
        } catch (err) {
            if (err?.code === 'ER_DUP_ENTRY') return null;
            throw err;
        }
    }

    /** Rank a finished season once (the season row is locked) and mark it 'closing'. */
    async function rankSeason(seasonId) {
        return withTx(db, async (conn) => {
            const [[s]] = await conn.query(`SELECT * FROM ${t.seasons} WHERE id = ? FOR UPDATE`, [seasonId]);
            if (!s || s.status !== 'active') return false;
            const [rows] = await conn.query(
                `SELECT st.account_id, st.score FROM ${t.season_standings} st JOIN ${t.accounts} a ON a.id = st.account_id
                  WHERE st.season_id = ? AND a.review = 0 AND a.status = 'active'`, [seasonId]);
            const ranked = rankStandings(rows);
            for (let i = 0; i < ranked.length; i += 500) {
                const chunk = ranked.slice(i, i + 500);
                const cases = chunk.map(() => 'WHEN ? THEN ?').join(' ');
                await conn.query(
                    `UPDATE ${t.season_standings} SET final_rank = CASE account_id ${cases} END WHERE season_id = ? AND account_id IN (?)`,
                    [...chunk.flatMap(r => [r.account_id, r.final_rank]), seasonId, chunk.map(r => r.account_id)]);
            }
            await conn.query(`UPDATE ${t.season_standings} SET reward_claimed_at = ? WHERE season_id = ? AND final_rank IS NULL AND reward_claimed_at IS NULL`, [date(), seasonId]);
            await conn.query(`UPDATE ${t.seasons} SET status = 'closing', ranked = ? WHERE id = ?`, [ranked.length, seasonId]);
            return true;
        });
    }

    /**
     * Lock the account row; false when the save no longer exists. A save deleted on request (privacy/index.js)
     * between the job reading its batch and paying it is skipped, so the season job carries on.
     */
    async function lockIfPresent(conn, accountId) {
        try {
            await ledger.lockAccount(conn, accountId);
            return true;
        } catch (err) {
            if (err?.code === 'NOT_FOUND') return false;
            throw err;
        }
    }

    /** Pay one standing's season reward. Exactly once: the conditional UPDATE, then the ledger key. */
    async function payStanding(season, accountId, rank, score) {
        return withTx(db, async (conn) => {
            if (!(await lockIfPresent(conn, accountId))) return false;
            const [u] = await conn.query(
                `UPDATE ${t.season_standings} SET reward_claimed_at = ? WHERE season_id = ? AND account_id = ? AND reward_claimed_at IS NULL`,
                [date(), season.id, accountId]);
            if (u.affectedRows !== 1) return false;
            const reward = seasonRewardFor({ seasonNumber: season.number, rank, ranked: Math.max(1, season.ranked || 1), score });
            if (!reward) return true;
            if (reward.cash > 0) {
                await ledger.applyInTx(conn, { accountId, key: `season:${season.id}`, reason: 'season_reward', ref: `s${season.number}`, cash: reward.cash });
            }
            await grantCosmetic(conn, accountId, 'badge', reward.badge, 'season');
            if (reward.decoration) await grantCosmetic(conn, accountId, 'decoration', reward.decoration, 'season');
            await notify(conn, accountId, 'season_reward', {
                number: season.number, rank, of: season.ranked, tier: reward.tier, tierName: SEASON_TIER_NAMES[reward.tier], cash: reward.cash
            });
            await conn.query(`UPDATE ${t.accounts} SET state_version = state_version + 1 WHERE id = ?`, [accountId]);
            return true;
        });
    }

    /** Pay every unpaid standing of a 'closing' season in batches; close it when none are left. */
    async function payoutSeason(seasonId, { signal = null } = {}) {
        let paid = 0;
        for (;;) {
            if (signal?.aborted) return { paid, done: false };
            const [[s]] = await db.query(`SELECT * FROM ${t.seasons} WHERE id = ?`, [seasonId]);
            if (!s || s.status !== 'closing') return { paid, done: s?.status === 'closed' };
            const season = seasonRow(s);
            const [rows] = await db.query(
                `SELECT account_id, final_rank, score FROM ${t.season_standings}
                  WHERE season_id = ? AND final_rank IS NOT NULL AND reward_claimed_at IS NULL ORDER BY final_rank, account_id LIMIT ?`,
                [seasonId, SEASON.PAYOUT_BATCH]);
            if (!rows.length) {
                await db.query(`UPDATE ${t.seasons} SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'closing'`, [date(), seasonId]);
                return { paid, done: true };
            }
            for (const r of rows) {
                if (await payStanding(season, Number(r.account_id), Number(r.final_rank), Number(r.score))) paid++;
            }
        }
    }

    /** Start, run and close the weekly challenges of every season that has open ones. */
    async function advanceChallenges() {
        const at = now();
        const [rows] = await db.query(
            `SELECT c.*, s.number AS season_number FROM ${t.challenges} c JOIN ${t.seasons} s ON s.id = c.season_id
              WHERE c.status IN ('scheduled','active') ORDER BY c.season_id, c.week`);
        const out = { started: 0, skipped: 0, closed: 0, podium: 0 };
        for (const r of rows) {
            const c = challengeRow(r);
            if (c.status === 'scheduled' && c.startsAtMs <= at) {
                // Its week has begun. Count the players seen in the last ACTIVE_WINDOW_DAYS (from now, not from the
                // week's start) and start it once there are enough; until then it waits and is counted again on every
                // run. It is skipped only if the week ends first (H-644: deciding once at the start skipped week 1 of
                // the first season, when nobody had played yet).
                const [[n]] = await db.query(
                    `SELECT COUNT(*) AS n FROM ${t.accounts} WHERE review = 0 AND status = 'active' AND last_seen_at >= ?`,
                    [date(at - SEASON.ACTIVE_WINDOW_DAYS * DAY_MS)]);
                const active = Number(n.n);
                if (c.endsAtMs <= at) {
                    await db.query(`UPDATE ${t.challenges} SET status = 'skipped', active_players = ? WHERE id = ? AND status = 'scheduled'`, [active, c.id]);
                    out.skipped++;
                    continue;
                }
                if (!challengeShouldRun({ activePlayers: active, minActivePlayers: c.minActivePlayers })) {
                    if (active !== c.activePlayers) {
                        await db.query(`UPDATE ${t.challenges} SET active_players = ? WHERE id = ? AND status = 'scheduled'`, [active, c.id]);
                        out.waiting = (out.waiting || 0) + 1;
                    }
                    continue;
                }
                await db.query(`UPDATE ${t.challenges} SET status = 'active', active_players = ? WHERE id = ? AND status = 'scheduled'`, [active, c.id]);
                out.started++;
                c.status = 'active';
            }
            if (c.status === 'active' && c.endsAtMs <= at) {
                out.podium += await payPodium(c, Number(r.season_number));
                await db.query(`UPDATE ${t.challenges} SET status = 'closed', podium_paid_at = ? WHERE id = ? AND status = 'active'`, [date(), c.id]);
                out.closed++;
            }
        }
        return out;
    }

    async function payPodium(c, seasonNumber) {
        const [rows] = await db.query(
            `SELECT q.account_id, q.completed_at FROM ${t.account_quests} q JOIN ${t.accounts} a ON a.id = q.account_id
              WHERE q.period_key = ? AND q.completed_at IS NOT NULL AND a.review = 0 AND a.status = 'active'`, [`c${c.id}`]);
        const podium = challengePodium(rows.map(r => ({ accountId: Number(r.account_id), completedAtMs: ms(r.completed_at) })));
        let paid = 0;
        for (const p of podium) {
            const done = await withTx(db, async (conn) => {
                if (!(await lockIfPresent(conn, p.accountId))) return false;
                const key = `challenge:${c.id}:podium`;
                if (await ledger.findEntry(conn, p.accountId, key, { lock: true })) return false;
                await ledger.applyInTx(conn, { accountId: p.accountId, key, reason: 'challenge', ref: `c${c.id}p${p.place}`, cash: SEASON.CHALLENGE_PODIUM.cash });
                await grantCosmetic(conn, p.accountId, 'badge', `s${seasonNumber}_challenge_podium`, 'challenge');
                await notify(conn, p.accountId, 'challenge_podium', { week: c.week, place: p.place, cash: SEASON.CHALLENGE_PODIUM.cash });
                return true;
            });
            if (done) paid++;
        }
        return paid;
    }

    /**
     * The season job (hourly; overlap guarded by the scheduler and its cross-process lock, and safe without
     * them): rank and pay seasons that ended, start the next one, and move the weekly challenges along.
     */
    async function rollover({ signal = null } = {}) {
        const at = now();
        const out = { ranked: 0, paid: 0, closed: 0, started: null, challenges: null };
        const [due] = await db.query(
            `SELECT id, status FROM ${t.seasons} WHERE status IN ('active','closing') AND ends_at <= ? ORDER BY number`, [date(at)]);
        for (const s of due) {
            if (s.status === 'active' && await rankSeason(Number(s.id))) out.ranked++;
            const r = await payoutSeason(Number(s.id), { signal });
            out.paid += r.paid;
            if (r.done) out.closed++;
        }
        const [open] = await db.query(`SELECT COUNT(*) AS n FROM ${t.seasons} WHERE status IN ('upcoming','active','closing')`);
        if (Number(open[0].n) === 0) out.started = await startSeason();
        out.challenges = await advanceChallenges();
        const changed = out.ranked || out.paid || out.closed || out.started || out.challenges.started || out.challenges.skipped || out.challenges.closed || out.challenges.waiting;
        if (changed) {
            invalidate();
            if (flags) {
                const v = Number(await flags.get('meta.version')) || 0;
                await flags.set('meta.version', v + 1, 'season-rollover');
            }
        }
        return out;
    }

    /** A small counter bumped when seasons or challenges change; part of the state etag. */
    async function metaVersion() {
        if (!flags) return 0;
        const v = Number(await flags.get('meta.version'));
        return Number.isSafeInteger(v) && v >= 0 ? v : 0;
    }

    return {
        current, invalidate, runningChallenge,
        notify, unreadCount, listNotifications, markRead, sweepNotifications,
        ensureQuestRows, progress, claimQuest, questsView,
        seasonPoints, seasonView, seasonDetail,
        statsFor, checkAchievements, claimAchievement, achievementsView, achievementSummary,
        grantCosmetic, badges, decorations,
        leaderboard,
        startSeason, rankSeason, payoutSeason, payStanding, advanceChallenges, rollover, metaVersion,
        CHALLENGES_CATALOG
    };
}
