// Greenhouse Tycoon (cfx v2), phase 4: quests, achievements, seasons, challenges, leaderboards,
// notifications, Replant, decorations and the Twitch review save, over real HTTP on throwaway tables
// (prefix ghtest_<random>_, dropped in after()) with a fake game clock.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setupTestDb, closePool, startApp, errorShape, makeAccount } from './_helpers.js';
import { createAuth } from '../../../services/cfx/http/auth.js';
import { createGame } from '../../../services/cfx/store/game.js';
import { gameError } from '../../../services/cfx/lib/errors.js';
import { HOUR_MS, MINUTE_MS, DAY_MS, REPLANT, STARTER_KIT, SEASON, SEASON_SCORE, LEADERBOARD } from '../../../services/cfx/config/game.js';
import { xpForLevel, sellPrice } from '../../../services/cfx/domain/economy.js';
import { periodsAt, replantBonus } from '../../../services/cfx/domain/meta.js';
import { SEASON_TIERS } from '../../../services/cfx/config/catalog.js';

let ctx, auth, srv, clock, game;
const secret = crypto.randomBytes(32).toString('hex');

// A stand-in for the Twitch extension verifier: tokens look like "panel-<channel>-<opaque>-xxxxxxxx".
const PANEL = /^panel-(\d+)-(U[A-Za-z0-9]+)-x{8,}$/;
function fakeTwitch(token) {
    const m = String(token).match(PANEL);
    if (!m) throw gameError('UNAUTHORIZED');
    return { opaqueId: m[2], userId: null, channelId: m[1], role: 'viewer' };
}
const panelToken = (channel, opaque = 'Ureviewer1') => `panel-${channel}-${opaque}-xxxxxxxxxxxx`;

before(async () => {
    clock = Date.UTC(2027, 2, 1, 9, 0, 0); // a Monday
    ctx = await setupTestDb({ now: () => clock });
    auth = createAuth({ secret, store: ctx.store });
    game = createGame({ store: ctx.store });
    srv = await startApp({
        store: ctx.store, auth, game, rateLimits: false, verifyTwitchExt: fakeTwitch,
        config: {
            publicUrl: 'https://certifriedmultitool.com', publicOrigin: 'https://certifriedmultitool.com', publicPrefix: '/gh-api',
            gamePath: '/greenhouse', allowDevPlatform: true, twitchExt: { clientId: '7k7fn5nym3jx13sdl4d56yxlu0cytp', secret: null },
            twitchOAuth: {}, kickOAuth: {}, dashboardSecret: ''
        }
    });
});

after(async () => {
    try {
        await srv?.close();
        const left = await ctx?.cleanup();
        assert.deepEqual(left, [], 'every ghtest table was dropped');
    } finally {
        await closePool();
    }
});

const uid = () => `p4-${crypto.randomBytes(5).toString('hex')}`;
async function devPlayer(name = 'Grower') {
    const r = await srv.call('POST', '/auth/dev', { body: { userId: uid(), name }, key: false });
    assert.equal(r.status, 200, r.text);
    return r.json;
}
const get = async (token, path) => srv.call('GET', path, { token });
const post = async (token, path, body = {}, key = true) => srv.call('POST', path, { token, body, key });
async function state(token) {
    const r = await get(token, '/state');
    assert.equal(r.status, 200, r.text);
    return r.json.state;
}
async function grant(accountId, { cash = 0, items = [] }) {
    await ctx.store.ledger.apply({ accountId, key: `grant-${crypto.randomBytes(6).toString('hex')}`, reason: 'admin_adjust', cash, items });
}
async function setLevel(accountId, level) {
    await ctx.pool.query(`UPDATE ${ctx.t.accounts} SET xp = ?, level = ? WHERE id = ?`, [xpForLevel(level), level, accountId]);
}
async function ledgerMatches(accountId) {
    const [[a]] = await ctx.pool.query(`SELECT cash FROM ${ctx.t.accounts} WHERE id = ?`, [accountId]);
    const [[l]] = await ctx.pool.query(`SELECT COALESCE(SUM(cash_delta), 0) AS s FROM ${ctx.t.ledger} WHERE account_id = ?`, [accountId]);
    assert.equal(Number(a.cash), Number(l.s), `cash equals the ledger for account ${accountId}`);
}
async function setQuests(accountId, rows) {
    const p = periodsAt(clock);
    await ctx.pool.query(`DELETE FROM ${ctx.t.account_quests} WHERE account_id = ? AND period_key = ?`, [accountId, p.daily]);
    await ctx.pool.query(`INSERT INTO ${ctx.t.account_quests} (account_id, quest_code, period_key, progress, target, reward_cash, reward_xp) VALUES ?`,
        [rows.map(([code, target]) => [accountId, code, p.daily, 0, target, 100, 10])]);
    return p.daily;
}

let main; // the player who plays through the season

describe('state and catalogue', () => {
    test('the state carries quests, season, achievements, notifications, Replant, cosmetics', async () => {
        main = await devPlayer('Season Grower');
        const s = await state(main.token);
        assert.equal(s.quests.daily.length, 3);
        assert.equal(s.quests.weekly.length, 3);
        for (const q of [...s.quests.daily, ...s.quests.weekly]) {
            assert.equal(typeof q.title, 'string');
            assert.ok(q.target >= 1 && q.progress === 0 && !q.completed && !q.claimed);
            assert.ok(q.reward.cash > 0 && q.reward.xp > 0);
        }
        assert.equal(s.quests.dailyKey, periodsAt(clock).daily);
        assert.equal(s.season, null, 'no season before the job first runs');
        assert.ok(s.achievements.total >= 20 && s.achievements.unlocked === 0);
        assert.deepEqual(s.notifications, { unread: 0, more: false });
        assert.equal(s.replant.count, 0);
        assert.equal(s.replant.available, false);
        assert.deepEqual(s.replant.next, replantBonus(1));
        assert.deepEqual(s.cosmetics.decorations, []);
        assert.equal(s.review, null);
        assert.equal(s.account.review, false);
        assert.match(s.etag, /^\d+\.\d+\.\d+$/);
        const again = await state(main.token);
        assert.deepEqual(again.quests.daily.map(q => q.code), s.quests.daily.map(q => q.code), 'quests are made once per day');
        const c = (await srv.call('GET', '/catalog')).json.catalog;
        assert.ok(c.decorations.length >= 10 && c.decorations.some(d => !d.sold));
        assert.equal(c.rules.replant.minLevel, REPLANT.MIN_LEVEL);
    });

    test('a website account starts with its sign-in name when it passes the name rules', async () => {
        const a = await devPlayer('Crispy \u{1F35F}');
        assert.equal((await state(a.token)).account.displayName, 'Crispy');
        const b = await devPlayer('x');
        assert.equal((await state(b.token)).account.displayName, 'Grower');
        const c = await devPlayer('Support Desk');
        assert.equal((await state(c.token)).account.displayName, 'Grower', 'reserved words fall back');
    });
});

describe('season job, quests and the weekly challenge', () => {
    test('the job starts season 1 with four challenges, once', async () => {
        await ctx.store.flags.set('challenges.minActivePlayers', 1, 'test');
        const r1 = await ctx.store.meta.rollover();
        assert.equal(r1.started.number, 1);
        const r2 = await ctx.store.meta.rollover();
        assert.equal(r2.started, null);
        const [seasons] = await ctx.pool.query(`SELECT * FROM ${ctx.t.seasons}`);
        assert.equal(seasons.length, 1);
        const season = seasons[0];
        assert.equal(new Date(season.starts_at).getTime(), Math.floor(clock / DAY_MS) * DAY_MS);
        assert.equal(new Date(season.ends_at).getTime() - new Date(season.starts_at).getTime(), SEASON.LENGTH_DAYS * DAY_MS);
        const [ch] = await ctx.pool.query(`SELECT * FROM ${ctx.t.challenges} WHERE season_id = ? ORDER BY week`, [season.id]);
        assert.equal(ch.length, SEASON.CHALLENGE_WEEKS);
        assert.equal(ch[0].status, 'active', 'week 1 runs: enough active players');
        assert.ok(Number(ch[0].active_players) >= 1);
        assert.ok(ch.slice(1).every(c => c.status === 'scheduled'));
        const s = await state(main.token);
        assert.equal(s.season.number, 1);
        assert.equal(s.season.score, 0);
        assert.equal(s.season.rank, null);
        assert.equal(s.season.challenge.week, 1);
        assert.equal(s.season.dailyCap, SEASON_SCORE.DAILY_CAP);
    });

    test('actions move quests and the challenge; finishing the challenge pays once; points are capped per day', async () => {
        const acc = main.accountId;
        const [[c1]] = await ctx.pool.query(`SELECT id FROM ${ctx.t.challenges} WHERE week = 1`);
        await ctx.pool.query(`UPDATE ${ctx.t.challenges} SET quest_code = 'c_harvest', target = 1 WHERE id = ?`, [c1.id]);
        ctx.store.meta.invalidate();
        const key = await setQuests(acc, [['d_plant', 2], ['d_harvest', 1], ['d_sell', 3]]);
        assert.equal((await post(main.token, '/plots/plant', { slot: 1, varietyId: 1 })).status, 200);
        assert.equal((await post(main.token, '/plots/plant', { slot: 2, varietyId: 1 })).status, 200);
        let s = await state(main.token);
        const plantQ = s.quests.daily.find(q => q.code === 'd_plant');
        assert.equal(plantQ.progress, 2);
        assert.equal(plantQ.completed, true);
        clock += 3 * MINUTE_MS;
        const h = await post(main.token, '/plots/harvest', { slot: 1 });
        assert.equal(h.status, 200, h.text);
        const [chal] = await ctx.pool.query(`SELECT * FROM ${ctx.t.ledger} WHERE account_id = ? AND idempotency_key = ?`, [acc, `challenge:${c1.id}`]);
        assert.equal(chal.length, 1, 'the finished challenge paid');
        assert.equal(Number(chal[0].cash_delta), SEASON.CHALLENGE_REWARD.cash);
        assert.equal((await post(main.token, '/plots/harvest', { slot: 2 })).status, 200);
        const [again] = await ctx.pool.query(`SELECT COUNT(*) AS n FROM ${ctx.t.ledger} WHERE account_id = ? AND reason = 'challenge'`, [acc]);
        assert.equal(Number(again[0].n), 1, 'a second harvest does not pay the challenge again');
        s = await state(main.token);
        const produce = s.inventory.produce.find(p => p.varietyId === 1);
        const sold = await post(main.token, '/sell', { lines: [{ varietyId: 1, quality: produce.quality, quantity: 3 }] });
        assert.equal(sold.status, 200, sold.text);
        s = sold.json.state;
        assert.ok(s.quests.daily.every(q => q.completed), 'all three quests done');
        assert.equal(s.quests.claimable, 3);
        assert.ok(s.notifications.unread >= 4, 'quest and challenge notifications');
        // Score: 2 per harvest, the challenge counts as four quests, sale points.
        const [[st]] = await ctx.pool.query(`SELECT * FROM ${ctx.t.season_standings} WHERE account_id = ?`, [acc]);
        const salePts = Math.floor(sold.json.result.cash / SEASON_SCORE.SALE_CASH_PER_POINT);
        assert.equal(Number(st.score), 2 * SEASON_SCORE.POINTS.harvest + 4 * SEASON_SCORE.POINTS.quest + salePts);
        assert.equal(s.season.score, Number(st.score));
        assert.equal(s.season.rank, 1);
        // Claim: pays once, a retry is a replay, an unfinished or unknown quest is refused.
        const before = s.account.cash;
        const claim = await post(main.token, '/quests/claim', { periodKey: key, code: 'd_plant' });
        assert.equal(claim.status, 200, claim.text);
        assert.equal(claim.json.result.cash, 100);
        assert.equal(claim.json.state.account.cash, before + 100);
        const replay = await post(main.token, '/quests/claim', { periodKey: key, code: 'd_plant' });
        assert.equal(replay.status, 200);
        assert.equal(replay.json.result.replayed, true);
        assert.equal(replay.json.state.account.cash, before + 100);
        errorShape(assert, await post(main.token, '/quests/claim', { periodKey: key, code: 'd_water' }), 'NOT_FOUND');
        const wk = s.quests.weekly[0];
        errorShape(assert, await post(main.token, '/quests/claim', { periodKey: wk.periodKey, code: wk.code }), 'QUEST_NOT_DONE');
        await post(main.token, '/quests/claim', { periodKey: key, code: 'd_harvest' });
        await post(main.token, '/quests/claim', { periodKey: key, code: 'd_sell' });
        // The daily cap.
        await ctx.pool.query(`UPDATE ${ctx.t.season_standings} SET score_today = ? WHERE account_id = ?`, [SEASON_SCORE.DAILY_CAP - 1, acc]);
        const [[b1]] = await ctx.pool.query(`SELECT score FROM ${ctx.t.season_standings} WHERE account_id = ?`, [acc]);
        await post(main.token, '/plots/plant', { slot: 1, varietyId: 1 });
        clock += 3 * MINUTE_MS;
        await post(main.token, '/plots/harvest', { slot: 1 });
        const [[b2]] = await ctx.pool.query(`SELECT score, score_today FROM ${ctx.t.season_standings} WHERE account_id = ?`, [acc]);
        assert.equal(Number(b2.score), Number(b1.score) + 1, 'only 1 point fitted under the cap');
        assert.equal(Number(b2.score_today), SEASON_SCORE.DAILY_CAP);
        await ledgerMatches(acc);
    });

    test('quests of the next day are new; finished ones from yesterday can still be collected', async () => {
        const s0 = await state(main.token);
        const key = s0.quests.dailyKey;
        // Make one of today's quests finished but not collected, then move to tomorrow.
        await ctx.pool.query(`UPDATE ${ctx.t.account_quests} SET claimed_at = NULL WHERE account_id = ? AND period_key = ? AND quest_code = 'd_sell'`, [main.accountId, key]);
        const [[row]] = await ctx.pool.query(`SELECT cash_delta FROM ${ctx.t.ledger} WHERE account_id = ? AND idempotency_key = ?`, [main.accountId, `quest:${key}:d_sell`]);
        await ctx.pool.query(`DELETE FROM ${ctx.t.ledger} WHERE account_id = ? AND idempotency_key = ?`, [main.accountId, `quest:${key}:d_sell`]);
        await ctx.pool.query(`UPDATE ${ctx.t.accounts} SET cash = cash - ? WHERE id = ?`, [Number(row.cash_delta), main.accountId]);
        clock += DAY_MS;
        const s = await state(main.token);
        assert.notEqual(s.quests.dailyKey, key);
        const prev = s.quests.daily.filter(q => q.previous);
        assert.equal(prev.length, 1);
        assert.equal(prev[0].code, 'd_sell');
        assert.equal(s.quests.daily.filter(q => !q.previous).length, 3);
        const c = await post(main.token, '/quests/claim', { periodKey: key, code: 'd_sell' });
        assert.equal(c.status, 200, c.text);
        await ledgerMatches(main.accountId);
    });
});

describe('achievements and notifications', () => {
    test('achievements unlock from stats and pay once; locked ones are refused', async () => {
        const r = await get(main.token, '/achievements');
        assert.equal(r.status, 200);
        const first = r.json.achievements.find(a => a.code === 'first_harvest');
        assert.equal(first.unlocked, true);
        assert.equal(first.claimed, false);
        assert.ok(r.json.claimable >= 1);
        const before = (await state(main.token)).account.cash;
        const c = await post(main.token, '/achievements/claim', { code: 'first_harvest' });
        assert.equal(c.status, 200, c.text);
        assert.equal(c.json.state.account.cash, before + first.reward.cash);
        const again = await post(main.token, '/achievements/claim', { code: 'first_harvest' });
        assert.equal(again.json.result.replayed, true);
        assert.equal(again.json.state.account.cash, before + first.reward.cash);
        errorShape(assert, await post(main.token, '/achievements/claim', { code: 'harvests_10000' }), 'ACHIEVEMENT_LOCKED');
        await ledgerMatches(main.accountId);
    });

    test('notifications: list, page and mark read; the unread count is in the state', async () => {
        const list = await get(main.token, '/notifications');
        assert.equal(list.status, 200);
        assert.ok(list.json.notifications.length >= 4);
        for (const n of list.json.notifications) assert.ok(typeof n.text === 'string' && n.text.length > 5, n.kind);
        const ids = list.json.notifications.map(n => n.id);
        assert.deepEqual(ids, [...ids].sort((a, b) => b - a), 'newest first');
        const older = await get(main.token, `/notifications?before=${ids[1]}`);
        assert.ok(older.json.notifications.every(n => n.id < ids[1]));
        const unread = (await state(main.token)).notifications.unread;
        const part = await post(main.token, '/notifications/read', { upToId: ids[ids.length - 1] });
        assert.equal(part.status, 200);
        assert.equal(part.json.state.notifications.unread, unread - 1);
        const all = await post(main.token, '/notifications/read', {});
        assert.equal(all.json.state.notifications.unread, 0);
        const none = await post(main.token, '/notifications/read', {});
        assert.equal(none.json.result.read, 0);
    });
});

describe('leaderboards', () => {
    let others;
    test('season board: ordered, ties share a rank, paged, with my own row', async () => {
        const cur = (await ctx.store.meta.current()).season;
        others = [];
        for (let i = 0; i < 24; i++) {
            const id = await makeAccount(ctx.store, { name: `Board ${i}` });
            others.push(id);
            const score = i < 2 ? 5000 : 3000 - i * 100;
            await ctx.pool.query(`INSERT INTO ${ctx.t.season_standings} (season_id, account_id, score) VALUES (?, ?, ?)`, [cur.id, id, Math.max(0, score)]);
        }
        ctx.store.meta.invalidate();
        const p1 = await get(main.token, '/leaderboard?board=season&page=1');
        assert.equal(p1.status, 200, p1.text);
        const lb = p1.json.leaderboard;
        assert.equal(lb.rows.length, LEADERBOARD.PAGE_SIZE);
        assert.equal(lb.rows[0].rank, 1);
        assert.equal(lb.rows[1].rank, 1, 'a tie shares the rank');
        assert.equal(lb.rows[2].rank, 3);
        for (let i = 1; i < lb.rows.length; i++) assert.ok(lb.rows[i - 1].score >= lb.rows[i].score);
        const [[n]] = await ctx.pool.query(`SELECT COUNT(*) AS n FROM ${ctx.t.season_standings} WHERE score > 0`);
        assert.equal(lb.total, Number(n.n));
        assert.ok(lb.me.rank >= 1 && lb.me.score > 0);
        const p2 = await get(main.token, '/leaderboard?board=season&page=2');
        assert.ok(p2.json.leaderboard.rows.length >= 1);
        assert.ok(p2.json.leaderboard.rows[0].rank > 20);
    });

    test('all-time board ranks lifetime XP; review saves and suspended accounts are left out', async () => {
        await ctx.pool.query(`INSERT INTO ${ctx.t.account_stats} (account_id, xp_earned) VALUES (?, 999999) ON DUPLICATE KEY UPDATE xp_earned = 999999`, [others[0]]);
        await ctx.pool.query(`UPDATE ${ctx.t.accounts} SET status = 'suspended' WHERE id = ?`, [others[1]]);
        await ctx.pool.query(`INSERT INTO ${ctx.t.account_stats} (account_id, xp_earned) VALUES (?, 888888) ON DUPLICATE KEY UPDATE xp_earned = 888888`, [others[1]]);
        const review = await ctx.store.review.ensure();
        ctx.store.meta.invalidate();
        const r = await get(main.token, '/leaderboard?board=alltime');
        assert.equal(r.status, 200);
        const rows = r.json.leaderboard.rows;
        assert.equal(rows[0].displayName, 'Board 0');
        assert.ok(!rows.some(x => x.displayName === 'Board 1'), 'suspended account left out');
        assert.ok(!rows.some(x => x.displayName === 'Review save'), 'review save left out');
        assert.ok(r.json.leaderboard.me.rank >= 2);
        await ctx.pool.query(`UPDATE ${ctx.t.accounts} SET status = 'active' WHERE id = ?`, [others[1]]);
        assert.ok(review.accountId > 0);
    });
});

describe('season end', () => {
    test('the job ranks, pays each reward once, grants badges and starts season 2', async () => {
        const s1 = (await ctx.store.meta.current()).season;
        clock = s1.endsAtMs + HOUR_MS;
        const r = await ctx.store.meta.rollover();
        assert.equal(r.ranked, 1);
        assert.equal(r.closed, 1);
        assert.equal(r.started.number, 2);
        const [[closed]] = await ctx.pool.query(`SELECT * FROM ${ctx.t.seasons} WHERE id = ?`, [s1.id]);
        assert.equal(closed.status, 'closed');
        const [standings] = await ctx.pool.query(`SELECT * FROM ${ctx.t.season_standings} WHERE season_id = ? ORDER BY final_rank`, [s1.id]);
        assert.ok(standings.every(x => x.reward_claimed_at != null), 'every standing processed');
        const [paid] = await ctx.pool.query(`SELECT account_id, cash_delta FROM ${ctx.t.ledger} WHERE reason = 'season_reward'`);
        const eligible = standings.filter(x => Number(x.score) >= SEASON.PARTICIPATION_MIN_SCORE && x.final_rank != null);
        assert.equal(paid.length, eligible.length);
        const champions = standings.filter(x => Number(x.final_rank) === 1);
        assert.equal(champions.length, 2, 'two tied for first');
        for (const ch of champions) {
            const row = paid.find(p => Number(p.account_id) === Number(ch.account_id));
            assert.equal(Number(row.cash_delta), SEASON_TIERS[0].cash);
            const [b] = await ctx.pool.query(`SELECT code FROM ${ctx.t.account_cosmetics} WHERE account_id = ? AND kind = 'badge'`, [ch.account_id]);
            assert.deepEqual(b.map(x => x.code), ['s1_champion']);
            const [d] = await ctx.pool.query(`SELECT code FROM ${ctx.t.account_cosmetics} WHERE account_id = ? AND kind = 'decoration'`, [ch.account_id]);
            assert.deepEqual(d.map(x => x.code), ['laurel_arch']);
        }
        const again = await ctx.store.meta.rollover();
        assert.equal(again.paid, 0);
        const [paid2] = await ctx.pool.query(`SELECT COUNT(*) AS n FROM ${ctx.t.ledger} WHERE reason = 'season_reward'`);
        assert.equal(Number(paid2[0].n), paid.length, 'nothing paid twice');
        // The week-1 challenge closed and its first finisher got the podium bonus.
        const [chal] = await ctx.pool.query(`SELECT * FROM ${ctx.t.challenges} WHERE season_id = ? ORDER BY week`, [s1.id]);
        assert.ok(chal.every(c => c.status === 'closed' || c.status === 'skipped'));
        const [pod] = await ctx.pool.query(`SELECT * FROM ${ctx.t.ledger} WHERE account_id = ? AND idempotency_key = ?`, [main.accountId, `challenge:${chal[0].id}:podium`]);
        assert.equal(pod.length, 1);
        const detail = await get(main.token, '/season');
        assert.equal(detail.status, 200);
        assert.equal(detail.json.season.number, 2);
        assert.equal(detail.json.lastSeason.number, 1);
        assert.ok(detail.json.lastSeason.rank >= 1);
        assert.equal(detail.json.tiers.length, SEASON_TIERS.length);
        const old = await get(main.token, '/leaderboard?board=season&season=1');
        assert.equal(old.json.leaderboard.season.status, 'closed');
        await ledgerMatches(main.accountId);
    });

    test('a challenge below the minimum active players waits, starts once enough play, and is skipped if its week ends first', async () => {
        const s2 = (await ctx.store.meta.current()).season;
        const week = async (n) => (await ctx.pool.query(`SELECT * FROM ${ctx.t.challenges} WHERE season_id = ? AND week = ?`, [s2.id, n]))[0][0];
        await ctx.pool.query(`UPDATE ${ctx.t.challenges} SET min_active_players = 10000 WHERE season_id = ? AND week IN (2, 3)`, [s2.id]);
        clock = s2.startsAtMs + 7 * DAY_MS + HOUR_MS;
        await ctx.store.meta.rollover();
        // Week 2 has begun with too few players: it waits instead of being skipped for the whole week (H-644).
        let w2 = await week(2);
        assert.equal(w2.status, 'scheduled');
        assert.ok(Number(w2.active_players) < 10000);
        let s = await state(main.token);
        assert.equal(s.season.challenge.status, 'scheduled');
        assert.equal(s.season.challenge.id, Number(w2.id));
        // Enough players later in the week: the next run starts it.
        await ctx.pool.query(`UPDATE ${ctx.t.challenges} SET min_active_players = 1 WHERE id = ?`, [w2.id]);
        clock += 2 * DAY_MS;
        await state(main.token);
        await ctx.store.meta.rollover();
        w2 = await week(2);
        assert.equal(w2.status, 'active');
        s = await state(main.token);
        assert.equal(s.season.challenge.status, 'active');
        // Week 3 never reaches its minimum: skipped once its week is over, not before.
        clock = s2.startsAtMs + 14 * DAY_MS + HOUR_MS;
        await ctx.store.meta.rollover();
        assert.equal((await week(3)).status, 'scheduled');
        assert.equal((await week(2)).status, 'closed');
        clock = s2.startsAtMs + 21 * DAY_MS + HOUR_MS;
        await ctx.store.meta.rollover();
        const w3 = await week(3);
        assert.equal(w3.status, 'skipped');
        assert.ok(Number(w3.active_players) < 10000);
    });
});

describe('Replant', () => {
    test('resets the greenhouse through the ledger, keeps the collection and gives the bonus', async () => {
        const p = await devPlayer('Replanter');
        const acc = p.accountId;
        errorShape(assert, await post(p.token, '/replant', { prestige: 0 }), 'REPLANT_LOCKED');
        await setLevel(acc, REPLANT.MIN_LEVEL);
        await grant(acc, { cash: 2_000_000, items: [{ kind: 'produce', itemId: 4, quality: 2, delta: 50 }, { kind: 'boost', itemId: 1, delta: 4 }] });
        assert.equal((await post(p.token, '/upgrades/buy', { code: 'extra_bench' })).status, 200);
        assert.equal((await post(p.token, '/upgrades/buy', { code: 'grow_lights' })).status, 200);
        assert.equal((await post(p.token, '/staff/hire', { code: 'gardener' })).status, 200);
        await post(p.token, '/plots/plant', { slot: 3, varietyId: 3 });
        const before = await state(p.token);
        assert.equal(before.replant.available, true);
        errorShape(assert, await post(p.token, '/replant', { prestige: 1 }), 'PRESTIGE_MISMATCH');
        const r = await post(p.token, '/replant', { prestige: 0 }, 'replant-key-0001');
        assert.equal(r.status, 200, r.text);
        const s = r.json.state;
        assert.equal(s.account.level, 1);
        assert.equal(s.account.xp, 0);
        assert.equal(s.account.prestige, 1);
        assert.equal(s.account.cash, STARTER_KIT.cash);
        assert.equal(s.plotsOwned, STARTER_KIT.plots);
        assert.ok(s.plots.every(x => x.status === 'empty'));
        assert.ok(s.upgrades.every(u => u.level === 0));
        assert.ok(s.staff.every(x => x.count === 0));
        assert.deepEqual(s.inventory.produce, []);
        assert.deepEqual(s.inventory.boosts, []);
        assert.deepEqual(s.inventory.seeds.map(x => [x.varietyId, x.quantity]), STARTER_KIT.seeds.map(x => [x.varietyId, x.quantity]));
        assert.ok(s.discovered.length >= before.discovered.length, 'the collection is kept');
        assert.deepEqual(s.replant.bonus, replantBonus(1));
        assert.equal(s.effects.price_pct, REPLANT.PRICE_PCT);
        const [hist] = await ctx.pool.query(`SELECT * FROM ${ctx.t.replants} WHERE account_id = ?`, [acc]);
        assert.equal(hist.length, 1);
        assert.equal(Number(hist[0].level_before), REPLANT.MIN_LEVEL);
        // A retry of the same request answers the first result.
        const again = await post(p.token, '/replant', { prestige: 0 }, 'replant-key-0002');
        assert.equal(again.status, 200);
        assert.equal(again.json.result.replayed, true);
        assert.equal(again.json.state.account.prestige, 1);
        await ledgerMatches(acc);
        // The bonus: XP +10 % on a harvest, sale prices +10 %.
        await post(p.token, '/plots/plant', { slot: 1, varietyId: 3 });
        clock += 7 * MINUTE_MS;
        const h = await post(p.token, '/plots/harvest', { slot: 1 });
        assert.equal(h.json.result.harvested[0].xp, Math.floor(12 * 110 / 100));
        const q = h.json.result.harvested[0].quality;
        const demand = h.json.state.market.find(m => m.varietyId === 3).demandPct;
        const sold = await post(p.token, '/sell', { lines: [{ varietyId: 3, quality: q, quantity: 1 }] });
        assert.equal(sold.json.result.sold[0].unitPrice, sellPrice({ basePrice: 10, quality: q, demandPct: demand, pricePct: REPLANT.PRICE_PCT }));
        // A bench bought after the Replant starts a new planting counter, so old harvest keys never repeat.
        await grant(acc, { cash: 10_000 });
        await setLevel(acc, 5);
        // Upgrades bought again after a Replant cost cash again (H-639: the old keys answered them as free replays).
        const cashBefore = (await state(p.token)).account.cash;
        const bench = await post(p.token, '/upgrades/buy', { code: 'extra_bench' });
        assert.equal(bench.status, 200, bench.text);
        assert.equal(bench.json.result.replayed, false);
        assert.ok(bench.json.result.cost > 0);
        assert.equal(bench.json.state.account.cash, cashBefore - bench.json.result.cost);
        const lights = await post(p.token, '/upgrades/buy', { code: 'grow_lights', level: 1 });
        assert.equal(lights.json.result.replayed, false);
        assert.equal(lights.json.state.account.cash, cashBefore - bench.json.result.cost - lights.json.result.cost);
        // A retry of that purchase is still free.
        const lightsAgain = await post(p.token, '/upgrades/buy', { code: 'grow_lights', level: 1 });
        assert.equal(lightsAgain.json.result.replayed, true);
        assert.equal(lightsAgain.json.state.account.cash, lights.json.state.account.cash);
        await ledgerMatches(acc);
        const [[slot3]] = await ctx.pool.query(`SELECT plant_seq FROM ${ctx.t.plots} WHERE account_id = ? AND slot = 3`, [acc]);
        assert.equal(Number(slot3.plant_seq), 1_000_000);
        const ach = (await get(p.token, '/achievements')).json.achievements.find(a => a.code === 'replant_1');
        assert.equal(ach.unlocked, true);
    });
});

describe('decorations', () => {
    test('bought once with cash, shown up to the limit, unlock level and unsold ones refused', async () => {
        const p = await devPlayer('Decorator');
        const acc = p.accountId;
        errorShape(assert, await post(p.token, '/decorations/buy', { code: 'potted_fern' }), 'LEVEL_TOO_LOW');
        await setLevel(acc, 30);
        errorShape(assert, await post(p.token, '/decorations/buy', { code: 'potted_fern' }), 'INSUFFICIENT_FUNDS');
        await grant(acc, { cash: 20_000_000 });
        const b = await post(p.token, '/decorations/buy', { code: 'potted_fern' });
        assert.equal(b.status, 200, b.text);
        assert.equal(b.json.result.placed, true);
        assert.deepEqual(b.json.state.cosmetics.decorations.map(d => d.code), ['potted_fern']);
        const replay = await post(p.token, '/decorations/buy', { code: 'potted_fern' });
        assert.equal(replay.json.result.replayed, true);
        errorShape(assert, await post(p.token, '/decorations/buy', { code: 'laurel_arch' }), 'DECORATION_NOT_SOLD');
        for (const code of ['stone_path', 'bird_bath', 'wind_chime', 'trellis_arch', 'koi_pond', 'glass_cupola']) {
            assert.equal((await post(p.token, '/decorations/buy', { code })).status, 200);
        }
        const s = await state(p.token);
        assert.equal(s.cosmetics.decorations.filter(d => d.placed).length, s.cosmetics.maxPlaced);
        const extra = s.cosmetics.decorations.find(d => !d.placed);
        errorShape(assert, await post(p.token, '/decorations/place', { code: extra.code, placed: true }), 'DECORATION_LIMIT');
        assert.equal((await post(p.token, '/decorations/place', { code: 'potted_fern', placed: false })).status, 200);
        const ok = await post(p.token, '/decorations/place', { code: extra.code, placed: true });
        assert.equal(ok.json.result.changed, true);
        errorShape(assert, await post(p.token, '/decorations/place', { code: 'fountain', placed: true }), 'DECORATION_NOT_OWNED');
        assert.equal((await get(p.token, '/achievements')).json.achievements.find(a => a.code === 'decor_1').unlocked, true);
        await ledgerMatches(acc);
    });
});

describe('the Twitch review save', () => {
    test('closed until the owner opens it; then a sandboxed mid-game save', async () => {
        await ctx.store.flags.set('review.enabled', false, 'test');
        assert.deepEqual((await srv.call('GET', '/review')).json, { review: { enabled: false } });
        errorShape(assert, await srv.call('POST', '/auth/review', { body: { token: panelToken('222') }, key: false }), 'REVIEW_UNAVAILABLE');
        await ctx.store.flags.set('review.enabled', true, 'test');
        await ctx.store.flags.set('review.channelIds', ['111'], 'test');
        errorShape(assert, await srv.call('POST', '/auth/review', { body: { token: panelToken('222') }, key: false }), 'REVIEW_UNAVAILABLE');
        errorShape(assert, await srv.call('POST', '/auth/review', { body: { token: 'not-a-panel-token-at-all' }, key: false }), 'UNAUTHORIZED');
        const r = await srv.call('POST', '/auth/review', { body: { token: panelToken('111') }, key: false });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.json.platform, 'review');
        assert.equal(r.json.refreshToken, null);
        const tok = r.json.token;
        const s = await state(tok);
        assert.equal(s.account.review, true);
        assert.equal(typeof s.review.note, 'string');
        assert.equal(s.account.level, 12);
        assert.equal(s.plotsOwned, 6);
        assert.ok(s.plots.some(p => p.status === 'ready') && s.plots.some(p => p.status === 'growing'));
        assert.ok(s.quests.claimable >= 1);
        assert.ok(s.notifications.unread >= 1);
        assert.equal(s.breeding.length, 1);
        assert.ok(s.staff.some(x => x.count > 0 && x.pending));
        for (const [path, body] of [['/account/link-code', {}], ['/account/link', { code: 'ABCDEFGH' }], ['/account/name', { name: 'Another' }], ['/account/unlink', { identityId: 1 }], ['/replant', { prestige: 0 }]]) {
            errorShape(assert, await post(tok, path, body), 'REVIEW_ACCOUNT', path);
        }
        // Playing works, but is never ranked.
        const ready = s.plots.find(p => p.status === 'ready');
        assert.equal((await post(tok, '/plots/harvest', { slot: ready.slot })).status, 200);
        const [st] = await ctx.pool.query(`SELECT * FROM ${ctx.t.season_standings} WHERE account_id = ?`, [r.json.accountId]);
        assert.equal(st.length, 0, 'no season standing for the review save');
        ctx.store.meta.invalidate();
        const lb = await get(tok, '/leaderboard?board=alltime');
        assert.equal(lb.json.leaderboard.me.rank, null);
        // Reset puts the save back; the session stays valid.
        await ctx.store.review.reset();
        const back = await state(tok);
        assert.equal(back.account.cash, 25000);
        assert.ok(back.plots.filter(p => p.status === 'ready').length >= 2);
        // Nightly: once a day after 04:00 UTC.
        const day = Math.floor(clock / DAY_MS) + 1;
        clock = day * DAY_MS + 3 * HOUR_MS;
        assert.equal(await ctx.store.review.resetIfDue(), null, 'not before 04:00');
        clock = day * DAY_MS + 5 * HOUR_MS;
        assert.ok(await ctx.store.review.resetIfDue());
        assert.equal(await ctx.store.review.resetIfDue(), null, 'once a day');
        await ctx.store.flags.set('review.enabled', false, 'test');
        await ctx.store.flags.set('review.channelIds', [], 'test');
    });
});

describe('contract', () => {
    test('phase 4 routes refuse bad input with the error shape and never a 500', async () => {
        const p = await devPlayer();
        const key = (await state(p.token)).quests.dailyKey;
        const bad = [
            ['/quests/claim', {}], ['/quests/claim', { periodKey: 'x', code: 'd_plant' }], ['/quests/claim', { periodKey: key, code: 'nope' }],
            ['/quests/claim', { periodKey: key, code: 'd_plant', extra: 1 }], ['/quests/claim', { periodKey: 20270301, code: 'd_plant' }],
            ['/quests/claim', { periodKey: 'c12345678901', code: 'c_plant' }],
            ['/achievements/claim', { code: 'nope' }], ['/achievements/claim', { code: 1 }], ['/achievements/claim', {}],
            ['/notifications/read', { upToId: 0 }], ['/notifications/read', { upToId: 'x' }], ['/notifications/read', { upToId: 1.5 }],
            ['/replant', {}], ['/replant', { prestige: -1 }], ['/replant', { prestige: 1.5 }], ['/replant', { prestige: '0' }], ['/replant', { prestige: null }],
            ['/decorations/buy', { code: 'x' }], ['/decorations/buy', {}], ['/decorations/place', { code: 'potted_fern' }],
            ['/decorations/place', { code: 'potted_fern', placed: 'yes' }], ['/decorations/place', { code: [], placed: true }]
        ];
        for (const [path, body] of bad) errorShape(assert, await post(p.token, path, body), 'VALIDATION', `${path} ${JSON.stringify(body)}`);
        for (const q of ['?board=x', '?page=0', `?page=${LEADERBOARD.MAX_PAGES + 1}`, '?page=1.5', '?season=0', '?board=alltime&season=1', '?page=a']) {
            errorShape(assert, await get(p.token, `/leaderboard${q}`), 'VALIDATION', q);
        }
        errorShape(assert, await get(p.token, '/leaderboard?season=999'), 'NOT_FOUND');
        for (const q of ['?before=0', '?before=abc', '?before=-1']) errorShape(assert, await get(p.token, `/notifications${q}`), 'VALIDATION', q);
        for (const path of ['/achievements', '/season', '/leaderboard', '/notifications']) errorShape(assert, await get(null, path), 'UNAUTHORIZED', path);
        errorShape(assert, await post(p.token, '/quests/claim', { periodKey: key, code: 'd_plant' }, false), 'IDEMPOTENCY_KEY_REQUIRED');
        errorShape(assert, await srv.call('POST', '/auth/review', { body: { token: 'short' }, key: false }), 'VALIDATION');
        assert.deepEqual(srv.errorsLogged, [], 'nothing reached the generic 500 handler');
    });

    test('GET /state 304 polling still works with the three-part etag', async () => {
        const p = await devPlayer();
        const s = await state(p.token);
        const r = await get(p.token, `/state?v=${s.etag}`);
        assert.equal(r.status, 304);
        await ctx.store.flags.set('meta.version', 999, 'test');
        const r2 = await get(p.token, `/state?v=${s.etag}`);
        assert.equal(r2.status, 200, 'a season change refreshes clients');
    });
});
