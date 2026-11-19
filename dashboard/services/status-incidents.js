/*
 * Incident history for the super-admin status view (GET /api/status/incidents).
 *
 * There is no hand-maintained incidents table. Incidents are DERIVED from what the bot already
 * records, so the list is always complete and needs no writer hooks:
 *
 *   uptime_events          start / stop / crash / restart rows written by utils/uptime-tracker.js.
 *                          A 'start' that follows another start with no stop/crash in between means
 *                          the process died without a clean shutdown (deploy, pm2 restart, OOM,
 *                          hard crash). Starts within RESTART_LOOP_GAP_SEC of each other are one
 *                          incident; RESTART_LOOP_MIN or more of them is a restart loop.
 *   music_health_samples   written every ~60s by the music health monitor while the process is up —
 *                          the last sample before a restart tells us when the bot actually went
 *                          down, so restart incidents get a measured downtime when it is available.
 *   music_health_events    down / still_down / up transitions per music check; a down..up pair is
 *                          one incident (an unpaired down is ongoing).
 *
 * The derivation functions are pure (unit-tested in tests/status-incidents.test.js);
 * loadIncidents() does the reading.
 */

export const RESTART_LOOP_GAP_SEC = 10 * 60;
export const RESTART_LOOP_MIN = 3;
export const LONG_OUTAGE_SEC = 10 * 60;
export const SEVERITY_ORDER = ['critical', 'major', 'minor', 'info'];

/**
 * @param {Array<{id:number, type:string, t:number, details?:string}>} events uptime_events, oldest
 *        first; may include the one event just before the window (for context)
 * @returns {Array} incidents: { id, source:'bot', type, severity, title, detail, start, end,
 *          restarts, firstStartT, prevUpT }   (times in unix seconds; end null = ongoing)
 */
export function deriveBotIncidents(events) {
    const incidents = [];
    let prev = null;
    let pendingDown = null;   // a crash/stop waiting for the start that ends it
    let cluster = null;       // unclean restarts being grouped

    const closeCluster = () => {
        if (!cluster) return;
        const loop = cluster.restarts >= RESTART_LOOP_MIN;
        incidents.push({
            id: `bot-${cluster.firstId}`,
            source: 'bot',
            type: loop ? 'restart_loop' : 'restart',
            severity: loop ? 'major' : 'minor',
            title: loop
                ? `Restart loop — ${cluster.restarts} restarts`
                : (cluster.restarts > 1 ? `${cluster.restarts} unexpected restarts` : 'Unexpected restart'),
            detail: 'The bot came back up without logging a clean shutdown (deploy or pm2 restart, '
                + 'out-of-memory, or a crash before the shutdown handler ran).',
            start: cluster.firstStartT,
            end: cluster.lastT,
            restarts: cluster.restarts,
            // each restart and the previous start — the window its last heartbeat must fall in
            starts: cluster.starts,
        });
        cluster = null;
    };

    for (const ev of events || []) {
        if (!ev || !Number.isFinite(Number(ev.t))) continue;
        const t = Number(ev.t);
        const type = String(ev.type);

        if (type === 'crash' || type === 'stop') {
            closeCluster();
            const inc = {
                id: `bot-${ev.id}`,
                source: 'bot',
                type: type === 'crash' ? 'crash' : 'maintenance',
                severity: type === 'crash' ? 'critical' : 'info',
                title: type === 'crash' ? 'Bot crashed' : 'Planned shutdown',
                detail: ev.details ? String(ev.details).slice(0, 500) : null,
                start: t,
                end: null,
                restarts: 0,
            };
            incidents.push(inc);
            pendingDown = inc;
        } else if (type === 'start' || type === 'restart') {
            if (pendingDown) {
                pendingDown.end = t;
                pendingDown = null;
            } else if (prev && (prev.type === 'start' || prev.type === 'restart')) {
                if (cluster && t - cluster.lastT <= RESTART_LOOP_GAP_SEC) {
                    cluster.restarts++;
                    cluster.lastT = t;
                    cluster.starts.push({ t, prevT: Number(prev.t) });
                } else {
                    closeCluster();
                    cluster = { firstId: ev.id, firstStartT: t, lastT: t, restarts: 1, starts: [{ t, prevT: Number(prev.t) }] };
                }
            }
            // A start with no earlier event in range has no context to judge — not an incident.
        }
        prev = { type, t };
    }
    closeCluster();
    return incidents;
}

const MUSIC_SEVERITY = { critical: 'major', warning: 'minor', info: 'info' };

/**
 * @param {Array<{id, t, check_id, kind:'down'|'still_down'|'up', severity, title, detail}>} rows oldest first
 * @returns {Array} incidents: { id, source:'music', type:'music', severity, title, detail, start, end, check_id }
 */
export function deriveMusicIncidents(rows) {
    const incidents = [];
    const open = new Map();
    for (const r of rows || []) {
        if (!r || !r.check_id) continue;
        const t = Number(r.t);
        const sev = MUSIC_SEVERITY[r.severity] || 'minor';
        const current = open.get(r.check_id);
        if (r.kind === 'down' || r.kind === 'still_down') {
            if (!current) {
                const inc = {
                    id: `music-${r.id}`,
                    source: 'music',
                    type: 'music',
                    severity: sev,
                    title: r.title || r.check_id,
                    detail: r.detail ? String(r.detail).slice(0, 500) : null,
                    start: t,
                    end: null,
                    check_id: r.check_id,
                    startedEarlier: r.kind === 'still_down',
                };
                incidents.push(inc);
                open.set(r.check_id, inc);
            } else {
                // Escalate if it got worse; keep the newest detail.
                if (SEVERITY_ORDER.indexOf(sev) < SEVERITY_ORDER.indexOf(current.severity)) current.severity = sev;
                if (r.detail) current.detail = String(r.detail).slice(0, 500);
            }
        } else if (r.kind === 'up' && current) {
            current.end = t;
            open.delete(r.check_id);
        }
    }
    return incidents;
}

/**
 * Measured downtime of a restart incident from heartbeat lookups.
 * @param {Array<{t:number, prevT:number}>} starts the incident's restarts
 * @param {Array<number|null>} lastBeats for each restart, the last heartbeat between prevT and t
 * @returns {{firstDownT:number, downtimeSec:number}|null} null unless every restart was measured
 */
export function measureRestartDowntime(starts, lastBeats) {
    if (!starts?.length || lastBeats?.length !== starts.length) return null;
    let total = 0;
    for (let i = 0; i < starts.length; i++) {
        const hb = lastBeats[i];
        if (hb == null || !(hb < starts[i].t)) return null;
        total += starts[i].t - hb;
    }
    return { firstDownT: lastBeats[0], downtimeSec: total };
}

/**
 * Severity bump for long outages, durations and the public shape.
 * @param {object|null} measured measureRestartDowntime() result for restart incidents
 *   duration_seconds = time the bot was actually down (for a restart loop: the sum of each
 *   outage, not the span — it was up between restarts); span_seconds = first to last event.
 */
export function finalizeIncident(inc, nowSec, measured = null) {
    const isRestart = inc.source === 'bot' && (inc.type === 'restart' || inc.type === 'restart_loop');
    const startT = isRestart && measured ? Math.min(measured.firstDownT, inc.start) : inc.start;
    const endT = inc.end;
    const span = startT != null ? Math.max(0, (endT ?? nowSec) - startT) : null;
    // Without a heartbeat a restart's outage length is unknown (not zero).
    const duration = isRestart ? (measured ? measured.downtimeSec : null) : span;
    let severity = inc.severity;
    if (isRestart && severity === 'minor' && duration != null && duration >= LONG_OUTAGE_SEC) {
        severity = 'major';
    }
    return {
        id: inc.id,
        source: inc.source,
        type: inc.type,
        severity,
        title: inc.title,
        detail: inc.detail || null,
        started_at: startT != null ? new Date(startT * 1000).toISOString() : null,
        resolved_at: endT != null ? new Date(endT * 1000).toISOString() : null,
        ongoing: endT == null,
        duration_seconds: duration,
        span_seconds: span,
        // Bot restart incidents measure downtime only when a heartbeat sample preceded every restart.
        downtime_measured: !isRestart || !!measured,
        restarts: inc.restarts || undefined,
        check_id: inc.check_id || undefined,
    };
}

export function summarize(incidents, windowDays) {
    const bySeverity = Object.fromEntries(SEVERITY_ORDER.map(s => [s, 0]));
    const bySource = {};
    let ongoing = 0;
    let botDowntime = 0;
    for (const i of incidents) {
        bySeverity[i.severity] = (bySeverity[i.severity] || 0) + 1;
        bySource[i.source] = (bySource[i.source] || 0) + 1;
        if (i.ongoing) ongoing++;
        if (i.source === 'bot' && i.downtime_measured && i.duration_seconds != null) botDowntime += i.duration_seconds;
    }
    const windowSec = windowDays * 86400;
    return {
        total: incidents.length,
        ongoing,
        by_severity: bySeverity,
        by_source: bySource,
        bot_downtime_seconds: botDowntime,
        bot_uptime_percent: windowSec > 0 ? Math.max(0, Math.min(100, Number((100 * (1 - botDowntime / windowSec)).toFixed(3)))) : null,
    };
}

const missingTable = (e) => e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146);

/**
 * Read and derive. Returns { incidents, summary, window_days, sources }.
 * @param pool mysql2 pool
 * @param {object} opts { days (1-90, default 30), limit (1-100, default 20), processName }
 */
export async function loadIncidents(pool, { days = 30, limit = 20, processName = 'CertiFried Utility Bot', logger = null } = {}) {
    const windowDays = Math.max(1, Math.min(90, Math.floor(Number(days)) || 30));
    const max = Math.max(1, Math.min(100, Math.floor(Number(limit)) || 20));
    const sources = { uptime_events: true, music_health_events: true, heartbeat: true };

    const [[{ nowT }]] = await pool.query('SELECT UNIX_TIMESTAMP(NOW()) AS nowT');
    const nowSec = Number(nowT);
    const sinceSec = nowSec - windowDays * 86400;

    // Bot lifecycle — the window plus the one event before it, so the first start has context.
    const [inWindow] = await pool.execute(
        `SELECT id, event_type AS type, UNIX_TIMESTAMP(\`timestamp\`) AS t, details
           FROM uptime_events
          WHERE process_name = ? AND \`timestamp\` >= DATE_SUB(NOW(), INTERVAL ${windowDays} DAY)
          ORDER BY \`timestamp\`, id`,
        [processName]);
    const [before] = await pool.execute(
        `SELECT id, event_type AS type, UNIX_TIMESTAMP(\`timestamp\`) AS t, details
           FROM uptime_events
          WHERE process_name = ? AND \`timestamp\` < DATE_SUB(NOW(), INTERVAL ${windowDays} DAY)
          ORDER BY \`timestamp\` DESC, id DESC LIMIT 1`,
        [processName]);
    const botIncidents = deriveBotIncidents([...before, ...inWindow]).filter(i => (i.end ?? nowSec) >= sinceSec);

    // Music health — look back a week further so an "up" in the window can find its "down".
    let musicIncidents = [];
    try {
        const [rows] = await pool.execute(
            `SELECT id, UNIX_TIMESTAMP(ts) AS t, check_id, kind, severity, title, detail
               FROM music_health_events
              WHERE ts >= DATE_SUB(NOW(), INTERVAL ${windowDays + 7} DAY)
              ORDER BY id`);
        musicIncidents = deriveMusicIncidents(rows).filter(i => (i.end ?? nowSec) >= sinceSec);
    } catch (e) {
        if (!missingTable(e)) throw e;
        sources.music_health_events = false;
    }

    // Newest first. Restart incidents get their downtime measured from the heartbeat (one indexed
    // MAX() per incident; bounded so a pathological restart storm cannot run thousands of queries).
    const all = [...botIncidents, ...musicIncidents].sort((a, b) => b.start - a.start);
    const finals = [];
    let lookups = 0;
    for (const inc of all) {
        let measured = null;
        const isRestart = inc.source === 'bot' && (inc.type === 'restart' || inc.type === 'restart_loop');
        if (isRestart && sources.heartbeat && lookups + inc.starts.length <= 1000) {
            const beats = [];
            for (const s of inc.starts) {
                lookups++;
                try {
                    const [[hb]] = await pool.execute(
                        `SELECT UNIX_TIMESTAMP(MAX(ts)) AS t FROM music_health_samples
                          WHERE ts < FROM_UNIXTIME(?) AND ts > FROM_UNIXTIME(?)`,
                        [s.t, s.prevT]);
                    beats.push(hb?.t != null ? Number(hb.t) : null);
                } catch (e) {
                    if (!missingTable(e)) throw e;
                    sources.heartbeat = false;
                    break;
                }
                if (beats[beats.length - 1] == null) break; // one unmeasured restart → not measured
            }
            measured = measureRestartDowntime(inc.starts, beats);
        }
        finals.push(finalizeIncident(inc, nowSec, measured));
    }
    if (logger && (!sources.music_health_events || !sources.heartbeat)) {
        logger.debug?.('[Status] Incident sources missing', sources);
    }

    return {
        incidents: finals.slice(0, max),
        summary: summarize(finals, windowDays),
        window_days: windowDays,
        sources,
    };
}
