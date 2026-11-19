import test from 'node:test';
import assert from 'node:assert/strict';

/*
 * The activity page's filters come straight from the query string. Only whitelisted values and bound
 * parameters may reach the SQL; anything else is ignored.
 */

const { buildFilter } = await import('../dashboard/services/music-activity.js');
const NOW = 1_800_000_000_000;

test('defaults to 7 days; unknown ranges fall back to it', () => {
    for (const range of [undefined, '1y', "7d' OR 1=1"]) {
        const f = buildFilter({ range }, NOW);
        assert.equal(f.rangeKey, '7d');
        assert.equal(f.sql, 'logged_at >= ?');
        assert.equal(f.params[0].getTime(), NOW - 7 * 24 * 3600 * 1000);
    }
    assert.equal(buildFilter({ range: '90d' }, NOW).rangeKey, '90d');
});

test('server, source and result filters only accept known shapes', () => {
    const f = buildFilter({ guild: '1554057640504721409', source: 'spotify', outcome: 'skipped' }, NOW);
    assert.equal(f.sql, 'logged_at >= ? AND guild_id = ? AND request_source = ? AND outcome = ?');
    assert.deepEqual(f.params.slice(1), ['1554057640504721409', 'spotify', 'skipped']);
    const bad = buildFilter({ guild: '1 OR 1=1', source: 'spotify; DROP TABLE x', outcome: 'won' }, NOW);
    assert.equal(bad.sql, 'logged_at >= ?');
});

test('text search is a bound LIKE with its wildcards escaped', () => {
    const f = buildFilter({ q: '  100%_real\\  ' }, NOW);
    assert.match(f.sql, /\(title LIKE \? OR author LIKE \? OR requester_name LIKE \? OR guild_name LIKE \?\)$/);
    assert.deepEqual(f.params.slice(1), Array(4).fill('%100\\%\\_real\\\\%'));
});

test('the Discord / stream filter and stream bot pseudo servers (sb:<profile>) are accepted; nothing else is', () => {
    const f = buildFilter({ context: 'stream', guild: 'sb:42' }, NOW);
    assert.equal(f.sql, 'logged_at >= ? AND context = ? AND guild_id = ?');
    assert.deepEqual(f.params.slice(1), ['stream', 'sb:42']);
    assert.equal(buildFilter({ context: 'discord' }, NOW).sql, 'logged_at >= ? AND context = ?');
    for (const bad of [{ context: "stream' OR 1=1" }, { guild: 'sb:' }, { guild: 'sb:1 OR 1=1' }, { guild: 'sb:abc' }]) {
        assert.equal(buildFilter(bad, NOW).sql, 'logged_at >= ?', JSON.stringify(bad));
    }
});

test('stream plays are not counted as servers: servers come from Discord plays, streams are totalled and ranked apart (H-757)', async () => {
    const { loadActivity } = await import('../dashboard/services/music-activity.js');
    const sqls = [];
    const pool = {
        async query(sql) {
            sqls.push(sql.replace(/\s+/g, ' '));
            if (/COUNT\(\*\) plays, SUM\(outcome = 'completed'\)/.test(sql)) return [[{ plays: 5, servers: 2, streams: 1, streamPlays: 3 }]];
            if (/context = 'stream' GROUP BY guild_id/.test(sql)) return [[{ id: 'sb:7', name: 'Stream: Maple', plays: 3, listeners: 2, listened: 400 }]];
            if (/MAX\(context = 'stream'\) stream/.test(sql)) return [[{ id: '1554057640504721409', name: 'Maple Hollow', stream: 0, plays: 2 }, { id: 'sb:7', name: 'Stream: Maple', stream: 1, plays: 3 }]];
            return [[]];
        },
    };
    const out = await loadActivity(pool, {}, NOW);
    const totals = sqls.find((s) => s.includes("SUM(outcome = 'completed')"));
    assert.match(totals, /COUNT\(DISTINCT CASE WHEN context <> 'stream' THEN guild_id END\) servers/);
    assert.match(totals, /SUM\(context = 'stream'\) streamPlays/);
    assert.equal(sqls.filter((s) => /MAX\(guild_name\) name, COUNT\(\*\) plays, COUNT\(DISTINCT requester_id\) listeners/.test(s) && s.includes("context <> 'stream' GROUP BY guild_id")).length, 1, 'top servers leave stream plays out');
    assert.deepEqual(out.totals, { plays: 5, servers: 2, streams: 1, streamPlays: 3 });
    assert.deepEqual(out.topStreams.map((r) => [r.id, r.plays]), [['sb:7', 3]]);
    assert.deepEqual(out.guilds.map((g) => [g.id, g.stream]), [['1554057640504721409', false], ['sb:7', true]]);
});
