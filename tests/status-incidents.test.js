import test from 'node:test';
import assert from 'node:assert/strict';

/*
 * Status-page incidents are derived from uptime_events and music_health_events. A start after a
 * start (no clean stop) is an unexpected restart; bursts are one restart-loop incident; a crash or
 * planned stop is resolved by the next start; a music down..up pair is one incident.
 */
const {
    deriveBotIncidents, deriveMusicIncidents, finalizeIncident, summarize, loadIncidents,
    measureRestartDowntime, RESTART_LOOP_GAP_SEC,
} = await import('../dashboard/services/status-incidents.js');

const T = 1_800_000_000;
const ev = (id, type, t, details = null) => ({ id, type, t, details });

test('clean stop then start is a planned maintenance window', () => {
    const inc = deriveBotIncidents([ev(1, 'start', T), ev(2, 'stop', T + 100), ev(3, 'start', T + 160)]);
    assert.equal(inc.length, 1);
    assert.equal(inc[0].type, 'maintenance');
    assert.equal(inc[0].severity, 'info');
    assert.equal(inc[0].end - inc[0].start, 60);
});

test('crash is critical and resolved by the next start', () => {
    const inc = deriveBotIncidents([ev(1, 'start', T), ev(2, 'crash', T + 10, 'boom'), ev(3, 'start', T + 70)]);
    assert.equal(inc[0].type, 'crash');
    assert.equal(inc[0].severity, 'critical');
    assert.equal(inc[0].end, T + 70);
    assert.equal(inc[0].detail, 'boom');
});

test('start after start is an unexpected restart; first start with no context is not', () => {
    const inc = deriveBotIncidents([ev(1, 'start', T), ev(2, 'start', T + 3600)]);
    assert.equal(inc.length, 1);
    assert.equal(inc[0].type, 'restart');
    assert.equal(inc[0].severity, 'minor');
    assert.deepEqual(inc[0].starts, [{ t: T + 3600, prevT: T }]);
    assert.equal(deriveBotIncidents([ev(1, 'start', T)]).length, 0);
});

test('restarts close together are one restart-loop incident', () => {
    const events = [ev(1, 'start', T)];
    for (let i = 0; i < 4; i++) events.push(ev(2 + i, 'start', T + 3600 + i * 60));
    events.push(ev(10, 'start', T + 3600 + 3 * 60 + RESTART_LOOP_GAP_SEC + 1)); // separate
    const inc = deriveBotIncidents(events);
    assert.equal(inc.length, 2);
    assert.equal(inc[0].type, 'restart_loop');
    assert.equal(inc[0].restarts, 4);
    assert.equal(inc[0].severity, 'major');
    assert.equal(inc[1].type, 'restart');
});

test('music down..up pairs, still_down escalates/continues, unpaired down is ongoing', () => {
    const rows = [
        { id: 1, t: T, check_id: 'resolver:a', kind: 'down', severity: 'warning', title: 'Resolver A', detail: 'slow' },
        { id: 2, t: T + 600, check_id: 'resolver:a', kind: 'still_down', severity: 'critical', title: 'Resolver A', detail: 'dead' },
        { id: 3, t: T + 900, check_id: 'resolver:a', kind: 'up', severity: null, title: 'Resolver A', detail: null },
        { id: 4, t: T + 1000, check_id: 'relay', kind: 'down', severity: 'critical', title: 'Relay', detail: 'x' },
        { id: 5, t: T + 1100, check_id: 'ghost', kind: 'up', severity: null, title: 'Ghost', detail: null },
    ];
    const inc = deriveMusicIncidents(rows);
    assert.equal(inc.length, 2);
    assert.equal(inc[0].severity, 'major');
    assert.equal(inc[0].detail, 'dead');
    assert.equal(inc[0].end, T + 900);
    assert.equal(inc[1].end, null);
});

test('finalize: heartbeat measures restart downtime; unmeasured restart has no duration', () => {
    const [restart] = deriveBotIncidents([ev(1, 'start', T), ev(2, 'start', T + 3600)]);
    const measured = finalizeIncident(restart, T + 7200, measureRestartDowntime(restart.starts, [T + 3600 - 900]));
    assert.equal(measured.duration_seconds, 900);
    assert.equal(measured.downtime_measured, true);
    assert.equal(measured.started_at, new Date((T + 3600 - 900) * 1000).toISOString());
    assert.equal(measured.severity, 'major'); // >= 10 min outage
    const unmeasured = finalizeIncident(restart, T + 7200, null);
    assert.equal(unmeasured.duration_seconds, null);
    assert.equal(unmeasured.downtime_measured, false);
    assert.equal(unmeasured.severity, 'minor');
    assert.equal(unmeasured.ongoing, false);
});

test('a restart loop counts only the time actually down, not the up-time between restarts', () => {
    const [loop] = deriveBotIncidents([ev(1, 'start', T), ev(2, 'start', T + 1000), ev(3, 'start', T + 1300), ev(4, 'start', T + 1600)]);
    assert.equal(loop.type, 'restart_loop');
    const m = measureRestartDowntime(loop.starts, [T + 970, T + 1290, T + 1580]);
    assert.deepEqual(m, { firstDownT: T + 970, downtimeSec: 30 + 10 + 20 });
    const f = finalizeIncident(loop, T + 5000, m);
    assert.equal(f.duration_seconds, 60);
    assert.equal(f.span_seconds, 630);
    assert.equal(measureRestartDowntime(loop.starts, [T + 970, null, T + 1580]), null);
    assert.equal(measureRestartDowntime(loop.starts, [T + 970]), null);
});

test('summary counts and downtime', () => {
    const finals = [
        { source: 'bot', severity: 'critical', ongoing: false, downtime_measured: true, duration_seconds: 600 },
        { source: 'bot', severity: 'minor', ongoing: false, downtime_measured: false, duration_seconds: null },
        { source: 'music', severity: 'major', ongoing: true, downtime_measured: true, duration_seconds: 100 },
    ];
    const s = summarize(finals, 1);
    assert.equal(s.total, 3);
    assert.equal(s.ongoing, 1);
    assert.equal(s.bot_downtime_seconds, 600);
    assert.equal(s.by_source.bot, 2);
    assert.equal(s.by_severity.critical, 1);
    assert.ok(Math.abs(s.bot_uptime_percent - (100 * (1 - 600 / 86400))) < 0.01);
});

test('loadIncidents reads, derives, measures and degrades without music tables', async () => {
    const now = T + 86400;
    const calls = [];
    const fakePool = {
        async query(sql) { calls.push(sql); return [[{ nowT: now }]]; },
        async execute(sql, params) {
            calls.push(sql);
            if (/FROM uptime_events/.test(sql) && /timestamp\` </.test(sql)) return [[ev(1, 'start', T)]];
            if (/FROM uptime_events/.test(sql)) return [[ev(2, 'start', T + 3600), ev(3, 'crash', T + 7000, 'x'), ev(4, 'start', T + 7060)]];
            if (/music_health_events/.test(sql)) { const e = new Error('no table'); e.code = 'ER_NO_SUCH_TABLE'; throw e; }
            if (/music_health_samples/.test(sql)) return [[{ t: params[0] - 120 }]];
            throw new Error(`unexpected SQL ${sql}`);
        },
    };
    const r = await loadIncidents(fakePool, { days: 2, limit: 10 });
    assert.equal(r.window_days, 2);
    assert.equal(r.sources.music_health_events, false);
    assert.deepEqual(r.incidents.map(i => i.type), ['crash', 'restart']);
    assert.equal(r.incidents[1].duration_seconds, 120);
    assert.equal(r.incidents[0].duration_seconds, 60);
    assert.equal(r.summary.bot_downtime_seconds, 180);
});
