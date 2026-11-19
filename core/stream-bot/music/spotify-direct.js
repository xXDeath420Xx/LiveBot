/*
 * Stream bot music: Spotify-direct. A streamer who linked Spotify (spotify_links, or the bot owner) can choose on the
 * Music page to play Spotify requests with real Spotify audio instead of the YouTube Music match.
 *
 *   go-librespot session ──FIFO──▶ streamTrack() (core/spotify-connect-manager.js, unchanged: 48 kHz WAV, end-of-track,
 *   fail-fast, bleed and preemption handling) ──▶ ffmpeg MP3 192k ──▶ a bounded buffer ──▶ the signed audio link ──▶ OBS player
 *
 * Sessions are the Discord bot's: getSessionForUser() picks the account (the owner's for the owner, the streamer's own
 * linked account otherwise; never the shared fallback for anyone else), and every song is acquired with
 * acquire(session, 'stream:<profile>', { owner: false }) and released when it ends. owner:false means a stream never
 * preempts anyone: when Discord voice holds the session, that song plays from the YouTube Music match instead, and the
 * Music page says so. The bot owner can still take the session back from a stream in Discord (the manager's own rule);
 * the stream then moves on and plays the next songs from YouTube Music for a while.
 *
 * Pause, resume and seek go to go-librespot as well as to the player, so the two stay in step. While nothing reads the
 * audio, at most bufferBytes are held and then the pipe is left to push back, exactly as Discord voice does; the reader
 * of the FIFO is never closed before go-librespot is paused (an EPIPE is what sent go-librespot into its busy loop).
 *
 *   createSpotifyDirect({ manager?, encode?, logger?, now?, limits? })
 *     .eligible(discordUserId) → { ok, why }                 linked (or the owner)
 *     .open({ profileId, discordUserId, item }) → { ok: true, live } | { ok: false, reason }
 *         reason: not_linked | not_spotify | busy | no_audio | suspended | error
 *     .suspend(profileId, why, ms) / .suspension(profileId) → { why, until } | null
 *   live: { account, attach(req, res), pause(), resume(), seek(ms), close(why), done (Promise<{ why, early, preempted }>), startedAt }
 *
 * Tested in tests/stream-bot-music-direct.test.js with a fake manager and encoder (no Spotify account is touched).
 */
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';

export const DIRECT_LIMITS = Object.freeze({
    bufferBytes: 30 * 24 * 1024,      // about 30 s of MP3 at 192 kbps held while nothing reads
    attachWaitMs: 20_000,             // the player must ask for the audio within this, or the song is closed
    earlyEndSlackMs: 20_000,          // ending this much before the song's length, not by us: someone else took the account
    suspendMs: 30 * 60_000,           // then Spotify-direct rests for this long (YouTube Music meanwhile)
});

const SP_TRACK = /^sp:([A-Za-z0-9]{22})$/;

/** The real encoder: 48 kHz WAV in, MP3 192k out (what every browser, OBS's included, plays as a live stream). */
export function ffmpegMp3() {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', 'pipe:1'],
        { stdio: ['pipe', 'pipe', 'ignore'] });
    ff.on('error', () => {});
    return { stdin: ff.stdin, stdout: ff.stdout, kill: () => { try { ff.kill('SIGKILL'); } catch { /* gone */ } } };
}

export function createSpotifyDirect({ manager = null, encode = ffmpegMp3, logger = null, now = () => Date.now(), limits = {} } = {}) {
    const L = { ...DIRECT_LIMITS, ...limits };
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[StreamMusic] ${msg}`, meta); } catch { /* ignore */ } };
    let loading = null;
    const mgr = () => (manager ? Promise.resolve(manager) : (loading ||= import('../../spotify-connect-manager.js').catch((e) => { loading = null; throw e; })));
    const suspended = new Map();   // profileId -> { why, until }

    async function eligible(discordUserId) {
        if (!discordUserId) return { ok: false, why: 'not_linked' };
        try {
            const m = await mgr();
            if (m.isOwnerUser(discordUserId)) return { ok: true, why: 'owner' };
            return (await m.isLinked(discordUserId)) ? { ok: true, why: 'linked' } : { ok: false, why: 'not_linked' };
        } catch { return { ok: false, why: 'error' }; }
    }

    function suspension(profileId) {
        const s = suspended.get(profileId);
        if (!s) return null;
        if (s.until <= now()) { suspended.delete(profileId); return null; }
        return s;
    }
    function suspend(profileId, why, ms = L.suspendMs) { suspended.set(profileId, { why, until: now() + ms }); }

    async function open({ profileId, discordUserId, item }) {
        const idMatch = String(item?.trackKey || '').match(SP_TRACK);
        if (!idMatch) return { ok: false, reason: 'not_spotify' };
        if (suspension(profileId)) return { ok: false, reason: 'suspended' };
        const el = await eligible(discordUserId);
        if (!el.ok) return { ok: false, reason: el.why === 'error' ? 'error' : 'not_linked' };
        let m;
        try { m = await mgr(); } catch { return { ok: false, reason: 'error' }; }
        const session = await m.getSessionForUser(discordUserId).catch(() => null);
        // getSessionForUser() falls back to the shared owner account when a linked user's own instance fails to start:
        // never play a streamer's requests on someone else's account.
        if (!session || (el.why === 'linked' && session.id === 'owner')) return { ok: false, reason: 'no_audio' };
        const holder = `stream:${profileId}`;
        let ended = null;
        let closing = false;
        let preempted = false;
        let finish = () => {};
        if (!m.acquire(session, holder, { owner: false, stopHolder: () => { preempted = true; finish('preempted'); } })) return { ok: false, reason: 'busy' };
        let wav;
        try { wav = await m.streamTrack(session, `spotify:track:${idMatch[1]}`); } catch { wav = null; }
        if (!wav) { m.release(session, holder); return { ok: false, reason: preempted ? 'busy' : 'no_audio' }; }

        const enc = encode();
        wav.on('error', () => {});
        enc.stdin.on('error', () => {});
        wav.pipe(enc.stdin);
        const startedAt = now();
        const out = new PassThrough({ highWaterMark: L.bufferBytes });
        let consumer = null;
        let resolveDone;
        const done = new Promise((r) => { resolveDone = r; });
        let attachTimer = null;

        // Encoder → bounded buffer. Above the cap, stop reading: the pipe pushes back to go-librespot, as with Discord voice.
        enc.stdout.on('data', (chunk) => { if (!out.write(chunk)) enc.stdout.pause(); });
        out.on('drain', () => enc.stdout.resume());
        enc.stdout.on('end', () => finish('ended'));
        enc.stdout.on('error', () => finish('encoder_error'));

        finish = (why) => {
            if (ended) return;
            ended = why;
            // The manager's owner preemption kills streamTrack's ffmpeg (our audio ends) and moves the session to the new
            // holder; it does not call our stopHolder. Seeing another holder here is how a preemption shows.
            if (!preempted && session.busyGuildId && session.busyGuildId !== holder) preempted = true;
            const short = item.durationMs ? (now() - startedAt) < item.durationMs - L.earlyEndSlackMs : false;
            const early = !closing && (why !== 'ended' || short);
            if (preempted) suspend(profileId, 'Your Spotify was taken for Discord.');
            else if (early) suspend(profileId, 'Spotify stopped early, so it may be playing somewhere else on your account.');
            try { out.end(); } catch { /* ignore */ }
            if (why === 'ended' && !closing) enc.kill();
            else {
                // Pause first, then retire the readers: go-librespot must never write into a pipe nobody reads (EPIPE).
                Promise.resolve(m.pause(session)).catch(() => {}).finally(() => {
                    setTimeout(() => { try { wav.destroy?.(); } catch { /* gone */ } enc.kill(); }, 250);
                });
            }
            m.release(session, holder);
            clearTimeout(attachTimer);
            resolveDone({ why, early, preempted });
        };

        attachTimer = setTimeout(() => {
            if (consumer) return;
            log('warn', 'the player never asked for the Spotify audio; closing it', { profileId });
            closing = true;
            finish('no_player');
        }, L.attachWaitMs);
        attachTimer.unref?.();

        const live = {
            account: session.id === 'owner' ? 'owner' : 'linked',
            startedAt,
            done,
            get ended() { return ended; },
            /** Stream to one player at a time; a newer request takes over (an MP3 stream can start mid-way). */
            attach(req, res) {
                if (ended && !out.readableLength) { res.status(410).json({ ok: false, error: 'gone' }); return Promise.resolve(false); }
                if (consumer) { try { out.unpipe(consumer); consumer.end(); } catch { /* gone */ } }
                consumer = res;
                clearTimeout(attachTimer);
                res.status(200);
                res.setHeader('content-type', 'audio/mpeg');
                res.setHeader('cache-control', 'no-store');
                res.setHeader('accept-ranges', 'none');
                res.setHeader('x-content-type-options', 'nosniff');
                out.pipe(res);
                return new Promise((resolve) => res.on('close', () => {
                    if (consumer === res) { try { out.unpipe(res); } catch { /* ignore */ } consumer = null; }
                    resolve(true);
                }));
            },
            pause: () => Promise.resolve(m.pause(session)).catch(() => {}),
            resume: () => Promise.resolve(m.resume(session)).catch(() => {}),
            seek: (ms) => Promise.resolve(typeof m.seek === 'function' ? m.seek(session, Math.max(0, Math.round(ms))) : null).catch(() => {}),
            close(why = 'closed') { if (!ended) { closing = true; finish(why); } return done; },
        };
        return { ok: true, live };
    }

    return { eligible, open, suspend, suspension, _suspended: suspended };
}

export default { createSpotifyDirect, ffmpegMp3, DIRECT_LIMITS };
