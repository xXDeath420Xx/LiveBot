// Greenhouse Tycoon (cfx v2), phase 4: the meta game's pure rules (domain/meta.js) and the starting name
// of a new website account. No database.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    weekOfDay, weekKey, periodsAt, questTarget, questReward, questsFor, advance, achievementProgress, seasonWindow,
    challengesFor, seasonRewardFor, challengePodium, salePoints, replantBonus, canReplant, withPrestige, boostedXp,
    clearingOps, questSeasonPoints, SOLD_DECORATIONS
} from '../../../services/cfx/domain/meta.js';
import { QUESTS_CATALOG, CHALLENGES_CATALOG, ACHIEVEMENTS, DECORATIONS, SEASON_TIERS, QUEST_METRICS, achievement } from '../../../services/cfx/config/catalog.js';
import { QUESTS, SEASON, REPLANT, DAY_MS, LIMITS, SEASON_SCORE } from '../../../services/cfx/config/game.js';
import { ACHIEVEMENT_TEXT, DECORATION_NAMES, BADGE_NAMES, QUEST_TEXT, badgeName, notificationText } from '../../../services/cfx/config/copy.js';
import { startingName } from '../../../services/cfx/store/accounts.js';
import { nameProblem } from '../../../services/cfx/lib/name-filter.js';

const day = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);

describe('periods', () => {
    test('weeks start on Monday (UTC) and use ISO week numbers', () => {
        assert.equal(weekKey(weekOfDay(day('2026-11-16'))), 'w2026-47'); // Monday
        assert.equal(weekKey(weekOfDay(day('2026-11-22'))), 'w2026-47'); // Sunday
        assert.equal(weekKey(weekOfDay(day('2026-11-23'))), 'w2026-48');
        assert.equal(weekKey(weekOfDay(day('2027-01-01'))), 'w2026-53'); // 2026 has 53 ISO weeks
        assert.equal(weekKey(weekOfDay(day('2027-01-04'))), 'w2027-01');
        assert.equal(weekKey(weekOfDay(day('2021-01-03'))), 'w2020-53');
        assert.equal(weekKey(weekOfDay(day('2024-12-30'))), 'w2025-01');
    });
    test('periodsAt gives keys and the next reset times', () => {
        const at = Date.UTC(2026, 10, 18, 23, 59, 59);
        const p = periodsAt(at);
        assert.equal(p.daily, 'd2026-11-18');
        assert.equal(p.weekly, 'w2026-47');
        assert.equal(p.dailyEndsAtMs, Date.UTC(2026, 10, 19));
        assert.equal(p.weeklyEndsAtMs, Date.UTC(2026, 10, 23));
        assert.ok(p.daily.length <= 16 && p.weekly.length <= 16, 'fits gh_account_quests.period_key');
    });
});

describe('quests', () => {
    test('catalogue: known metrics, unique codes, text for every metric, targets within caps', () => {
        const codes = new Set();
        for (const q of [...QUESTS_CATALOG, ...CHALLENGES_CATALOG]) {
            assert.ok(!codes.has(q.code), q.code);
            codes.add(q.code);
            assert.ok(QUEST_METRICS.includes(q.metric), q.code);
            assert.ok(QUEST_TEXT[q.metric], q.metric);
            assert.ok(q.code.length <= 32);
        }
        for (const q of QUESTS_CATALOG) {
            for (const level of [1, 10, 50, 100]) {
                const n = questTarget(q, level);
                assert.ok(Number.isSafeInteger(n) && n >= 1 && n <= q.max, `${q.code} at ${level}: ${n}`);
            }
        }
    });
    test('questsFor is deterministic, distinct metrics, the right count, level-gated', () => {
        const a = questsFor({ accountId: 42, period: 'daily', index: 20500, level: 8 });
        const b = questsFor({ accountId: 42, period: 'daily', index: 20500, level: 8 });
        assert.deepEqual(a, b);
        assert.equal(a.length, QUESTS.DAILY_COUNT);
        assert.equal(new Set(a.map(q => q.metric)).size, a.length);
        for (let id = 1; id <= 200; id++) {
            for (const level of [1, 4]) {
                for (const q of questsFor({ accountId: id, period: 'daily', index: 20500 + id, level })) {
                    const def = QUESTS_CATALOG.find(d => d.code === q.code);
                    assert.ok(def.minLevel <= level, `${q.code} offered at level ${level}`);
                    assert.equal(def.period, 'daily');
                }
            }
            assert.equal(questsFor({ accountId: id, period: 'weekly', index: 2900, level: 20 }).length, QUESTS.WEEKLY_COUNT);
        }
        const days = new Set();
        for (let d = 0; d < 30; d++) days.add(questsFor({ accountId: 7, period: 'daily', index: 20500 + d, level: 10 }).map(q => q.code).join(','));
        assert.ok(days.size > 5, 'quests vary from day to day');
    });
    test('rewards grow with level; weekly more than daily; season points', () => {
        assert.ok(questReward('daily', 20).cash > questReward('daily', 1).cash);
        assert.ok(questReward('weekly', 5).cash > questReward('daily', 5).cash * 3);
        assert.equal(questSeasonPoints('daily'), SEASON_SCORE.POINTS.quest);
        assert.equal(questSeasonPoints('weekly'), SEASON_SCORE.POINTS.quest * QUESTS.WEEKLY_SEASON_QUESTS);
        assert.equal(questSeasonPoints('challenge'), SEASON_SCORE.POINTS.quest * QUESTS.CHALLENGE_SEASON_QUESTS);
    });
    test('advance stops at the target and reports completion once', () => {
        assert.deepEqual(advance({ progress: 3, target: 5, completed: false }, 1), { progress: 4, justCompleted: false });
        assert.deepEqual(advance({ progress: 4, target: 5, completed: false }, 9), { progress: 5, justCompleted: true });
        assert.deepEqual(advance({ progress: 5, target: 5, completed: true }, 1), { progress: 5, justCompleted: false });
        assert.throws(() => advance({ progress: 0, target: 5 }, -1));
        assert.throws(() => advance({ progress: 0, target: 5 }, 1.5));
    });
    test('sale points are per 250 cash', () => {
        assert.equal(salePoints(249), 0);
        assert.equal(salePoints(250), 1);
        assert.equal(salePoints(10_000), 40);
        assert.throws(() => salePoints(-1));
    });
});

describe('achievements', () => {
    test('catalogue: unique codes, text for each, badge names exist, sensible rewards', () => {
        const codes = new Set(ACHIEVEMENTS.map(a => a.code));
        assert.equal(codes.size, ACHIEVEMENTS.length);
        for (const a of ACHIEVEMENTS) {
            assert.ok(ACHIEVEMENT_TEXT[a.code], a.code);
            assert.ok(a.cash >= 0 && a.cash <= 100_000, a.code);
            if (a.badge) assert.ok(BADGE_NAMES[a.badge], a.badge);
        }
        assert.equal(achievement('decor_all').target, SOLD_DECORATIONS.length, 'decor_all needs every decoration sold');
    });
    test('progress comes from stats and is capped at the target', () => {
        const p = achievementProgress({ harvests: 150, best_level: 30, replants: 1, decorations: 0 });
        const by = Object.fromEntries(p.map(x => [x.code, x]));
        assert.equal(by.first_harvest.met, true);
        assert.equal(by.harvests_100.met, true);
        assert.equal(by.harvests_1000.met, false);
        assert.equal(by.harvests_1000.progress, 150);
        assert.equal(by.harvests_100.progress, 100);
        assert.equal(by.level_25.met, true);
        assert.equal(by.replant_1.met, true);
        assert.equal(by.decor_1.met, false);
        assert.equal(achievementProgress({}).filter(x => x.met).length, 0);
    });
});

describe('seasons and challenges', () => {
    test('a season is 30 days from a UTC midnight', () => {
        const w = seasonWindow(day('2026-12-01'));
        assert.equal(w.startsAtMs, Date.UTC(2026, 11, 1));
        assert.equal(w.endsAtMs - w.startsAtMs, SEASON.LENGTH_DAYS * DAY_MS);
    });
    test('four weekly challenges, distinct, back to back from the season start', () => {
        const start = Date.UTC(2026, 11, 1);
        const c = challengesFor({ seasonNumber: 3, startsAtMs: start });
        assert.equal(c.length, SEASON.CHALLENGE_WEEKS);
        assert.equal(new Set(c.map(x => x.code)).size, c.length);
        c.forEach((x, i) => {
            assert.equal(x.week, i + 1);
            assert.equal(x.startsAtMs, start + i * 7 * DAY_MS);
            assert.equal(x.endsAtMs, x.startsAtMs + 7 * DAY_MS);
        });
        assert.ok(c[c.length - 1].endsAtMs <= start + SEASON.LENGTH_DAYS * DAY_MS);
        assert.deepEqual(challengesFor({ seasonNumber: 3, startsAtMs: start }), c);
    });
    test('reward tiers: best tier wins, ties share, a minimum score, badge per season', () => {
        const r = (rank, ranked, score) => seasonRewardFor({ seasonNumber: 2, rank, ranked, score });
        assert.equal(r(1, 50, 9000).tier, 'champion');
        assert.equal(r(1, 50, 9000).badge, 's2_champion');
        assert.equal(r(1, 50, 9000).decoration, 'laurel_arch');
        assert.equal(r(3, 50, 5000).tier, 'podium');
        assert.equal(r(10, 50, 5000).tier, 'top10');
        assert.equal(r(13, 50, 900).tier, 'top_quarter');
        assert.equal(r(14, 50, 900).tier, 'grower');
        assert.equal(r(40, 50, 99), null, 'below the minimum score gets nothing');
        assert.equal(r(2, 2, 50), null);
        for (const t of SEASON_TIERS) assert.ok(t.cash <= 25_000, 'season cash stays small next to the economy');
        assert.equal(badgeName('s2_top10'), 'Season 2: Top 10');
        assert.equal(badgeName('botanist'), 'Botanist');
        assert.equal(badgeName('nope'), null);
    });
    test('challenge podium: first finishers, ties by account id', () => {
        const p = challengePodium([
            { accountId: 9, completedAtMs: 300 }, { accountId: 4, completedAtMs: 100 }, { accountId: 2, completedAtMs: 100 }, { accountId: 1, completedAtMs: 500 }
        ]);
        assert.deepEqual(p.map(x => [x.accountId, x.place]), [[2, 1], [4, 2], [9, 3]]);
        assert.deepEqual(challengePodium([]), []);
    });
});

describe('Replant', () => {
    test('bonus per replant, capped', () => {
        assert.deepEqual(replantBonus(0), { pricePct: 0, xpPct: 0 });
        assert.deepEqual(replantBonus(1), { pricePct: REPLANT.PRICE_PCT, xpPct: REPLANT.XP_PCT });
        assert.deepEqual(replantBonus(50), replantBonus(REPLANT.MAX_COUNTED));
        assert.equal(canReplant({ level: REPLANT.MIN_LEVEL - 1 }), false);
        assert.equal(canReplant({ level: REPLANT.MIN_LEVEL }), true);
    });
    test('effects and XP with the bonus', () => {
        const e = withPrestige({ price_pct: 9, speed_pct: 5 }, 2);
        assert.equal(e.price_pct, 9 + 2 * REPLANT.PRICE_PCT);
        assert.equal(e.xp_pct, 2 * REPLANT.XP_PCT);
        assert.equal(e.speed_pct, 5);
        assert.equal(boostedXp(100, 20), 120);
        assert.equal(boostedXp(7, 10), 7);
        assert.equal(boostedXp(0, 50), 0);
    });
    test('clearing operations respect the ledger limits and list each item once per operation', () => {
        const items = [];
        for (let i = 1; i <= 45; i++) items.push({ kind: 'produce', itemId: i, quality: i % 4, quantity: 10 });
        items.push({ kind: 'seed', itemId: 1, quality: 0, quantity: LIMITS.MAX_ITEM_DELTA * 2 + 5 });
        const ops = clearingOps(items);
        let total = 0;
        for (const op of ops) {
            assert.ok(op.length >= 1 && op.length <= LIMITS.MAX_LINES_PER_OP);
            const keys = op.map(l => `${l.kind}:${l.itemId}:${l.quality}`);
            assert.equal(new Set(keys).size, keys.length);
            for (const l of op) {
                assert.ok(l.delta < 0 && -l.delta <= LIMITS.MAX_ITEM_DELTA);
                total += -l.delta;
            }
        }
        assert.equal(total, 45 * 10 + LIMITS.MAX_ITEM_DELTA * 2 + 5);
        assert.deepEqual(clearingOps([]), []);
    });
});

describe('cosmetics and text', () => {
    test('decorations: unique, named, prices rise with unlock level, one season-only', () => {
        assert.equal(new Set(DECORATIONS.map(d => d.code)).size, DECORATIONS.length);
        for (const d of DECORATIONS) assert.ok(DECORATION_NAMES[d.code], d.code);
        const sold = DECORATIONS.filter(d => d.price != null);
        for (let i = 1; i < sold.length; i++) {
            assert.ok(sold[i].price > sold[i - 1].price);
            assert.ok(sold[i].unlockLevel >= sold[i - 1].unlockLevel);
        }
        assert.ok(sold.reduce((a, d) => a + d.price, 0) >= 15_000_000, 'enough to be a sink for heavy players');
        assert.equal(DECORATIONS.filter(d => d.price == null).length, 1);
    });
    test('notification text never throws', () => {
        assert.equal(typeof notificationText('quest', { title: 'Harvest 4 plants' }), 'string');
        assert.equal(notificationText('nope', {}), '');
        assert.ok(notificationText('season_reward', { number: 1, rank: 2, of: 10, tierName: 'Top 3', cash: 15000 }).includes('$15,000'));
    });
});

describe('starting names (phase 3 follow-up)', () => {
    test('a sign-in name that passes the rules is kept', () => {
        assert.equal(startingName('Crispy'), 'Crispy');
        assert.equal(startingName('Lili Garden'), 'Lili Garden');
        assert.equal(startingName("O'Brien_99"), "O'Brien_99");
    });
    test('symbols and emoji are dropped first; too short or banned names become Grower', () => {
        assert.equal(startingName('Crispy \u{1F35F}'), 'Crispy');
        assert.equal(startingName('★★ Moss ★★'), 'Moss');
        assert.equal(startingName('\u{1F600}'), 'Grower');
        assert.equal(startingName('x'), 'Grower');
        assert.equal(startingName(''), 'Grower');
        assert.equal(startingName(null), 'Grower');
        assert.equal(startingName('CertiFried Admin'), 'Grower');
        assert.equal(startingName('a'.repeat(40)).length, 24);
        // A theme word: the filter's own list, so this test does not spell one out.
        for (const n of ['Garden Moderator', 'Official Grower']) assert.equal(startingName(n), 'Grower');
        assert.ok(nameProblem(startingName('Moss Lover')) === null);
    });
});
