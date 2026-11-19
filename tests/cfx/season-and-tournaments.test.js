// CertiFried Tycoon (cfx): season ranking, rewards and naming (game/season-system.js, H-408) and the
// rule for starting weekly tournaments (jobs/tournament-tick.js, H-409). Pure functions only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseRewardConfig, rewardForRank, rankStandings, nextSeasonName, DEFAULT_REWARD_CONFIG, SEASON_LENGTH_DAYS
} from '../../services/certifried-extension/game/season-system.js';
import { templatesToCreate, minActivePlayers, TOURNAMENT_TEMPLATES } from '../../services/certifried-extension/jobs/tournament-tick.js';

test('seasons last 30 days', () => {
    assert.equal(SEASON_LENGTH_DAYS, 30);
});

test('reward config: empty or junk means "no rewards defined"; valid JSON text and objects parse', () => {
    for (const raw of [null, undefined, '', '   ', 'not json', '{}', { ranks: [] }, { ranks: [{ from: 0, to: 0, cash: 5 }] }]) {
        assert.equal(parseRewardConfig(raw), null, JSON.stringify(raw));
    }
    const cfg = parseRewardConfig(JSON.stringify({ ranks: [{ from: 1, to: 1, cash: '500', prestige_tokens: 1 }], participation: { cash: 10 } }));
    assert.deepEqual(cfg, { ranks: [{ from: 1, to: 1, cash: 500, prestige_tokens: 1 }], participation: { cash: 10, prestige_tokens: 0 } });
    assert.ok(parseRewardConfig(DEFAULT_REWARD_CONFIG), 'the documented default parses');
});

test('default rewards: 1st 100k + 3 tokens, 2nd 60k + 2, 3rd 40k + 1, 4th-10th 15k, then 2.5k', () => {
    const cfg = parseRewardConfig(DEFAULT_REWARD_CONFIG);
    assert.deepEqual(rewardForRank(cfg, 1), { cash: 100000, prestige_tokens: 3 });
    assert.deepEqual(rewardForRank(cfg, 2), { cash: 60000, prestige_tokens: 2 });
    assert.deepEqual(rewardForRank(cfg, 3), { cash: 40000, prestige_tokens: 1 });
    assert.deepEqual(rewardForRank(cfg, 4), { cash: 15000, prestige_tokens: 0 });
    assert.deepEqual(rewardForRank(cfg, 10), { cash: 15000, prestige_tokens: 0 });
    assert.deepEqual(rewardForRank(cfg, 11), { cash: 2500, prestige_tokens: 0 });
    assert.deepEqual(rewardForRank(null, 1), { cash: 0, prestige_tokens: 0 });
});

test('standings: season XP first, then earnings, then harvests; nobody with nothing earned; ties by older player', () => {
    const rows = [
        { player_id: 5, season_xp: 100, season_earnings: 0, season_sales: 0 },
        { player_id: 2, season_xp: 300, season_earnings: 10, season_sales: 1 },
        { player_id: 9, season_xp: 0, season_earnings: 0, season_sales: 0 },
        { player_id: 3, season_xp: 100, season_earnings: 50, season_sales: 0 },
        { player_id: 4, season_xp: 100, season_earnings: 50, season_sales: 0 },
        { player_id: 7, season_xp: '0', season_earnings: '900', season_sales: null }
    ];
    const ranked = rankStandings(rows);
    assert.deepEqual(ranked.map(r => [r.final_rank, r.player_id]), [[1, 2], [2, 3], [3, 4], [4, 5], [5, 7]]);
    const byEarnings = rankStandings(rows, { primary: 'season_earnings' });
    assert.deepEqual(byEarnings.map(r => r.player_id), [7, 3, 4, 2, 5], 'logged (legacy) seasons rank by earnings');
    assert.equal(rows[0].final_rank, undefined, 'input rows are not modified');
});

test('season names count up', () => {
    assert.equal(nextSeasonName('Season 1', 1), 'Season 2');
    assert.equal(nextSeasonName('season 12', 3), 'Season 13');
    assert.equal(nextSeasonName('Spring Bloom', 4), 'Season 5');
    assert.equal(nextSeasonName(null, 0), 'Season 1');
});

test('tournaments start only with enough active players, and only the types not already running', () => {
    assert.deepEqual(templatesToCreate([], 0, 2), []);
    assert.deepEqual(templatesToCreate([], 1, 2), []);
    assert.deepEqual(templatesToCreate([], 2, 2).map(t => t.type), TOURNAMENT_TEMPLATES.map(t => t.type));
    assert.deepEqual(templatesToCreate(['harvest', 'quality'], 5, 2).map(t => t.type), ['sales']);
    assert.deepEqual(templatesToCreate(['harvest', 'sales', 'quality'], 5, 2), []);
});

test('tournament minimum comes from CFX_TOURNAMENT_MIN_ACTIVE_PLAYERS (default 2, junk ignored)', () => {
    const saved = process.env.CFX_TOURNAMENT_MIN_ACTIVE_PLAYERS;
    try {
        delete process.env.CFX_TOURNAMENT_MIN_ACTIVE_PLAYERS;
        assert.equal(minActivePlayers(), 2);
        process.env.CFX_TOURNAMENT_MIN_ACTIVE_PLAYERS = '5';
        assert.equal(minActivePlayers(), 5);
        process.env.CFX_TOURNAMENT_MIN_ACTIVE_PLAYERS = 'zero';
        assert.equal(minActivePlayers(), 2);
        process.env.CFX_TOURNAMENT_MIN_ACTIVE_PLAYERS = '0';
        assert.equal(minActivePlayers(), 2);
    } finally {
        if (saved === undefined) delete process.env.CFX_TOURNAMENT_MIN_ACTIVE_PLAYERS;
        else process.env.CFX_TOURNAMENT_MIN_ACTIVE_PLAYERS = saved;
    }
});
