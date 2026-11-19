// Greenhouse Tycoon (cfx v2), phase 4: everything that pays must pay once under races.
//   - the same quest claimed 10 times at once; the same achievement 10 times at once
//   - the season payout run by several jobs at once (and a direct payout beside them)
//   - one daily reward per account per day across the website, the Discord bot (integrations/bot.js) and the
//     panel, all at once, through two sign-ins linked to one account
//   - Replant and a decoration bought by parallel requests
// After each race the account's cash equals the sum of its ledger.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setupTestDb, closePool, startApp, makeAccount } from './_helpers.js';
import { createAuth } from '../../../services/cfx/http/auth.js';
import { createGame } from '../../../services/cfx/store/game.js';
import { createGreenhouseBridge } from '../../../services/cfx/integrations/bot.js';
import { REPLANT, DAY_MS, HOUR_MS } from '../../../services/cfx/config/game.js';
import { xpForLevel } from '../../../services/cfx/domain/economy.js';
import { periodsAt } from '../../../services/cfx/domain/meta.js';

let ctx, auth, srv, clock, game, bridge;
const secret = crypto.randomBytes(32).toString('hex');

before(async () => {
    clock = Date.UTC(2027, 4, 3, 10, 0, 0);
    ctx = await setupTestDb({ now: () => clock });
    auth = createAuth({ secret, store: ctx.store });
    game = createGame({ store: ctx.store });
    bridge = createGreenhouseBridge({ db: ctx.pool, prefix: ctx.prefix, now: () => clock });
    srv = await startApp({
        store: ctx.store, auth, game, rateLimits: false,
        config: {
            publicUrl: 'https://certifriedmultitool.com', publicOrigin: 'https://certifriedmultitool.com', publicPrefix: '/gh-api',
            gamePath: '/greenhouse', allowDevPlatform: true, twitchExt: { clientId: 'x', secret: null }, twitchOAuth: {}, kickOAuth: {}, dashboardSecret: ''
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

const uid = () => `p4c-${crypto.randomBytes(5).toString('hex')}`;
async function devPlayer(name = 'Racer') {
    const r = await srv.call('POST', '/auth/dev', { body: { userId: uid(), name }, key: false });
    assert.equal(r.status, 200, r.text);
    return r.json;
}
const post = (token, path, body = {}, key = true) => srv.call('POST', path, { token, body, key });
async function ledgerMatches(accountId) {
    const [[a]] = await ctx.pool.query(`SELECT cash FROM ${ctx.t.accounts} WHERE id = ?`, [accountId]);
    const [[l]] = await ctx.pool.query(`SELECT COALESCE(SUM(cash_delta), 0) AS s FROM ${ctx.t.ledger} WHERE account_id = ?`, [accountId]);
    assert.equal(Number(a.cash), Number(l.s), `cash equals the ledger for account ${accountId}`);
}
const count = async (sql, args) => Number((await ctx.pool.query(sql, args))[0][0].n);

describe('races', () => {
    test('one quest claimed 10 times at once pays once', async () => {
        const p = await devPlayer();
        const key = periodsAt(clock).daily;
        await ctx.pool.query(`DELETE FROM ${ctx.t.account_quests} WHERE account_id = ? AND period_key = ?`, [p.accountId, key]);
        await ctx.pool.query(
            `INSERT INTO ${ctx.t.account_quests} (account_id, quest_code, period_key, progress, target, reward_cash, reward_xp, completed_at) VALUES (?, 'd_plant', ?, 3, 3, 777, 20, ?)`,
            [p.accountId, key, new Date(clock)]);
        const res = await Promise.all(Array.from({ length: 10 }, (_, i) => post(p.token, '/quests/claim', { periodKey: key, code: 'd_plant' }, `quest-race-${i}-xxxx`)));
        assert.ok(res.every(r => r.status === 200), res.map(r => r.status).join(','));
        assert.equal(res.filter(r => r.json.result.replayed === false).length, 1);
        assert.equal(await count(`SELECT COUNT(*) AS n FROM ${ctx.t.ledger} WHERE account_id = ? AND reason = 'quest'`, [p.accountId]), 1);
        const [[s]] = await ctx.pool.query(`SELECT quests_claimed FROM ${ctx.t.account_stats} WHERE account_id = ?`, [p.accountId]);
        assert.equal(Number(s.quests_claimed), 1);
        await ledgerMatches(p.accountId);
    });

    test('one achievement claimed 10 times at once pays once', async () => {
        const p = await devPlayer();
        await ctx.pool.query(`INSERT INTO ${ctx.t.account_achievements} (account_id, achievement_code) VALUES (?, 'orders_50')`, [p.accountId]);
        const res = await Promise.all(Array.from({ length: 10 }, () => post(p.token, '/achievements/claim', { code: 'orders_50' })));
        assert.ok(res.every(r => r.status === 200));
        assert.equal(res.filter(r => r.json.result.replayed === false).length, 1);
        assert.equal(await count(`SELECT COUNT(*) AS n FROM ${ctx.t.ledger} WHERE account_id = ? AND reason = 'achievement'`, [p.accountId]), 1);
        await ledgerMatches(p.accountId);
    });

    test('the season payout run by several jobs at once pays each standing once', async () => {
        const started = await ctx.store.meta.startSeason();
        assert.ok(started);
        const ids = [];
        for (let i = 0; i < 40; i++) {
            const id = await makeAccount(ctx.store, { name: `Payout ${i}` });
            ids.push(id);
            await ctx.pool.query(`INSERT INTO ${ctx.t.season_standings} (season_id, account_id, score) VALUES (?, ?, ?)`, [started.id, id, 200 + (i % 7) * 50]);
        }
        const [[season]] = await ctx.pool.query(`SELECT * FROM ${ctx.t.seasons} WHERE id = ?`, [started.id]);
        clock = new Date(season.ends_at).getTime() + HOUR_MS;
        ctx.store.meta.invalidate();
        const runs = await Promise.allSettled([
            ctx.store.meta.rollover(), ctx.store.meta.rollover(), ctx.store.meta.rollover(),
            (async () => { await ctx.store.meta.rankSeason(started.id); return ctx.store.meta.payoutSeason(started.id); })(),
            ctx.store.meta.payoutSeason(started.id)
        ]);
        for (const r of runs) assert.equal(r.status, 'fulfilled', r.reason?.message);
        await ctx.store.meta.rollover();
        for (const id of ids) {
            assert.equal(await count(`SELECT COUNT(*) AS n FROM ${ctx.t.ledger} WHERE account_id = ? AND reason = 'season_reward'`, [id]), 1, `account ${id}`);
            assert.equal(await count(`SELECT COUNT(*) AS n FROM ${ctx.t.notifications} WHERE account_id = ? AND kind = 'season_reward'`, [id]), 1);
            await ledgerMatches(id);
        }
        const [[s]] = await ctx.pool.query(`SELECT status FROM ${ctx.t.seasons} WHERE id = ?`, [started.id]);
        assert.equal(s.status, 'closed');
        assert.equal(await count(`SELECT COUNT(*) AS n FROM ${ctx.t.seasons} WHERE status = 'active'`), 1, 'exactly one next season');
    });

    test('one daily per account per day across the website, Discord and the panel', async () => {
        const web = await devPlayer('Daily Racer');
        const discordId = String(100000000000000000n + BigInt(crypto.randomInt(1e9)));
        assert.equal((await bridge.ready()), true);
        // Link the Discord sign-in to the website save with a code made on the website.
        const code = await post(web.token, '/account/link-code', {});
        assert.equal(code.status, 201, code.text);
        const linked = await bridge.redeem(discordId, code.json.code, 'Daily Racer');
        assert.equal(linked.ready, true);
        assert.equal(linked.error, undefined, JSON.stringify(linked.error));
        assert.equal(linked.accountId, web.accountId);
        const discordIdentity = (await ctx.store.accounts.findIdentity('discord', discordId)).identityId;
        const results = await Promise.allSettled([
            post(web.token, '/daily', {}), post(web.token, '/daily', {}), post(web.token, '/daily', {}),
            bridge.daily(discordId), bridge.daily(discordId), bridge.daily(discordId),
            game.claimDaily(web.accountId, { identityId: discordIdentity }), game.claimDaily(web.accountId, { identityId: web.identityId })
        ]);
        const okWeb = results.slice(0, 3).filter(r => r.value?.status === 200).length;
        const okBot = results.slice(3, 6).filter(r => r.value?.ready && !r.value.error).length;
        const okDirect = results.slice(6).filter(r => r.status === 'fulfilled').length;
        assert.equal(okWeb + okBot + okDirect, 1, `exactly one claim won (web ${okWeb}, bot ${okBot}, direct ${okDirect})`);
        for (const r of results.slice(3, 6)) if (r.value?.error) assert.equal(r.value.error.code, 'DAILY_ALREADY_CLAIMED');
        assert.equal(await count(`SELECT COUNT(*) AS n FROM ${ctx.t.ledger} WHERE account_id = ? AND reason = 'daily'`, [web.accountId]), 1);
        assert.equal(await count(`SELECT COUNT(*) AS n FROM ${ctx.t.daily_claims} WHERE account_id = ?`, [web.accountId]), 1);
        // The next day the bot claims first and the website is refused.
        clock += DAY_MS;
        const bot = await bridge.daily(discordId);
        assert.equal(bot.error, undefined);
        assert.equal(bot.claim.streak, 2);
        const w = await post(web.token, '/daily', {});
        assert.equal(w.status, 409);
        assert.equal(w.json.error.code, 'DAILY_ALREADY_CLAIMED');
        const st = await bridge.status(discordId);
        assert.equal(st.linked, true);
        assert.equal(st.daily.claimedToday, true);
        await ledgerMatches(web.accountId);
    });

    test('Replant sent six times at once happens once', async () => {
        const p = await devPlayer();
        await ctx.pool.query(`UPDATE ${ctx.t.accounts} SET xp = ?, level = ? WHERE id = ?`, [xpForLevel(REPLANT.MIN_LEVEL), REPLANT.MIN_LEVEL, p.accountId]);
        await ctx.store.ledger.apply({ accountId: p.accountId, key: 'fund-replant-race', reason: 'admin_adjust', cash: 123456, items: [{ kind: 'produce', itemId: 2, quality: 1, delta: 9 }] });
        const res = await Promise.all(Array.from({ length: 6 }, (_, i) => post(p.token, '/replant', { prestige: 0 }, `replant-race-${i}-xx`)));
        assert.ok(res.every(r => r.status === 200), res.map(r => `${r.status} ${r.json?.error?.code || ''}`).join(','));
        assert.equal(res.filter(r => r.json.result.replayed === false).length, 1);
        const [[a]] = await ctx.pool.query(`SELECT prestige, level FROM ${ctx.t.accounts} WHERE id = ?`, [p.accountId]);
        assert.equal(Number(a.prestige), 1);
        assert.equal(await count(`SELECT COUNT(*) AS n FROM ${ctx.t.replants} WHERE account_id = ?`, [p.accountId]), 1);
        assert.equal(await count(`SELECT COUNT(*) AS n FROM ${ctx.t.ledger} WHERE account_id = ? AND idempotency_key LIKE 'replant:1:kit'`, [p.accountId]), 1);
        await ledgerMatches(p.accountId);
    });

    test('a decoration bought six times at once is paid once', async () => {
        const p = await devPlayer();
        await ctx.pool.query(`UPDATE ${ctx.t.accounts} SET xp = ?, level = 20 WHERE id = ?`, [xpForLevel(20), p.accountId]);
        await ctx.store.ledger.apply({ accountId: p.accountId, key: 'fund-decor-race', reason: 'admin_adjust', cash: 100000 });
        const res = await Promise.all(Array.from({ length: 6 }, () => post(p.token, '/decorations/buy', { code: 'bird_bath' })));
        assert.ok(res.every(r => r.status === 200), res.map(r => r.status).join(','));
        assert.equal(await count(`SELECT COUNT(*) AS n FROM ${ctx.t.ledger} WHERE account_id = ? AND reason = 'decoration'`, [p.accountId]), 1);
        const [[a]] = await ctx.pool.query(`SELECT cash FROM ${ctx.t.accounts} WHERE id = ?`, [p.accountId]);
        assert.equal(Number(a.cash), 500 + 100000 - 40000);
        await ledgerMatches(p.accountId);
    });
});

describe('the bot bridge', () => {
    test('answers ready: false while the tables are missing', async () => {
        const missing = createGreenhouseBridge({ db: ctx.pool, prefix: 'ghtest_000000_', now: () => clock });
        assert.deepEqual(await missing.status('123456789012345678'), { ready: false });
        assert.deepEqual(await missing.daily('123456789012345678'), { ready: false });
        assert.deepEqual(await missing.jobsStatus(), { ready: false });
    });

    test('status of an unknown Discord user; daily creates a save once; link code; kill switch', async () => {
        const id = String(200000000000000000n + BigInt(crypto.randomInt(1e9)));
        const s0 = await bridge.status(id);
        assert.equal(s0.linked, false);
        assert.match(s0.gameUrl, /\/greenhouse$/);
        const d = await bridge.daily(id, 'Moss \u{1F331}');
        assert.equal(d.createdAccount, true);
        assert.equal(d.starterGranted, true);
        const s1 = await bridge.status(id);
        assert.equal(s1.linked, true);
        assert.equal(s1.account.displayName, 'Moss');
        assert.equal(s1.daily.claimedToday, true);
        const again = await bridge.daily(id);
        assert.equal(again.error.code, 'DAILY_ALREADY_CLAIMED');
        const lc = await bridge.linkCode(id);
        assert.match(lc.code, /^[A-Z2-9]{8}$/);
        assert.ok(lc.expiresAt > clock);
        const bad = await bridge.redeem(id, 'ZZZZZZZZ');
        assert.equal(bad.error.code, 'LINK_CODE_INVALID');
        assert.deepEqual((await bridge.setJobsDisabled(['season-rollover'], '111111111111111111')).disabled, ['season-rollover']);
        assert.equal(await ctx.store.flags.jobDisabled('season-rollover'), true);
        assert.equal(await ctx.store.flags.jobDisabled('market-day'), false);
        const js = await bridge.jobsStatus();
        assert.deepEqual(js.disabled, ['season-rollover']);
        await bridge.setJobsDisabled(false, '111111111111111111');
        await assert.rejects(() => bridge.setJobsDisabled('all', 'x'), RangeError);
        const players = await bridge.communityPlayers([id, '999999999999999999', 'not-an-id']);
        assert.equal(players.players.length, 1);
        assert.equal(players.players[0].discordId, id);
    });
});
