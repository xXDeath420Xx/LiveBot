/**
 * Shapes the music health monitor's output for the super-admin "Music health" page:
 *   - data/music-health.json      the monitor's latest snapshot (written every tick)
 *   - music_health_samples/events the history (migration 255)
 * Pure functions plus one loader; the route is dashboard/routes/music-health.js.
 */

const H = 3600 * 1000;
const D = 24 * H;

/** Timeline resolution per range, and how sparsely to read the metrics column (counters are cumulative). */
export const RANGES = {
    '24h': { ms: D, buckets: 96, metricStride: 1 },        // 15-minute buckets
    '7d': { ms: 7 * D, buckets: 168, metricStride: 5 },    // 1-hour buckets
    '30d': { ms: 30 * D, buckets: 120, metricStride: 20 }, // 6-hour buckets
};

const RESOLVER_LABELS = { server2: 'server2 · Comcast', workstation: 'Workstation · Ziply' };

/** Which panel a check id belongs to: youtube:residential, resolver:X:*, tunnel:X:*, server1:*, spotify:*, sentinel:*. */
export function componentOf(checkId) {
    const [kind, name] = String(checkId).split(':');
    if (kind === 'resolver' || kind === 'tunnel') return `resolver:${name}`;
    if (kind === 'sentinel') return 'sentinels';
    if (['youtube', 'server1', 'spotify'].includes(kind)) return kind;
    return 'other';
}

export function componentLabel(id) {
    if (id.startsWith('resolver:')) { const n = id.slice(9); return `${RESOLVER_LABELS[n] || n} resolver`; }
    return { youtube: 'YouTube playback', server1: 'server1 · bot host', spotify: 'Spotify (go-librespot)',
        sentinels: 'Cross-checks (sentinels)', other: 'Other' }[id] || id;
}

const ORDER = (id) => (id === 'youtube' ? 0 : id.startsWith('resolver:') ? 1 : id === 'server1' ? 2 : id === 'spotify' ? 3 : id === 'sentinels' ? 4 : 5);

/** The panels to draw: every component that has a check now or had one in the history. */
export function componentsFor(checkIds) {
    return [...new Set(checkIds.map(componentOf))].sort((a, b) => ORDER(a) - ORDER(b) || a.localeCompare(b));
}

const ids = (csv) => (csv ? String(csv).split(',').filter(Boolean) : []);

/**
 * Per component, per bucket: 'down' if any of its checks was DOWN (after the monitor's hysteresis) in
 * any sample of the bucket; 'degraded' if a probe failed without the check going down (a blip);
 * 'up' if every sample was clean; 'none' when there are no samples (monitor not running).
 * Uptime = share of samples in which none of the component's checks was down.
 */
export function buildTimelines(samples, components, { from, to, buckets }) {
    const width = (to - from) / buckets;
    const acc = Object.fromEntries(components.map(c => [c, {
        n: 0, downN: 0, b: Array.from({ length: buckets }, () => ({ n: 0, down: new Set(), failing: new Set() })),
    }]));
    for (const s of samples) {
        const i = Math.floor((s.t - from) / width);
        if (i < 0 || i >= buckets) continue;
        const down = ids(s.down), failing = ids(s.failing);
        for (const c of components) {
            const a = acc[c], bucket = a.b[i];
            const d = down.filter(id => componentOf(id) === c);
            bucket.n++; a.n++;
            if (d.length) a.downN++;
            d.forEach(id => bucket.down.add(id));
            failing.filter(id => componentOf(id) === c).forEach(id => bucket.failing.add(id));
        }
    }
    return Object.fromEntries(Object.entries(acc).map(([c, a]) => [c, {
        uptime: a.n ? 1 - a.downN / a.n : null,
        buckets: a.b.map((b, i) => ({
            start: Math.round(from + i * width),
            state: !b.n ? 'none' : b.down.size ? 'down' : b.failing.size ? 'degraded' : 'up',
            down: [...b.down],
            failing: [...b.failing].filter(id => !b.down.has(id)),
        })),
    }]));
}

/** Share of samples in which each check was NOT down; null for a check absent from every sample's universe. */
export function uptimeByCheck(samples, checkIds) {
    const n = samples.length;
    const downCount = Object.fromEntries(checkIds.map(id => [id, 0]));
    for (const s of samples) for (const id of ids(s.down)) if (id in downCount) downCount[id]++;
    return Object.fromEntries(checkIds.map(id => [id, n ? 1 - downCount[id] / n : null]));
}

/**
 * Growth of a cumulative counter between two samples. The first sample of a range has no baseline
 * (its value is everything since that process started), so it contributes nothing; a decrease means
 * the process restarted and counted up from zero again.
 */
const grew = (prev, cur) => (cur == null || prev == null ? 0 : cur < prev ? cur : cur - prev);

/**
 * Trend lines per bucket from the per-tick metrics:
 *   latency[resolver]   mean canary duration (ms), null where no canary ran
 *   relayMb[resolver]   audio streamed through that resolver's relay
 *   requests[resolver]  resolve/info requests it served
 *   plays / local       server1 extractor calls / plays that fell back to server1's own yt-dlp
 */
export function buildTrends(rows, { from, to, buckets }) {
    const width = (to - from) / buckets;
    const resolvers = [...new Set(rows.flatMap(r => Object.keys(r.m?.r || {})))].sort();
    const zero = () => Array(buckets).fill(0);
    const out = {
        resolvers,
        latency: Object.fromEntries(resolvers.map(n => [n, Array(buckets).fill(null)])),
        relayMb: Object.fromEntries(resolvers.map(n => [n, zero()])),
        requests: Object.fromEntries(resolvers.map(n => [n, zero()])),
        plays: zero(), local: zero(),
    };
    const latSum = Object.fromEntries(resolvers.map(n => [n, zero()]));
    const latN = Object.fromEntries(resolvers.map(n => [n, zero()]));
    let prev = null;
    for (const row of rows) {
        const i = Math.floor((row.t - from) / width);
        const m = row.m || {};
        if (i >= 0 && i < buckets) {
            for (const n of resolvers) {
                const cur = m.r?.[n], before = prev?.r?.[n];
                if (!cur) continue;
                if (cur.cm != null) { latSum[n][i] += cur.cm; latN[n][i]++; }
                out.relayMb[n][i] += grew(before?.rb, cur.rb) / 1e6;
                out.requests[n][i] += grew(before?.q, cur.q);
            }
            out.plays[i] += grew(prev?.x?.c, m.x?.c);
            out.local[i] += grew(prev?.x?.lo, m.x?.lo) + grew(prev?.x?.lf, m.x?.lf);
        }
        prev = m;
    }
    for (const n of resolvers) out.latency[n] = latSum[n].map((s, i) => (latN[n][i] ? Math.round(s / latN[n][i]) : null));
    return out;
}

/** Reads everything the page needs for one range. */
export async function loadHistory(pool, rangeKey, now = Date.now()) {
    const range = RANGES[rangeKey] || RANGES['24h'];
    const from = now - range.ms;
    const since = new Date(from);
    const [samples] = await pool.execute(
        'SELECT UNIX_TIMESTAMP(ts) * 1000 AS t, failing, down FROM music_health_samples WHERE ts >= ? ORDER BY id', [since]);
    const [metricRows] = await pool.execute(
        `SELECT UNIX_TIMESTAMP(ts) * 1000 AS t, metrics FROM music_health_samples WHERE ts >= ? AND id % ${Number(range.metricStride)} = 0 ORDER BY id`,
        [since]);
    const [events] = await pool.execute(
        `SELECT UNIX_TIMESTAMP(ts) * 1000 AS t, check_id, kind, severity, title, detail, notified
           FROM music_health_events WHERE ts >= ? ORDER BY id DESC LIMIT 200`, [since]);
    const [[first]] = await pool.execute('SELECT UNIX_TIMESTAMP(MIN(ts)) * 1000 AS t FROM music_health_samples');
    const parse = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
    return {
        range, from, to: now,
        samples: samples.map(s => ({ t: Number(s.t), failing: s.failing, down: s.down })),
        metrics: metricRows.map(r => ({ t: Number(r.t), m: parse(r.metrics) })),
        events: events.map(e => ({ ...e, t: Number(e.t), notified: !!e.notified })),
        historySince: first?.t ? Number(first.t) : null,
    };
}
