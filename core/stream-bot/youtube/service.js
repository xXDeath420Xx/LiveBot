/*
 * Stream bot, YouTube Live: finding the broadcast, reading its chat, and acting in it (design §13).
 *
 *   createYouTubeService({ db, store, ingest, api, auth, quota, logger?, now?, sleep?, timings? })
 *     start() / stop()                 the 15-second scheduler (startStreamBot starts it; tests drive tick() themselves)
 *     tick()                           reload linked channels (every minute), check the ones that are due, verify live ones
 *     hint(profileId)                  another of the profile's platforms went live, or Studio started streaming: check YouTube
 *                                      now and every minute for 10 minutes
 *     checkNow(profileId)              the Connections page's "Check now"
 *     sendChat({ profileId, channelId, text })            → { ok, error? }   as the channel, 20 units
 *     deleteMessage(profileId, ev, { dryRun })            → { status, detail }
 *     moderate(profileId, ev, { seconds, dryRun })        → { status, detail }   timeout (seconds) or ban (null), 200 units
 *     streamInfo({ profileId, channelId })                → { live, title, category, viewers, startedAt } | null (no API call)
 *     status(profileId)                                   → { channels: [...], quota }  for Connections
 *
 * Going live. A channel that is not live is checked with liveBroadcasts.list (broadcastStatus=active, the streamer's own token,
 * 1 unit): every 10 minutes when nothing hints otherwise (20 when quota is "slow", 40 when "critical"), and every minute for
 * 10 minutes after a hint. YouTube's public /live page no longer carries the broadcast without a browser (checked 2026-11-20),
 * so there is no free check; hints make the common case (going live everywhere at once) fast.
 *
 * Chat. While live, liveChatMessages.streamList is read connection after connection (YouTube closes each after about 10.5 s;
 * 5 units each, about 1,700 units an hour), resuming from the last nextPageToken, which is also kept in stream_bot_youtube_live
 * every 30 seconds so a restart resumes where it stopped. The quota guard adds a pause between connections when the day's
 * allowance runs low (quota.js). If the streaming endpoint is refused as unknown twice, the reader falls back to
 * liveChatMessages.list, waiting max(pollingIntervalMillis, the guard's floor) between calls. The first connection of a new
 * broadcast skips YouTube's backlog of older messages. Every 10 minutes a live broadcast is verified with videos.list (1 unit,
 * viewer count for {stream.viewers}); offlineAt, chatEndedEvent, liveChatEnded and an ended video all end it.
 *
 * Every message becomes an event through ingest.youtube() (echo guard, de-duplication, store, live feed, automations, viewers).
 * Before that, each message (also deletions and bans, which are not events) goes to ingest.youtubeRaw(item, channelId) when
 * something set it: the Chat overlay (overlays/index.js), like the raw Twitch and Kick notifications.
 */
import { normaliseYouTubeMessage, broadcastEvent, isChatEnded } from './normalise.js';
import { CHAT_MAX } from './config.js';

export const TIMINGS = Object.freeze({
    tickMs: 15_000,
    reloadMs: 60_000,
    idleCheckMs: 10 * 60_000,
    burstCheckMs: 60_000,
    burstMs: 10 * 60_000,
    verifyMs: 10 * 60_000,
    persistMs: 30_000,
    maxAgeMs: 15 * 60_000,       // messages older than this are never events (backlog after a gap)
    backlogSlackMs: 60_000,      // the first connection of a broadcast keeps messages from this long before the reader started
});

const LEVEL_FACTOR = Object.freeze({ normal: 1, slow: 2, critical: 4, exhausted: 6 });
const FIRST_MAX = 50_000;

const ERRORS = Object.freeze({
    liveChatDisabled: 'Live chat is turned off for this broadcast.',
    forbidden: 'YouTube did not let CertiFried read or act in this chat.',
    liveChatEnded: 'The live chat has ended.',
    liveChatNotFound: 'YouTube no longer has this live chat.',
    rateLimitExceeded: 'YouTube asked CertiFried to slow down.',
    quotaExceeded: 'Today\'s YouTube allowance is used up.',
    quotaGuardExhausted: 'Today\'s YouTube allowance is used up.',
    quotaGuardCritical: 'Paused to save today\'s YouTube allowance.',
    network: 'Could not reach YouTube.',
});
const say = (err) => ERRORS[err?.reason] || err?.message || 'YouTube refused the request.';

function abortableSleep(ms, signal = null) {
    return new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const t = setTimeout(done, Math.max(0, ms));
        function done() { clearTimeout(t); signal?.removeEventListener?.('abort', done); resolve(); }
        signal?.addEventListener?.('abort', done, { once: true });
    });
}

export function createYouTubeService({
    db, store, ingest, api, auth, quota, logger = null, now = () => Date.now(), sleep = abortableSleep, timings = {}, prefix = null,
} = {}) {
    const TM = { ...TIMINGS, ...timings };
    const P = prefix || store?.prefix || 'stream_bot_';
    const LIVE_T = `\`${P}youtube_live\``;
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[StreamBotYouTube] ${msg}`, meta); } catch { /* ignore */ } };
    const channels = new Map();   // 'profileId:channelId' -> state
    let timer = null;
    let lastReload = 0;
    let ticking = false;
    let liveTable = true;          // false once the table is known to be missing (migration 470 not applied)
    const key = (profileId, channelId) => `${Number(profileId)}:${channelId}`;

    // ── persistence (stream_bot_youtube_live) ──
    async function persist(ch, force = false) {
        if (!liveTable || !db) return;
        if (!force && now() - (ch.persistedAt || 0) < TM.persistMs) return;
        ch.persistedAt = now();
        try {
            await db.query(`INSERT INTO ${LIVE_T} (profile_id, channel_id, broadcast_id, live_chat_id, page_token, title, status, transport, started_at, ended_at, last_check_at, last_message_at, error)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE broadcast_id = VALUES(broadcast_id), live_chat_id = VALUES(live_chat_id), page_token = VALUES(page_token), title = VALUES(title),
                    status = VALUES(status), transport = VALUES(transport), started_at = VALUES(started_at), ended_at = VALUES(ended_at),
                    last_check_at = VALUES(last_check_at), last_message_at = VALUES(last_message_at), error = VALUES(error)`,
            [ch.profileId, ch.channelId, ch.broadcastId, ch.chatId, ch.pageToken, ch.title ? String(ch.title).slice(0, 200) : null, ch.live ? 'live' : (ch.error ? 'error' : 'offline'),
                ch.transport, ch.startedAt ? new Date(ch.startedAt) : null, ch.endedAt ? new Date(ch.endedAt) : null,
                ch.lastCheckAt ? new Date(ch.lastCheckAt) : null, ch.lastMessageAt ? new Date(ch.lastMessageAt) : null, ch.error ? String(ch.error).slice(0, 255) : null]);
        } catch (err) {
            if (err?.code === 'ER_NO_SUCH_TABLE') { liveTable = false; log('warn', 'stream_bot_youtube_live is missing (migration 470); live state is kept in memory only'); }
            else if (err?.code === 'ER_NO_REFERENCED_ROW_2' || err?.code === 'ER_NO_REFERENCED_ROW') { /* profile deleted meanwhile */ }
            else log('warn', 'could not save live state', { error: err?.message });
        }
    }
    async function savedState() {
        if (!liveTable || !db) return new Map();
        try {
            const [rows] = await db.query(`SELECT profile_id, channel_id, broadcast_id, live_chat_id, page_token, title, status, transport, started_at FROM ${LIVE_T}`);
            return new Map(rows.map((r) => [key(r.profile_id, r.channel_id), r]));
        } catch (err) {
            if (err?.code === 'ER_NO_SUCH_TABLE') liveTable = false;
            return new Map();
        }
    }

    // ── the linked channels ──
    async function linkedChannels() {
        const [rows] = await db.query(`SELECT c.profile_id, c.platform_user_id, c.login, c.display_name, p.owner_discord_id
            FROM \`${P}channels\` c JOIN \`${P}profiles\` p ON p.id = c.profile_id WHERE c.platform = 'youtube' AND p.enabled = 1`);
        return rows;
    }
    function fresh(r) {
        return {
            profileId: Number(r.profile_id), ownerId: String(r.owner_discord_id), channelId: String(r.platform_user_id), login: r.login || null, name: r.display_name || r.login || null,
            live: false, broadcastId: null, chatId: null, title: null, startedAt: null, endedAt: null, viewers: null, pageToken: null, transport: 'stream',
            readerStartedAt: null, lastMessageAt: null, lastCheckAt: null, nextCheckAt: now() + Math.floor(Math.random() * 30_000), burstUntil: 0, verifyAt: 0,
            error: null, errorCode: null, first: new Set(), reader: null, abort: null, streamFailures: 0, messages: 0, persistedAt: 0, ended: false,
        };
    }
    async function reload(resume = false) {
        lastReload = now();
        let rows;
        try { rows = await linkedChannels(); } catch (err) { log('warn', 'could not read linked YouTube channels', { error: err?.message }); return; }
        const seen = new Set();
        const saved = resume ? await savedState() : null;
        for (const r of rows) {
            const k = key(r.profile_id, r.platform_user_id);
            seen.add(k);
            if (channels.has(k)) { const ch = channels.get(k); ch.ownerId = String(r.owner_discord_id); ch.login = r.login || ch.login; continue; }
            const ch = fresh(r);
            channels.set(k, ch);
            const s = saved?.get(k);
            if (s && s.status === 'live' && s.live_chat_id && s.broadcast_id) {
                // A restart while live: verify the broadcast, then resume from the saved page token.
                ch.broadcastId = s.broadcast_id; ch.chatId = s.live_chat_id; ch.pageToken = s.page_token || null; ch.title = s.title;
                ch.startedAt = s.started_at ? new Date(s.started_at).getTime() : null; ch.transport = s.transport === 'poll' ? 'poll' : 'stream';
                ch.resumeCheck = true;
                ch.nextCheckAt = now();
            }
        }
        for (const [k, ch] of channels) {
            if (seen.has(k)) continue;
            stopReader(ch);
            channels.delete(k);   // unlinked or profile switched off: no events; the table row goes with the profile or stays harmless
        }
    }

    // ── live detection ──
    function nextCheck(ch) {
        const f = LEVEL_FACTOR[quota.level()] || 1;
        const base = now() < ch.burstUntil ? TM.burstCheckMs : TM.idleCheckMs * f;
        ch.nextCheckAt = now() + base;
    }
    async function tokenFor(ch, opts = {}) {
        try {
            const t = await auth.token({ ownerId: ch.ownerId, channelId: ch.channelId }, opts);
            if (ch.errorCode && ['missing', 'other_channel', 'needs_reconnect', 'scope'].includes(ch.errorCode)) { ch.error = null; ch.errorCode = null; }
            return t;
        } catch (err) {
            ch.error = err.message;
            ch.errorCode = err.code || 'auth';
            return null;
        }
    }
    async function checkLive(ch) {
        ch.lastCheckAt = now();
        if (quota.level() === 'exhausted') { ch.nextCheckAt = now() + 5 * 60_000; return; }
        const tok = await tokenFor(ch);
        if (!tok) { ch.nextCheckAt = now() + (ch.errorCode === 'refresh_failed' ? 2 * 60_000 : 30 * 60_000); return; }
        if (ch.resumeCheck) {
            ch.resumeCheck = false;
            let v = null;
            try {
                v = await api.video(tok.accessToken, ch.broadcastId, ch.profileId);
            } catch (err) {
                // Could not ask (network, quota): try again in a minute rather than calling the broadcast over.
                log('warn', 'resume check failed', { error: err?.reason || err?.message });
                ch.resumeCheck = true;
                ch.nextCheckAt = now() + 60_000;
                return;
            }
            if (v && v.live && v.chatId) {
                ch.live = true; ch.chatId = v.chatId; ch.viewers = v.viewers; ch.title = v.title || ch.title; ch.verifyAt = now() + TM.verifyMs;
                ch.readerStartedAt = now();
                log('info', 'resuming YouTube chat after a restart', { profileId: ch.profileId });
                startReader(ch);
                return;
            }
            // It ended while CertiFried was down.
            ch.live = true;
            await goOffline(ch, v?.endedAt || null);
            return;
        }
        let list;
        try {
            list = await api.activeBroadcasts(tok.accessToken, ch.profileId);
        } catch (err) {
            if (err?.status === 401) { await tokenFor(ch, { force: true }); }
            ch.error = say(err);
            ch.errorCode = err?.reason || 'api';
            nextCheck(ch);
            return;
        }
        if (ch.errorCode && !['missing', 'other_channel', 'needs_reconnect', 'scope'].includes(ch.errorCode)) { ch.error = null; ch.errorCode = null; }
        const b = list.find((x) => x.chatId && (!x.channelId || x.channelId === ch.channelId)) || null;
        nextCheck(ch);
        if (b && !ch.live) await goLive(ch, b);
        else if (!b && ch.live) await goOffline(ch, null);
        else persist(ch).catch(() => {});
    }
    async function goLive(ch, b) {
        const same = ch.broadcastId === b.id;
        ch.live = true; ch.ended = false;
        ch.broadcastId = b.id; ch.chatId = b.chatId; ch.title = b.title || null;
        ch.startedAt = b.startedAt ? new Date(b.startedAt).getTime() : now(); ch.endedAt = null;
        if (!same) { ch.pageToken = null; ch.first = new Set(); ch.messages = 0; }
        ch.readerStartedAt = now(); ch.verifyAt = now() + TM.verifyMs; ch.error = null; ch.errorCode = null; ch.streamFailures = 0;
        await persist(ch, true);
        log('info', 'YouTube broadcast is live', { profileId: ch.profileId });
        await ingest.youtube(broadcastEvent('stream.online', { channelId: ch.channelId, broadcastId: b.id, title: b.title, startedAt: b.startedAt }));
        startReader(ch);
    }
    async function goOffline(ch, endedAt = null) {
        if (!ch.live) return;
        ch.live = false;
        stopReader(ch);
        ch.endedAt = endedAt ? new Date(endedAt).getTime() : now();
        const broadcastId = ch.broadcastId;
        ch.chatId = null; ch.pageToken = null; ch.first = new Set(); ch.viewers = null;
        ch.burstUntil = now() + 5 * 60_000;   // a dropped stream often comes back
        nextCheck(ch);
        await persist(ch, true);
        log('info', 'YouTube broadcast ended', { profileId: ch.profileId });
        await ingest.youtube(broadcastEvent('stream.offline', { channelId: ch.channelId, broadcastId, title: ch.title, endedAt: ch.endedAt }));
    }
    async function verify(ch) {
        ch.verifyAt = now() + TM.verifyMs * (LEVEL_FACTOR[quota.level()] || 1);
        if (quota.level() === 'exhausted') return;
        const tok = await tokenFor(ch);
        if (!tok) return;
        let v;
        try { v = await api.video(tok.accessToken, ch.broadcastId, ch.profileId); } catch (err) { log('debug', 'verify failed', { error: err?.reason }); return; }
        if (!v || !v.live) { await goOffline(ch, v?.endedAt || null); return; }
        ch.viewers = v.viewers; ch.title = v.title || ch.title;
        if (v.chatId && v.chatId !== ch.chatId) { ch.chatId = v.chatId; ch.pageToken = null; }
        if (!ch.reader) startReader(ch);   // a reader that stopped on an error gets another go
    }

    // ── the chat reader ──
    function isFirst(ch) {
        return (userId) => {
            if (ch.first.has(userId)) return false;
            if (ch.first.size >= FIRST_MAX) return false;
            ch.first.add(userId);
            return true;
        };
    }
    async function handleResponse(ch, el, skipBefore) {
        for (const item of el?.items || []) {
            if (isChatEnded(item)) { ch.ended = true; continue; }
            const at = Date.parse(item?.snippet?.publishedAt || '') || now();
            if (skipBefore != null && at < skipBefore) continue;
            if (now() - at > TM.maxAgeMs) continue;
            if (typeof ingest.youtubeRaw === 'function') { try { ingest.youtubeRaw(item, ch.channelId); } catch { /* the chat overlay is best effort */ } }
            const ev = normaliseYouTubeMessage(item, { channelId: ch.channelId, broadcastId: ch.broadcastId, isFirst: isFirst(ch) });
            if (!ev) continue;
            ch.lastMessageAt = now();
            ch.messages++;
            try { await ingest.youtube(ev); } catch (err) { log('warn', 'ingest failed', { error: err?.message }); }
        }
        if (el?.nextPageToken) ch.pageToken = el.nextPageToken;
        persist(ch).catch(() => {});
    }
    function stopReader(ch) {
        try { ch.abort?.abort(); } catch { /* ignore */ }
        ch.abort = null;
    }
    function startReader(ch) {
        if (ch.reader) return;
        const ctrl = new AbortController();
        ch.abort = ctrl;
        ch.reader = readLoop(ch, ctrl.signal)
            .catch((err) => log('warn', 'chat reader stopped', { error: err?.message }))
            .finally(() => { ch.reader = null; if (ch.abort === ctrl) ch.abort = null; });
    }
    async function readLoop(ch, signal) {
        let backoff = 2000;
        let forced = false;
        let skipBefore = ch.pageToken ? null : (ch.readerStartedAt || now()) - TM.backlogSlackMs;
        while (ch.live && !signal.aborted) {
            if (quota.level() === 'exhausted') {
                ch.transportNote = 'paused';
                await sleep(5 * 60_000, signal);
                continue;
            }
            ch.transportNote = null;
            const tok = await tokenFor(ch, forced ? { force: true } : {});
            forced = false;
            if (!tok) {
                if (['missing', 'other_channel', 'needs_reconnect', 'scope'].includes(ch.errorCode)) return;   // verify() retries after a new link
                await sleep(60_000, signal);
                continue;
            }
            try {
                if (ch.transport !== 'poll') {
                    const r = await api.streamChat(tok.accessToken, ch.chatId, ch.pageToken, { profileId: ch.profileId, signal, onResponse: (el) => handleResponse(ch, el, skipBefore) });
                    skipBefore = null;
                    ch.streamFailures = 0;
                    backoff = 2000;
                    if (ch.errorCode && !['missing', 'other_channel', 'needs_reconnect', 'scope'].includes(ch.errorCode)) { ch.error = null; ch.errorCode = null; }
                    if (r.offlineAt || ch.ended) { await goOffline(ch, r.offlineAt || null); return; }
                    await sleep(Math.max(500, quota.gapMs()), signal);
                } else {
                    const data = await api.listChat(tok.accessToken, ch.chatId, ch.pageToken, ch.profileId);
                    await handleResponse(ch, data, skipBefore);
                    skipBefore = null;
                    backoff = 2000;
                    if (data?.offlineAt || ch.ended) { await goOffline(ch, data?.offlineAt || null); return; }
                    await sleep(Math.max(Number(data?.pollingIntervalMillis) || 0, quota.pollFloorMs()), signal);
                }
            } catch (err) {
                if (signal.aborted || err?.reason === 'stopped') return;
                const reason = err?.reason;
                if (reason === 'liveChatEnded' || reason === 'liveChatNotFound') { await goOffline(ch, null); return; }
                ch.error = say(err);
                ch.errorCode = reason || 'api';
                if (reason === 'rateLimitExceeded') { await sleep(5000 + quota.gapMs(), signal); continue; }
                if (reason === 'pageTokenInvalid') { ch.pageToken = null; skipBefore = now() - TM.backlogSlackMs; await sleep(2000, signal); continue; }
                if (err?.status === 401) { forced = true; await sleep(1000, signal); continue; }
                if (reason === 'liveChatDisabled' || reason === 'forbidden' || reason === 'insufficientPermissions') { await sleep(5 * 60_000, signal); continue; }
                if (reason === 'quotaExceeded' || reason === 'quotaGuardExhausted' || reason === 'quotaGuardCritical') { await sleep(5 * 60_000, signal); continue; }
                if (err?.status === 404 && ch.transport !== 'poll') {
                    // The streaming endpoint itself refused as unknown (not a chat error): fall back to polling after twice.
                    ch.streamFailures++;
                    if (ch.streamFailures >= 2) { ch.transport = 'poll'; log('warn', 'streamList unavailable; polling liveChatMessages.list instead', { profileId: ch.profileId }); }
                }
                await sleep(backoff, signal);
                backoff = Math.min(backoff * 2, 60_000);
            }
        }
    }

    // ── scheduler ──
    async function tick() {
        if (ticking) return;
        ticking = true;
        try {
            if (now() - lastReload >= TM.reloadMs || !lastReload) await reload(!lastReload);
            for (const ch of channels.values()) {
                try {
                    if (!ch.live && now() >= ch.nextCheckAt) await checkLive(ch);
                    else if (ch.live && now() >= ch.verifyAt) await verify(ch);
                } catch (err) { log('warn', 'check failed', { profileId: ch.profileId, error: err?.message }); }
            }
        } finally {
            ticking = false;
        }
    }
    function hint(profileId) {
        for (const ch of channels.values()) {
            if (ch.profileId !== Number(profileId) || ch.live) continue;
            ch.burstUntil = now() + TM.burstMs;
            ch.nextCheckAt = Math.min(ch.nextCheckAt, now());
        }
    }

    // ── actions ──
    const liveChannel = (profileId, channelId) => {
        const ch = channels.get(key(profileId, channelId));
        return ch && ch.live && ch.chatId ? ch : null;
    };
    async function sendChat({ profileId, channelId, text }) {
        const ch = liveChannel(profileId, channelId);
        // notLive: "Send to all" treats this as nothing to do rather than a failure (engine.js).
        if (!ch) return { ok: false, notLive: true, error: 'not live on YouTube (a YouTube chat exists only during a live broadcast)' };
        const a = quota.allow('liveChatMessages.insert');
        if (!a.ok) return { ok: false, error: a.reason === 'critical' ? ERRORS.quotaGuardCritical : ERRORS.quotaGuardExhausted };
        const tok = await tokenFor(ch, { write: true });
        if (!tok) return { ok: false, error: ch.error };
        const msg = String(text ?? '').slice(0, CHAT_MAX);
        ingest.noteSent('youtube', ch.channelId, msg);
        try {
            await api.sendMessage(tok.accessToken, ch.chatId, msg, ch.profileId);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: say(err) };
        }
    }
    async function deleteMessage(profileId, ev, { dryRun = false } = {}) {
        const id = ev?.metadata?.messageId;
        if (ev?.platform !== 'youtube' || ev?.type !== 'chat' || !id) return { status: 'skipped', detail: 'no YouTube chat message started this run' };
        const ch = liveChannel(profileId, ev.channelId);
        if (!ch) return { status: 'skipped', detail: 'not live on YouTube' };
        if (dryRun) return { status: 'dry', detail: 'would delete the message on YouTube' };
        const tok = await tokenFor(ch, { write: true });
        if (!tok) return { status: 'failed', detail: ch.error };
        try {
            await api.deleteMessage(tok.accessToken, id, ch.profileId);
            return { status: 'ok', detail: 'message deleted on YouTube' };
        } catch (err) {
            return { status: 'failed', detail: say(err) };
        }
    }
    async function moderate(profileId, ev, { seconds = null, dryRun = false } = {}) {
        const target = ev?.user;
        if (ev?.platform !== 'youtube' || !target?.id) return { status: 'skipped', detail: 'this event has no YouTube viewer' };
        if ((target.roles || []).includes('broadcaster')) return { status: 'skipped', detail: 'the channel owner cannot be timed out or banned' };
        const ch = liveChannel(profileId, ev.channelId);
        if (!ch) return { status: 'skipped', detail: 'not live on YouTube' };
        const what = seconds ? `time out ${target.name || target.id} for ${seconds} s` : `ban ${target.name || target.id}`;
        if (dryRun) return { status: 'dry', detail: `would ${what} on YouTube` };
        const a = quota.allow('liveChatBans.insert');
        if (!a.ok) return { status: 'skipped', detail: a.reason === 'critical' ? 'paused: over 85% of today\'s YouTube allowance is used (a ban costs 200 units)' : ERRORS.quotaGuardExhausted };
        const tok = await tokenFor(ch, { write: true });
        if (!tok) return { status: 'failed', detail: ch.error };
        try {
            await api.ban(tok.accessToken, ch.chatId, target.id, seconds, ch.profileId);
            return { status: 'ok', detail: `${seconds ? 'timed out' : 'banned'} ${target.name || target.id} on YouTube` };
        } catch (err) {
            return { status: 'failed', detail: say(err) };
        }
    }

    function streamInfo({ profileId, channelId }) {
        const ch = channels.get(key(profileId, channelId));
        if (!ch) return null;
        return { live: !!ch.live, title: ch.title || '', category: '', viewers: ch.live ? Number(ch.viewers) || 0 : 0, startedAt: ch.live && ch.startedAt ? new Date(ch.startedAt).toISOString() : null };
    }
    function status(profileId) {
        const list = [...channels.values()].filter((c) => c.profileId === Number(profileId)).map((c) => ({
            channelId: c.channelId, login: c.login, live: !!c.live, title: c.title, transport: c.live ? (c.transportNote === 'paused' ? 'paused' : c.transport) : null,
            startedAt: c.startedAt && c.live ? new Date(c.startedAt).toISOString() : null, lastCheckAt: c.lastCheckAt ? new Date(c.lastCheckAt).toISOString() : null,
            nextCheckAt: !c.live && c.nextCheckAt ? new Date(c.nextCheckAt).toISOString() : null, lastMessageAt: c.lastMessageAt ? new Date(c.lastMessageAt).toISOString() : null,
            messages: c.messages, error: c.error, errorCode: c.errorCode, reading: !!c.reader,
        }));
        return { channels: list, quota: quota.status(profileId) };
    }
    async function checkNow(profileId) {
        if (!lastReload || now() - lastReload > 5000) await reload(!lastReload);
        hint(profileId);
        for (const ch of channels.values()) if (ch.profileId === Number(profileId) && !ch.live) await checkLive(ch);
        return status(profileId);
    }

    return {
        tick, hint, checkNow, sendChat, deleteMessage, moderate, streamInfo, status, reload,
        start() {
            if (timer) return;
            quota.load?.().catch?.(() => {});
            quota.start?.();
            timer = setInterval(() => { tick().catch((err) => log('warn', 'tick failed', { error: err?.message })); }, TM.tickMs);
            timer.unref?.();
            setTimeout(() => { tick().catch(() => {}); }, 20_000).unref?.();
        },
        async stop() {
            if (timer) clearInterval(timer);
            timer = null;
            quota.stop?.();
            for (const ch of channels.values()) { stopReader(ch); await persist(ch, true); }
            await quota.flush?.();
        },
        _channels: channels,
    };
}

export default { createYouTubeService, TIMINGS };
