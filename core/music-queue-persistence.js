/*
 * Music queue restore across restarts (table music_queues, extended by migration 290).
 *
 * SAVING — attachQueuePersistence(player), once, right after attachPlayLog():
 *   every queue change (track added/removed/started/skipped, pause, volume, queue ended) schedules a
 *   debounced snapshot of that guild's queue, and every SNAPSHOT_INTERVAL_MS each queue with music is
 *   re-saved so the playback position is never more than a few seconds stale. Position-only changes
 *   are a light UPDATE; the track list is rewritten only when it changed. /music stop, the bot being
 *   disconnected, or the queue running dry deletes the row.
 *
 * SHUTDOWN — freezeQueuePersistence(), from index.js shutdown() BEFORE the Discord clients are
 *   destroyed: writes a final snapshot of every queue, then ignores the disconnect/delete events the
 *   teardown fires, so a deploy does not erase the very rows it needs. A hard crash (SIGKILL, OOM)
 *   skips this and restores from the last periodic snapshot instead.
 *
 * RESTORING — startMusicQueueRestore({ player, client }), once, after the player is set up and the
 *   default client is ready. Rows written by an EARLIER process are loaded; for each guild, as soon as
 *   the bot that was playing there is online (custom bots log in later, so passes repeat every 30 s):
 *   rejoin the voice channel if humans are still in it, rebuild the queue from the stored data (no
 *   re-searching — a 300-track playlist must not cost 300 resolver lookups), resume the current track
 *   a few seconds before where it was, restore volume / repeat mode / DJ-mode metadata, post a note in
 *   the text channel, and clear the row. Rows older than maxAgeMs (default 30 min) are discarded.
 *
 * The play log is untouched: attachPlayLog() already closed the old process's "playing" rows as
 * 'interrupted'; a resumed track is a new play with its own row.
 */
import { PermissionFlagsBits, User } from 'discord.js';
import { Track } from 'discord-player';
import logger from '../utils/logger.js';
import { requestSourceOf, noteRequestKind } from './music-play-log.js';
import {
    buildSnapshot, rowFromSnapshot, rowSignature, snapshotFromRow, planRestore, restoreNotice,
    isSpotifyTrack, DEFAULT_MAX_AGE_MS,
} from './music-queue-snapshot.js';

/** Identifies the process that wrote a row, so a restore only ever picks up rows from before the restart. */
export const INSTANCE_ID = `${process.pid}-${Date.now()}`.slice(0, 40);

const SNAPSHOT_INTERVAL_MS = Number(process.env.MUSIC_QUEUE_SNAPSHOT_MS) || 15_000;
const DEBOUNCE_MS = 2_000;
const FIRST_RESTORE_DELAY_MS = 15_000;
const RETRY_INTERVAL_MS = 30_000;
/** How long to wait for the bot that was playing to come online before any bot in the guild may take over. */
const OWNER_WAIT_MS = 3 * 60_000;

/** The play log's request kinds, as a query that classifies back to the same kind (music-play-log classifyQuery). */
const KIND_QUERY = {
    search: 'restored search',
    youtube: 'https://www.youtube.com/',
    soundcloud: 'https://soundcloud.com/',
    spotify: 'https://open.spotify.com/',
    other: 'https://restored.invalid/',
};

const state = {
    player: null,
    frozen: false,
    interval: null,
    timers: new Map(),          // guildId -> debounce timeout
    lastSig: new Map(),         // guildId -> signature of the row this process last wrote
    pendingRestore: new Map(),  // guildId -> { snap, ageAtLoadMs, loadedAt }
    restoreTimer: null,
    restoreClient: null,
    maxAgeMs: DEFAULT_MAX_AGE_MS,
};

// ── database ────────────────────────────────────────────────────────────────
let pool = null, tableMissing = false, columnsMissing = false, lastErrorAt = 0;
let testExecutor = null;   // tests/music-queue-persistence.test.js routes SQL to a fake
async function execute(sql, params) {
    if (tableMissing || columnsMissing) return null;
    try {
        if (testExecutor) return await testExecutor(sql, params);
        pool ||= (await import('../utils/db.js')).default;
        const [result] = await pool.execute(sql, params);
        return result;
    } catch (e) {
        if (e.code === 'ER_NO_SUCH_TABLE') {
            tableMissing = true;
            logger.error('[MusicRestore] music_queues is missing — queues are not being saved for restore');
        } else if (e.code === 'ER_BAD_FIELD_ERROR') {
            columnsMissing = true;
            logger.error(`[MusicRestore] music_queues lacks the restore columns (migration 290) — queues are not being saved: ${e.message}`);
        } else if (Date.now() - lastErrorAt > 10 * 60_000) {
            lastErrorAt = Date.now();
            logger.warn(`[MusicRestore] database write failed: ${e.message}`);
        }
        return null;
    }
}

function requestSourceSafe(track) {
    try { return requestSourceOf(track); } catch { return null; }
}

// ── saving ──────────────────────────────────────────────────────────────────
// Writes for one guild run strictly one after another: a DELETE from /music stop must never be
// overtaken by a periodic save that was already in flight (that would resurrect stopped music after
// the next restart).
const chains = new Map();   // guildId -> tail promise
function serial(guildId, fn) {
    const next = (chains.get(guildId) || Promise.resolve()).catch(() => {}).then(fn);
    chains.set(guildId, next);
    next.finally(() => { if (chains.get(guildId) === next) chains.delete(guildId); }).catch(() => {});
    return next;
}

function saveQueue(queue) {
    const guildId = queue?.guild?.id;
    if (!guildId) return Promise.resolve();
    return serial(guildId, () => writeSnapshot(queue));
}

function removeRow(guildId) {
    return serial(guildId, () => deleteRow(guildId));
}

async function writeSnapshot(queue) {
    const guildId = queue.guild.id;
    if (queue.deleted) return deleteRow(guildId);
    let snap = null;
    try {
        snap = buildSnapshot(queue, { describe: t => ({ requestSource: requestSourceSafe(t) }) });
    } catch (e) {
        logger.warn(`[MusicRestore] could not snapshot guild ${guildId}: ${e.message}`);
        return;
    }
    if (!snap) return deleteRow(guildId);

    // Music started live before this guild's old queue was restored: the live session wins.
    if (state.pendingRestore.delete(guildId)) {
        logger.info(`[MusicRestore] guild ${guildId} started new music before its restore — not restoring the old queue`);
    }

    const row = rowFromSnapshot(snap, INSTANCE_ID);
    const sig = rowSignature(row);
    if (state.lastSig.get(guildId) === sig) {
        const res = await execute(
            'UPDATE music_queues SET position_ms = ?, is_playing = ?, is_paused = ?, instance_id = ?, saved_at = NOW() WHERE guild_id = ?',
            [row.position_ms, row.is_playing, row.is_paused, row.instance_id, guildId]);
        if (res?.affectedRows > 0) return;
    }
    const res = await execute(
        `INSERT INTO music_queues
            (guild_id, queue, now_playing, is_playing, is_paused, voice_channel_id, text_channel_id, bot_user_id,
             position_ms, volume, repeat_mode, metadata, instance_id, saved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE queue = VALUES(queue), now_playing = VALUES(now_playing), is_playing = VALUES(is_playing),
            is_paused = VALUES(is_paused), voice_channel_id = VALUES(voice_channel_id), text_channel_id = VALUES(text_channel_id),
            bot_user_id = VALUES(bot_user_id), position_ms = VALUES(position_ms), volume = VALUES(volume),
            repeat_mode = VALUES(repeat_mode), metadata = VALUES(metadata), instance_id = VALUES(instance_id), saved_at = NOW()`,
        [row.guild_id, row.queue, row.now_playing, row.is_playing, row.is_paused, row.voice_channel_id, row.text_channel_id,
            row.bot_user_id, row.position_ms, row.volume, row.repeat_mode, row.metadata, row.instance_id]);
    if (res) state.lastSig.set(guildId, sig);
}

async function deleteRow(guildId) {
    if (state.frozen) return;                         // shutdown teardown: keep the rows for the restore
    if (state.pendingRestore.has(guildId)) return;    // still waiting to be restored (e.g. an idle camp queue)
    if (!state.lastSig.has(guildId)) return;          // this process never saved one
    state.lastSig.delete(guildId);
    await execute('DELETE FROM music_queues WHERE guild_id = ?', [guildId]);
}

function schedule(queue, delay = DEBOUNCE_MS) {
    if (state.frozen) return;
    const guildId = queue?.guild?.id;
    if (!guildId) return;
    clearTimeout(state.timers.get(guildId));
    const timer = setTimeout(() => runScheduled(guildId), delay);
    timer.unref?.();
    state.timers.set(guildId, timer);
}

function runScheduled(guildId) {
    state.timers.delete(guildId);
    const live = state.player?.nodes?.get(guildId);
    const job = live ? saveQueue(live) : removeRow(guildId);
    job.catch(e => logger.warn(`[MusicRestore] save failed for guild ${guildId}: ${e.message}`));
}

function dropNow(queue) {
    const guildId = queue?.guild?.id;
    if (!guildId) return;
    clearTimeout(state.timers.get(guildId));
    state.timers.delete(guildId);
    removeRow(guildId).catch(e => logger.warn(`[MusicRestore] delete failed for guild ${guildId}: ${e.message}`));
}

async function snapshotAll() {
    if (state.frozen || !state.player?.nodes?.cache) return;
    for (const queue of state.player.nodes.cache.values()) {
        if (state.timers.has(queue.guild?.id)) continue;   // a debounced save is about to run anyway
        if (!queue.currentTrack && !(queue.tracks?.size > 0) && !queue.metadata?.djMode) continue;
        await saveQueue(queue).catch(e => logger.warn(`[MusicRestore] periodic save failed: ${e.message}`));
    }
}

/** Subscribe to the player's events and start the periodic snapshot. Call once, after attachPlayLog(player). */
export function attachQueuePersistence(player) {
    if (!player?.events || state.player === player) return;
    state.player = player;
    const handlers = {
        playerStart: q => schedule(q, 250),
        audioTrackAdd: q => schedule(q),
        audioTracksAdd: q => schedule(q),
        audioTrackRemove: q => schedule(q),
        audioTracksRemove: q => schedule(q),
        playerSkip: q => schedule(q),
        playerPause: q => schedule(q),
        playerResume: q => schedule(q),
        volumeChange: q => schedule(q),
        emptyQueue: q => schedule(q),
        queueDelete: q => dropNow(q),
        disconnect: q => dropNow(q),
    };
    for (const [event, fn] of Object.entries(handlers)) {
        player.events.on(event, (queue) => {
            try { fn(queue); } catch (e) { logger.warn(`[MusicRestore] ${event} handler: ${e.message}`); }
        });
    }
    state.interval = setInterval(() => {
        snapshotAll().catch(e => logger.warn(`[MusicRestore] periodic snapshot failed: ${e.message}`));
    }, SNAPSHOT_INTERVAL_MS);
    state.interval.unref?.();
    logger.info(`[MusicRestore] queue persistence attached (snapshot every ${SNAPSHOT_INTERVAL_MS / 1000}s, instance ${INSTANCE_ID})`);
}

/**
 * For shutdown(): save every queue one last time and stop deleting rows, so the client teardown that
 * follows (which disconnects every voice session) cannot wipe what the next boot restores.
 * @returns {Promise<number>} queues saved
 */
export async function freezeQueuePersistence(timeoutMs = 4000) {
    if (!state.player || state.frozen) return 0;
    for (const t of state.timers.values()) clearTimeout(t);
    state.timers.clear();
    clearInterval(state.interval);
    state.frozen = true;
    const queues = [...(state.player.nodes?.cache?.values?.() || [])]
        .filter(q => q.currentTrack || q.tracks?.size > 0 || q.metadata?.djMode);
    let timer;
    await Promise.race([
        Promise.allSettled(queues.map(q => saveQueue(q))),
        new Promise(r => { timer = setTimeout(r, timeoutMs); }),
    ]);
    clearTimeout(timer);
    if (queues.length) logger.info(`[MusicRestore] saved ${queues.length} queue(s) for restore after the restart`);
    return queues.length;
}

// ── restoring ───────────────────────────────────────────────────────────────

/**
 * Load the queues an earlier process left behind and restore them as their bots come online.
 * Safe to call once per process; returns how many guilds are pending.
 */
export async function startMusicQueueRestore({ player = state.player, client = null, maxAgeMs = DEFAULT_MAX_AGE_MS, firstDelayMs = FIRST_RESTORE_DELAY_MS } = {}) {
    if (!player) { logger.warn('[MusicRestore] no player — nothing restored'); return 0; }
    state.player ||= player;
    state.restoreClient = client;
    state.maxAgeMs = maxAgeMs;

    const rows = await execute(
        `SELECT guild_id, queue, now_playing, is_playing, is_paused, voice_channel_id, text_channel_id, bot_user_id,
                position_ms, volume, repeat_mode, metadata, TIMESTAMPDIFF(SECOND, saved_at, NOW()) AS age_sec
           FROM music_queues WHERE instance_id IS NULL OR instance_id <> ?`, [INSTANCE_ID]);
    if (!rows) return 0;

    let expired = 0;
    for (const row of rows) {
        const snap = snapshotFromRow(row);
        const ageMs = Math.max(0, Number(row.age_sec) || 0) * 1000;
        if (!snap || ageMs > maxAgeMs) {
            expired++;
            await execute('DELETE FROM music_queues WHERE guild_id = ? AND (instance_id IS NULL OR instance_id <> ?)', [row.guild_id, INSTANCE_ID]);
            continue;
        }
        state.pendingRestore.set(snap.guildId, { snap, ageAtLoadMs: ageMs, loadedAt: Date.now() });
    }
    if (expired) logger.info(`[MusicRestore] discarded ${expired} saved queue(s) older than ${Math.round(maxAgeMs / 60000)} min`);
    if (!state.pendingRestore.size) return 0;
    logger.info(`[MusicRestore] ${state.pendingRestore.size} queue(s) to restore: ${[...state.pendingRestore.keys()].join(', ')}`);
    scheduleRestorePass(firstDelayMs);
    return state.pendingRestore.size;
}

/** Guilds whose queue is still waiting to be restored (for diagnostics). */
export function pendingRestores() {
    return [...state.pendingRestore.keys()];
}

function scheduleRestorePass(delay) {
    clearTimeout(state.restoreTimer);
    state.restoreTimer = setTimeout(() => {
        restorePass().catch(e => logger.error(`[MusicRestore] restore pass failed: ${e.message}`, { stack: e.stack }));
    }, delay);
    state.restoreTimer.unref?.();
}

async function restorePass() {
    state.restoreTimer = null;
    if (state.frozen) return;
    for (const [guildId, entry] of [...state.pendingRestore]) {
        if (!state.pendingRestore.has(guildId)) continue;
        try {
            await restoreGuild(guildId, entry);
        } catch (e) {
            state.pendingRestore.delete(guildId);
            logger.error(`[MusicRestore] restoring guild ${guildId} failed: ${e.message}`, { stack: e.stack });
        }
    }
    if (state.pendingRestore.size) scheduleRestorePass(RETRY_INTERVAL_MS);
}

async function dropPending(guildId, why) {
    state.pendingRestore.delete(guildId);
    await execute('DELETE FROM music_queues WHERE guild_id = ? AND (instance_id IS NULL OR instance_id <> ?)', [guildId, INSTANCE_ID]);
    logger.info(`[MusicRestore] not restoring guild ${guildId}: ${why}`);
}

/** The bot that was playing in this guild — or, once it has had OWNER_WAIT_MS to come online, any bot there. */
function resolveClient(guildId, botUserId, waitedMs) {
    const bm = global.botManager;
    const clients = bm?.getAllClients?.() || (state.restoreClient ? [state.restoreClient] : []);
    const usable = c => c?.isReady?.() && c.guilds?.cache?.has(guildId);
    if (botUserId) {
        const owner = clients.find(c => c?.user?.id === botUserId);
        if (usable(owner)) return owner;
        if (waitedMs < OWNER_WAIT_MS) return null;
    }
    const any = bm?.getClientForGuild?.(guildId);
    if (usable(any)) return any;
    if (usable(state.restoreClient)) return state.restoreClient;
    return null;
}

async function restoreGuild(guildId, entry) {
    const player = state.player;
    const waited = Date.now() - entry.loadedAt;
    const plan = planRestore(entry.snap, { ageMs: entry.ageAtLoadMs + waited, maxAgeMs: state.maxAgeMs });
    if (plan.action === 'expired') return dropPending(guildId, 'too old (no bot came online for it in time)');
    if (plan.action !== 'restore') return dropPending(guildId, 'nothing left to play');

    const live = player.nodes.get(guildId);
    if (live && (live.currentTrack || live.tracks?.size > 0)) {
        state.pendingRestore.delete(guildId);   // its own persistence owns the row now
        logger.info(`[MusicRestore] guild ${guildId} already has music playing — not restoring the old queue`);
        return;
    }

    const client = resolveClient(guildId, entry.snap.botUserId, waited);
    if (!client) return;   // its bot isn't online yet — next pass
    const guild = client.guilds.cache.get(guildId);
    const channel = entry.snap.voiceChannelId ? guild.channels.cache.get(entry.snap.voiceChannelId) : null;
    if (!channel?.isVoiceBased?.()) return dropPending(guildId, 'the voice channel no longer exists');
    const humans = channel.members?.filter(m => !m.user?.bot)?.size ?? 0;
    if (!humans) return dropPending(guildId, `nobody is in #${channel.name} any more`);
    const me = guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (!perms?.has(PermissionFlagsBits.Connect) || !perms.has(PermissionFlagsBits.Speak)) {
        return dropPending(guildId, `missing Connect/Speak in #${channel.name}`);
    }

    // Claim it: from here the restored queue's own persistence writes the guild's row.
    state.pendingRestore.delete(guildId);
    await execute('DELETE FROM music_queues WHERE guild_id = ? AND (instance_id IS NULL OR instance_id <> ?)', [guildId, INSTANCE_ID]);
    await rebuildQueue({ player, client, guild, channel, snap: entry.snap, plan });
}

async function resolveUsers(client, tracks) {
    const users = new Map();
    for (const t of tracks) {
        const r = t?.requestedBy;
        if (!r?.id || users.has(r.id)) continue;
        if (r.bot) { users.set(r.id, r.id === client.user?.id ? client.user : (client.users.cache.get(r.id) || client.user)); continue; }
        let user = client.users.cache.get(r.id) || null;
        if (!user && users.size < 25) user = await client.users.fetch(r.id).catch(() => null);
        if (!user) {
            try { user = new User(client, { id: r.id, username: r.username || 'unknown', global_name: r.globalName || null, bot: false, discriminator: '0' }); }
            catch { user = null; }
        }
        users.set(r.id, user);
    }
    return users;
}

async function rebuildQueue({ player, client, guild, channel, snap, plan }) {
    const [{ spotifyConnectStream }, { getLeaveOptions }] = await Promise.all([
        import('../handlers/music/player.js'),
        import('../utils/music_helpers.js'),
    ]);
    const users = await resolveUsers(client, [plan.current, ...plan.upcoming].filter(Boolean));

    const toTrack = (d) => {
        try {
            const track = new Track(player, {
                title: d.title,
                author: d.author,
                url: d.url,
                thumbnail: d.thumbnail || undefined,
                duration: d.duration || '0:00',
                source: d.source || 'arbitrary',
                queryType: d.queryType || undefined,
                requestedBy: (d.requestedBy?.id && users.get(d.requestedBy.id)) || null,
                metadata: d.metadata || undefined,
                ...(d.unresolved ? { ytdlpUnresolved: true } : {}),
            });
            if (d.extractor) {
                const ext = player.extractors?.get?.(d.extractor);
                if (ext) track.extractor = ext;
            }
            if (d.requestSource && KIND_QUERY[d.requestSource]) noteRequestKind(track, KIND_QUERY[d.requestSource]);
            return track;
        } catch (e) {
            logger.warn(`[MusicRestore] could not rebuild "${d?.title}": ${e.message}`);
            return null;
        }
    };
    const current = plan.current ? toTrack(plan.current) : null;
    const upcoming = plan.upcoming.map(toTrack).filter(Boolean);

    const textChannelId = snap.textChannelId || snap.meta?.channelId || null;
    const metadata = {
        ...snap.meta,
        channelId: textChannelId,
        voiceChannelId: channel.id,
        djMode: !!snap.meta?.djMode,
        playedTracks: Array.isArray(snap.meta?.playedTracks) ? snap.meta.playedTracks : [],
        isGenerating: false,
        restoredAt: Date.now(),
    };
    // Leaving is core/music-leave-policy.js's job (its queueCreate/playerStart hooks manage every queue,
    // a restored one included); these are the same policy-managed values.
    const leave = await getLeaveOptions(guild.id);
    const volume = Number.isFinite(snap.volume) && snap.volume > 0 ? snap.volume : 80;

    let queue = player.nodes.get(guild.id);
    if (queue) {
        // An idle queue (voice camp) already holds the guild's voice session: reuse it.
        queue.setMetadata({ ...(queue.metadata || {}), ...metadata });
        Object.assign(queue.options, leave);
        queue.onBeforeCreateStream = spotifyConnectStream;
    } else {
        queue = player.nodes.create(guild, {
            metadata, selfDeaf: true, volume, onBeforeCreateStream: spotifyConnectStream, ...leave,
        });
    }
    if (!queue.connection || queue.channel?.id !== channel.id) await queue.connect(channel);
    try { queue.node.setVolume(volume); } catch { /* volume is a nicety */ }
    if (Number.isInteger(snap.repeatMode)) queue.setRepeatMode(snap.repeatMode);
    if (upcoming.length) queue.addTrack(upcoming);

    if (current) {
        queue.node.play(current, { queue: false, seek: plan.seekMs })
            .then(() => { if (snap.paused) queue.node.setPaused(true); })
            .catch(e => logger.error(`[MusicRestore] resuming "${current.title}" in guild ${guild.id} failed: ${e.message}`));
    } else if (upcoming.length) {
        queue.node.play().catch(e => logger.error(`[MusicRestore] starting the queue in guild ${guild.id} failed: ${e.message}`));
    } else if (metadata.djMode) {
        const dj = client.djManager || global.djManager;
        dj?.onQueueEnd(queue).catch(e => logger.error(`[MusicRestore] DJ refill in guild ${guild.id} failed: ${e.message}`));
    }

    logger.info(`[MusicRestore] restored guild ${guild.id} in #${channel.name}: ${current ? `"${current.title}" at ${Math.round(plan.seekMs / 1000)}s` : 'DJ refill'}`
        + `, ${upcoming.length} queued${metadata.djMode ? ', DJ mode' : ''}`);

    const text = textChannelId ? guild.channels.cache.get(textChannelId) : null;
    if (text?.isTextBased?.()) {
        const content = current
            ? restoreNotice({
                title: current.title, author: current.author, seekMs: plan.seekMs,
                upcomingCount: upcoming.length, droppedCount: Math.max(0, (snap.totalUpcoming || 0) - (snap.upcoming?.length || 0)),
                djMode: metadata.djMode, paused: snap.paused, spotifyRestart: plan.seekMs === 0 && isSpotifyTrack(plan.current) && snap.positionMs > 5000,
            })
            : '🔁 I was restarted — the AI DJ session is back and picking new songs.';
        await text.send({ content, allowedMentions: { parse: [] } })
            .catch(e => logger.debug(`[MusicRestore] restore notice failed in ${guild.id}: ${e.message}`));
    }
}

/**
 * Tests only: a fake SQL executor, a clean slate between cases, and the timers run on demand
 * (debounced saves, restore passes) so tests wait for the work itself, never for wall-clock time.
 */
export const _testing = {
    setExecutor(fn) { testExecutor = fn; tableMissing = false; columnsMissing = false; },
    /** Start every debounced save now (without waiting for the writes). */
    fireSaves() {
        for (const [guildId, t] of [...state.timers]) { clearTimeout(t); runScheduled(guildId); }
    },
    /** Resolves once every queued write has finished. */
    async settle() {
        while (chains.size) await Promise.allSettled([...chains.values()]);
    },
    /** fireSaves(), then settle(). */
    async flushSaves() {
        this.fireSaves();
        await this.settle();
    },
    /** Run a restore pass now instead of waiting for its timer; resolves when it is done. */
    runRestorePass() {
        clearTimeout(state.restoreTimer);
        state.restoreTimer = null;
        return restorePass();
    },
    reset() {
        for (const t of state.timers.values()) clearTimeout(t);
        clearInterval(state.interval);
        clearTimeout(state.restoreTimer);
        Object.assign(state, {
            player: null, frozen: false, interval: null, timers: new Map(), lastSig: new Map(),
            pendingRestore: new Map(), restoreTimer: null, restoreClient: null, maxAgeMs: DEFAULT_MAX_AGE_MS,
        });
        chains.clear();
    },
};

export default { attachQueuePersistence, freezeQueuePersistence, startMusicQueueRestore, pendingRestores, INSTANCE_ID };
