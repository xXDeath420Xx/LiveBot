/*
 * Chat-to-voice: read a text channel aloud in voice with the Piper voices the AI DJ uses.
 *
 * One row per guild in voice_reader_config:
 *   text_channels     channels to read. EMPTY means "each voice channel's own built-in chat is
 *                     read into that voice channel" — the natural default, no setup beyond enabling.
 *   voice_channel_id  where to speak when follow_author is off (or the author isn't in voice).
 *   follow_author     speak in the voice channel the author is sitting in.
 *   require_in_voice  only read people who are actually in the target voice channel, so someone
 *                     outside can't talk into a room they aren't in.
 *
 * The reader never talks over music. It borrows the guild's shared voice connection
 * (core/voice-connection-share.js) only while nothing else is playing, then hands it straight
 * back to whatever audio player had it — discord-player subscribes its player once and never
 * again, so failing to restore it would silence the next song.
 *
 * Voices are Piper's or Kokoro's (`kokoro_*`). A Kokoro message is spoken sentence by sentence as
 * each one is synthesised (utils/piper-worker.js synthesizeFastStream), so a long message starts
 * after its first sentence rather than after all of it.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createAudioPlayer, createAudioResource } from 'discord-player';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { getVoiceInfo } from '../utils/piper-tts.js';
import { synthesizeFastStream } from '../utils/piper-worker.js';

const { createChunkStream } = createRequire(import.meta.url)('../utils/kokoro-logic.cjs');
const unlinkQuietly = (file) => { fs.promises.unlink(file).catch(() => {}); };
import { speakableBody, speakableName } from '../utils/speech-text.js';
import { getConfig as getTtsConfig } from './tts-config.js';
import { displayNameFor } from '../utils/display-name.js';
import { acquireVoice, getGuildConnection, isConnectionBusy } from './voice-connection-share.js';
import { getSession as getTranscriptionSession, isOptedOut } from './voice-transcription-manager.js';

const CONFIG_TTL_MS = 60_000;
const MAX_QUEUE = 8;
const DELETE_GRACE_MS = 1_200;       // let automod remove a message before we read it out
const NAME_REPEAT_WINDOW_MS = 30_000;
const PLAY_TIMEOUT_MS = 45_000;
const IDLE_LEAVE_MS = 5 * 60_000;    // leave a connection the reader opened after this long with nothing to say
const ALONE_LEAVE_MS = 15_000;       // ...or this soon after everyone else has left the channel
const USER_VOICE_TTL_MS = 5 * 60_000;
const REACT_SPEAKING = '🗣️';
const REACT_DONE = '🙊';

const DEFAULTS = {
    enabled: 0,
    text_channels: null,
    voice_channel_id: null,
    follow_author: 1,
    voice: null,
    read_names: 1,
    require_in_voice: 1,
    max_length: 600,
    allowed_roles: null,
    skip_links: 1,
    reactions: 1,
};

const configCache = new Map();       // guildId -> { value, expires }
const guildState = new Map();        // guildId -> { queue: [], busy, player, lastQueued, lastQueuedAt }
const userVoices = new Map();        // userId -> { voice|null, spokenName|null, expires }

const truthy = v => v === 1 || v === true || v === '1';

function idList(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v.map(String);
    const s = String(v).trim();
    if (s.startsWith('[')) { try { return JSON.parse(s).map(String); } catch { return []; } }
    return s.split(',').map(x => x.trim()).filter(Boolean);
}

export async function getReaderConfig(guildId) {
    const hit = configCache.get(guildId);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = { ...DEFAULTS };
    try {
        const [rows] = await pool.execute('SELECT * FROM voice_reader_config WHERE guild_id = ?', [guildId]);
        if (rows[0]) for (const [k, v] of Object.entries(rows[0])) if (v !== null && v !== undefined) value[k] = v;
    } catch (err) {
        logger.warn(`[VoiceReader] Could not read config for ${guildId}: ${err.message}`);
    }
    configCache.set(guildId, { value, expires: Date.now() + CONFIG_TTL_MS });
    return value;
}

export function invalidateReaderConfig(guildId) {
    configCache.delete(guildId);
}

async function getUserPrefs(userId) {
    const hit = userVoices.get(userId);
    if (hit && hit.expires > Date.now()) return hit;
    let prefs = { voice: null, spokenName: null };
    try {
        const [rows] = await pool.execute('SELECT voice, spoken_name FROM voice_reader_user_voices WHERE user_id = ?', [userId]);
        if (rows[0]) prefs = { voice: rows[0].voice ?? null, spokenName: rows[0].spoken_name ?? null };
    } catch (err) {
        logger.debug(`[VoiceReader] Could not read user prefs for ${userId}: ${err.message}`);
    }
    const entry = { ...prefs, expires: Date.now() + USER_VOICE_TTL_MS };
    userVoices.set(userId, entry);
    return entry;
}

/** A member's own reader voice (set with /voice reader my-voice), used in every server. */
export async function getUserVoice(userId) {
    return (await getUserPrefs(userId)).voice;
}

/** How a member's name is said (set with /voice reader my-name), used in every server. */
export async function getUserSpokenName(userId) {
    return (await getUserPrefs(userId)).spokenName;
}

async function saveUserPref(userId, column, value) {
    await pool.execute(
        `INSERT INTO voice_reader_user_voices (user_id, ${column}) VALUES (?, ?) ON DUPLICATE KEY UPDATE ${column} = VALUES(${column})`,
        [userId, value]
    );
    // A row holding neither setting is just noise.
    await pool.execute('DELETE FROM voice_reader_user_voices WHERE user_id = ? AND voice IS NULL AND spoken_name IS NULL', [userId]);
    userVoices.delete(userId);
}

export async function setUserVoice(userId, voice) {
    await saveUserPref(userId, 'voice', voice || null);
}

export async function setUserSpokenName(userId, name) {
    await saveUserPref(userId, 'spoken_name', name ? String(name).slice(0, 64) : null);
}

/** Save selected columns (commands use this; the dashboard writes the same table). */
export async function saveReaderConfig(guildId, patch) {
    const allowed = Object.keys(DEFAULTS);
    const cols = Object.keys(patch).filter(k => allowed.includes(k));
    if (!cols.length) return;
    const values = cols.map(k => patch[k]);
    await pool.execute(
        `INSERT INTO voice_reader_config (guild_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
         ON DUPLICATE KEY UPDATE ${cols.map(k => `${k} = VALUES(${k})`).join(', ')}`,
        [guildId, ...values]
    );
    invalidateReaderConfig(guildId);
}

/**
 * Turn a Discord message into something worth hearing — see utils/speech-text.js for the rules
 * (fancy fonts, emoji, chat shorthand, line breaks as pauses, cut at sentence ends).
 */
export function speakableText(message, { skipLinks = true, maxLength = 600 } = {}) {
    const guild = message.guild;
    return speakableBody(message.content, {
        skipLinks,
        maxLength,
        resolve: {
            user: id => displayNameFor(id, guild),
            role: id => guild?.roles?.cache?.get(id)?.name,
            channel: id => guild?.channels?.cache?.get(id)?.name,
        },
    });
}

/** The author's name as it should be said: their own override, else the cleaned display name. */
async function spokenNameFor(message) {
    const override = await getUserSpokenName(message.author.id);
    if (override) return override;
    return speakableName(displayNameFor(message.member ?? message.author, message.guild))
        || speakableName(message.author.globalName)
        || speakableName(message.author.username)
        || 'Someone';
}

function stateFor(guildId) {
    let s = guildState.get(guildId);
    if (!s) {
        s = { queue: [], busy: false, player: null, lastQueued: null, lastQueuedAt: 0, idleTimer: null, ownsConnection: false };
        guildState.set(guildId, s);
    }
    return s;
}

/**
 * Where should this message be spoken? Returns the voice channel, or null when it shouldn't be.
 */
function resolveTarget(message, config) {
    const guild = message.guild;
    const authorVoice = message.member?.voice?.channel ?? null;
    const readChannels = idList(config.text_channels);

    let target = null;
    if (readChannels.length) {
        if (!readChannels.includes(message.channel.id)) return null;
        target = truthy(config.follow_author) && authorVoice
            ? authorVoice
            : (config.voice_channel_id ? guild.channels.cache.get(String(config.voice_channel_id)) : null);
    } else if (message.channel.isVoiceBased?.()) {
        // No list configured: a voice channel's built-in chat is read into that voice channel.
        target = message.channel;
    }

    if (!target?.isVoiceBased?.()) return null;
    if (truthy(config.require_in_voice) && authorVoice?.id !== target.id) return null;
    return target;
}

/** messageCreate entry point. Never throws; never blocks the rest of message handling. */
export async function handleReaderMessage(message) {
    try {
        if (!message.guild || message.author.bot || message.system || !message.content) return;
        // /voice privacy opt-out keeps a member out of every voice tool: never transcribed, never read aloud.
        if (isOptedOut(message.author.id)) return;
        const config = await getReaderConfig(message.guild.id);
        if (!truthy(config.enabled)) return;

        const roles = idList(config.allowed_roles);
        if (roles.length && !roles.some(r => message.member?.roles?.cache?.has(r))) return;

        const target = resolveTarget(message, config);
        if (!target) return;

        const body = speakableText(message, { skipLinks: truthy(config.skip_links), maxLength: config.max_length });
        if (!body || !/[\p{L}\p{N}]/u.test(body)) return;

        // Everything awaited happens before the queue is touched, so the name-once rule and the
        // queue itself see messages in one consistent order.
        const voice = await pickVoice(message, config);
        const intro = truthy(config.read_names) ? await introFor(message, voice) : null;

        const state = stateFor(message.guild.id);
        if (state.queue.length >= MAX_QUEUE) {
            logger.debug(`[VoiceReader] Queue full in ${message.guild.id}; dropped a message`);
            return;
        }
        // Name once per run of messages from the same person, decided in queue order.
        const repeatName = state.lastQueued === message.author.id && Date.now() - state.lastQueuedAt < NAME_REPEAT_WINDOW_MS;
        state.lastQueued = message.author.id;
        state.lastQueuedAt = Date.now();
        const spoken = intro && !repeatName ? `${intro}: ${body}` : body;

        // Start synthesising now, so the next message is ready the moment this one finishes.
        // Failures surface when the item is spoken.
        const item = { message, target, config, chunks: renderAudio(spoken, voice) };
        state.queue.push(item);
        drain(message.guild.id).catch(err => logger.warn(`[VoiceReader] Drain error in ${message.guild.id}: ${err.message}`));
    } catch (err) {
        logger.warn(`[VoiceReader] handleReaderMessage failed: ${err.message}`);
    }
}

async function drain(guildId) {
    const state = stateFor(guildId);
    if (state.busy) return;
    state.busy = true;
    try {
        while (state.queue.length) {
            const item = state.queue.shift();
            await speakItem(state, item).catch(err =>
                logger.warn(`[VoiceReader] Could not read message ${item.message.id} in ${guildId}: ${err.message}`));
        }
    } finally {
        state.busy = false;
    }
}

/** The member's own voice wins, then the server's reader voice, then the server's TTS default. */
async function pickVoice(message, config) {
    const tts = await getTtsConfig(message.guild.id).catch(() => ({}));
    const candidates = [await getUserVoice(message.author.id), config.voice, tts.default_voice, 'ryan'];
    return candidates.find(v => v && getVoiceInfo(v));
}

/**
 * What goes before the message. A custom voice trained on someone (Bear's 'bear') speaking that
 * person's own message says "I said" rather than "Bear says" — it is their voice, after all.
 */
export async function introFor(message, voice) {
    const ownerId = voice ? getVoiceInfo(voice)?.ownerId : null;
    if (ownerId && ownerId === message.author.id) return 'I said';
    return `${await spokenNameFor(message)} says`;
}

/** Returns a chunk stream of WAV files at once (one per sentence for Kokoro, one for Piper). */
function renderAudio(spoken, voice) {
    const out = createChunkStream();
    (async () => {
        const src = synthesizeFastStream(spoken, voice);
        for await (const file of src) out.push(file);
        out.end(src.error && !out.produced ? src.error : null);
    })().catch(err => out.end(err));
    return out;
}

async function speakItem(state, { message, target, config, chunks }) {
    const reader = chunks[Symbol.asyncIterator]();
    const [first] = await Promise.all([reader.next(), new Promise(r => setTimeout(r, DELETE_GRACE_MS))]);
    let wavPath = first.done ? null : first.value;
    try {
        if (!wavPath) return;
        // A message automod (or a mod) removed in the meantime must not be read out.
        const cached = message.channel.messages?.cache;
        if (cached && !cached.has(message.id)) return;
        // They may have opted out while this was waiting in the queue.
        if (isOptedOut(message.author.id)) return;

        const guildId = message.guild.id;
        const existing = getGuildConnection(message.client, guildId);
        if (existing && isConnectionBusy(existing, state.player)) return;   // music is playing — stay quiet

        const transcribing = getTranscriptionSession(guildId);
        clearTimeout(state.idleTimer);
        const { connection, created } = await acquireVoice(message.client, target, {
            // Never deafen a connection the transcriber is listening on.
            selfDeaf: !transcribing,
            // Don't drag the bot out of a room that is being transcribed.
            allowMove: !transcribing,
        });
        if (created) state.ownsConnection = true;
        if (isConnectionBusy(connection, state.player)) return;

        const react = truthy(config.reactions);
        if (react) await message.react(REACT_SPEAKING).catch(() => {});
        // Sentence by sentence: the next one is usually ready before this one ends.
        let outcome = 'finished';
        while (wavPath) {
            outcome = await playOnce(state, connection, wavPath);
            unlinkQuietly(wavPath);
            wavPath = null;
            if (outcome !== 'finished') break;
            const next = await reader.next();
            if (!next.done) wavPath = next.value;
        }
        if (react) {
            await message.reactions.cache.get(REACT_SPEAKING)?.users.remove(message.client.user.id).catch(() => {});
            // 🙊 only when it was read to the end — a skip or music cutting in leaves no "done" mark.
            if (outcome === 'finished') await message.react(REACT_DONE).catch(() => {});
        }
    } finally {
        if (wavPath) unlinkQuietly(wavPath);
        // Sentences not read (skipped, interrupted, or still being made) are deleted as they land.
        chunks.discard(unlinkQuietly);
        scheduleIdleLeave(message.client, message.guild.id, state);
    }
}

/**
 * If the reader is the reason the bot is in voice, don't sit there forever after the chat goes
 * quiet. Anything else holding the session (music, camp, a transcription) keeps it.
 */
function scheduleIdleLeave(client, guildId, state) {
    clearTimeout(state.idleTimer);
    if (!state.ownsConnection) return;
    state.idleTimer = setTimeout(() => {
        if (state.busy || state.queue.length || getTranscriptionSession(guildId)) return;
        const queue = (client.player || global.player)?.nodes?.get(guildId);
        if (!queue || queue.isPlaying() || queue.tracks?.size || queue.metadata?.camp) {
            state.ownsConnection = false;
            return;
        }
        try { queue.delete(); } catch (err) { logger.debug(`[VoiceReader] Idle leave failed: ${err.message}`); }
        state.ownsConnection = false;
    }, IDLE_LEAVE_MS);
    state.idleTimer.unref?.();
}

function playOnce(state, connection, wavPath) {
    if (!state.player) {
        state.player = createAudioPlayer();
        state.player.on('error', err => logger.warn(`[VoiceReader] Player error: ${err.message}`));
    }
    const player = state.player;
    const previous = connection.state?.subscription?.player;
    const restore = previous && previous !== player ? previous : null;

    state.interrupted = false;
    return new Promise((resolve) => {
        let done = false;
        const finish = (outcome = 'finished') => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            player.off('stateChange', onState);
            restore?.off('stateChange', onRestoreState);
            // Hand the connection back so the next song actually reaches the channel.
            if (restore && connection.state?.status !== 'destroyed') connection.subscribe(restore);
            resolve(state.interrupted ? 'interrupted' : outcome);
        };
        const onState = (oldS, newS) => {
            if (newS.status === 'idle' && oldS.status !== 'idle') finish();
        };
        // Music started while we were mid-sentence: yield immediately.
        const onRestoreState = (_o, newS) => {
            if (newS.status === 'playing' || newS.status === 'buffering') { player.stop(true); finish('interrupted'); }
        };
        const timer = setTimeout(() => { player.stop(true); finish('interrupted'); }, PLAY_TIMEOUT_MS);

        player.on('stateChange', onState);
        restore?.on('stateChange', onRestoreState);
        connection.subscribe(player);
        player.play(createAudioResource(wavPath));
    });
}

/**
 * True while the reader needs the voice connection: it is speaking, has lines waiting, or it brought
 * the bot in (its own idle/alone timers then decide when to leave). core/music-leave-policy.js asks this
 * before leaving at the end of a music queue.
 */
export function readerHoldsVoice(guildId) {
    const state = guildState.get(guildId);
    return !!(state && (state.ownsConnection || state.busy || state.queue.length));
}

/** Stop anything being read in this guild and clear its queue. */
export function skipReader(guildId) {
    const state = guildState.get(guildId);
    if (!state) return false;
    // Queued items were already synthesised (or are being); drop their files as they land.
    for (const item of state.queue.splice(0)) item.chunks.discard(unlinkQuietly);
    state.interrupted = true;
    state.player?.stop(true);
    return true;
}

/**
 * Leave the voice channel the reader brought the bot into once nobody else is in it — the same
 * "don't sit alone in a room" behaviour as Scriptly. Music, camp and transcription keep their own
 * rules and are never cut off by this.
 */
export function handleReaderVoiceState(oldState, newState) {
    const guildId = newState.guild?.id;
    const state = guildId && guildState.get(guildId);
    if (!state?.ownsConnection) return;
    const me = newState.guild.members.me;
    const channel = me?.voice?.channel;
    if (!channel) { state.ownsConnection = false; return; }
    if (oldState.channelId !== channel.id && newState.channelId !== channel.id) return;
    if (channel.members.some(m => !m.user.bot)) return;

    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
        const live = newState.guild.members.me?.voice?.channel;
        if (!live || live.members.some(m => !m.user.bot)) return scheduleIdleLeave(newState.client, guildId, state);
        if (getTranscriptionSession(guildId)) return;
        const queue = (newState.client.player || global.player)?.nodes?.get(guildId);
        if (!queue || queue.isPlaying() || queue.tracks?.size || queue.metadata?.camp) { state.ownsConnection = false; return; }
        skipReader(guildId);
        try { queue.delete(); } catch (err) { logger.debug(`[VoiceReader] Alone-leave failed: ${err.message}`); }
        state.ownsConnection = false;
    }, ALONE_LEAVE_MS);
    state.idleTimer.unref?.();
}

export default {
    handleReaderMessage, getReaderConfig, saveReaderConfig, invalidateReaderConfig, speakableText, skipReader,
    getUserVoice, setUserVoice, getUserSpokenName, setUserSpokenName, handleReaderVoiceState,
};
