/*
 * Stream bot music: the player. The engine owns the queue and decides what plays; the OBS browser source
 * (/stream/bot/overlay/music/<key>) only plays what it is told and reports back.
 *
 * VOD rule (owner, not optional): music must never reach the Twitch VOD. A song starts only when
 *   1. a music overlay is connected (the "CertiFried Music" browser source, audio controlled by OBS), and
 *   2. the profile's CertiFried Studio reports VOD protection on in its state (`music.vodSafe`, read with
 *      studioMusicStatus() from core/stream-bot/studio.js: the source is on every audio track except the Twitch VOD
 *      track), and
 *   3. right before each song, Studio answers the `music.prepare` action with { vodSafe: true } (it checks OBS again).
 * Otherwise nothing starts and the queue is held with the reason; losing 1 or 2 while a song plays pauses it at once.
 * There is no other output: the music is never played on the streamer's speakers or Desktop Audio by CertiFried.
 *
 *   createPlayer({ mstore, resolver, signer, emit, now, logger, settingsOf, profileOf, gateOf, prepare, limits })
 *     prepare(profileId) -> { ok, vodTrack?, reason? }   the music.prepare round trip to Studio
 *     direct, directFor(profileId) -> { discordUserId } | null   Spotify-direct (spotify-direct.js): a Spotify song plays
 *                                  from the streamer's own go-librespot session when they turned it on; otherwise, or when
 *                                  the session is busy, from the YouTube Music match. A live song's pause, resume and seek
 *                                  go to go-librespot too.
 *     .attachOverlay(profileId, keyHash, client)   client = { send(event, data), close() } (an SSE response); → detach()
 *     .report(profileId, report)                   from the overlay: { playId, event: ready|started|progress|paused|ended|error, positionMs, durationMs, error }
 *     .gateChanged(profileId)                      Studio's status or an overlay changed: start, hold or pause
 *     .start(profileId) / .stop(profileId)         the dashboard's Play and Stop; a queued request starts it too
 *     .skip(profileId, reason) / .back / .pause / .resume / .restart / .setVolume(profileId, v) / .playPlaylist(profileId, id)
 *     .nowPlaying(profileId)  → { item, requestId, requester, startedAt, positionMs, paused, playlist } | null
 *     .history(profileId)     → items that played, newest first
 *     .status(profileId)      → { running, overlays, gate, current, held }
 *     .upstreamFor(profileId, playId) → the audio address behind a signed link (current or just-finished play only)
 *     .votes(profileId)       → the vote-skip set for the current play
 *
 * `emit(profileId, item, meta)` is the "song changed" hook (event log + automations + template variables).
 * Tested in tests/stream-bot-music.test.js (fake resolver and overlay client).
 */
export const PLAYER_LIMITS = Object.freeze({ attempts: 3, history: 25, linkTtlMs: 3 * 60 * 60 * 1000, retryOnError: 1, reportsPer10s: 40 });

export function createPlayer({
    mstore, resolver, signer, emit = () => {}, now = () => Date.now(), logger = null,
    settingsOf, profileOf, gateOf, prepare = async () => ({ ok: true }), direct = null, directFor = async () => null, limits = {},
} = {}) {
    const L = { ...PLAYER_LIMITS, ...limits };
    const states = new Map();
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[StreamMusic] ${msg}`, meta); } catch { /* ignore */ } };
    const st = (profileId) => {
        let s = states.get(profileId);
        if (!s) {
            s = { overlays: new Map(), running: false, current: null, previousPlay: null, history: [], votes: new Set(), activePlaylistId: null, chain: Promise.resolve(), held: null, seq: 0, directNote: null };
            states.set(profileId, s);
        }
        return s;
    };
    /** One change at a time per profile (skips, reports and gate changes can arrive together). */
    const serial = (profileId, fn) => {
        const s = st(profileId);
        const run = s.chain.then(fn, fn);
        s.chain = run.catch((err) => log('warn', 'player step failed', { profileId, error: err?.message }));
        return run;
    };
    const broadcast = (s, event, data) => { for (const c of s.overlays.values()) { try { c.send(event, data); } catch { /* the close handler removes it */ } } };
    const position = (cur) => {
        if (!cur) return 0;
        const base = cur.positionMs || 0;
        if (cur.paused || !cur.reportedAt) return base;
        return Math.max(0, base + (now() - cur.reportedAt));
    };
    const listened = (cur) => Math.round(position(cur) / 1000);

    async function gate(profileId) {
        const s = st(profileId);
        const g = await Promise.resolve(gateOf(profileId)).catch(() => ({ vodSafe: false, reason: 'studio_unknown' }));
        const overlay = s.overlays.size > 0;
        const ok = overlay && g?.vodSafe === true;
        return { ok, overlay, vodSafe: g?.vodSafe === true, vodTrack: g?.vodTrack ?? null, reason: ok ? null : (!overlay ? 'no_overlay' : (g?.reason || 'vod_off')) };
    }

    function linkFor(profileId, keyHash, key, playId) {
        const { exp, sig } = signer.sign({ profileId, keyHash, playId, ttlMs: L.linkTtlMs });
        return { exp, sig };
    }

    /** What the overlay needs to play the current song (one link per overlay key). */
    function playFrame(profileId, s, cur, startMs, overlayKeyHash) {
        const settings = cur.settings || {};
        const sig = linkFor(profileId, overlayKeyHash, null, cur.playId);
        return {
            playId: cur.playId, exp: sig.exp, sig: sig.sig, startMs: Math.max(0, Math.round(startMs || 0)),
            volume: settings.volume ?? 70, card: settings.card !== false,
            title: cur.item.title, artist: cur.item.artist || '', thumbnail: cur.item.thumbnail || null, durationMs: cur.item.durationMs || null,
            requester: cur.requester || null, live: !!cur.live,
        };
    }
    /** go-librespot follows the player: pause, resume and seek a live Spotify song there too. */
    const liveDo = (cur, what, arg) => { if (cur?.live && !cur.live.ended) cur.live[what](arg); };
    const sendPlay = (profileId, s, cur, startMs) => {
        for (const [kh, c] of s.overlays) { try { c.send('play', playFrame(profileId, s, cur, startMs, kh)); } catch { /* removed on close */ } }
    };

    async function finishCurrent(profileId, s, outcome, { skipReason = null, error = null, requestStatus = null } = {}) {
        const cur = s.current;
        if (!cur) return;
        s.current = null;
        s.votes = new Set();
        s.previousPlay = { playId: cur.playId, upstream: cur.upstream, until: now() + 60_000 };
        if (cur.live) cur.live.close(outcome === 'ended' ? 'finished' : outcome);
        const secs = listened(cur);
        const final = outcome === 'ended' ? (cur.item.durationMs && secs < (cur.item.durationMs / 1000) * 0.9 && (cur.item.durationMs / 1000) - secs > 20 ? 'stopped' : 'completed') : outcome;
        await mstore.finishPlay(cur.logId, { outcome: final, listenedSec: secs, skipReason, error });
        if (cur.requestId) {
            await mstore.setRequestStatus(profileId, cur.requestId, requestStatus || (final === 'skipped' ? 'skipped' : final === 'failed' ? 'failed' : 'played'),
                { finished: true, ...(skipReason ? { reason: skipReason } : {}), ...(error ? { reason: String(error).slice(0, 160) } : {}) });
        }
        s.history.unshift({ ...cur.item, requester: cur.requester, requestId: cur.requestId, playlist: cur.playlist || null, at: now() });
        s.history = s.history.slice(0, L.history);
    }

    /** The next thing to play: the oldest queued request, else a song from the active or fallback playlist. */
    async function pickNext(profileId, s, settings, skipKeys) {
        const req = await mstore.nextQueued(profileId);
        if (req) return { request: req, item: { source: req.source, title: req.title, artist: req.artist, url: req.url, trackKey: req.trackKey, durationMs: req.durationMs, explicit: req.explicit, thumbnail: req.thumbnail }, requester: req.viewerName || null };
        const listId = s.activePlaylistId || settings.fallbackPlaylistId;
        if (!listId) return null;
        const list = await mstore.getPlaylist(profileId, listId);
        if (!list) { if (s.activePlaylistId === listId) s.activePlaylistId = null; return null; }
        const recent = s.history.slice(0, 15).map((h) => h.trackKey).concat(skipKeys);
        const it = await mstore.randomItem(profileId, listId, recent);
        if (!it) return null;
        return { request: null, item: { source: it.source, title: it.title, artist: it.artist, url: it.url, trackKey: it.trackKey, durationMs: it.durationMs, explicit: it.explicit, thumbnail: it.thumbnail }, requester: null, playlist: list.name };
    }
    /** Spotify-direct for a Spotify song when the streamer turned it on; null to use the music pipeline. */
    async function directAudio(profileId, s, item) {
        if (!direct || !String(item.trackKey || '').startsWith('sp:')) return null;
        const who = await Promise.resolve(directFor(profileId)).catch(() => null);
        if (!who?.discordUserId) return null;
        const r = await direct.open({ profileId, discordUserId: who.discordUserId, item }).catch(() => ({ ok: false, reason: 'error' }));
        if (r.ok) { s.directNote = null; return { live: r.live, url: null, playback: 'spotify', account: r.live.account, matchedVia: null, matchedTitle: null }; }
        if (r.reason !== 'not_spotify') s.directNote = { reason: r.reason, title: item.title, at: now(), why: r.reason === 'suspended' ? direct.suspension(profileId)?.why || null : null };
        return null;
    }

    async function playItem(profileId, s, choice, settings, { startMs = 0 } = {}) {
        const audio = (await directAudio(profileId, s, choice.item)) || await resolver.audioFor(choice.item);
        const profile = await profileOf(profileId);
        const logId = await mstore.insertPlay({
            context: 'stream', stream_profile_id: profileId, stream_request_id: choice.request?.id ?? null,
            guild_id: `sb:${profileId}`.slice(0, 20), guild_name: `Stream: ${profile?.displayName || profileId}`.slice(0, 100),
            requester_id: null, requester_name: null, added_by: choice.request ? 'user' : 'autoplay',
            request_source: choice.request ? (['spotify', 'youtube', 'soundcloud', 'search'].includes(choice.item.source) ? choice.item.source : 'other') : (choice.item.trackKey?.startsWith('sp:') ? 'spotify' : choice.item.source === 'youtube' ? 'youtube' : choice.item.source === 'soundcloud' ? 'soundcloud' : 'other'),
            playlist: choice.playlist ? String(choice.playlist).slice(0, 255) : null,
            title: String(choice.item.title || 'Unknown').slice(0, 500), author: choice.item.artist ? String(choice.item.artist).slice(0, 255) : null,
            url: choice.item.url ? String(choice.item.url).slice(0, 1000) : null,
            duration_sec: choice.item.durationMs ? Math.round(choice.item.durationMs / 1000) : null,
            explicit: choice.item.explicit == null ? null : (choice.item.explicit ? 1 : 0),
            playback: audio.playback ? String(audio.playback).slice(0, 48) : null, prefetched: 0, spotify_account: audio.account || null,
            matched_via: audio.matchedVia ? String(audio.matchedVia).slice(0, 16) : null, matched_title: audio.matchedTitle ? String(audio.matchedTitle).slice(0, 500) : null,
            requested_at: choice.request?.createdAt ? new Date(choice.request.createdAt) : null, started_at: new Date(now()), outcome: 'playing',
        });
        s.seq++;
        const playId = logId ? String(logId) : `t${now().toString(36)}${s.seq}`;
        s.current = { playId, logId, requestId: choice.request?.id ?? null, item: choice.item, requester: choice.requester, playlist: choice.playlist || null,
            upstream: audio.url, live: audio.live || null, settings, positionMs: startMs, reportedAt: null, paused: false, startedAt: now(), errors: 0 };
        if (choice.request) await mstore.setRequestStatus(profileId, choice.request.id, 'playing', { started: true, playLogId: logId });
        sendPlay(profileId, s, s.current, startMs);
        try { emit(profileId, s.current.item, { requester: s.current.requester, requestId: s.current.requestId, playlist: s.current.playlist }); } catch { /* hooks never stop the music */ }
        prefetchNext(profileId, s).catch(() => {});
    }

    async function prefetchNext(profileId) {
        const next = await mstore.nextQueued(profileId);
        if (!next) return;
        resolver.prefetch({ source: next.source, title: next.title, artist: next.artist, url: next.url, trackKey: next.trackKey, durationMs: next.durationMs, explicit: next.explicit });
    }

    /** Start the next song if the gate is open and something is waiting; otherwise hold or go idle. */
    async function advance(profileId) {
        const s = st(profileId);
        if (s.current) return 'playing';
        if (!s.running) return 'stopped';
        const g = await gate(profileId);
        if (!g.ok) { s.held = g.reason; broadcast(s, 'idle', { reason: g.reason }); return 'held'; }
        s.held = null;
        const settings = await settingsOf(profileId);
        if (!(await mstore.nextQueued(profileId)) && !(s.activePlaylistId || settings.fallbackPlaylistId)) { broadcast(s, 'idle', { reason: 'empty' }); return 'idle'; }
        const prep = await Promise.resolve(prepare(profileId)).catch((e) => ({ ok: false, reason: e?.message || 'Studio did not answer' }));
        if (!prep?.ok) { s.held = prep?.reason || 'vod_unsafe'; broadcast(s, 'idle', { reason: 'vod' }); return 'held'; }
        const failedKeys = [];
        for (let i = 0; i < L.attempts; i++) {
            const choice = await pickNext(profileId, s, settings, failedKeys);
            if (!choice) { broadcast(s, 'idle', { reason: 'empty' }); return 'idle'; }
            try {
                await playItem(profileId, s, choice, settings);
                return 'started';
            } catch (err) {
                log('warn', 'song could not be played', { profileId, title: choice.item.title, error: err?.message });
                failedKeys.push(choice.item.trackKey);
                await mstore.insertPlay({ context: 'stream', stream_profile_id: profileId, stream_request_id: choice.request?.id ?? null, guild_id: `sb:${profileId}`.slice(0, 20),
                    added_by: choice.request ? 'user' : 'autoplay', request_source: 'other', title: String(choice.item.title || 'Unknown').slice(0, 500),
                    author: choice.item.artist || null, url: choice.item.url || null, outcome: 'failed', ended_at: new Date(now()), error: String(err?.message || 'no audio').slice(0, 500) });
                if (choice.request) await mstore.setRequestStatus(profileId, choice.request.id, 'failed', { finished: true, reason: String(err?.message || 'no playable audio').slice(0, 160) });
            }
        }
        broadcast(s, 'idle', { reason: 'failed' });
        return 'failed';
    }

    const api = {
        attachOverlay(profileId, keyHash, client) {
            const s = st(profileId);
            const old = s.overlays.get(keyHash);
            if (old && old !== client) { try { old.close(); } catch { /* gone */ } }
            s.overlays.set(keyHash, client);
            serial(profileId, async () => {
                const settings = await settingsOf(profileId);
                client.send('hello', { card: settings.card !== false, volume: settings.volume });
                const g = await gate(profileId);
                if (s.current && g.ok) { s.current.paused = false; s.current.reportedAt = now(); sendPlay(profileId, s, s.current, position(s.current)); liveDo(s.current, 'resume'); }
                else if (!s.current) await advance(profileId);
                else client.send('idle', { reason: g.reason });
            });
            return () => {
                if (s.overlays.get(keyHash) !== client) return;
                s.overlays.delete(keyHash);
                if (!s.overlays.size && s.current) serial(profileId, async () => { if (s.current && !s.overlays.size) { s.current.positionMs = position(s.current); s.current.paused = true; s.current.reportedAt = now(); liveDo(s.current, 'pause'); } });
            };
        },

        report(profileId, r = {}) {
            const s = st(profileId);
            return serial(profileId, async () => {
                const cur = s.current;
                const pos = Number.isFinite(Number(r.positionMs)) ? Math.max(0, Number(r.positionMs)) : null;
                if (r.event === 'ready') {
                    if (cur && (await gate(profileId)).ok) sendPlay(profileId, s, cur, position(cur));
                    else if (!cur) await advance(profileId);
                    return 'ok';
                }
                if (!cur || String(r.playId) !== cur.playId) return 'stale';
                switch (r.event) {
                    case 'started': case 'progress': case 'resumed':
                        if (pos != null) cur.positionMs = pos;
                        cur.reportedAt = now();
                        cur.paused = false;
                        if (Number(r.durationMs) > 0 && !cur.item.durationMs) cur.item.durationMs = Math.round(Number(r.durationMs));
                        return 'ok';
                    case 'paused':
                        if (pos != null) cur.positionMs = pos;
                        cur.reportedAt = now();
                        cur.paused = true;
                        return 'ok';
                    case 'ended':
                        if (pos != null) cur.positionMs = pos;
                        cur.reportedAt = now();
                        await finishCurrent(profileId, s, 'ended');
                        await advance(profileId);
                        return 'ok';
                    case 'error': {
                        if (pos != null) cur.positionMs = pos;
                        if (cur.errors < L.retryOnError) {
                            // The relay link may have gone stale (a resolver restarted): resolve the same song again, carry on where it was.
                            cur.errors++;
                            try {
                                // A live Spotify song the player could not take: close it (go-librespot paused first) and carry on
                                // from the same place with the YouTube Music match.
                                if (cur.live) {
                                    await cur.live.close('player_error');
                                    cur.live = null;
                                    s.directNote = { reason: 'player_error', title: cur.item.title, at: now(), why: null };
                                }
                                const audio = await resolver.audioFor(cur.item);
                                cur.upstream = audio.url;
                                sendPlay(profileId, s, cur, cur.positionMs || 0);
                                return 'retried';
                            } catch { /* give up below */ }
                        }
                        await finishCurrent(profileId, s, 'failed', { error: String(r.error || 'the player could not play it').slice(0, 200) });
                        await advance(profileId);
                        return 'failed';
                    }
                    default: return 'ignored';
                }
            });
        },

        gateChanged(profileId) {
            const s = st(profileId);
            return serial(profileId, async () => {
                const g = await gate(profileId);
                if (s.current && !g.ok && !s.current.paused) {
                    s.current.positionMs = position(s.current);
                    s.current.paused = true;
                    s.current.reportedAt = now();
                    s.held = g.reason;
                    broadcast(s, 'pause', { reason: g.reason });
                    liveDo(s.current, 'pause');
                    return 'paused';
                }
                if (s.current && g.ok && s.current.paused && s.held) {
                    s.held = null; s.current.paused = false; s.current.reportedAt = now();
                    sendPlay(profileId, s, s.current, position(s.current));
                    liveDo(s.current, 'resume');
                    return 'resumed';
                }
                if (!s.current) return advance(profileId);
                return 'unchanged';
            });
        },

        start(profileId) { const s = st(profileId); s.running = true; return serial(profileId, () => advance(profileId)); },
        stop(profileId) {
            const s = st(profileId);
            return serial(profileId, async () => {
                s.running = false;
                if (s.current) await finishCurrent(profileId, s, 'stopped');
                broadcast(s, 'stop', {});
                return 'stopped';
            });
        },
        /** A request went into the queue: start the music if it is not running. */
        nudge(profileId) { const s = st(profileId); s.running = true; return serial(profileId, () => (s.current ? 'playing' : advance(profileId))); },

        skip(profileId, reason = 'command') {
            const s = st(profileId);
            return serial(profileId, async () => {
                if (!s.current) return null;
                const was = { ...s.current.item, requester: s.current.requester };
                await finishCurrent(profileId, s, 'skipped', { skipReason: reason });
                s.running = true;
                await advance(profileId);
                return was;
            });
        },
        back(profileId) {
            const s = st(profileId);
            return serial(profileId, async () => {
                const prev = s.history.find((h) => !s.current || h.trackKey !== s.current.item.trackKey);
                if (!prev) return null;
                const g = await gate(profileId);
                if (!g.ok) return { held: g.reason };
                const prep = await Promise.resolve(prepare(profileId)).catch((e) => ({ ok: false, reason: e?.message }));
                if (!prep?.ok) return { held: prep?.reason || 'vod_unsafe' };
                const settings = await settingsOf(profileId);
                if (s.current) {
                    // The song that was playing goes back to the front of the queue (a request) or is simply left.
                    const cur = s.current;
                    s.current = null;
                    await mstore.finishPlay(cur.logId, { outcome: 'stopped', listenedSec: listened(cur), skipReason: 'back' });
                    if (cur.requestId) await mstore.setRequestStatus(profileId, cur.requestId, 'queued', { reason: null });
                }
                s.running = true;
                await playItem(profileId, s, { request: null, item: { ...prev, requester: undefined }, requester: prev.requester || null, playlist: prev.playlist }, settings);
                return prev;
            });
        },
        pause(profileId) {
            const s = st(profileId);
            return serial(profileId, async () => {
                if (!s.current || s.current.paused) return s.current ? 'already' : null;
                s.current.positionMs = position(s.current);
                s.current.paused = true;
                s.current.reportedAt = now();
                broadcast(s, 'pause', {});
                liveDo(s.current, 'pause');
                return 'paused';
            });
        },
        resume(profileId) {
            const s = st(profileId);
            return serial(profileId, async () => {
                s.running = true;
                if (!s.current) return advance(profileId);
                const g = await gate(profileId);
                if (!g.ok) return 'held';
                s.current.paused = false;
                s.current.reportedAt = now();
                broadcast(s, 'resume', { positionMs: s.current.positionMs });
                liveDo(s.current, 'resume');
                return 'resumed';
            });
        },
        restart(profileId) {
            const s = st(profileId);
            return serial(profileId, async () => {
                if (!s.current) return null;
                s.current.positionMs = 0;
                s.current.reportedAt = now();
                broadcast(s, 'seek', { positionMs: 0 });
                liveDo(s.current, 'seek', 0);
                return s.current.item;
            });
        },
        setVolume(profileId, volume) {
            const s = st(profileId);
            const v = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)));
            if (s.current?.settings) s.current.settings = { ...s.current.settings, volume: v };
            broadcast(s, 'volume', { volume: v });
            return v;
        },
        setCard(profileId, card) { broadcast(st(profileId), 'card', { card: !!card }); },
        playPlaylist(profileId, playlistId) {
            const s = st(profileId);
            return serial(profileId, async () => {
                s.activePlaylistId = playlistId;
                s.running = true;
                // A song from the old list (not a request) gives way now; a request keeps playing.
                if (s.current && !s.current.requestId) await finishCurrent(profileId, s, 'skipped', { skipReason: 'playlist' });
                return advance(profileId);
            });
        },
        removedRequest(profileId, requestId) {
            const s = st(profileId);
            if (s.current?.requestId === requestId) return api.skip(profileId, 'removed');
            return null;
        },

        nowPlaying(profileId) {
            const s = states.get(profileId);
            const cur = s?.current;
            if (!cur) return null;
            return { playId: cur.playId, item: cur.item, requestId: cur.requestId, requester: cur.requester, playlist: cur.playlist, startedAt: cur.startedAt,
                positionMs: position(cur), paused: !!cur.paused, live: !!cur.live };
        },
        history: (profileId) => [...(states.get(profileId)?.history || [])],
        votes: (profileId) => st(profileId).votes,
        async status(profileId) {
            const s = st(profileId);
            const g = await gate(profileId);
            return { running: s.running, overlays: s.overlays.size, gate: g, held: s.held, current: api.nowPlaying(profileId), activePlaylistId: s.activePlaylistId,
                live: !!s.current?.live, directNote: s.directNote, directSuspended: direct?.suspension(profileId) || null };
        },
        /** A live Spotify song behind a signed link (current play only), or null. */
        liveFor(profileId, playId) {
            const cur = states.get(profileId)?.current;
            return cur && cur.live && cur.playId === String(playId) ? cur.live : null;
        },
        /** The audio behind a signed link: only the current play, or the one that just ended (a last Range request). */
        upstreamFor(profileId, playId) {
            const s = states.get(profileId);
            if (!s) return null;
            if (s.current && s.current.playId === String(playId)) return s.current.upstream;
            if (s.previousPlay && s.previousPlay.playId === String(playId) && s.previousPlay.until > now()) return s.previousPlay.upstream;
            return null;
        },
        overlayCount: (profileId) => states.get(profileId)?.overlays.size || 0,
        estimatedWaitMs(profileId, queuedBefore) {
            const cur = states.get(profileId)?.current;
            const left = cur?.item?.durationMs ? Math.max(0, cur.item.durationMs - position(cur)) : 0;
            return left + queuedBefore.reduce((a, r) => a + (r.durationMs || 0), 0);
        },
        _states: states,
    };
    return api;
}

export default { createPlayer, PLAYER_LIMITS };
