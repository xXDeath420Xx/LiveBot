/**
 * Music health monitor — watches every link in the music chain and DMs the bot owner on changes.
 *
 * Checked every MUSIC_HEALTH_TICK_MS (default 60s), per residential resolver (MUSIC_RESOLVERS:
 * server2 on Comcast, the workstation on Ziply):
 *   - each tunnel — GET /health; resolver auth — POST /resolve {} must be 400, not 401
 *   - the resolver's own status: canary, cookie jar, bgutil, auto-update result
 *   - playback: a test video resolved through it actually streams on server1 (via its audio relay)
 *   - youtube:residential (critical) = at least one resolver reachable, authenticated, canary and playback passing
 *   - server1: cookies.txt freshness + auth markers, bgutil PO-token server, auto-update result
 *   - Spotify owner session (go-librespot API reachable + logged in)
 *
 * A check flips only after 2 consecutive results the other way (no alert on a single blip). All
 * flips in one tick go out as ONE DM. Recoveries are announced; a still-down check is re-announced
 * every 6h. State persists in data/music-health-state.json so restarts don't re-alert.
 * A snapshot of the latest results is written to data/music-health.json for inspection.
 */
import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../utils/logger.js';
import { resolverGroups, resolverSecret } from '../utils/music-resolver-config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.MUSIC_HEALTH_DATA_DIR || join(ROOT, 'data');
const STATE_FILE = join(DATA_DIR, 'music-health-state.json');
const SNAPSHOT_FILE = join(DATA_DIR, 'music-health.json');
const SERVER1_UPDATE_STATUS = join(ROOT, 'data', 'music-update-status.json');
const SERVER1_COOKIES = join(ROOT, 'cookies.txt');
const SPOTIFY_STATUS_URL = 'http://127.0.0.1:3678/status';
const SERVER1_BGUTIL_PING = 'http://127.0.0.1:4416/ping';
// Sentinels on the other machines watch server1 and touch data/sentinel-<name>.heartbeat each probe.
const SENTINELS = (process.env.MUSIC_SENTINELS || 'server2,workstation').split(',').map(s => s.trim()).filter(Boolean);
const SENTINEL_STALE_SEC = 300;

const TICK_MS = Number(process.env.MUSIC_HEALTH_TICK_MS) || 60_000;
const FLIP_AFTER = 2;
const REMIND_MS = 6 * 3600 * 1000;
const COOKIE_STALE_SEC = 72 * 3600;
const AUTH_PROBE_EVERY = 10;
// Playback: resolve a short video through each resolver and pull its first bytes from server1 — the
// path the bot really uses. Every 15 ticks, and every tick while failing (to see the recovery).
const PLAYBACK_PROBE_EVERY = 15;
const PLAYBACK_CANARY = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'; // "Me at the zoo", 19s
const SUMMARY_EVERY = 60;

const SEVERITY = { critical: 3, warning: 2, info: 1 };
const COLORS = { critical: 0xe53935, warning: 0xffa000, info: 0x1e88e5, recovered: 0x43a047 };

let client = null;
let timer = null;
let tickCount = 0;
const monitorStartedAt = new Date().toISOString();
let lastResults = {};
const lastAuthOk = new Map();    // resolver name -> true / false
const lastPlayback = new Map();  // resolver name -> { ok, detail }
let state = loadState();
const tunnelProbes = new Map(); // base -> { reachable, at } from the latest tick (no hysteresis)

function loadState() {
    let s;
    try { s = JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
    catch { return { checks: {}, seenEvents: [] }; }
    // Drop check ids from the single-resolver version so they can't linger as stale "up"/"down".
    for (const id of Object.keys(s.checks || {})) {
        if (/^resolver:(reachable|canary|cookies|bgutil|auth)$/.test(id) || /^tunnel:http/.test(id)) delete s.checks[id];
    }
    return s;
}
function saveState() {
    try {
        writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(state, null, 1));
        renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
    } catch (e) { logger.warn(`[MusicHealth] could not persist state: ${e.message}`); }
}

async function fetchJson(url, opts = {}, timeoutMs = 5000) {
    const resp = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    let body = null;
    try { body = await resp.json(); } catch { /* non-JSON */ }
    return { status: resp.status, body };
}

/** Resolve the test video through one resolver and fetch its first 4 KB from here, as a play would. */
async function probePlayback(base, secret) {
    try {
        const r = await fetchJson(`${base}/resolve`, {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
            body: JSON.stringify({ url: PLAYBACK_CANARY, timeoutMs: 40000 }),
        }, 45000);
        if (!r.body?.ok) return { ok: false, detail: `Resolving the test video failed (${r.body?.reason || `HTTP ${r.status}`})` };
        const viaRelay = typeof r.body.streamPath === 'string';
        const audio = await fetch(viaRelay ? `${base}${r.body.streamPath}` : r.body.audioUrl,
            { headers: { range: 'bytes=0-4095' }, signal: AbortSignal.timeout(15000) });
        const bytes = Buffer.from(await audio.arrayBuffer()).length;
        if ((audio.status === 206 || audio.status === 200) && bytes > 0) return { ok: true, detail: `${bytes} bytes via ${viaRelay ? 'the relay' : 'the direct link'}` };
        return { ok: false, detail: viaRelay
            ? `The resolver's audio relay answered HTTP ${audio.status}`
            : `The direct audio link answered HTTP ${audio.status} here — that resolver has no relay (older build) and YouTube refuses server1's IP` };
    } catch (e) {
        return { ok: false, detail: `Playback probe error: ${e.message}` };
    }
}

const TUNNEL_LABELS = {
    ':49998': 'server1→server2 forward tunnel (:49998)',
    ':49999': 'server2→server1 reverse tunnel (:49999)',
    ':49997': 'workstation→server1 reverse tunnel (:49997)',
};
const hostLabel = (base) => Object.entries(TUNNEL_LABELS).find(([p]) => base.endsWith(p))?.[1] || base;

function readJsonFile(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }

/** Run every probe; returns { checks: id -> {ok, severity, title, detail}, events: [...] }. */
async function evaluate() {
    const checks = {};
    const events = [];
    const add = (id, ok, severity, title, detail) => { checks[id] = { ok, severity, title, detail }; };

    // ── residential resolvers (server2, workstation), each reached over 1+ tunnels ─────────────
    const groups = resolverGroups();
    const tunnelResults = (await Promise.all(groups.map(g => Promise.all(g.bases.map(async (base) => {
        try { const r = await fetchJson(`${base}/health`); return { group: g.name, base, reachable: r.status === 200, health: r.body }; }
        catch (e) { return { group: g.name, base, reachable: false, error: e.cause?.code || e.name || e.message }; }
    }))))).flat();
    for (const t of tunnelResults) tunnelProbes.set(t.base, { reachable: t.reachable, at: Date.now() });

    const healthy = [];   // resolvers that are reachable, authenticated and passing their canary
    const healthByGroup = {};
    for (const g of groups) {
        const mine = tunnelResults.filter(t => t.group === g.name);
        const up = mine.filter(t => t.reachable);
        const health = up[0]?.health || null;
        healthByGroup[g.name] = health;
        const label = g.name === 'workstation' ? 'workstation (Ziply)' : g.name === 'server2' ? 'server2 (Comcast)' : g.name;

        add(`resolver:${g.name}:reachable`, up.length > 0, 'warning', `${label} resolver unreachable`,
            `No tunnel to the ${label} resolver answers. Plays use the other residential resolver; if both are out they fall `
            + 'back to server1\'s OVH IP. Tunnels restart automatically — if this persists, that machine or its internet is down.');
        for (const t of mine) {
            add(`tunnel:${g.name}:${t.base}`, t.reachable, 'warning', `Resolver path down: ${hostLabel(t.base)}`,
                up.length ? `Redundancy reduced — ${label}'s other tunnel is carrying its traffic.` : `Error: ${t.error || 'no response'}`);
        }
        if (!health) continue;

        const problems = health.problems || [];
        add(`resolver:${g.name}:canary`, !problems.includes('canary_failing'), 'warning', `YouTube extraction failing on ${label}`,
            `The canary can't resolve test videos (last reason: ${health.canary?.reason || 'unknown'}) — that IP may be flagged or `
            + 'YouTube changed something (the daily auto-update tries stable, then nightly). Plays use the other resolver meanwhile.');
        const cookieProblem = problems.find(p => ['cookies_stale', 'cookie_jar_suspect', 'no_cookie_jar'].includes(p));
        add(`resolver:${g.name}:cookies`, !cookieProblem, 'warning', `YouTube cookies on ${label} need attention`,
            cookieProblem === 'cookie_jar_suspect'
                ? 'Requests only succeed WITHOUT the cookie jar (cookieless rescues): the jar is unreadable or the session died. '
                  + 'Make sure Firefox on the workstation is still signed into YouTube.'
                : `Cookie jar is ${cookieProblem === 'no_cookie_jar' ? 'missing' : `${Math.round((health.cookieAgeSec || 0) / 3600)}h old`} — `
                  + 'the workstation cookie sync has not refreshed it.');
        // Signed-in YouTube accounts (resolver-3.5+): a dead session needs a new sign-in; the other account
        // carries the plays meanwhile.
        for (const acct of health.accounts || []) {
            const where = acct.name === 'primary' ? 'your main Firefox profile on the workstation'
                : `the Firefox profile "yt-${acct.name}" on the workstation`;
            add(`resolver:${g.name}:account:${acct.name}`, !problems.includes(`account_signed_out:${acct.name}`), 'warning',
                `YouTube account "${acct.name}" signed out on ${label}`,
                `YouTube says this account's session is no longer valid. Sign ${where} back into YouTube; the next `
                + 'cookie sync (every 6h) pushes the fresh session and the account comes back on its own. Other accounts carry the plays meanwhile.');
        }
        add(`resolver:${g.name}:bgutil`, !problems.includes('bgutil_down'), 'warning', `PO-token provider down on ${label}`,
            'bgutil-provider is not answering; its supervisor should restart it. Extraction degrades without PO tokens.');
        if (health.update?.at && ['rolled_back', 'failed', 'nightly'].includes(health.update.result)) {
            events.push({ key: `update:${g.name}:${health.update.at}`, severity: health.update.result === 'failed' ? 'warning' : 'info',
                title: `${label} auto-update: ${health.update.result}`, detail: (health.update.notes || []).join('\n') || 'see its update logs' });
        }

        // Auth: a wrong secret makes every play skip this resolver. 400 = authenticated; 401 = not.
        if (tickCount === 1 || tickCount % AUTH_PROBE_EVERY === 0 || lastAuthOk.get(g.name) !== true) {
            try {
                const r = await fetchJson(`${up[0].base}/resolve`, {
                    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${resolverSecret(g.name)}` }, body: '{}',
                });
                lastAuthOk.set(g.name, r.status !== 401);
            } catch { /* keep previous */ }
        }
        if (lastAuthOk.has(g.name)) {
            add(`resolver:${g.name}:auth`, lastAuthOk.get(g.name), 'warning', `${label} resolver rejects the bot's secret`,
                `401 from ${label}: the secret file on server1 (MUSIC_RESOLVER_SECRET_FILE_${g.name.toUpperCase()}) and that resolver's `
                + 'secret.txt disagree — a rotation probably half-finished.');
        }
        // A resolver can be reachable, authenticated and passing its own canary while the audio it
        // hands out still won't play here (2026-10-03: YouTube started refusing server1's IP for
        // home-signed links). Only fetching the bytes from server1 proves the play path.
        if (lastAuthOk.get(g.name) !== false
            && (tickCount === 1 || tickCount % PLAYBACK_PROBE_EVERY === 0 || lastPlayback.get(g.name)?.ok === false)) {
            lastPlayback.set(g.name, await probePlayback(up[0].base, resolverSecret(g.name)));
        }
        const playback = lastPlayback.get(g.name);
        if (playback) {
            add(`resolver:${g.name}:playback`, playback.ok, 'warning', `Audio from ${label} doesn't play on server1`,
                `${playback.detail}. Plays are routed to the other resolver first meanwhile.`);
        }
        if (!problems.includes('canary_failing') && lastAuthOk.get(g.name) !== false && playback?.ok !== false) healthy.push(g.name);
    }

    if (groups.length) {
        add('youtube:residential', healthy.length > 0, 'critical', 'No residential YouTube resolver available',
            'Neither server2 nor the workstation can serve playable YouTube audio right now. Plays fall back to server1\'s OVH IP, '
            + 'where many videos are bot-walled. Usually both home networks are down (power outage), or both canaries / '
            + 'playback probes are failing.');
    }

    // ── cross-check: are the sentinels that watch server1 still reporting? ────
    for (const name of SENTINELS) {
        let age = null;
        try { age = (Date.now() - statSync(join(ROOT, 'data', `sentinel-${name}.heartbeat`)).mtimeMs) / 1000; } catch { /* never reported */ }
        add(`sentinel:${name}`, age !== null && age < SENTINEL_STALE_SEC, 'warning', `${name} cross-check not reporting`,
            `The sentinel on ${name} hasn't checked in ${age === null ? 'at all' : `for ${Math.round(age / 60)} min`}. It watches server1 from `
            + `outside — without it, a server1 or bot outage might not reach you from ${name}. Its supervisor/pm2 restarts it automatically.`);
    }

    // ── server1 local fallback ──────────────────────────────────────────────
    try {
        const age = (Date.now() - statSync(SERVER1_COOKIES).mtimeMs) / 1000;
        const jar = readFileSync(SERVER1_COOKIES, 'utf8');
        const authed = /(^|\s)(SAPISID|__Secure-1PSID|LOGIN_INFO)\s/.test(jar);
        add('server1:cookies', age < COOKIE_STALE_SEC && authed, 'warning', 'server1 fallback cookie jar stale',
            authed ? `cookies.txt is ${Math.round(age / 3600)}h old — the workstation sync task hasn't run.`
                   : 'cookies.txt has no signed-in session markers.');
    } catch {
        add('server1:cookies', false, 'warning', 'server1 fallback cookie jar missing', 'cookies.txt is missing on server1.');
    }
    try {
        const r = await fetchJson(SERVER1_BGUTIL_PING, {}, 3000);
        add('server1:bgutil', r.status === 200, 'warning', 'PO-token provider down on server1', 'bgutil-provider on server1 is not answering.');
    } catch {
        add('server1:bgutil', false, 'warning', 'PO-token provider down on server1', 'bgutil-provider on server1 is not answering.');
    }
    const s1update = readJsonFile(SERVER1_UPDATE_STATUS);
    if (s1update?.at && ['rolled_back', 'failed', 'nightly'].includes(s1update.result)) {
        events.push({ key: `update:server1:${s1update.at}`, severity: s1update.result === 'failed' ? 'warning' : 'info',
            title: `server1 auto-update: ${s1update.result}`, detail: (s1update.notes || []).join('\n') || 'see logs/music-update-*.log' });
    }
    const glr = s1update?.goLibrespot;
    if (glr?.action && !['none', 'deferred_busy'].includes(glr.action)) {
        events.push({ key: `glr:${glr.latest}:${glr.action}`, severity: glr.action === 'rolled_back' ? 'warning' : 'info',
            title: `go-librespot ${glr.latest}: ${glr.action.replace('_', ' ')}`,
            detail: glr.action === 'available_minor'
                ? `Current ${glr.current}. Minor/major releases aren't auto-applied (API may change) — review the release notes, then update manually.`
                : `Current ${glr.current}.` });
    }

    // ── Spotify ─────────────────────────────────────────────────────────────
    try {
        const r = await fetchJson(SPOTIFY_STATUS_URL, {}, 4000);
        add('spotify:owner', r.status === 200 && !!r.body?.username, 'critical', 'Spotify owner session down',
            r.status === 200 ? 'go-librespot is up but NOT logged in — re-link the owner account.'
                             : 'go-librespot API not answering; pm2 / the CPU watchdog should restart it.');
    } catch {
        add('spotify:owner', false, 'critical', 'Spotify owner session down', 'go-librespot API not answering; pm2 / the CPU watchdog should restart it.');
    }

    return { checks, events, healthByGroup, tunnelResults };
}

/**
 * Apply hysteresis to one tick's results, mutating `checksState` (id -> state). Returns the
 * transitions to announce. Pure apart from that object, so it is unit-testable.
 */
export function applyResultsTo(checksState, checks, now = Date.now()) {
    const transitions = [];
    for (const [id, r] of Object.entries(checks)) {
        const s = checksState[id] || { status: 'unknown', streak: 0, since: now, lastAlertAt: 0, alerted: false };
        const want = r.ok ? 'up' : 'down';
        if (s.status === want) { s.streak = 0; }
        else if (s.status === 'unknown' && r.ok) { s.status = 'up'; s.since = now; s.streak = 0; }  // silent first sighting
        else if (++s.streak >= FLIP_AFTER) {
            s.status = want; s.since = now; s.streak = 0;
            // `alerted` is set by announce() only for downs it actually shows, so a down that was folded
            // into a higher-level alert doesn't produce a stray "recovered" line later.
            if (want === 'down') { transitions.push({ id, kind: 'down', ...r }); s.lastAlertAt = now; }
            else { if (s.alerted) transitions.push({ id, kind: 'up', ...r }); s.alerted = false; }
        }
        if (s.status === 'down' && s.alerted && now - s.lastAlertAt > REMIND_MS) {
            transitions.push({ id, kind: 'still_down', ...r, downForH: Math.round((now - s.since) / 3600000) });
            s.lastAlertAt = now;
        }
        checksState[id] = s;
    }
    return transitions;
}
const applyResults = (checks) => applyResultsTo(state.checks, checks);

/**
 * Report each outage at its highest level only — no residential resolver at all > one resolver
 * unreachable > one of its tunnels / its sentinel. Marks shown downs `alerted` in `checksState`
 * (only those get a "recovered" later). Returns the transitions to show.
 */
export function selectAnnouncements(transitions, checksState) {
    const isDown = (t) => t.kind !== 'up';
    const allDown = transitions.some(t => t.id === 'youtube:residential' && isDown(t));
    const groupsDown = new Set(transitions.filter(t => isDown(t) && /^resolver:[^:]+:reachable$/.test(t.id)).map(t => t.id.split(':')[1]));
    const shown = transitions.filter(t => {
        if (!isDown(t)) return true;
        if (allDown && (t.id.startsWith('tunnel:') || /^resolver:[^:]+:reachable$/.test(t.id))) return false;
        if (t.id.startsWith('tunnel:') && groupsDown.has(t.id.split(':')[1])) return false;
        // A machine that is down entirely is already reported as its resolver being unreachable.
        if (t.id.startsWith('sentinel:')) {
            const host = t.id.split(':')[1];
            if (groupsDown.has(host) || checksState[`resolver:${host}:reachable`]?.status === 'down') return false;
        }
        return true;
    });
    for (const t of shown) if (t.kind === 'down' && checksState[t.id]) checksState[t.id].alerted = true;
    return shown;
}

async function sendOwnerDm(embed) {
    const ownerId = process.env.BOT_OWNER_ID;
    if (!client || !ownerId) { logger.warn('[MusicHealth] cannot DM owner (no client or BOT_OWNER_ID)'); return; }
    try {
        const user = await client.users.fetch(ownerId);
        await user.send({ embeds: [embed] });
    } catch (e) { logger.error(`[MusicHealth] owner DM failed: ${e.message}`); }
}

/** DMs the owner; returns the transitions it showed (the rest were folded into a higher-level one). */
async function announce(transitions, events) {
    if (!transitions.length && !events.length) return [];
    const shown = selectAnnouncements(transitions, state.checks);
    const items = [
        ...shown.map(t => ({
            sev: t.kind === 'up' ? 'recovered' : t.severity,
            name: `${t.kind === 'up' ? '✅ Recovered' : t.kind === 'still_down' ? `⏳ Still down (${t.downForH}h)` : t.severity === 'critical' ? '🔴 Down' : '🟠 Degraded'}: ${t.title}`,
            value: (t.kind === 'up' ? 'Back to normal.' : t.detail).slice(0, 1000),
        })),
        ...events.map(e => ({ sev: e.severity, name: `ℹ️ ${e.title}`, value: e.detail.slice(0, 1000) })),
    ];
    if (!items.length) return shown;
    const worst = items.reduce((w, i) => ((SEVERITY[i.sev] || 0) > (SEVERITY[w] || 0) ? i.sev : w), 'recovered');
    for (const i of items) logger[i.sev === 'recovered' || i.sev === 'info' ? 'info' : 'warn'](`[MusicHealth] ${i.name} — ${i.value.split('\n')[0]}`);
    await sendOwnerDm({
        title: '🎵 Music system health',
        color: COLORS[worst] || COLORS.info,
        fields: items.slice(0, 20).map(i => ({ name: i.name.slice(0, 256), value: i.value || '—' })),
        timestamp: new Date().toISOString(),
        footer: { text: 'CertiFried music health monitor' },
    });
    return shown;
}

// ── history for the super-admin "Music health" page (migration 255) ───────────────────────────
/**
 * The few numbers the page draws trend lines from. Counters are the resolvers' / extractor's own
 * running totals (they reset on restart); the page turns consecutive samples into per-bucket deltas.
 */
export function sampleMetrics(snapshot) {
    const r = {};
    for (const [name, h] of Object.entries(snapshot.resolvers || {})) {
        r[name] = h ? {
            c: h.canary?.ok ?? null, cm: h.canary?.ms ?? null, ca: h.cookieAgeSec ?? null,
            q: h.stats?.requests ?? 0, f: h.stats?.fail ?? 0,
            rs: h.stats?.relay?.streams ?? 0, rb: h.stats?.relay?.bytes ?? 0, ym: h.stats?.ytm?.served ?? 0,
        } : null;
    }
    const x = snapshot.extractor || {};
    return { r, x: { c: x.calls ?? 0, h: x.hits ?? 0, lo: x.localOk ?? 0, lf: x.localFail ?? 0 },
        p: { s: snapshot.prefetch?.started ?? 0, h: snapshot.prefetch?.hits ?? 0 } };
}

let historyOff = false;
let historyErrorAt = 0;
async function recordHistory(checks, transitions, shown, snapshot) {
    if (historyOff) return;
    try {
        const { default: pool } = await import('../utils/db.js'); // lazy: the unit tests import this module without a DB
        const failing = Object.entries(checks).filter(([, r]) => !r.ok).map(([id]) => id);
        const down = Object.keys(checks).filter(id => state.checks[id]?.status === 'down');
        await pool.execute('INSERT INTO music_health_samples (checks_total, failing, down, metrics) VALUES (?, ?, ?, ?)',
            [Object.keys(checks).length, failing.join(',') || null, down.join(',') || null, JSON.stringify(sampleMetrics(snapshot))]);
        for (const t of transitions) {
            await pool.execute('INSERT INTO music_health_events (check_id, kind, severity, title, detail, notified) VALUES (?, ?, ?, ?, ?, ?)',
                [t.id, t.kind, t.severity || null, String(t.title || t.id).slice(0, 255), t.kind === 'up' ? null : String(t.detail || '').slice(0, 2000),
                    shown.includes(t) ? 1 : 0]);
        }
    } catch (e) {
        if (e.code === 'ER_NO_SUCH_TABLE') {
            historyOff = true;
            logger.warn('[MusicHealth] history tables missing (migration 255) — the Music health page will have no history');
        } else if (Date.now() - historyErrorAt > 30 * 60 * 1000) {
            historyErrorAt = Date.now();
            logger.warn(`[MusicHealth] could not record history: ${e.message}`);
        }
    }
}

async function tick() {
    tickCount++;
    let result;
    try { result = await evaluate(); }
    catch (e) { logger.error(`[MusicHealth] evaluation failed: ${e.message}`); return; }
    lastResults = result.checks;

    const transitions = applyResults(result.checks);
    const freshEvents = result.events.filter(e => !state.seenEvents.includes(e.key));
    state.seenEvents = [...state.seenEvents, ...freshEvents.map(e => e.key)].slice(-100);
    const shown = await announce(transitions, freshEvents);
    saveState(); // after announce: it records which downs were actually shown

    let extractor = null, prefetch = null;
    try {
        const m = await import('./ytdlp-extractor.js');
        extractor = m.getResolverStats?.() || null;
        prefetch = m.getPrefetchStats?.() || null;
    } catch { /* not loaded */ }
    const snapshot = {
        at: new Date().toISOString(),
        monitor: { startedAt: monitorStartedAt, tick: tickCount, tickMs: TICK_MS },
        checks: Object.fromEntries(Object.entries(result.checks).map(([id, r]) => [id, {
            ok: r.ok, status: state.checks[id]?.status, since: state.checks[id]?.since || null,
            severity: r.severity, title: r.title, detail: r.detail }])),
        resolvers: Object.fromEntries(Object.entries(result.healthByGroup).map(([name, h]) => [name, h ? {
            status: h.status, problems: h.problems, canary: h.canary, cookieAgeSec: h.cookieAgeSec,
            versions: h.versions, update: h.update?.result || null, stats: h.stats } : null])),
        tunnels: result.tunnelResults.map(t => ({ resolver: t.group, base: t.base, reachable: t.reachable })),
        extractor,
        prefetch,
    };
    try { writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 1)); } catch { /* best effort */ }
    recordHistory(result.checks, transitions, shown, snapshot); // not awaited: a slow DB must not stall the tick

    if (tickCount === 1 || tickCount % SUMMARY_EVERY === 0) {
        const down = Object.entries(state.checks).filter(([, s]) => s.status === 'down').map(([id]) => id);
        const perResolver = Object.entries(result.healthByGroup).map(([name, h]) => {
            const t = snapshot.tunnels.filter(x => x.resolver === name).map(x => (x.reachable ? 'up' : 'down')).join('/');
            return `${name}=${h?.status || 'unreachable'}(tunnels ${t}, canary ${h?.canary?.ok ?? '?'})`;
        }).join(' ');
        const by = extractor?.byResolver ? Object.entries(extractor.byResolver).map(([n, v]) => `${n}:${v.hits}`).join(',') : '';
        logger.info(`[MusicHealth] summary: ${down.length ? `DOWN=${down.join(',')}` : 'all checks up'}; ${perResolver}; `
            + (extractor ? `extractor: calls=${extractor.calls} hits=${extractor.hits} [${by}] noResolver=${extractor.noTunnel} localOk=${extractor.localOk} localFail=${extractor.localFail}` : '')
            + (prefetch ? `; prefetch: started=${prefetch.started} hits=${prefetch.hits} awaited=${prefetch.awaitedInFlight} expired=${prefetch.expired} failed=${prefetch.failed}` : ''));
    }
}

export function startMusicHealthMonitor(discordClient) {
    if (timer) return;
    client = discordClient;
    // First tick after a short delay so tunnels/sessions settle after a restart.
    setTimeout(() => { tick(); timer = setInterval(tick, TICK_MS); timer.unref?.(); }, 20_000).unref?.();
    logger.info(`[MusicHealth] monitor started (tick ${TICK_MS / 1000}s)`);
}

/**
 * Latest raw probe of one tunnel: true / false, or null when unknown or older than 3 ticks.
 * The extractor uses this to route around a hung tunnel before it costs real plays a timeout.
 */
/** Did the last playback probe through this resolver play on server1? null = not probed yet. */
export function playbackProbeOk(name) {
    return lastPlayback.get(name)?.ok ?? null;
}

export function tunnelProbeOk(base) {
    const p = tunnelProbes.get(base);
    if (!p || Date.now() - p.at > 3 * TICK_MS) return null;
    return p.reachable;
}

/** For other modules: is the residential YouTube path working right now? */
export function getMusicHealth() {
    const s = (id) => state.checks[id]?.status;
    return {
        resolverHealthy: s('youtube:residential') === 'up',
        checks: lastResults,
    };
}
