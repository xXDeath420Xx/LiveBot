/**
 * When the bot leaves voice after music.
 *
 * The owner's rules (2026-10-05):
 *   - stay while music is actively playing, even to an empty channel (autoplay and the AI DJ keep going);
 *   - stay when the server has 24/7 on (camped queues included), or while a voice tool needs the
 *     connection: a transcription, the chat reader, a recording (holdVoice);
 *   - otherwise leave as soon as the queue runs out, once autoplay / the AI DJ have had their go;
 *   - paused with nobody in the channel is not "playing": leave after EMPTY_IDLE_MS.
 *
 * discord-player's own leave options are switched off on every queue (manageLeave). Its end/stop timers
 * only drop the voice connection: the queue stays registered, 'disconnect' never fires (so the status,
 * panel and Spotify-account cleanup is skipped) and the next /music play reuses that queue with whatever
 * options it was created with. None of them can see the voice tools either.
 */
import logger from '../utils/logger.js';

export const QUEUE_END_GRACE_MS = 3_000;        // "immediately": just enough for a /music play already in flight
export const DJ_REFILL_GRACE_MS = 3 * 60_000;   // the AI DJ takes up to ~90 s to build its next playlist
export const EMPTY_IDLE_MS = 5 * 60_000;         // paused / idle with nobody in the channel
export const SWEEP_IDLE_MS = 2 * 60_000;         // sweep: connected, idle and unclaimed for this long

const timers = new Map();        // guildId -> pending leave check
const holds = new Map();         // guildId -> Set of feature keys that need the connection
const lastActivity = new Map();  // guildId -> ms of the last queue/track event

let deps = null;
let defaultOnLeft = null;

/** index.js registers the status/panel/Spotify cleanup once, so every caller of leaveIfIdle gets it. */
export function setLeaveCleanup(fn) { defaultOnLeft = fn; }

// Loaded lazily so the module (and its tests) don't pull in the DB or the voice managers up front.
async function getDeps() {
    if (!deps) {
        const [{ is247Enabled }, transcription, reader] = await Promise.all([
            import('../utils/music_helpers.js'),
            import('./voice-transcription-manager.js'),
            import('./voice-reader-manager.js'),
        ]);
        deps = {
            is247: is247Enabled,
            transcribing: guildId => !!transcription.getSession(guildId),
            reading: guildId => !!reader.readerHoldsVoice?.(guildId),
        };
    }
    return deps;
}

/** Tests: replace the 24/7 / transcription / reader lookups. */
export function setLeavePolicyDeps(d) { deps = d; }

/** Take leaving away from discord-player for this queue (call on create, on every start and on queue end). */
export function manageLeave(queue) {
    const o = queue?.options;
    if (!o) return;
    o.leaveOnEnd = false;
    o.leaveOnEmpty = false;
    o.leaveOnStop = false;
    o.pauseOnEmpty = false;              // keep playing to an empty room
    o.leaveOnEmptyCooldown = EMPTY_IDLE_MS; // its empty timer now only emits 'emptyChannel'
}

export function noteActivity(guildId, now = Date.now()) {
    if (guildId) lastActivity.set(guildId, now);
}

/** A feature that needs the voice connection (e.g. a recording) keeps the bot in until it releases. */
export function holdVoice(guildId, key) {
    if (!holds.has(guildId)) holds.set(guildId, new Set());
    holds.get(guildId).add(key);
}

export function releaseVoice(guildId, key) {
    const set = holds.get(guildId);
    if (!set) return;
    set.delete(key);
    if (!set.size) holds.delete(guildId);
}

export function isActivelyPlaying(queue) {
    return !!queue?.isPlaying?.() && !queue.node?.isPaused?.();
}

function listeners(queue) {
    const members = queue?.channel?.members;
    if (!members) return 0;
    let n = 0;
    for (const m of members.values()) if (!m.user?.bot) n++;
    return n;
}

/** A non-music feature using the connection (recording hold, transcription, chat reader), or null. */
export async function voiceToolHolding(guildId) {
    const held = holds.get(guildId);
    if (held?.size) return `held by ${[...held].join(', ')}`;
    const d = await getDeps();
    if (d.transcribing(guildId)) return 'transcription running';
    if (d.reading(guildId)) return 'chat reader active';
    return null;
}

/**
 * Why the bot should stay connected, or null when nothing needs it.
 * requireEmpty: only leave if nobody is listening (the paused-alone checks).
 */
export async function reasonToStay(queue, { requireEmpty = false } = {}) {
    const guildId = queue.guild.id;
    if (isActivelyPlaying(queue)) return 'playing';
    // Audio from outside the queue on its connection (Spotify-direct, the reader's TTS) is playing too.
    const status = queue.connection?.state?.subscription?.player?.state?.status;
    if (status === 'playing' || status === 'buffering') return 'other audio on the connection';
    if (queue.tracks?.size) return 'tracks queued';
    if (queue.metadata?.isGenerating) return 'AI DJ building a playlist';
    if (queue.metadata?.camp) return 'voice camp';
    const people = listeners(queue);
    if (queue.currentTrack && queue.node?.isPaused?.() && people > 0) return 'paused with listeners';
    if (requireEmpty && people > 0) return 'listeners present';
    const tool = await voiceToolHolding(guildId);
    if (tool) return tool;
    if (await (await getDeps()).is247(guildId)) return '24/7 mode';
    return null;
}

/**
 * Leave now unless something still needs the connection. `player` (when given) makes sure the queue is
 * still the guild's live one, so a check scheduled for an old session can't end a new one.
 * onLeft(guildId, reason) runs the cleanup the 'disconnect' event would have done.
 */
export async function leaveIfIdle(queue, { reason = 'idle', requireEmpty = false, player = null, onLeft = null } = {}) {
    const guildId = queue?.guild?.id;
    if (!guildId) return false;
    if (player && player.nodes?.get?.(guildId) !== queue) return false;
    const stay = await reasonToStay(queue, { requireEmpty });
    if (stay) {
        logger.debug(`[MusicLeave] Staying in guild ${guildId} (${stay})`);
        return false;
    }
    try {
        queue.delete();
    } catch (err) {
        logger.warn(`[MusicLeave] Could not leave guild ${guildId}: ${err.message}`);
        return false;
    }
    lastActivity.delete(guildId);
    logger.info(`[MusicLeave] Left voice in guild ${guildId}: ${reason}`);
    try { await (onLeft ?? defaultOnLeft)?.(guildId, reason); } catch (err) {
        logger.warn(`[MusicLeave] Cleanup after leaving guild ${guildId} failed: ${err.message}`);
    }
    return true;
}

/** Check (and leave) after delayMs; a newer schedule or cancelLeave() replaces it. */
export function scheduleLeave(queue, delayMs, opts = {}) {
    const guildId = queue?.guild?.id;
    if (!guildId) return;
    cancelLeave(guildId);
    const timer = setTimeout(() => {
        timers.delete(guildId);
        leaveIfIdle(queue, opts).catch(err => logger.error(`[MusicLeave] Leave check failed in guild ${guildId}: ${err.message}`));
    }, delayMs);
    timer.unref?.();
    timers.set(guildId, timer);
}

export function cancelLeave(guildId) {
    const timer = timers.get(guildId);
    if (timer) clearTimeout(timer);
    timers.delete(guildId);
}

/**
 * Safety net for every path the events miss (a transcription that ended after the music, a stalled DJ,
 * a queue left over by an old timer): leave any queue that has been idle and unclaimed for SWEEP_IDLE_MS.
 */
export async function sweepIdle(player, { now = Date.now(), onLeft = null } = {}) {
    let left = 0;
    for (const queue of player?.nodes?.cache?.values?.() ?? []) {
        const guildId = queue?.guild?.id;
        if (!guildId || timers.has(guildId)) continue;
        if (now - (lastActivity.get(guildId) ?? 0) < SWEEP_IDLE_MS) continue;
        if (await leaveIfIdle(queue, { reason: 'idle', player, onLeft })) left++;
    }
    return left;
}

export default {
    QUEUE_END_GRACE_MS, DJ_REFILL_GRACE_MS, EMPTY_IDLE_MS, SWEEP_IDLE_MS,
    manageLeave, noteActivity, holdVoice, releaseVoice, isActivelyPlaying, reasonToStay, voiceToolHolding,
    leaveIfIdle, scheduleLeave, cancelLeave, sweepIdle, setLeavePolicyDeps, setLeaveCleanup,
};
