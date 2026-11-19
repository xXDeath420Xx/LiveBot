/*
 * Channel integrity report: measurable evidence about viewer authenticity, chatter
 * legitimacy and detected anomalies over a window. Every indicator carries the measured
 * value, the threshold and how it was measured, so the printed report shows its reasoning.
 * Account names are never treated as evidence.
 */
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import ejs from 'ejs';
import { getBrowser, closeBrowser } from '../utils/browserManager.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { getAccessToken } from '../utils/platforms/twitch-api.js';
import { isChatBot } from '../utils/twitch-chat-bots.js';
import { knownBotStatus, knownBotFirstListed, knownBotListUrl } from './twitch-known-bots.js';
import { LINK, assessViewerLink, viewerDips } from './twitch-integrity-viewer-link.js';

const LOG = '[TwitchIntegrity]';
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export const THRESHOLDS = Object.freeze({
    cohortMinSize: 10,           // A: silent accounts that joined in the same minute and left in the same minute
    cohortEdgeMinutes: 2,        //    joins/leaves this close to stream start/end are ignored (everyone shares them)
    silentMinMinutes: 30,        //    "long-present" = 30+ minutes in a single visit
    creationClusterDays: 7,      // B: bulk-created accounts
    creationClusterMin: 15,
    creationClusterShare: 0.25,
    jumpMinViewers: 20,          // C: unexplained viewer jumps
    jumpMinRatio: 0.30,
    jumpBaselineMinutes: 15,     //    a jump must beat the highest count of the previous 15 minutes (dip recoveries don't count)
    jumpExplainMinutes: 3,       //    a raid or received shoutout this close explains the jump
    jumpIgnoreStartMinutes: 30,  //    followers arriving after the go-live notification ramp up over ~30 minutes
    jumpSustainMinutes: 5,       //    the higher level must hold this long (one-minute spikes are API glitches)
    departureIgnoreEndMinutes: 10, //  drops this close to the stream's end are normal sign-off
    jumpMinCount: 2,             //    rises that later leave as a block
    knownListMinCount: 10,       // D: silent long-present accounts on CommanderRoot's known-bot list
    knownListMinShare: 0.25,
    knownListMinChecked: 0.8,    //    assessed only once 80%+ of those accounts have been looked up
    accountLookupCap: 1500,
    accountCacheDays: 30,
});

const toDate = (v) => (v instanceof Date ? v : new Date(v));
const minuteKey = (d) => Math.floor(toDate(d).getTime() / MIN);

// ─── Data window + coverage ─────────────────────────────────────────────────

async function coverage(bid, since) {
    const [[snap]] = await pool.execute(
        `SELECT MIN(recorded_at) AS first, COALESCE(SUM(is_live), 0) AS live_minutes
           FROM twitch_stream_snapshots WHERE broadcaster_id = ? AND recorded_at >= ?`, [bid, since]);
    const [[chat]] = await pool.execute(
        `SELECT MIN(recorded_at) AS first, COUNT(*) AS minutes
           FROM twitch_chatters_snapshots WHERE broadcaster_id = ? AND recorded_at >= ?`, [bid, since]);
    const [[cfg]] = await pool.execute(
        `SELECT chat_sampling_enabled FROM twitch_analytics_alerts_config WHERE broadcaster_id = ? LIMIT 1`, [bid]);
    const [[ever]] = await pool.execute(
        `SELECT MIN(recorded_at) AS first FROM twitch_stream_snapshots WHERE broadcaster_id = ?`, [bid]);
    return {
        collectedFrom: ever?.first || null,
        firstSnapshot: snap?.first || null,
        liveMinutes: Number(snap?.live_minutes) || 0,
        firstChatterList: chat?.first || null,
        chatterListMinutes: Number(chat?.minutes) || 0,
        chatSampling: !!cfg?.chat_sampling_enabled,
    };
}

async function sessionsIn(bid, since) {
    const [rows] = await pool.execute(
        `SELECT id, started_at, COALESCE(ended_at, NOW()) AS ended_at, ended_at IS NULL AS open,
                duration_minutes, peak_viewers, avg_viewers, primary_category_name
           FROM twitch_stream_sessions
          WHERE broadcaster_id = ? AND started_at >= ?
          ORDER BY started_at ASC`, [bid, since]);
    return rows;
}

// ─── A: synchronized silent cohorts ─────────────────────────────────────────

async function messageSenders(bid, since) {
    const [rows] = await pool.execute(
        `SELECT DISTINCT LOWER(chatter_user_login) AS login FROM twitch_chat_message_samples
          WHERE broadcaster_id = ? AND occurred_at >= ? AND chatter_user_login IS NOT NULL`, [bid, since]);
    const set = new Set(rows.map(r => r.login));
    // When we started saving messages. Before this we cannot know who chatted, so time in chat
    // before it never counts toward "silent".
    const [[first]] = await pool.execute(
        'SELECT MIN(occurred_at) AS t FROM twitch_chat_message_samples WHERE broadcaster_id = ? AND occurred_at >= ?', [bid, since]);
    set.from = first?.t ? toDate(first.t) : null;
    return set;
}

/**
 * Presence runs per login from the per-minute chatter lists. A run breaks on a gap of more
 * than 2 minutes. Runs are tagged with the session they fall in so stream-edge joins/leaves
 * (shared by everyone already watching) can be excluded.
 */
async function silentPresence(bid, since, sessions, senders) {
    const [snaps] = await pool.execute(
        `SELECT recorded_at, chatter_logins_json FROM twitch_chatters_snapshots
          WHERE broadcaster_id = ? AND recorded_at >= ? ORDER BY recorded_at ASC`, [bid, since]);
    const sessionFor = (m) => sessions.find(s => m >= minuteKey(s.started_at) && m <= minuteKey(s.ended_at));
    const open = new Map();   // login -> { start, last }
    const runs = [];
    const close = (login, run) => runs.push({ login, start: run.start, end: run.last });
    for (const snap of snaps) {
        const m = minuteKey(snap.recorded_at);
        let logins = [];
        try { logins = JSON.parse(snap.chatter_logins_json || '[]'); } catch { /* skip malformed */ }
        const present = new Set(logins.map(l => String(l).toLowerCase()));
        for (const login of present) {
            const run = open.get(login);
            if (run && m - run.last <= 2) run.last = m;
            else { if (run) close(login, run); open.set(login, { start: m, last: m }); }
        }
        for (const [login, run] of open) {
            if (!present.has(login) && m - run.last > 2) { close(login, run); open.delete(login); }
        }
    }
    for (const [login, run] of open) close(login, run);
    const allRuns = runs.slice();
    // Only time while messages were being saved can show an account stayed silent. Clip every run
    // to that period; with no saved messages at all, nothing can be called silent.
    const fromM = senders.from ? minuteKey(senders.from) : Infinity;
    runs.length = 0;
    for (const r of allRuns) if (r.end >= fromM) runs.push({ login: r.login, start: Math.max(r.start, fromM), end: r.end });

    // Stretches of time we actually have chatter lists for. First/last-seen times that sit on these
    // edges only mark where our data starts or stops, not when the account arrived or left.
    const captureWindows = [];
    for (const snap of snaps) {
        const m = minuteKey(snap.recorded_at);
        const w = captureWindows[captureWindows.length - 1];
        if (w && m - w.end <= 2) w.end = m; else captureWindows.push({ start: m, end: m });
    }

    const isSilent = (login) => !senders.has(login) && !isChatBot(login) && login !== '';
    const longRuns = runs.filter(r => r.end - r.start + 1 >= THRESHOLDS.silentMinMinutes);
    const longPresentLogins = new Set(longRuns.map(r => r.login));
    const silentLongLogins = new Set(longRuns.filter(r => isSilent(r.login)).map(r => r.login));

    // Per-account totals across every run (short ones too) for the account-detail appendix.
    const perLogin = new Map();
    for (const r of runs) {
        if (!silentLongLogins.has(r.login)) continue;
        const s = sessionFor(r.start);
        const p = perLogin.get(r.login) || { minutes: 0, streams: new Set(), first: r.start, last: r.end };
        p.minutes += r.end - r.start + 1;
        if (s) p.streams.add(String(s.id));
        p.first = Math.min(p.first, r.start);
        p.last = Math.max(p.last, r.end);
        perLogin.set(r.login, p);
    }

    // Cohorts: silent long runs that start and end at the same minutes (±1), away from stream edges.
    const edge = THRESHOLDS.cohortEdgeMinutes;
    const groups = new Map();
    for (const r of longRuns) {
        if (!isSilent(r.login)) continue;
        const s = sessionFor(r.start);
        if (!s) continue;
        if (r.start - minuteKey(s.started_at) <= edge) continue;
        if (!s.open && minuteKey(s.ended_at) - r.end <= edge) continue;
        const key = `${r.start}:${r.end}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
    }
    // Merge neighbouring keys (±1 minute on either edge) into one cohort.
    const keys = Array.from(groups.keys()).map(k => k.split(':').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const used = new Set();
    const cohorts = [];
    for (const [s0, e0] of keys) {
        const k0 = `${s0}:${e0}`;
        if (used.has(k0)) continue;
        const members = [];
        for (const [s1, e1] of keys) {
            const k1 = `${s1}:${e1}`;
            if (used.has(k1) || Math.abs(s1 - s0) > 1 || Math.abs(e1 - e0) > 1) continue;
            used.add(k1);
            members.push(...groups.get(k1));
        }
        const logins = Array.from(new Set(members.map(m => m.login)));
        if (logins.length >= THRESHOLDS.cohortMinSize) {
            cohorts.push({ joinedAt: new Date(s0 * MIN), leftAt: new Date(e0 * MIN), minutes: e0 - s0 + 1, size: logins.length, logins });
        }
    }
    cohorts.sort((a, b) => b.size - a.size);

    return {
        accountsSeen: new Set(allRuns.map(r => r.login)).size,
        messagesFrom: senders.from || null,
        longPresent: longPresentLogins.size,
        silentLongPresent: silentLongLogins.size,
        silentLongLogins: Array.from(silentLongLogins),
        chattersLongPresent: Array.from(longPresentLogins).filter(l => senders.has(l)),
        perLogin,
        captureWindows: captureWindows.map(w => ({ start: new Date(w.start * MIN), end: new Date(w.end * MIN), startM: w.start, endM: w.end })),
        cohorts,
    };
}

// ─── B: account creation clusters ───────────────────────────────────────────

export async function accountAges(logins, { maxAgeDays = THRESHOLDS.accountCacheDays } = {}) {
    const wanted = Array.from(new Set(logins.map(l => String(l).toLowerCase()).filter(l => /^[a-z0-9_]{1,25}$/.test(l))))
        .slice(0, THRESHOLDS.accountLookupCap);
    if (!wanted.length) return new Map();
    const fresh = new Date(Date.now() - maxAgeDays * DAY);
    const [cachedFresh] = await pool.query(
        'SELECT login FROM twitch_account_cache WHERE login IN (?) AND fetched_at >= ?', [wanted, fresh]);
    const freshSet = new Set(cachedFresh.map(r => r.login));
    const missing = wanted.filter(l => !freshSet.has(l));
    if (missing.length) {
        const token = await getAccessToken().catch(() => null);
        if (token) {
            const headers = { 'Client-ID': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` };
            for (let i = 0; i < missing.length; i += 100) {
                const batch = missing.slice(i, i + 100);
                try {
                    const params = new URLSearchParams();
                    for (const l of batch) params.append('login', l);
                    const r = await axios.get(`https://api.twitch.tv/helix/users?${params}`, { headers, timeout: 15_000 });
                    const found = new Map((r.data?.data || []).map(u => [String(u.login).toLowerCase(), u]));
                    const now = new Date();
                    const rows = batch.map(l => {
                        const u = found.get(l);
                        return [l, u?.id || null, u?.created_at ? new Date(u.created_at) : null, u ? 1 : 0, now,
                                u ? (/user-default-pictures/.test(u.profile_image_url || '') ? 1 : 0) : null,
                                u ? (String(u.description || '').trim() ? 1 : 0) : null,
                                u ? (u.broadcaster_type || '') : null];
                    });
                    // gone_at is assigned first so it compares against the previous exists_on_twitch.
                    // A vanished account keeps its last-known id and creation date.
                    await pool.query(
                        `INSERT INTO twitch_account_cache
                            (login, user_id, created_at_twitch, exists_on_twitch, fetched_at, profile_default, has_bio, broadcaster_type)
                         VALUES ?
                         ON DUPLICATE KEY UPDATE
                             gone_at = CASE WHEN VALUES(exists_on_twitch) = 0 AND exists_on_twitch = 1 THEN VALUES(fetched_at)
                                            WHEN VALUES(exists_on_twitch) = 1 THEN NULL ELSE gone_at END,
                             user_id = COALESCE(VALUES(user_id), user_id),
                             created_at_twitch = COALESCE(VALUES(created_at_twitch), created_at_twitch),
                             exists_on_twitch = VALUES(exists_on_twitch), fetched_at = VALUES(fetched_at),
                             profile_default = COALESCE(VALUES(profile_default), profile_default),
                             has_bio = COALESCE(VALUES(has_bio), has_bio),
                             broadcaster_type = COALESCE(VALUES(broadcaster_type), broadcaster_type)`, [rows]);
                } catch (e) {
                    logger.warn(`${LOG} account lookup batch failed: ${e.message}`);
                }
            }
        }
    }
    const [rows] = await pool.query(
        `SELECT login, user_id, created_at_twitch, exists_on_twitch, profile_default, has_bio, broadcaster_type,
                gone_at, has_vod, last_vod_at, has_highlight, has_clip, last_clip_at, live_seen_at, live_started_at, vod_checked_at
           FROM twitch_account_cache WHERE login IN (?)`, [wanted]);
    const nb = (v) => (v === null || v === undefined ? null : !!v);
    // Streams we recorded ourselves (connected channels), as proof an account has gone live.
    const ids = rows.map(r => r.user_id).filter(Boolean).map(String);
    const liveHere = new Set();
    if (ids.length) {
        const [s] = await pool.query(
            'SELECT DISTINCT broadcaster_id FROM twitch_stream_sessions WHERE broadcaster_id IN (?)', [ids]).catch(() => [[]]);
        for (const x of s) liveHere.add(String(x.broadcaster_id));
    }
    // Twitch's API has no last-live field. A missing past broadcast does not mean an account never
    // streamed: Twitch deletes them after 7 to 60 days and streamers can turn saving off. Proof it
    // streamed: a past broadcast, highlight or clip (clips are only cut from streams), Affiliate or
    // Partner status, a stream we recorded, or our own 10-minute live check seeing it live.
    // So `streamed` is true only on proof, and null (unknown) otherwise; never false.
    const latest = (...ds) => ds.filter(Boolean).map(toDate).sort((a, b) => b - a)[0] || null;
    return new Map(rows.map(r => {
        const affiliated = r.broadcaster_type === 'affiliate' || r.broadcaster_type === 'partner';
        const streamed = r.has_vod === 1 || r.has_highlight === 1 || r.has_clip === 1 || affiliated
            || !!r.live_seen_at || liveHere.has(String(r.user_id)) ? true : null;
        const evidence = r.has_vod === 1 ? 'past broadcast' : r.live_seen_at ? 'seen live' : r.has_clip === 1 ? 'clip'
            : r.has_highlight === 1 ? 'highlight' : r.broadcaster_type === 'partner' ? 'partner'
            : affiliated ? 'affiliate' : liveHere.has(String(r.user_id)) ? 'recorded here' : null;
        return [r.login, {
            id: r.user_id ? String(r.user_id) : null, created: r.created_at_twitch, exists: !!r.exists_on_twitch,
            defaultAvatar: nb(r.profile_default), hasBio: nb(r.has_bio), broadcasterType: r.broadcaster_type,
            goneAt: r.gone_at, streamed, streamEvidence: evidence,
            // Real stream dates only: a past broadcast's start, or a stream we saw live.
            lastVodAt: latest(r.last_vod_at, r.live_started_at || r.live_seen_at),
            liveSeenAt: r.live_seen_at || null,
            // Only once the full check (broadcasts, highlights, clips) has run and found nothing.
            noSavedVods: !!r.vod_checked_at && r.has_vod === 0 && r.has_highlight === 0 && r.has_clip === 0 && streamed !== true,
        }];
    }));
}

function largestCreationCluster(dates, windowDays) {
    const t = dates.filter(Boolean).map(d => toDate(d).getTime()).sort((a, b) => a - b);
    let best = { count: 0, from: null, to: null };
    for (let i = 0, j = 0; i < t.length; i++) {
        while (t[i] - t[j] > windowDays * DAY) j++;
        if (i - j + 1 > best.count) best = { count: i - j + 1, from: new Date(t[j]), to: new Date(t[i]) };
    }
    return best;
}

// ─── C: unexplained viewer jumps ────────────────────────────────────────────

async function viewerJumps(bid, since, sessions) {
    const [rows] = await pool.execute(
        `SELECT recorded_at, viewer_count, raid_in_count FROM twitch_stream_snapshots
          WHERE broadcaster_id = ? AND recorded_at >= ? AND is_live = 1 ORDER BY recorded_at ASC`, [bid, since]);
    const [shoutouts] = await pool.execute(
        `SELECT occurred_at FROM twitch_shoutout_events
          WHERE broadcaster_id = ? AND direction = 'received' AND occurred_at >= ?`, [bid, since]);
    const shoutMinutes = shoutouts.map(s => minuteKey(s.occurred_at));
    const raidMinutes = rows.filter(r => Number(r.raid_in_count) > 0).map(r => minuteKey(r.recorded_at));
    const near = (list, m) => list.some(x => Math.abs(x - m) <= THRESHOLDS.jumpExplainMinutes);
    const sessionAt = (m) => sessions.find(x => m >= minuteKey(x.started_at) && m <= minuteKey(x.ended_at));
    const sessionStart = (m) => { const s = sessionAt(m); return s ? minuteKey(s.started_at) : null; };
    const sessionEndFor = (m) => { const s = sessionAt(m); return s && !s.open ? minuteKey(s.ended_at) : null; };

    const series = rows.map(r => ({ m: minuteKey(r.recorded_at), v: Number(r.viewer_count) || 0 }));
    const T = THRESHOLDS;
    const jumps = [];
    let explained = 0;
    for (let i = 1; i < series.length; i++) {
        const cur = series[i];
        const start = sessionStart(cur.m);
        if (start == null || cur.m - start < T.jumpIgnoreStartMinutes) continue;
        // Baseline = highest count in the previous 15 minutes, so a recovery from a dip
        // (count falls, then returns to where it was) is never read as a rise.
        const window = [];
        for (let k = i - 1; k >= 0 && cur.m - series[k].m <= T.jumpBaselineMinutes; k--) window.push(series[k]);
        if (window.length < T.jumpBaselineMinutes * 0.6) continue;
        const before = Math.max(...window.map(p => p.v));
        const delta = cur.v - before;
        // Beating every value of the previous 15 minutes by this margin also rules out gradual ramps.
        if (before <= 0 || delta < T.jumpMinViewers || delta / before < T.jumpMinRatio) continue;
        if (jumps.length && cur.m - minuteKey(jumps[jumps.length - 1].at) < 15) continue;
        // Sustained: one-minute spikes are API glitches, not arrivals.
        const hold = series.slice(i, i + T.jumpSustainMinutes + 1).filter(p => p.m - cur.m <= T.jumpSustainMinutes);
        if (hold.length < T.jumpSustainMinutes || Math.min(...hold.map(p => p.v)) < before + delta * 0.7) continue;
        if (near(raidMinutes, cur.m) || near(shoutMinutes, cur.m)) { explained++; continue; }

        // Block departure: later in the same stream the count drops by 70%+ of the rise within
        // 2 minutes, away from the stream's end, and does not recover within 10 minutes.
        const sessionEnd = sessionEndFor(cur.m);
        let departure = null;
        for (let k = i + T.jumpSustainMinutes; k < series.length; k++) {
            const p = series[k];
            if (sessionEnd != null && sessionEnd - p.m <= T.departureIgnoreEndMinutes) break;
            if (p.m - cur.m > 6 * 60) break;
            const prior = series.slice(Math.max(0, k - 2), k).filter(q => p.m - q.m <= 2);
            if (!prior.length) continue;
            const from = Math.max(...prior.map(q => q.v));
            if (from - p.v < delta * 0.7) continue;
            const later = series.find(q => q.m - p.m >= 10 && q.m - p.m <= 15);
            if (later && later.v >= from - delta * 0.5) continue;   // recovered: reconnect or glitch
            departure = { at: new Date(p.m * MIN), from, to: p.v, afterMinutes: p.m - cur.m };
            break;
        }
        jumps.push({ at: new Date(cur.m * MIN), before, after: cur.v, delta, ratio: delta / before, departure });
    }
    return { jumps, explained, series };
}

// Logged-in accounts in the chatter list vs Twitch's viewer count at the same minutes. Twitch
// counts people watching the video; the chatter list also holds accounts idling in chat that
// don't watch, so a list larger than the viewer count means those accounts aren't counted.
async function chatListVsViewers(bid, since) {
    const [[r]] = await pool.execute(
        `SELECT COUNT(*) AS minutes, AVG(c.total_count) AS listed, AVG(s.viewer_count) AS viewers
           FROM twitch_chatters_snapshots c
           JOIN twitch_stream_snapshots s
             ON s.broadcaster_id = c.broadcaster_id AND s.is_live = 1
            AND s.recorded_at = DATE_FORMAT(c.recorded_at, '%Y-%m-%d %H:%i:00')
          WHERE c.broadcaster_id = ? AND c.recorded_at >= ?`, [bid, since]);
    return { minutes: Number(r?.minutes) || 0, listed: Number(r?.listed) || 0, viewers: Number(r?.viewers) || 0 };
}

// E: one row per live minute that has both a viewer count and a chatter list, splitting the list into
// accounts on the known-bot list and everyone else.
async function listedTrack(bid, since) {
    const [listedRows] = await pool.execute(
        `SELECT LOWER(s.chatter_user_login) AS login FROM twitch_chatter_sightings s
           JOIN twitch_known_bot_checks k ON k.user_id = s.chatter_user_id
          WHERE s.broadcaster_id = ? AND k.listed = 1`, [bid]);
    const listed = new Set(listedRows.map(r => r.login));
    const [rows] = await pool.execute(
        `SELECT c.recorded_at, c.chatter_logins_json, s.viewer_count
           FROM twitch_chatters_snapshots c
           JOIN twitch_stream_snapshots s
             ON s.broadcaster_id = c.broadcaster_id AND s.is_live = 1
            AND s.recorded_at = DATE_FORMAT(c.recorded_at, '%Y-%m-%d %H:%i:00')
          WHERE c.broadcaster_id = ? AND c.recorded_at >= ? AND s.viewer_count IS NOT NULL
          ORDER BY c.recorded_at ASC`, [bid, since]);
    return rows.map(r => {
        let logins = [];
        try { logins = JSON.parse(r.chatter_logins_json || '[]'); } catch { /* skip malformed */ }
        const onList = logins.filter(l => listed.has(String(l).toLowerCase())).length;
        return { m: minuteKey(r.recorded_at), viewers: Number(r.viewer_count), listed: onList, other: logins.length - onList };
    });
}

// Every account seen by any route (chat lists or messages), which is wider than the silent accounts.
async function accountTotals(bid, since) {
    const [[r]] = await pool.execute(
        `SELECT COUNT(*) AS seen, COUNT(k.user_id) AS checked, COALESCE(SUM(k.listed = 1), 0) AS listed,
                COALESCE(SUM(s.messages > 0), 0) AS chatted, COALESCE(SUM(k.listed = 1 AND s.messages > 0), 0) AS listedChatted
           FROM twitch_chatter_sightings s LEFT JOIN twitch_known_bot_checks k ON k.user_id = s.chatter_user_id
          WHERE s.broadcaster_id = ? AND s.last_seen_at >= ?`, [bid, since]);
    // Accounts in the chatter lists that never reached sightings are matched through the account cache.
    const { seen } = await chatListPresence(bid);
    const [sighted] = await pool.execute('SELECT LOWER(chatter_user_login) AS login FROM twitch_chatter_sightings WHERE broadcaster_id = ?', [bid]);
    const inSightings = new Set(sighted.map(s => s.login));
    const others = Array.from(seen.keys()).filter(l => !inSightings.has(l));
    const [[o]] = others.length ? await pool.query(
        `SELECT COUNT(*) AS checked, COALESCE(SUM(k.listed = 1), 0) AS listed
           FROM twitch_account_cache c JOIN twitch_known_bot_checks k ON k.user_id = c.user_id
          WHERE c.login IN (?)`, [others]) : [[{ checked: 0, listed: 0 }]];
    return { seen: (Number(r.seen) || 0) + others.length, checked: (Number(r.checked) || 0) + (Number(o.checked) || 0),
             listed: (Number(r.listed) || 0) + (Number(o.listed) || 0),
             chatted: Number(r.chatted) || 0, listedChatted: Number(r.listedChatted) || 0 };
}

// ─── Chatter legitimacy (descriptive) ───────────────────────────────────────

async function chatterLegitimacy(bid, since) {
    const [rows] = await pool.execute(
        `SELECT LOWER(chatter_user_login) AS login, message_text, has_link, occurred_at
           FROM twitch_chat_message_samples WHERE broadcaster_id = ? AND occurred_at >= ?
          ORDER BY occurred_at ASC`, [bid, since]);
    const human = rows.filter(r => r.login && !isChatBot(r.login));
    const bots = rows.length - human.length;
    const perChatter = new Map();
    for (const r of human) perChatter.set(r.login, (perChatter.get(r.login) || 0) + 1);
    const counts = Array.from(perChatter.values()).sort((a, b) => b - a);
    const topShare = human.length ? (counts.slice(0, 5).reduce((a, n) => a + n, 0) / human.length) : 0;

    // Copy-paste bursts: the same normalized text (8+ chars) from 3+ distinct accounts within 2 minutes.
    const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const byText = new Map();
    for (const r of human) {
        const t = norm(r.message_text);
        if (t.length < 8) continue;
        if (!byText.has(t)) byText.set(t, []);
        byText.get(t).push(r);
    }
    const bursts = [];
    for (const [text, msgs] of byText) {
        for (let i = 0; i < msgs.length; i++) {
            const windowMsgs = msgs.filter(m => toDate(m.occurred_at) - toDate(msgs[i].occurred_at) >= 0
                && toDate(m.occurred_at) - toDate(msgs[i].occurred_at) <= 2 * MIN);
            const accounts = new Set(windowMsgs.map(m => m.login));
            if (accounts.size >= 3) { bursts.push({ text: text.slice(0, 80), accounts: accounts.size, at: msgs[i].occurred_at }); break; }
        }
    }
    bursts.sort((a, b) => b.accounts - a.accounts);
    return {
        firstMessageAt: rows[0]?.occurred_at || null,
        messages: rows.length,
        humanMessages: human.length,
        botMessages: bots,
        chatters: perChatter.size,
        oneMessageChatters: counts.filter(n => n === 1).length,
        topFiveShare: topShare,
        linkMessages: human.filter(r => r.has_link).length,
        copyPasteBursts: bursts.slice(0, 10),
    };
}

// ─── Detected anomalies ────────────────────────────────────────────────────

async function confirmedAnomalies(bid, since) {
    const [rows] = await pool.execute(
        `SELECT id, alert_type, severity, status, score, evidence_json, created_at, resolution_note
           FROM twitch_anomaly_alerts WHERE broadcaster_id = ? AND created_at >= ?
          ORDER BY created_at DESC`, [bid, since]);
    const kept = rows.filter(r => r.status !== 'superseded');
    return {
        excludedFalsePositives: rows.length - kept.length,
        alerts: kept.map(r => {
            let ev = {};
            try { ev = JSON.parse(r.evidence_json || '{}'); } catch { /* keep empty */ }
            return { id: r.id, type: r.alert_type, severity: r.severity, status: r.status, at: r.created_at,
                     interpretation: ev.interpretation || null, note: r.resolution_note || null,
                     target: ev.target || null, legacyCount: r.alert_type === 'harassment' && !ev.senders };
        }),
    };
}

/** alert id -> captured chat by or naming the target around a harassment alert. */
export async function alertChatMessages(bid, alerts) {
    const out = {};
    for (const a of alerts.filter(al => al.type === 'harassment' && al.target).slice(0, 25)) {
        const at = new Date(a.at);
        const [rows] = await pool.execute(
            `SELECT occurred_at AS at, chatter_user_login AS login, message_text AS text
               FROM twitch_chat_message_samples
              WHERE broadcaster_id = ? AND occurred_at BETWEEN DATE_SUB(?, INTERVAL 5 MINUTE) AND DATE_ADD(?, INTERVAL 2 MINUTE)
                AND (chatter_user_login = ? OR message_text LIKE ?)
              ORDER BY occurred_at LIMIT 60`,
            [bid, at, at, a.target, `%${String(a.target).replace(/[\\%_]/g, '\\$&')}%`]);
        out[a.id] = rows;
    }
    return out;
}

// ─── Verdict ────────────────────────────────────────────────────────────────

function grade(indicators, labels, rule) {
    const assessed = indicators.filter(i => i.met !== null);
    const met = assessed.filter(i => i.met).length;
    const label = !assessed.length ? 'Not assessed' : labels[Math.min(met, labels.length - 1)];
    return { label, level: !assessed.length ? 'na' : met === 0 ? 'none' : met >= labels.length - 1 ? 'strong' : 'some',
             met, assessed: assessed.length, total: indicators.length, rule, indicators };
}

const cache = new Map();

export function clearIntegrityCache() { cache.clear(); }

// ─── Known-bot account list ─────────────────────────────────────────────────

// Minutes each account sat in the chatter lists. Sightings start later than the lists, so a date from
// sightings alone can be too late.
async function chatListPresence(bid) {
    const [rows] = await pool.execute(
        'SELECT recorded_at, chatter_logins_json FROM twitch_chatters_snapshots WHERE broadcaster_id = ? ORDER BY recorded_at ASC', [bid]);
    const seen = new Map();
    for (const r of rows) {
        let logins = [];
        try { logins = JSON.parse(r.chatter_logins_json || '[]'); } catch { /* skip malformed */ }
        const minute = minuteKey(r.recorded_at);
        for (const raw of logins) {
            const login = String(raw).toLowerCase();
            const p = seen.get(login);
            if (!p) seen.set(login, { first: r.recorded_at, last: r.recorded_at, minutes: 1, minute });
            else if (p.minute !== minute) { p.last = r.recorded_at; p.minutes++; p.minute = minute; }
        }
    }
    return { seen, from: rows.length ? rows[0].recorded_at : null };
}

/** Every account seen in this channel by any route whose ID is on the known-bot list, oldest account first. */
export async function buildKnownBotList(bid) {
    const { seen, from } = await chatListPresence(bid);
    const [sighted] = await pool.execute(
        `SELECT s.chatter_user_id AS id, LOWER(s.chatter_user_login) AS login, s.first_seen_at, s.last_seen_at,
                s.messages, s.is_mod, s.is_vip, s.is_sub, k.checked_at, k.first_listed_at
           FROM twitch_chatter_sightings s JOIN twitch_known_bot_checks k ON k.user_id = s.chatter_user_id
          WHERE s.broadcaster_id = ? AND k.listed = 1`, [bid]);
    // Accounts in the chatter lists that never reached sightings are matched through the account cache.
    const sightedLogins = new Set(sighted.map(r => r.login));
    const others = Array.from(seen.keys()).filter(l => !sightedLogins.has(l));
    const [unsighted] = others.length ? await pool.query(
        `SELECT c.user_id AS id, c.login, k.checked_at, k.first_listed_at
           FROM twitch_account_cache c JOIN twitch_known_bot_checks k ON k.user_id = c.user_id
          WHERE k.listed = 1 AND c.login IN (?)`, [others]) : [[]];

    const rows = [...sighted, ...unsighted].filter(r => /^[a-z0-9_]{1,25}$/.test(r.login || '') && !isChatBot(r.login));
    const ages = await accountAges(rows.map(r => r.login));
    const created = rows.map(r => ages.get(r.login)?.created).filter(Boolean);
    const batch = largestCreationCluster(created, THRESHOLDS.creationClusterDays);
    const isBatch = batch.count >= THRESHOLDS.creationClusterMin;
    const [[latest]] = await pool.execute(
        'SELECT started_at FROM twitch_stream_sessions WHERE broadcaster_id = ? ORDER BY started_at DESC LIMIT 1', [bid]);
    const newSince = latest ? toDate(latest.started_at) : null;

    const accounts = rows.map(r => {
        const age = ages.get(r.login), p = seen.get(r.login);
        const when = [p?.first, r.first_seen_at].filter(Boolean).map(d => toDate(d).getTime());
        const until = [p?.last, r.last_seen_at].filter(Boolean).map(d => toDate(d).getTime());
        const at = age?.created ? toDate(age.created) : null;
        const firstSeen = when.length ? new Date(Math.min(...when)) : null;
        // New either way round: first seen here this stream, or seen before and only found on the list this stream.
        const isNew = !!newSince && ((firstSeen && firstSeen >= newSince) || (r.first_listed_at && toDate(r.first_listed_at) >= newSince));
        return {
            id: String(r.id), login: r.login, created: at, exists: age ? age.exists : null, goneAt: age?.goneAt || null,
            firstSeen, lastSeen: until.length ? new Date(Math.max(...until)) : null, isNew,
            minutes: p?.minutes || 0, chatted: Number(r.messages) > 0,
            role: [r.is_mod && 'Mod', r.is_vip && 'VIP', r.is_sub && 'Sub'].filter(Boolean).join(', '),
            inBatch: !!(isBatch && at && at >= batch.from && at <= batch.to),
            checkedAt: r.checked_at, firstListedAt: r.first_listed_at,
            profileUrl: `https://www.twitch.tv/${r.login}`, reportUrl: `https://www.twitch.tv/${r.login}/report`,
            listUrl: knownBotListUrl(r.id),
        };
    }).sort((a, b) => (a.created ? a.created.getTime() : Infinity) - (b.created ? b.created.getTime() : Infinity) || a.login.localeCompare(b.login));

    const dated = accounts.filter(a => a.created);
    return {
        accounts, generatedAt: new Date(),
        summary: {
            count: accounts.length, oldest: dated[0]?.created || null, newest: dated[dated.length - 1]?.created || null,
            batch, seenFrom: from, removed: accounts.filter(a => a.exists === false).length,
            lookFirst: accounts.filter(a => a.chatted || a.role).length,
            newSince, newCount: accounts.filter(a => a.isNew).length,
        },
    };
}

export async function buildIntegrityReport(bid, { days = 90 } = {}) {
    const key = `${bid}:${days}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 10 * MIN) return hit.report;

    const now = new Date();
    const since = new Date(now.getTime() - days * DAY);
    const [cov, sessions, senders] = await Promise.all([coverage(bid, since), sessionsIn(bid, since), messageSenders(bid, since)]);
    const presence = cov.chatterListMinutes ? await silentPresence(bid, since, sessions, senders) : null;
    const [jumps, chat, anomalies, chatList, track, audience] = await Promise.all([
        viewerJumps(bid, since, sessions), chatterLegitimacy(bid, since), confirmedAnomalies(bid, since), chatListVsViewers(bid, since),
        listedTrack(bid, since), accountTotals(bid, since)]);
    const linkSessions = sessions.map(s => ({ startM: minuteKey(s.started_at), endM: minuteKey(s.ended_at), open: !!s.open }));
    const link = assessViewerLink(track, linkSessions);
    const dips = viewerDips(jumps.series, linkSessions);
    // The span the numbers really cover: a window reaching back before collection began is cut to where it began.
    const collectedFrom = cov.collectedFrom ? toDate(cov.collectedFrom) : null;
    const from = collectedFrom && collectedFrom > since ? collectedFrom : since;
    const window = { from, to: now, days: Math.max(1, Math.round((now - from) / DAY)), cut: from !== since };

    let ages = null;
    let accounts = [];
    let known = null;
    if (presence && presence.silentLongLogins.length) {
        const lookup = await accountAges([...presence.silentLongLogins, ...presence.chattersLongPresent]);
        const silentAges = presence.silentLongLogins.map(l => lookup.get(l)).filter(Boolean);
        const chatterAges = presence.chattersLongPresent.map(l => lookup.get(l)).filter(Boolean);
        const silentCluster = largestCreationCluster(silentAges.map(a => a.created), THRESHOLDS.creationClusterDays);
        const chatterCluster = largestCreationCluster(chatterAges.map(a => a.created), THRESHOLDS.creationClusterDays);
        // Accounts in the batch that also sit in other channels we track look like a Twitch-wide
        // lurker network rather than something aimed at this channel.
        const clusterLogins = silentCluster.count
            ? presence.silentLongLogins.filter(l => {
                const c = lookup.get(l)?.created;
                return c && toDate(c) >= silentCluster.from && toDate(c) <= silentCluster.to;
            })
            : [];
        let seenElsewhere = 0, otherChannels = 0;
        if (clusterLogins.length) {
            const [[o]] = await pool.query(
                `SELECT COUNT(DISTINCT chatter_user_login) AS n FROM twitch_chatter_sightings
                  WHERE broadcaster_id <> ? AND LOWER(chatter_user_login) IN (?)`, [bid, clusterLogins]);
            const [[t]] = await pool.query(
                'SELECT COUNT(DISTINCT broadcaster_id) AS n FROM twitch_chatter_sightings WHERE broadcaster_id <> ?', [bid]);
            seenElsewhere = Number(o?.n) || 0;
            otherChannels = Number(t?.n) || 0;
        }
        // D: CommanderRoot known-bot list, from the cache the background sweep fills (no network here).
        const silentIds = presence.silentLongLogins.map(l => lookup.get(l)?.id).filter(Boolean);
        const status = await knownBotStatus(silentIds).catch(() => new Map());
        const listedLogins = new Set(presence.silentLongLogins.filter(l => status.get(String(lookup.get(l)?.id)) === true));
        known = {
            silent: presence.silentLongLogins.length,
            checked: presence.silentLongLogins.filter(l => status.has(String(lookup.get(l)?.id))).length,
            listed: listedLogins.size,
            batchListed: clusterLogins.filter(l => listedLogins.has(l)).length,
            batchSize: clusterLogins.length,
        };
        known.share = known.checked ? known.listed / known.checked : 0;
        known.statusOf = (l) => { const id = String(lookup.get(l)?.id); return status.has(id) ? status.get(id) : null; };
        const firstListed = await knownBotFirstListed(silentIds).catch(() => new Map());
        known.firstListedOf = (l) => firstListed.get(String(lookup.get(l)?.id)) || null;

        // Account detail: every silent long-present account, with what we measured about it.
        const elsewhere = new Map();
        const [seen] = await pool.query(
            `SELECT LOWER(chatter_user_login) AS login, COUNT(DISTINCT broadcaster_id) AS n FROM twitch_chatter_sightings
              WHERE broadcaster_id <> ? AND LOWER(chatter_user_login) IN (?) GROUP BY LOWER(chatter_user_login)`,
            [bid, presence.silentLongLogins]);
        for (const row of seen) elsewhere.set(row.login, Number(row.n) || 0);
        const clusterSet = new Set(clusterLogins);
        const cohortOf = new Map();
        presence.cohorts.forEach((c, i) => c.logins.forEach(l => cohortOf.set(l, i + 1)));
        // Only valid Twitch logins: the appendix and CSV insert them unescaped.
        accounts = presence.silentLongLogins.filter(l => /^[a-z0-9_]{1,25}$/.test(l)).map(l => {
            const a = lookup.get(l);
            const p = presence.perLogin.get(l);
            return {
                login: l,
                created: a?.created ? toDate(a.created) : null,
                exists: a ? a.exists : null,
                minutes: p ? p.minutes : 0,
                streams: p ? p.streams.size : 0,
                firstSeen: p ? new Date(p.first * MIN) : null,
                lastSeen: p ? new Date(p.last * MIN) : null,
                firstAtEdge: p ? presence.captureWindows.some(w => Math.abs(w.startM - p.first) <= 1)
                                 || (presence.messagesFrom && Math.abs(minuteKey(presence.messagesFrom) - p.first) <= 1) : false,
                lastAtEdge: p ? presence.captureWindows.some(w => Math.abs(w.endM - p.last) <= 1) : false,
                inBatch: clusterSet.has(l),
                onKnownList: known ? known.statusOf(l) : null,
                firstListedAt: known ? known.firstListedOf(l) : null,
                defaultAvatar: a ? a.defaultAvatar : null,
                hasBio: a ? a.hasBio : null,
                streamed: a ? a.streamed : null,
                noSavedVods: a ? a.noSavedVods : false,
                broadcasterType: a ? a.broadcasterType || '' : '',
                streamEvidence: a ? a.streamEvidence : null,
                lastVodAt: a ? a.lastVodAt : null,
                goneAt: a ? a.goneAt : null,
                cohort: cohortOf.get(l) || null,
                otherChannels: elsewhere.get(l) || 0,
            };
        }).sort((x, y) => (x.created ? x.created.getTime() : Infinity) - (y.created ? y.created.getTime() : Infinity)
                        || x.login.localeCompare(y.login));
        // Per-account findings, each a measured fact worded as one. No single flag is proof; the
        // report shows them so a reader can see everything out of place about an account at once.
        for (const x of accounts) {
            x.ageAtFirstSeen = x.created && x.firstSeen ? Math.floor((x.firstSeen - x.created) / DAY) : null;
            const f = [];
            if (x.onKnownList === true) f.push({ key: 'listed', label: "Found on CommanderRoot's bot list" });
            if (x.inBatch) f.push({ key: 'batch', label: 'Created in the bulk batch' });
            if (x.cohort) f.push({ key: 'cohort', label: `Joined and left with cohort ${x.cohort}` });
            if (x.exists === false) f.push({ key: 'removed', label: 'No longer on Twitch' });
            if (x.ageAtFirstSeen !== null && x.ageAtFirstSeen < 30) {
                f.push({ key: 'new', label: x.ageAtFirstSeen < 1 ? 'Created the day we first saw it' : `Created ${x.ageAtFirstSeen} day${x.ageAtFirstSeen === 1 ? '' : 's'} before we first saw it` });
            }
            if (cov.chatSampling) f.push({ key: 'silent', label: '0 messages' });
            if (x.noSavedVods) f.push({ key: 'neverLive', label: 'No stream history found' });
            if (x.defaultAvatar === true) f.push({ key: 'defaultPic', label: 'Default profile picture' });
            if (x.hasBio === false) f.push({ key: 'noBio', label: 'No bio' });
            if (x.otherChannels > 0) f.push({ key: 'elsewhere', label: `Also in ${x.otherChannels} other tracked channel${x.otherChannels === 1 ? '' : 's'}` });
            x.flags = f;
        }
        // Profiles of the listed accounts. Context only: real lurkers also skip bios and never stream.
        if (known) {
            const L = accounts.filter(x => x.onKnownList === true);
            known.profile = {
                listed: L.length,
                defaultAvatar: L.filter(x => x.defaultAvatar === true).length,
                noBio: L.filter(x => x.hasBio === false).length,
                neverStreamed: L.filter(x => x.noSavedVods).length,
                streamChecked: L.filter(x => x.noSavedVods || x.streamed === true).length,
                removedSinceListed: L.filter(x => x.goneAt && (!x.firstListedAt || toDate(x.goneAt) >= toDate(x.firstListedAt))).length,
                removed: L.filter(x => x.exists === false).length,
            };
            const U = accounts.filter(x => x.onKnownList === false);
            known.profile.compare = {
                count: U.length,
                noBio: U.filter(x => x.hasBio === false).length,
                neverStreamed: U.filter(x => x.noSavedVods).length,
                defaultAvatar: U.filter(x => x.defaultAvatar === true).length,
            };
        }
        ages = {
            silentLookedUp: silentAges.length,
            silentGone: silentAges.filter(a => !a.exists).length,
            silentCluster,
            silentClusterShare: silentAges.length ? silentCluster.count / silentAges.length : 0,
            chatterLookedUp: chatterAges.length,
            chatterClusterShare: chatterAges.length ? chatterCluster.count / chatterAges.length : 0,
            silentUnder30d: silentAges.filter(a => a.created && now - toDate(a.created) < 30 * DAY).length,
            clusterSeenElsewhere: seenElsewhere,
            otherChannelsTracked: otherChannels,
        };
    }

    const avgViewers = sessions.length
        ? sessions.reduce((a, s) => a + (Number(s.avg_viewers) || 0) * (Number(s.duration_minutes) || 1), 0)
          / Math.max(1, sessions.reduce((a, s) => a + (Number(s.duration_minutes) || 1), 0))
        : 0;
    const peakViewers = sessions.reduce((a, s) => Math.max(a, Number(s.peak_viewers) || 0), 0);
    const T = THRESHOLDS;
    const biggestCohort = presence?.cohorts[0] || null;

    const indicators = [
        {
            id: 'A', name: 'Synchronized silent accounts in chat',
            met: presence ? presence.cohorts.length > 0 : null,
            value: presence ? (biggestCohort ? `${biggestCohort.size} accounts joined and left together` : 'no qualifying group') : 'not assessed',
            threshold: `${T.cohortMinSize}+ accounts that never chatted, stayed ${T.silentMinMinutes}+ minutes, joined within the same minute and left within the same minute (ignoring the first and last ${T.cohortEdgeMinutes} minutes of each stream)`,
            why: 'Independent viewers do not arrive and leave in lockstep. Groups that do, without ever chatting, behave like a single controlled source.',
            missing: presence ? null : 'No per-minute chatter lists in this window.',
        },
        {
            id: 'B', name: 'Bulk-created accounts in chat',
            met: ages ? (ages.silentCluster.count >= T.creationClusterMin && ages.silentClusterShare >= T.creationClusterShare) : null,
            value: ages ? `${ages.silentCluster.count} of ${ages.silentLookedUp} silent long-present accounts created within ${T.creationClusterDays} days (${Math.round(ages.silentClusterShare * 100)}%)` : 'not assessed',
            threshold: `${T.creationClusterMin}+ accounts and ${Math.round(T.creationClusterShare * 100)}%+ of silent long-present accounts created within any ${T.creationClusterDays}-day span (account creation dates from Twitch)`,
            why: 'Genuine audiences are created over years. Batches registered in the same week point to accounts made for the purpose.',
            missing: ages ? null : (presence ? 'No silent long-present accounts to check.' : 'No per-minute chatter lists in this window.'),
        },
        {
            id: 'C', name: 'Viewers arriving and leaving as a block',
            met: jumps.series.length ? jumps.jumps.filter(j => j.departure).length >= T.jumpMinCount : null,
            value: jumps.series.length
                ? `${jumps.jumps.filter(j => j.departure).length} block arrival${jumps.jumps.filter(j => j.departure).length === 1 ? '' : 's'} with a block departure · ${jumps.jumps.filter(j => !j.departure).length} other unexplained rise${jumps.jumps.filter(j => !j.departure).length === 1 ? '' : 's'} · ${jumps.explained} explained by raids or shoutouts`
                : 'not assessed',
            threshold: `${T.jumpMinCount}+ times the viewer count rose ${Math.round(T.jumpMinRatio * 100)}%+ and ${T.jumpMinViewers}+ viewers above its highest point of the previous ${T.jumpBaselineMinutes} minutes, held ${T.jumpSustainMinutes}+ minutes, with no raid or received shoutout within ${T.jumpExplainMinutes} minutes and not in the first ${T.jumpIgnoreStartMinutes} minutes — and later in the same stream fell by 70%+ of that rise within 2 minutes (not in the last ${T.departureIgnoreEndMinutes} minutes, and not recovering within 10)`,
            why: 'A rise on its own can be organic (a shared link, a community ping). Extra viewers that arrive as a block and later leave as a block, mid-stream, behave like a controlled source; real audiences drift away gradually.',
            missing: jumps.series.length ? null : 'No live viewer data in this window.',
        },
        (() => {
            const assessed = !!known && known.silent > 0 && known.checked >= Math.max(1, Math.ceil(known.silent * T.knownListMinChecked));
            return {
                id: 'D', name: 'Accounts on a known-bot list',
                met: assessed ? (known.listed >= T.knownListMinCount && known.share >= T.knownListMinShare) : null,
                value: known
                    ? `${known.listed} of ${known.checked} checked silent long-present accounts are listed (${Math.round(known.share * 100)}%)${known.batchSize ? ` · ${known.batchListed} of ${known.batchSize} in the creation batch` : ''}${known.checked < known.silent ? ` · ${known.silent - known.checked} not checked yet` : ''}`
                    : 'not assessed',
                threshold: `${T.knownListMinCount}+ accounts and ${Math.round(T.knownListMinShare * 100)}%+ of silent long-present accounts on CommanderRoot's known-bot list (twitch-tools.rootonline.de, ~95 million accounts, updated daily; results rechecked weekly). Assessed once ${Math.round(T.knownListMinChecked * 100)}%+ of those accounts have been checked`,
                why: 'An independent, actively maintained list built from accounts seen behaving as bots across Twitch. Channel service bots (StreamElements, Nightbot and similar) are not on it. Being listed says what an account is, not who sent it.',
                missing: !known ? (presence ? 'No silent long-present accounts to check.' : 'No per-minute chatter lists in this window.')
                    : assessed ? null : `Only ${known.checked} of ${known.silent} accounts checked so far; the check runs in the background.`,
            };
        })(),
        {
            id: 'E', name: 'Viewer count moving with listed accounts',
            met: link.met,
            value: link.assessed
                ? `Viewers against listed accounts in chat: ${link.rListed === null ? 'no listed accounts' : `correlation ${link.rListed.toFixed(2)}`}${link.rOther === null ? '' : ` · against everyone else: ${link.rOther.toFixed(2)}`} · ${link.moves.length} block move${link.moves.length === 1 ? '' : 's'} with viewers following · ${link.minutes} minutes compared`
                : 'not assessed',
            threshold: `Across ${LINK.minMinutes}+ live minutes, correlation of ${LINK.minCorrelation}+ between the viewer count and the known-bot accounts in chat, and ${LINK.minMoves}+ times ${LINK.moveMinAccounts}+ of those accounts left or arrived within ${LINK.moveWindowMinutes} minutes with viewers shifting by at least half as many while everyone else in chat stayed (not in the first ${LINK.moveIgnoreStartMinutes} or last ${LINK.moveIgnoreEndMinutes} minutes of a stream)`,
            why: 'Listed accounts alone do not prove inflation, because an account in chat is not always counted as a viewer. When they leave and viewers leave with them, and everyone else stays, those accounts were counted. It shows how the number behaved, not who sent the accounts.',
            missing: link.assessed ? null : `Needs ${LINK.minMinutes}+ live minutes with chatter lists; this window has ${link.minutes}.`,
        },
    ];

    const report = {
        generatedAt: now, days, since, bid, window,
        coverage: cov,
        audience,
        viewerLink: { ...link, track, dips },
        stats: { sessions: sessions.length, avgViewers, peakViewers },
        sessions,
        presence: presence && { ...presence, silentLongLogins: undefined, chattersLongPresent: undefined, perLogin: undefined },
        known: known && { ...known, statusOf: undefined, firstListedOf: undefined },
        accounts,
        flagCounts: accounts.reduce((m, a) => { for (const f of a.flags || []) m[f.key] = (m[f.key] || 0) + 1; return m; }, {}),
        ages, jumps: { list: jumps.jumps, explained: jumps.explained, series: jumps.series }, chat, anomalies, chatList,
        verdicts: {
            viewers: grade([indicators[2], indicators[4]],
                ['No indicators of viewer inflation', 'Indicators of viewer inflation'],
                'Indicators C and E: either one met counts. This describes how the viewer count behaved, not who caused it.'),
            chat: grade([indicators[0], indicators[1], indicators[3]],
                ['No indicators of automated accounts', 'Some indicators of automated accounts', 'Strong indicators of automated accounts'],
                'Indicators A, B and D: none met = no indicators · one met = some · two or more met = strong. Indicators that could not be assessed do not count either way.'),
        },
        thresholds: T,
    };
    cache.set(key, { at: Date.now(), report });
    return report;
}


// ─── PDF / PNG rendering (shared by the dashboard download and the monthly DM) ──
const INTEGRITY_VIEW = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard', 'views', 'twitch-integrity-report.ejs');

/** Render a built report to { pdf, png, baseName }. One browser serves both renders. */
export async function renderIntegrityFiles(report, { login, guildId, tz = 'UTC' }) {
    const html = await ejs.renderFile(INTEGRITY_VIEW, {
        report, guildId, login, tz, base: `/manage/${guildId}/twitch-analytics/integrity`, printMode: true });
    const browser = await getBrowser();
    if (!browser) throw new Error('report renderer unavailable');
    try {
        const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
        await page.setContent(html, { waitUntil: 'load' });
        const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' } });
        const png = await page.screenshot({ type: 'png', fullPage: true });
        const stamp = new Date().toISOString().slice(0, 10);
        const baseName = `${String(login).replace(/[^a-z0-9_]/gi, '')}-integrity-${report.window.days}d-${stamp}`;
        return { pdf, png, baseName };
    } finally {
        await closeBrowser(browser).catch(() => {});
    }
}
