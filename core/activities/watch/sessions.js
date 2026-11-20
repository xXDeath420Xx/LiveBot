/*
 * Watch Together sessions: one per Discord Activity instance (one voice channel's Activity), shared by everyone in it.
 *
 * The clock: the server keeps { paused, position, at } — the position in seconds at server time `at`. While playing,
 * the position now is position + (now - at) / 1000. Every viewer computes the same target from that and the server
 * time (each answer carries serverNow, so viewers know their clock offset) and corrects their player towards it
 * (frontend/activities/src/watch.js: small drift -> play a little faster or slower, large drift -> jump). So someone who
 * joins half-way starts at the right place, and a pause, a jump or a new title reaches everyone through one event.
 *
 * Who controls: the host (who started it), and the people the router says may (the server's Cinema control role,
 * Manage Server). When the host has been gone hostHandoverSec, the viewer connected longest becomes host.
 * When nobody has been connected for idleEndSec, the session ends and Jellyfin's transcode is stopped.
 * At most cfg.watch.maxSessions sessions play a title at once (the home PC's upload and transcoder).
 *
 * Persistence (optional `store`): sessions are saved (debounced) so a dashboard restart does not end them; viewers
 * reconnect and carry on from where the clock says.
 */
import crypto from 'node:crypto';

export class WatchError extends Error {
    constructor(code, status, message) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

const newId = () => crypto.randomBytes(18).toString('base64url'); // 24 characters, unguessable: also the media folder name

export function createWatchSessions({ cfg, media, cache = null, store = null, logger = null, now = () => Date.now(), onAdvance = null }) {
    const byInstance = new Map();
    const byId = new Map();
    const saveTimers = new Map();

    const effective = (s, t = now()) => {
        const p = s.playback;
        const pos = p.paused ? p.position : p.position + (t - p.at) / 1000;
        const max = s.media?.runtimeSec || Infinity;
        return Math.max(0, Math.min(max, pos));
    };

    function connected(s) {
        return [...s.viewers.values()].filter((v) => v.conns.size > 0);
    }

    function activeCount(except = null) {
        let n = 0;
        for (const s of byId.values()) if (s !== except && s.media && !s.ended) n++;
        return n;
    }

    /** The state everyone in the session sees (no secrets: the media folder is a capability for this session only). */
    function view(s) {
        const m = s.media;
        return {
            id: s.id,
            rev: s.rev,
            serverNow: now(),
            ended: s.ended,
            host: { id: s.hostId, name: s.viewers.get(s.hostId)?.name || null },
            viewers: connected(s).sort((a, b) => a.joinedAt - b.joinedAt)
                .map((v) => ({ id: v.id, name: v.name, avatar: v.avatar, buffering: !!v.buffering, controller: v.id === s.hostId || !!v.controller })),
            media: m ? {
                gen: m.gen, itemId: m.itemId, name: m.name, label: m.label, type: m.type, runtimeSec: m.runtimeSec, remux: m.remux,
                src: `media/${s.id}/${m.gen}/index.m3u8`,
                subtitles: m.subtitles.map((t) => ({ index: t.index, label: t.label, language: t.language, src: `media/${s.id}/${m.gen}/sub-${t.index}.vtt` })),
                burnedSubtitle: Number.isInteger(m.burnSubtitleIndex) ? m.burnSubtitleIndex : null,
            } : null,
            playback: { paused: s.playback.paused, position: s.playback.position, at: s.playback.at },
            queue: s.queue.map((q, i) => ({ label: q.label, current: i === s.queueIndex })),
            queueIndex: s.queueIndex,
            limits: { maxViewers: cfg.watch.maxViewers },
        };
    }

    function broadcast(s, type = 'state') {
        s.rev++;
        s.updatedAt = now();
        const data = view(s);
        for (const v of s.viewers.values()) for (const send of v.conns) {
            try { send(type, data); } catch { /* a dead connection is cleaned up by its close handler */ }
        }
        scheduleSave(s);
    }

    function scheduleSave(s) {
        if (!store || saveTimers.has(s.id)) return;
        const timer = setTimeout(() => {
            saveTimers.delete(s.id);
            store.save(snapshot(s)).catch((e) => logger?.warn?.(`[watch] could not save session: ${e.message}`));
        }, 1000);
        timer.unref?.();
        saveTimers.set(s.id, timer);
    }

    function snapshot(s) {
        return {
            id: s.id, instanceId: s.instanceId, guildId: s.guildId, channelId: s.channelId, hostId: s.hostId,
            itemId: s.media?.itemId || null, itemName: s.media?.label || null,
            state: { media: s.media, queue: s.queue, queueIndex: s.queueIndex, playback: s.playback, createdAt: s.createdAt },
            ended: s.ended, endReason: s.endReason || null,
        };
    }

    /** The session of an Activity instance, created (with this person as host) when there is none. */
    function open({ instanceId, guildId, channelId, user }) {
        let s = byInstance.get(instanceId);
        if (s && !s.ended) return s;
        s = {
            id: newId(), instanceId, guildId, channelId, hostId: user.id, createdAt: now(), updatedAt: now(), rev: 0,
            media: null, queue: [], queueIndex: -1, playback: { paused: true, position: 0, at: now() },
            viewers: new Map(), emptySince: now(), hostGoneSince: null, ended: false, busy: false,
        };
        byInstance.set(instanceId, s);
        byId.set(s.id, s);
        scheduleSave(s);
        return s;
    }

    const get = (instanceId) => {
        const s = byInstance.get(instanceId);
        return s && !s.ended ? s : null;
    };
    const getById = (id) => {
        const s = byId.get(id);
        return s && !s.ended ? s : null;
    };

    /** A live connection (the event stream). Returns a function that closes it. */
    function join(s, user, send, { controller = false } = {}) {
        let v = s.viewers.get(user.id);
        if (!v) {
            if (connected(s).length >= cfg.watch.maxViewers) throw new WatchError('FULL', 429, `This Watch Together is full (${cfg.watch.maxViewers} people).`);
            v = { id: user.id, name: user.name, avatar: user.avatar || null, conns: new Set(), joinedAt: now(), buffering: false, controller };
            s.viewers.set(user.id, v);
        }
        v.name = user.name;
        v.avatar = user.avatar || null;
        v.controller = controller;
        if (!v.conns.size) v.joinedAt = now();
        v.conns.add(send);
        s.emptySince = null;
        if (user.id === s.hostId) s.hostGoneSince = null;
        broadcast(s, 'state');
        return () => {
            v.conns.delete(send);
            if (!v.conns.size) {
                v.buffering = false;
                if (!connected(s).length) s.emptySince = now();
                if (user.id === s.hostId) s.hostGoneSince = now();
                if (!s.ended) broadcast(s, 'state');
            }
        };
    }

    function report(s, userId, { buffering }) {
        const v = s.viewers.get(userId);
        if (!v) return;
        const b = !!buffering;
        if (v.buffering !== b) {
            v.buffering = b;
            broadcast(s, 'state');
        }
    }

    async function stopMedia(s) {
        const m = s.media;
        if (!m) return;
        cache?.dropPrefix(`${s.id}:`);
        await media.stopPlayback({ deviceId: m.deviceId, playSessionId: m.playSessionId });
    }

    /**
     * Play a title now. item: from jellyfin-media getItem(). queue: [{ itemId, label }] the title is the first of (or
     * keepQueue to move along the current queue).
     */
    async function play(s, { item, audioIndex = null, burnSubtitleIndex = null, queue = null, queueIndex = 0, keepQueue = false, position = 0 }) {
        if (s.ended) throw new WatchError('ENDED', 410, 'This Watch Together has ended.');
        if (s.busy) throw new WatchError('BUSY', 409, 'Already starting a title. One moment.');
        if (!s.media && activeCount(s) >= cfg.watch.maxSessions) {
            throw new WatchError('ALL_SCREENS_BUSY', 429, `All ${cfg.watch.maxSessions} screens are in use on CertiFried right now. Try again when one finishes.`);
        }
        s.busy = true;
        try {
            const gen = (s.media?.gen || 0) + 1;
            const deviceId = `cf-watch-${s.id.slice(0, 12)}`;
            const audio = Number.isInteger(audioIndex) && item.audio.some((a) => a.index === audioIndex) ? audioIndex : null;
            const burn = Number.isInteger(burnSubtitleIndex) && item.subtitles.some((t) => t.index === burnSubtitleIndex && !t.text) ? burnSubtitleIndex : null;
            const stream = await media.startPlayback({ item, deviceId, audioIndex: audio, burnSubtitleIndex: burn, maxBitrateKbps: cfg.watch.maxBitrateKbps });
            await stopMedia(s);
            const label = item.type === 'Episode' && item.seriesName
                ? `${item.seriesName} · S${String(item.season ?? 0).padStart(2, '0')}E${String(item.episode ?? 0).padStart(2, '0')} · ${item.name}`
                : (item.year ? `${item.name} (${item.year})` : item.name);
            s.media = {
                gen, itemId: item.id, name: item.name, label, type: item.type, runtimeSec: stream.runtimeSec || item.runtimeSec || 0,
                mediaSourceId: item.mediaSourceId, audioIndex: audio, burnSubtitleIndex: burn,
                subtitles: item.subtitles.filter((t) => t.text).slice(0, 40).map((t) => ({ index: t.index, label: t.label, language: t.language })),
                playSessionId: stream.playSessionId, deviceId, path: stream.path, remux: stream.remux, startedAt: now(),
            };
            if (!keepQueue) {
                s.queue = Array.isArray(queue) && queue.length ? queue.slice(0, 200) : [{ itemId: item.id, label }];
                s.queueIndex = Math.max(0, Math.min(s.queue.length - 1, queueIndex));
            } else {
                s.queueIndex = Math.max(0, Math.min(s.queue.length - 1, queueIndex));
            }
            s.playback = { paused: false, position: Math.max(0, Number(position) || 0), at: now() };
            broadcast(s, 'state');
            logger?.info?.(`[watch] session ${s.id.slice(0, 6)} in ${s.guildId}: playing an item (${stream.remux ? 'remux' : 'transcode'}), ${activeCount()} of ${cfg.watch.maxSessions} screens in use`);
            return view(s);
        } finally {
            s.busy = false;
        }
    }

    /** Start Jellyfin's stream again for the same title and generation (Jellyfin dropped it, or after a restart). */
    async function restartStream(s) {
        const m = s.media;
        if (!m || s.busy) return false;
        s.busy = true;
        try {
            const stream = await media.startPlayback({
                item: { id: m.itemId, mediaSourceId: m.mediaSourceId, runtimeSec: m.runtimeSec, audio: [], subtitles: [], videoCodec: m.remux ? 'h264' : null },
                deviceId: m.deviceId, audioIndex: m.audioIndex, burnSubtitleIndex: m.burnSubtitleIndex, maxBitrateKbps: cfg.watch.maxBitrateKbps,
            });
            cache?.dropPrefix(`${s.id}:`);
            m.playSessionId = stream.playSessionId;
            m.path = stream.path;
            m.startedAt = now();
            return true;
        } catch (e) {
            logger?.warn?.(`[watch] could not restart a stream: ${e.code || e.message}`);
            return false;
        } finally {
            s.busy = false;
        }
    }

    /** play | pause | seek | stop. Permission is checked by the caller. */
    async function control(s, { action, position }) {
        if (s.ended) throw new WatchError('ENDED', 410, 'This Watch Together has ended.');
        const t = now();
        if (action === 'stop') {
            await stopMedia(s);
            s.media = null;
            s.queue = [];
            s.queueIndex = -1;
            s.playback = { paused: true, position: 0, at: t };
            broadcast(s, 'state');
            return view(s);
        }
        if (!s.media) throw new WatchError('NOTHING_PLAYING', 409, 'Nothing is playing.');
        if (action === 'pause') s.playback = { paused: true, position: effective(s, t), at: t };
        else if (action === 'play') s.playback = { paused: false, position: effective(s, t) >= s.media.runtimeSec - 0.5 ? 0 : effective(s, t), at: t };
        else if (action === 'seek') {
            const pos = Number(position);
            if (!Number.isFinite(pos)) throw new WatchError('BAD_POSITION', 400, 'That is not a time in the film.');
            s.playback = { paused: s.playback.paused, position: Math.max(0, Math.min(s.media.runtimeSec || pos, pos)), at: t };
        } else throw new WatchError('BAD_ACTION', 400, 'Unknown control.');
        broadcast(s, 'state');
        return view(s);
    }

    async function end(s, reason = 'ended') {
        if (s.ended) return;
        s.ended = true;
        s.endReason = reason;
        await stopMedia(s).catch(() => {});
        for (const v of s.viewers.values()) for (const send of v.conns) { try { send('ended', { reason }); } catch { /* gone */ } }
        byInstance.delete(s.instanceId);
        byId.delete(s.id);
        clearTimeout(saveTimers.get(s.id));
        saveTimers.delete(s.id);
        if (store) await store.save(snapshot(s)).catch(() => {});
        logger?.info?.(`[watch] session ${s.id.slice(0, 6)} in ${s.guildId} ended (${reason})`);
    }

    /** Every 2 seconds: idle end, host handover, the end of a title (next in the queue, or stop at the end). */
    async function tick() {
        const t = now();
        for (const s of [...byId.values()]) {
            if (s.ended) continue;
            const live = connected(s);
            if (!live.length) {
                s.emptySince ??= t;
                if (t - s.emptySince > cfg.watch.idleEndSec * 1000) { await end(s, 'empty'); continue; }
            }
            if (live.length && !live.some((v) => v.id === s.hostId)) {
                s.hostGoneSince ??= t;
                if (t - s.hostGoneSince > cfg.watch.hostHandoverSec * 1000) {
                    s.hostId = live.sort((a, b) => a.joinedAt - b.joinedAt)[0].id;
                    s.hostGoneSince = null;
                    broadcast(s, 'state');
                }
            }
            if (s.media && !s.playback.paused && !s.busy && !s.advancing && s.media.runtimeSec && effective(s, t) >= s.media.runtimeSec - 0.5) {
                if (s.queueIndex + 1 < s.queue.length && onAdvance) {
                    s.advancing = true;
                    Promise.resolve().then(() => onAdvance(s, s.queueIndex + 1))
                        .catch((e) => {
                            logger?.warn?.(`[watch] could not start the next title: ${e.code || e.message}`);
                            s.playback = { paused: true, position: s.media?.runtimeSec || 0, at: now() };
                            if (!s.ended) broadcast(s, 'state');
                        })
                        .finally(() => { s.advancing = false; });
                } else {
                    s.playback = { paused: true, position: s.media.runtimeSec, at: t };
                    broadcast(s, 'state');
                }
            }
        }
    }

    /** Sessions saved before a restart (not ended, changed in the last 6 hours). */
    async function restore() {
        if (!store) return 0;
        const rows = await store.loadActive();
        let n = 0;
        for (const r of rows) {
            if (byInstance.has(r.instanceId)) continue;
            const st = r.state || {};
            const s = {
                id: r.id, instanceId: r.instanceId, guildId: r.guildId, channelId: r.channelId, hostId: r.hostId,
                createdAt: st.createdAt || now(), updatedAt: now(), rev: 0,
                media: st.media || null, queue: Array.isArray(st.queue) ? st.queue : [], queueIndex: Number.isInteger(st.queueIndex) ? st.queueIndex : -1,
                playback: st.playback || { paused: true, position: 0, at: now() },
                viewers: new Map(), emptySince: now(), hostGoneSince: null, ended: false, busy: false,
            };
            byInstance.set(s.instanceId, s);
            byId.set(s.id, s);
            n++;
        }
        return n;
    }

    function inGuild(guildId) {
        return [...byId.values()].filter((s) => !s.ended && s.guildId === guildId);
    }

    return {
        open, get, getById, join, report, play, control, end, tick, restore, view, effective, restartStream, inGuild,
        activeCount: () => activeCount(), all: () => [...byId.values()],
    };
}
