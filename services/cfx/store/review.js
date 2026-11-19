// Greenhouse Tycoon (cfx v2): the Twitch review save (phase 4). See README "Twitch review account".
//
// One shared account (gh_accounts.review = 1) with one sign-in of platform 'review'. Nobody signs in to it
// with a password or a platform account: a viewer of the Twitch panel can switch to it only while
//   - gh_config 'review.enabled' is true (the owner turns it on for the review and off afterwards; the
//     dashboard's super-admin page has the switch), and
//   - the request carries a valid Twitch extension token for this extension (POST /auth/review), and
//   - if gh_config 'review.channelIds' is a list, the token's channel is in it.
// The session it gets has no refresh token and names only the review sign-in. The save is sandboxed:
// it is never ranked (no season points, left out of every leaderboard and of challenge podiums and active
// player counts), it cannot create or redeem link codes, unlink, rename or Replant, and it has no Discord,
// Twitch or Kick sign-in, so nothing it earns can leave it. The 'review-reset' job puts the same mid-game
// save back every night (and the dashboard can reset it on demand).
import { withTx } from './tx.js';
import { gameError } from '../lib/errors.js';
import { REVIEW, STARTER_KIT, DAY_MS, HOUR_MS, MINUTE_MS } from '../config/game.js';
import { BASE_VARIETIES, baseVariety } from '../config/catalog.js';
import { xpForLevel } from '../domain/economy.js';
import { crossVarieties } from '../domain/breeding.js';
import { periodsAt, questsFor, questTitle } from '../domain/meta.js';
import { readyAt } from '../domain/growth.js';

// The mid-game save: about two weeks of regular play.
export const REVIEW_SAVE = Object.freeze({
    level: 12,
    cash: 25000,
    upgrades: Object.freeze({ grow_lights: 3, irrigation: 2, soil_mix: 1, extra_bench: 4, market_stall: 2, staff_training: 1 }),
    seeds: Object.freeze([[1, 20], [2, 15], [3, 15], [4, 10], [5, 8], [6, 6], [7, 4]]),
    produce: Object.freeze([[1, 0, 40], [2, 1, 25], [4, 2, 12], [5, 0, 18], [6, 1, 9]]),
    boosts: Object.freeze([[1, 3], [2, 2]]),
    hybrids: Object.freeze([[1, 4], [2, 5]]),
    staff: Object.freeze([['gardener', 2], ['propagator', 1]]),
    stats: Object.freeze({ harvests: 180, units_sold: 900, cash_earned: 60000, orders_filled: 12, hybrids_bred: 2, staff_claims: 8, best_streak: 4, quests_claimed: 9 }),
    achievements: Object.freeze([['first_harvest', true], ['harvests_100', false], ['orders_1', false], ['hybrid_1', true], ['level_10', false], ['staff_first', true]]),
    decorations: Object.freeze([['potted_fern', true], ['stone_path', true]])
});

// Tables cleared before the save is put back (the account row itself is kept, so sessions stay valid).
const CLEAR = ['ledger', 'inventory', 'account_varieties', 'plots', 'breeding', 'account_upgrades', 'account_staff', 'account_quests',
    'account_achievements', 'account_stats', 'orders', 'season_standings', 'notifications', 'daily_claims', 'account_cosmetics',
    'replants', 'link_codes', 'sessions'];

export function createReview({ db, t, ledger, now = () => Date.now(), flags = null }) {
    const date = (x = now()) => new Date(x);

    async function enabled() {
        return flags ? (await flags.get('review.enabled')) === true : false;
    }

    /** May a panel token for this channel switch to the review save? Throws REVIEW_UNAVAILABLE if not. */
    async function assertAllowed(channelId) {
        if (!(await enabled())) throw gameError('REVIEW_UNAVAILABLE');
        const channels = flags ? await flags.get('review.channelIds') : null;
        if (Array.isArray(channels) && channels.length && !channels.map(String).includes(String(channelId))) throw gameError('REVIEW_UNAVAILABLE');
    }

    async function find() {
        const [rows] = await db.query(
            `SELECT i.id AS identity_id, i.account_id FROM ${t.identities} i WHERE i.platform = 'review' AND i.platform_user_id = ?`, [REVIEW.PLATFORM_USER_ID]);
        if (!rows.length || rows[0].account_id == null) return null;
        return { identityId: Number(rows[0].identity_id), accountId: Number(rows[0].account_id) };
    }

    /** The review account, created (and filled) the first time. */
    async function ensure() {
        const have = await find();
        if (have) return have;
        await db.query(
            `INSERT IGNORE INTO ${t.identities} (platform, platform_user_id, display_name, created_at, starter_granted_at) VALUES ('review', ?, ?, ?, ?)`,
            [REVIEW.PLATFORM_USER_ID, REVIEW.DISPLAY_NAME, date(), date()]);
        await withTx(db, async (conn) => {
            const [rows] = await conn.query(`SELECT * FROM ${t.identities} WHERE platform = 'review' AND platform_user_id = ? FOR UPDATE`, [REVIEW.PLATFORM_USER_ID]);
            if (rows[0].account_id != null) return;
            const [acc] = await conn.query(
                `INSERT INTO ${t.accounts} (display_name, review, last_seen_at) VALUES (?, 1, NULL)`, [REVIEW.DISPLAY_NAME]);
            await conn.query(`UPDATE ${t.identities} SET account_id = ?, linked_at = ? WHERE id = ?`, [Number(acc.insertId), date(), rows[0].id]);
            await seed(conn, Number(acc.insertId), Number(rows[0].id));
        });
        return find();
    }

    /** Put the mid-game save back. Returns { accountId } or null when there is no review account yet. */
    async function reset() {
        const have = await find();
        if (!have) return null;
        await withTx(db, async (conn) => {
            await ledger.lockAccount(conn, have.accountId);
            await seed(conn, have.accountId, have.identityId);
        });
        if (flags) await flags.set('review.lastResetAt', now(), 'review-reset');
        return have;
    }

    /**
     * A reviewer switches to the save (POST /auth/review). The growing plants of the example save are only
     * mid-growth for about half an hour after a reset, so when nobody has switched to it for FRESH_AFTER_MS the
     * save is put back first; a reviewer who signs in again within that time (the panel renews its session)
     * keeps what they did.
     */
    async function signIn() {
        const who = await ensure();
        if (!who) return null;
        const last = flags ? Number(await flags.get('review.lastSignInAt')) || 0 : 0;
        if (now() - last > REVIEW.FRESH_AFTER_MS) await reset();
        if (flags) await flags.set('review.lastSignInAt', now(), 'review-signin');
        return who;
    }

    /** Nightly: reset once a day, after RESET_HOUR_UTC. */
    async function resetIfDue() {
        const t0 = now();
        if (new Date(t0).getUTCHours() < REVIEW.RESET_HOUR_UTC) return null;
        const last = flags ? Number(await flags.get('review.lastResetAt')) || 0 : 0;
        if (Math.floor(last / DAY_MS) === Math.floor(t0 / DAY_MS)) return null;
        return reset();
    }

    async function seed(conn, accountId, identityId) {
        const t0 = now();
        for (const name of CLEAR) await conn.query(`DELETE FROM ${t[name]} WHERE account_id = ?`, [accountId]);
        await conn.query(`DELETE FROM ${t.daily_claims} WHERE identity_id = ?`, [identityId]);
        const S = REVIEW_SAVE;
        const xp = xpForLevel(S.level) + Math.floor((xpForLevel(S.level + 1) - xpForLevel(S.level)) * 0.4);
        await conn.query(
            `UPDATE ${t.accounts} SET display_name = ?, status = 'active', review = 1, cash = 0, xp = ?, level = ?, prestige = 0,
                    tutorial_step = 0, name_changed_at = NULL, state_version = state_version + 1 WHERE id = ?`,
            [REVIEW.DISPLAY_NAME, xp, S.level, accountId]);
        // Hybrids exist for everyone once bred; the review save "bred" two.
        const hybridIds = [];
        for (const [a, b] of S.hybrids) {
            const h = crossVarieties(baseVariety(a), baseVariety(b));
            await conn.query(
                `INSERT IGNORE INTO ${t.varieties} (parent_a, parent_b, name, rarity, grow_ms, base_yield, base_price, first_bred_by, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`, [h.parentA, h.parentB, h.name.slice(0, 120), h.rarity, h.growMs, h.baseYield, h.basePrice, date()]);
            const [[row]] = await conn.query(`SELECT id FROM ${t.varieties} WHERE parent_a = ? AND parent_b = ?`, [h.parentA, h.parentB]);
            hybridIds.push(Number(row.id));
        }
        await ledger.applyInTx(conn, {
            accountId, key: 'review:seed', reason: 'review_seed', cash: S.cash,
            items: [
                ...S.seeds.map(([id, n]) => ({ kind: 'seed', itemId: id, delta: n })),
                ...hybridIds.map(id => ({ kind: 'seed', itemId: id, delta: 3 })),
                ...S.produce.map(([id, q, n]) => ({ kind: 'produce', itemId: id, quality: q, delta: n })),
                ...S.boosts.map(([id, n]) => ({ kind: 'boost', itemId: id, delta: n }))
            ]
        });
        const discovered = BASE_VARIETIES.filter(v => v.unlockLevel <= S.level && v.id <= 7).map(v => [accountId, v.id, 20]);
        for (const id of hybridIds) discovered.push([accountId, id, 2]);
        await conn.query(`INSERT INTO ${t.account_varieties} (account_id, variety_id, harvested) VALUES ?`, [discovered]);
        await conn.query(`INSERT INTO ${t.account_upgrades} (account_id, node_code, level) VALUES ?`, [Object.entries(S.upgrades).map(([c, l]) => [accountId, c, l])]);
        // Six benches: two ready, three growing, one empty.
        const plots = [];
        const plant = (slot, varietyId, startedAgoMs) => {
            const v = baseVariety(varietyId);
            const planted = t0 - startedAgoMs;
            const ready = readyAt({ plantedAtMs: planted, growMs: v.growMs, speedPct: 15 });
            plots.push([accountId, slot, varietyId, planted, ready, 400 + slot * 60, null, 1]);
        };
        plant(1, 4, 2 * HOUR_MS);
        plant(2, 5, 2 * HOUR_MS);
        plant(3, 6, 4 * MINUTE_MS);
        plant(4, 7, 10 * MINUTE_MS);
        plant(5, 3, 1 * MINUTE_MS);
        plots.push([accountId, 6, null, null, null, null, null, 0]);
        await conn.query(
            `INSERT INTO ${t.plots} (account_id, slot, variety_id, planted_at_ms, ready_at_ms, quality_roll, watered_at_ms, plant_seq) VALUES ?`, [plots]);
        await conn.query(`INSERT INTO ${t.account_staff} (account_id, staff_code, count, last_claim_at_ms) VALUES ?`,
            [S.staff.map(([code, n]) => [accountId, code, n, t0 - 6 * HOUR_MS])]);
        await conn.query(
            `INSERT INTO ${t.breeding} (account_id, parent_a, parent_b, started_at_ms, ready_at_ms, status, created_at) VALUES (?, 3, 6, ?, ?, 'active', ?)`,
            [accountId, t0 - 30 * MINUTE_MS, t0 + 5 * MINUTE_MS, date()]);
        await conn.query(
            `INSERT INTO ${t.account_stats} (account_id, harvests, units_sold, cash_earned, orders_filled, hybrids_bred, staff_claims, xp_earned, best_level, best_streak, quests_claimed)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [accountId, S.stats.harvests, S.stats.units_sold, S.stats.cash_earned, S.stats.orders_filled, S.stats.hybrids_bred, S.stats.staff_claims, xp, S.level, S.stats.best_streak, S.stats.quests_claimed]);
        await conn.query(`INSERT INTO ${t.account_achievements} (account_id, achievement_code, unlocked_at, claimed_at) VALUES ?`,
            [S.achievements.map(([code, claimed]) => [accountId, code, date(t0 - DAY_MS), claimed ? date(t0 - DAY_MS) : null])]);
        await conn.query(`INSERT INTO ${t.account_cosmetics} (account_id, kind, code, source, placed, acquired_at) VALUES ?`,
            [S.decorations.map(([code, placed]) => [accountId, 'decoration', code, 'review', placed ? 1 : 0, date(t0 - DAY_MS)])]);
        // Today's quests: one done and ready to collect, one half way.
        const periods = periodsAt(t0);
        const daily = questsFor({ accountId, period: 'daily', index: periods.dayIndex, level: S.level });
        const weekly = questsFor({ accountId, period: 'weekly', index: periods.weekIndex, level: S.level });
        const rows = [
            ...daily.map((q, i) => [accountId, q.code, periods.daily, i === 0 ? q.target : Math.floor(q.target / 2), q.target, q.reward.cash, q.reward.xp, i === 0 ? date(t0 - HOUR_MS) : null]),
            ...weekly.map((q, i) => [accountId, q.code, periods.weekly, i === 0 ? Math.floor(q.target / 3) : 0, q.target, q.reward.cash, q.reward.xp, null])
        ];
        await conn.query(
            `INSERT INTO ${t.account_quests} (account_id, quest_code, period_key, progress, target, reward_cash, reward_xp, completed_at) VALUES ?`, [rows]);
        await conn.query(`INSERT INTO ${t.notifications} (account_id, kind, payload, created_at) VALUES ?`, [[
            [accountId, 'achievement', JSON.stringify({ code: 'harvests_100', name: 'Green thumb' }), date(t0 - 2 * HOUR_MS)],
            [accountId, 'quest', JSON.stringify({ code: daily[0].code, periodKey: periods.daily, title: questTitle(daily[0].metric, daily[0].target) }), date(t0 - HOUR_MS)]
        ]]);
        return { accountId, starterCash: STARTER_KIT.cash };
    }

    return { enabled, assertAllowed, find, ensure, signIn, reset, resetIfDue, seed };
}
