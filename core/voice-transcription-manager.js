/*
 * Voice channel transcription: live captions + a finished transcript, speech-to-text on the
 * local Whisper servers (utils/whisper-stt.js). No audio is written to disk or kept anywhere —
 * each phrase is decoded in memory, transcribed, and discarded; only the text is stored.
 *
 * Consent is built in, not optional:
 *   - Only staff start a session (Manage Server, or the guild's configured starter role).
 *   - Starting posts a notice in the voice channel's own chat AND the caption channel.
 *   - Anyone joining mid-session gets the notice too (no ping).
 *   - `/voice privacy opt-out` is global and immediate: an opted-out member's packets are never
 *     decoded, in any server, including a stream that is mid-sentence when they opt out.
 *   - Transcripts are deleted after the guild's retention period (default 30 days).
 *
 * One session per guild, riding the guild's shared voice session (core/voice-connection-share.js)
 * so music and the chat reader keep working while it runs.
 */

import { AttachmentBuilder, escapeMarkdown, PermissionFlagsBits } from 'discord.js';
import { createRequire } from 'node:module';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { displayNameFor } from '../utils/display-name.js';
import { VoiceReceiver, ensureSodium } from './voice-receiver.js';
import { acquireVoice, redeafen, waitReady } from './voice-connection-share.js';
import { transcribePcm, whisperAvailable, downmixTo16kMono, rmsLevel, isFiller } from '../utils/whisper-stt.js';
import { CaptionPoster } from './voice-caption-poster.js';

const require = createRequire(import.meta.url);
const { OpusEncoder } = require('mediaplex');   // mediaplex's encoder also decodes

const CONFIG_TTL_MS = 60_000;
const MIN_PHRASE_MS = 450;          // shorter than this is a cough, a click, or "uh"
const MIN_RMS = 0.006;              // below this the clip is mic hiss, not speech
const SILENCE_END_MS = 900;         // a pause this long ends a phrase
const MAX_PHRASE_MS = 20_000;       // a monologue is still captioned in chunks as it goes
const EMPTY_STOP_MS = 60_000;       // nobody (human) left in the channel for this long → stop
const MAX_SESSION_MS = 4 * 60 * 60_000;
const DRAIN_TIMEOUT_MS = 20_000;

const DEFAULTS = {
    enabled: 1,
    caption_channel_id: null,
    live_captions: 1,
    caption_style: 'webhook',
    skip_filler: 1,
    post_transcript: 1,
    transcript_channel_id: null,
    model: 'fast',
    starter_role_id: null,
    retention_days: 30,
};

const configCache = new Map();      // guildId -> { value, expires }
const optOuts = new Set();          // userId, loaded at init and kept in step by setOptOut()
let optOutsLoaded = false;
let cleanupTimer = null;

const sessions = new Map();         // guildId -> Session

const truthy = v => v === 1 || v === true || v === '1';

export async function getTranscriptionConfig(guildId) {
    const hit = configCache.get(guildId);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = { ...DEFAULTS };
    try {
        const [rows] = await pool.execute('SELECT * FROM voice_transcription_config WHERE guild_id = ?', [guildId]);
        if (rows[0]) for (const [k, v] of Object.entries(rows[0])) if (v !== null && v !== undefined) value[k] = v;
    } catch (err) {
        logger.warn(`[Transcribe] Could not read config for ${guildId}: ${err.message}`);
    }
    configCache.set(guildId, { value, expires: Date.now() + CONFIG_TTL_MS });
    return value;
}

export function invalidateTranscriptionConfig(guildId) {
    configCache.delete(guildId);
}

async function loadOptOuts() {
    if (optOutsLoaded) return;
    try {
        const [rows] = await pool.execute('SELECT user_id FROM voice_transcription_optouts');
        for (const r of rows) optOuts.add(String(r.user_id));
        optOutsLoaded = true;
    } catch (err) {
        logger.error(`[Transcribe] Could not load opt-outs: ${err.message}`);
        throw err;   // never transcribe without knowing who refused
    }
}

export function isOptedOut(userId) {
    return optOuts.has(String(userId));
}

/** Opt a member out (or back in) everywhere. Takes effect on live sessions immediately. */
export async function setOptOut(userId, optedOut) {
    userId = String(userId);
    if (optedOut) {
        await pool.execute('INSERT IGNORE INTO voice_transcription_optouts (user_id) VALUES (?)', [userId]);
        optOuts.add(userId);
        for (const session of sessions.values()) session.dropUser(userId);
    } else {
        await pool.execute('DELETE FROM voice_transcription_optouts WHERE user_id = ?', [userId]);
        optOuts.delete(userId);
    }
}

/** May this member start/stop sessions here? */
export async function canControl(member) {
    if (!member) return false;
    if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
    const cfg = await getTranscriptionConfig(member.guild.id);
    return !!cfg.starter_role_id && member.roles?.cache?.has(String(cfg.starter_role_id));
}

function formatOffset(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return [h, m, sec].map(n => String(n).padStart(2, '0')).join(':');
}

function noticeText(channel, starter, sessionId) {
    return `🔴 **This voice channel is being transcribed** (session #${sessionId}). ${escapeMarkdown(displayNameFor(starter))} started live captions for ${channel}. `
        + 'What you say here is turned into text and posted to the server. Audio is not recorded or kept.\n'
        + 'Don\'t want to be included? Use `/voice privacy opt-out` — it applies immediately, in every server.';
}

class Session {
    constructor({ client, channel, connection, created, config, captionChannel, transcriptChannel, starter, rowId }) {
        this.client = client;
        this.guild = channel.guild;
        this.channel = channel;
        this.connection = connection;
        this.createdConnection = created;
        this.config = config;
        this.captionChannel = captionChannel;
        this.transcriptChannel = transcriptChannel;
        this.starter = starter;
        this.rowId = rowId;
        this.startedAt = Date.now();
        this.segments = [];                     // { offsetMs, name, text }
        this.pending = new Set();               // in-flight transcriptions
        this.captions = truthy(config.live_captions) && captionChannel
            ? new CaptionPoster({ channel: captionChannel, client, style: config.caption_style })
            : null;
        this.notified = new Set([starter.id]);
        this.emptySince = null;
        this.stopping = false;

        this.receiver = new VoiceReceiver(connection);
        this.receiver.on('unsubscribedAudio', userId => this.onSpeakingStart(userId));
        // Pipeline counters, so "captions aren't appearing" can be traced to the stage that stops.
        this.phraseStats = { phrases: 0, tooShort: 0, tooQuiet: 0, transcribed: 0, empty: 0, failed: 0, undecodable: 0 };
        this.maxTimer = setTimeout(() => stopSession(this.guild.id, 'time_limit'), MAX_SESSION_MS);
        this.healthTimer = setTimeout(() => this.healthCheck(), 30_000);
    }

    /** One line describing where audio stops, for /voice transcribe status and the logs. */
    diagnostics() {
        const r = this.receiver.stats, p = this.phraseStats;
        return `udp ${r.udpPackets}, opus ${r.opusPackets}, unmapped ${r.unmappedPackets}, mapped ${r.mappedPackets}, `
            + `decrypted ${r.pushedPackets}, decrypt-fail ${this.receiver.decryptFailures}, speakers known ${this.receiver.tracker.map.size} · `
            + `phrases ${p.phrases} (short ${p.tooShort}, quiet ${p.tooQuiet}, undecodable frames ${p.undecodable}), `
            + `transcribed ${p.transcribed}, empty ${p.empty}, failed ${p.failed}`;
    }

    /** Thirty seconds in, say plainly in the log if audio is not making it through. */
    healthCheck() {
        if (this.stopping) return;
        const r = this.receiver.stats;
        const humans = this.humansInChannel().size;
        let problem = null;
        if (r.udpPackets === 0) problem = 'no voice packets at all (bot deafened, or not really connected?)';
        else if (r.mappedPackets === 0 && r.unmappedPackets > 0) problem = 'packets arrive but no speaker is identified (SSRC announcements missed)';
        else if (r.mappedPackets > 0 && r.pushedPackets === 0) problem = 'packets identified but none decrypt (transport/DAVE)';
        if (problem && humans > 0) logger.warn(`[Transcribe] Session ${this.rowId} in ${this.guild.id}: ${problem} — ${this.diagnostics()}`);
        else logger.info(`[Transcribe] Session ${this.rowId} health: ${this.diagnostics()}`);
    }

    humansInChannel() {
        const live = this.guild.channels.cache.get(this.channel.id) ?? this.channel;
        return live.members?.filter(m => !m.user.bot) ?? new Map();
    }

    dropUser(userId) {
        const stream = this.receiver.subscriptions.get(userId);
        if (stream) {
            stream.optedOut = true;
            stream.destroy();
        }
    }

    onSpeakingStart(userId) {
        if (this.stopping || isOptedOut(userId) || this.receiver.isSubscribed(userId)) return;
        const member = this.guild.members.cache.get(userId);
        if (!member || member.user.bot) return;                   // other bots are music, not people
        if (member.voice?.channelId !== this.channel.id) return;

        const startedAt = Date.now();
        const stream = this.receiver.subscribe(userId, { silenceMs: SILENCE_END_MS, maxMs: MAX_PHRASE_MS });
        const decoder = new OpusEncoder(48000, 2);
        const chunks = [];
        let decodeErrors = 0;

        stream.on('data', packet => {
            if (stream.optedOut || isOptedOut(userId)) return;
            try { chunks.push(decoder.decode(packet)); }
            catch { decodeErrors++; this.phraseStats.undecodable++; }   // one corrupt frame is not the sentence
        });
        stream.once('end', () => {
            if (stream.optedOut || isOptedOut(userId) || !chunks.length) return;
            const job = this.transcribePhrase(member, startedAt, Buffer.concat(chunks))
                .catch(err => { this.phraseStats.failed++; logger.warn(`[Transcribe] Phrase failed in ${this.guild.id}: ${err.message}`); })
                .finally(() => this.pending.delete(job));
            this.pending.add(job);
            if (decodeErrors > 5) logger.debug(`[Transcribe] ${decodeErrors} undecodable frames from ${userId}`);
        });
        stream.once('error', err => logger.debug(`[Transcribe] Stream error for ${userId}: ${err.message}`));
    }

    async transcribePhrase(member, startedAt, pcm48kStereo) {
        this.phraseStats.phrases++;
        const durationMs = Math.round((pcm48kStereo.length / 4 / 48000) * 1000);
        if (durationMs < MIN_PHRASE_MS) { this.phraseStats.tooShort++; return; }
        const mono = downmixTo16kMono(pcm48kStereo);
        if (rmsLevel(mono) < MIN_RMS) { this.phraseStats.tooQuiet++; return; }

        const text = await transcribePcm(mono, this.config.model);
        if (!text) { this.phraseStats.empty++; return; }
        if (isOptedOut(member.id)) return;
        this.phraseStats.transcribed++;

        const name = displayNameFor(member);
        const offsetMs = Math.max(0, startedAt - this.startedAt);
        this.segments.push({ offsetMs, name, text });

        pool.execute(
            'INSERT INTO voice_transcription_segments (session_id, user_id, display_name, offset_ms, duration_ms, text) VALUES (?, ?, ?, ?, ?, ?)',
            [this.rowId, member.id, name.slice(0, 100), offsetMs, durationMs, text]
        ).catch(err => logger.warn(`[Transcribe] Could not store segment: ${err.message}`));

        // Filler ("mm-hmm", "yeah") stays in the transcript but not in the live channel — it is most
        // of what a conversation produces and all of what makes captions unreadable.
        if (this.captions && !(truthy(this.config.skip_filler) && isFiller(text))) {
            this.captions.add({ name, avatarURL: member.displayAvatarURL({ size: 128 }), text });
        }
    }

    async noticeJoin(member) {
        if (this.notified.has(member.id) || member.user.bot) return;
        this.notified.add(member.id);
        const optedOut = isOptedOut(member.id);
        const text = optedOut
            ? `ℹ️ ${escapeMarkdown(displayNameFor(member))}, this channel is being transcribed — you've opted out, so you won't be included.`
            : `🔴 ${escapeMarkdown(displayNameFor(member))}, this voice channel is being transcribed. Use \`/voice privacy opt-out\` if you don't want to be included.`;
        await this.channel.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
    }

    buildTranscript(reason) {
        const lines = [
            `Voice transcript — #${this.channel.name} in ${this.guild.name} (session #${this.rowId})`,
            `Started ${new Date(this.startedAt).toISOString()} by ${displayNameFor(this.starter)}`,
            `Ended ${new Date().toISOString()} (${reason})`,
            'Speech-to-text by Whisper; errors are likely with names, slang and crosstalk.',
            '',
        ];
        const ordered = [...this.segments].sort((a, b) => a.offsetMs - b.offsetMs);
        for (const s of ordered) lines.push(`[${formatOffset(s.offsetMs)}] ${s.name}: ${s.text}`);
        if (!ordered.length) lines.push('(nothing was transcribed)');
        return lines.join('\n');
    }

    async stop(reason) {
        if (this.stopping) return;
        this.stopping = true;
        clearTimeout(this.maxTimer);
        clearTimeout(this.healthTimer);

        // Finish every open phrase so the last thing said still makes the transcript.
        for (const stream of this.receiver.subscriptions.values()) stream.finish?.();
        await new Promise(r => setTimeout(r, 200));
        await Promise.race([
            Promise.allSettled([...this.pending]),
            new Promise(r => setTimeout(r, DRAIN_TIMEOUT_MS)),
        ]);
        this.receiver.destroy();
        await this.captions?.close();

        await pool.execute(
            'UPDATE voice_transcription_sessions SET ended_at = NOW(), end_reason = ?, segment_count = ? WHERE id = ?',
            [reason, this.segments.length, this.rowId]
        ).catch(err => logger.warn(`[Transcribe] Could not close session row: ${err.message}`));

        const minutes = Math.max(1, Math.round((Date.now() - this.startedAt) / 60000));
        const summary = `⏹️ Transcription of ${this.channel} ended (session #${this.rowId}, ${reason.replace('_', ' ')}) after ${minutes} min — ${this.segments.length} phrase${this.segments.length === 1 ? '' : 's'}.`;
        const target = this.transcriptChannel || this.captionChannel;
        if (target) {
            const payload = { content: summary, allowedMentions: { parse: [] } };
            if (truthy(this.config.post_transcript) && this.segments.length) {
                const stamp = new Date(this.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-');
                payload.files = [new AttachmentBuilder(Buffer.from(this.buildTranscript(reason), 'utf8'), {
                    name: `transcript-${this.channel.name.replace(/[^a-z0-9-]+/gi, '-')}-${stamp}.txt`,
                })];
            }
            await target.send(payload).catch(err => logger.warn(`[Transcribe] Transcript post failed: ${err.message}`));
        }
        await this.channel.send({ content: '⏹️ Transcription has stopped in this channel.', allowedMentions: { parse: [] } }).catch(() => {});

        // Stop listening. Leave unless something else still needs the voice session (music, camp, a
        // recording, the chat reader, 24/7 — core/music-leave-policy.js decides); otherwise hand it back
        // deafened so they carry on untouched. A running recording needs the bot to keep hearing.
        const player = this.client.player || global.player;
        const queue = player?.nodes?.get(this.guild.id);
        let left = false;
        if (queue) {
            try {
                const { leaveIfIdle } = await import('./music-leave-policy.js');
                left = await leaveIfIdle(queue, { reason: 'transcription ended', player });
            } catch (err) {
                logger.warn(`[Transcribe] Leave check failed in ${this.guild.id}: ${err.message}`);
            }
        }
        if (!left) {
            const { isRecording } = await import('./voice-recorder.js');
            if (!isRecording(this.guild.id)) redeafen(this.connection);
        }
        logger.info(`[Transcribe] Session ${this.rowId} ended in ${this.guild.id}: ${reason}, ${this.segments.length} segments — ${this.diagnostics()}`);
    }
}

/**
 * Start transcribing `channel`.
 * @returns {Promise<Session>}
 * @throws Error with a user-presentable message
 */
export async function startSession({ client, channel, starter, captionChannel = null }) {
    const guildId = channel.guild.id;
    if (sessions.has(guildId)) {
        const s = sessions.get(guildId);
        throw new Error(`Already transcribing ${s.channel} — stop that first.`);
    }

    const config = await getTranscriptionConfig(guildId);
    if (!truthy(config.enabled)) throw new Error('Transcription is turned off for this server on the dashboard.');

    const me = channel.guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (!perms?.has(PermissionFlagsBits.Connect)) throw new Error(`I don't have permission to join ${channel}.`);

    const model = config.model === 'accurate' ? 'accurate' : 'fast';
    const captionStyle = config.caption_style === 'compact' ? 'compact' : 'webhook';
    if (!(await whisperAvailable(model))) {
        throw new Error('The speech-to-text service is offline right now. Try again shortly.');
    }
    await loadOptOuts();
    await ensureSodium();

    const resolve = id => (id ? channel.guild.channels.cache.get(String(id)) ?? null : null);
    const captions = resolve(config.caption_channel_id) ?? captionChannel;
    const transcripts = resolve(config.transcript_channel_id);
    if (truthy(config.live_captions) && !captions?.isTextBased?.()) {
        throw new Error('No caption channel is set. Pick one on the dashboard or run the command from the channel captions should go to.');
    }

    // A recording holds the voice session: transcribe alongside it in that channel, never drag it elsewhere.
    const { getRecording } = await import('./voice-recorder.js');
    const recording = getRecording(guildId);
    if (recording && !recording.stopping && recording.channel?.id && recording.channel.id !== channel.id) {
        throw new Error(`A voice recording is running in ${recording.channel} — transcribe there, or stop the recording first.`);
    }

    const { connection, created } = await acquireVoice(client, channel, { selfDeaf: false, allowMove: true });

    const [res] = await pool.execute(
        'INSERT INTO voice_transcription_sessions (guild_id, voice_channel_id, starter_user_id) VALUES (?, ?, ?)',
        [guildId, channel.id, starter.id]
    );

    const session = new Session({
        client, channel, connection, created, config: { ...config, model, caption_style: captionStyle },
        captionChannel: captions, transcriptChannel: transcripts, starter, rowId: res.insertId,
    });
    sessions.set(guildId, session);

    if (session.receiver.needsFreshNetworking) {
        // This connection's speaker announcements happened before anything was tracking them.
        // A fresh voice session makes Discord announce everyone again (a sub-second audio blip).
        logger.info(`[Transcribe] Refreshing voice networking in ${guildId} so speakers are re-announced`);
        connection.configureNetworking();
        await waitReady(connection).catch(err => logger.warn(`[Transcribe] Voice refresh did not settle: ${err.message}`));
    }

    const notice = noticeText(channel, starter, res.insertId);
    await channel.send({ content: notice, allowedMentions: { parse: [] } }).catch(() => {});
    if (captions && captions.id !== channel.id) {
        await captions.send({ content: notice, allowedMentions: { parse: [] } }).catch(() => {});
    }

    logger.info(`[Transcribe] Session ${res.insertId} started in ${guildId} #${channel.name} by ${starter.id} (model ${model})`);
    return session;
}

export async function stopSession(guildId, reason = 'stopped') {
    const session = sessions.get(guildId);
    if (!session) return false;
    sessions.delete(guildId);
    try {
        await session.stop(reason);
    } catch (err) {
        logger.error(`[Transcribe] Error stopping session in ${guildId}: ${err.message}`, { stack: err.stack });
    }
    return true;
}

export function getSession(guildId) {
    return sessions.get(guildId) ?? null;
}

/**
 * voiceStateUpdate hook: join notices, auto-stop when the bot is pulled out or the room empties,
 * and keep the bot undeafened if something else (music, camp) re-deafened it mid-session.
 */
export async function handleVoiceStateUpdate(oldState, newState) {
    const guildId = newState.guild?.id;
    const session = guildId && sessions.get(guildId);
    if (!session || session.stopping) return;
    const botId = newState.client.user?.id;

    if (newState.id === botId) {
        if (!newState.channelId || newState.channelId !== session.channel.id) {
            return stopSession(guildId, 'bot_moved');
        }
        if (newState.selfDeaf) {
            try { session.connection.rejoin({ channelId: session.channel.id, selfDeaf: false, selfMute: false }); } catch {}
        }
        return;
    }

    if (newState.channelId === session.channel.id && oldState.channelId !== session.channel.id && newState.member) {
        session.noticeJoin(newState.member);
    }
    if (oldState.channelId === session.channel.id && newState.channelId !== session.channel.id) {
        session.receiver.subscriptions.get(newState.id)?.finish();
    }

    const humans = session.humansInChannel().size;
    if (humans === 0 && !session.emptySince) {
        session.emptySince = Date.now();
        setTimeout(() => {
            const s = sessions.get(guildId);
            if (s === session && s.emptySince && s.humansInChannel().size === 0) stopSession(guildId, 'channel_empty');
        }, EMPTY_STOP_MS);
    } else if (humans > 0) {
        session.emptySince = null;
    }
}

/** Delete transcripts past each guild's retention period. */
async function purgeExpired() {
    try {
        const [res] = await pool.execute(`
            DELETE seg FROM voice_transcription_segments seg
            JOIN voice_transcription_sessions s ON s.id = seg.session_id
            LEFT JOIN voice_transcription_config c ON c.guild_id = s.guild_id
            WHERE s.started_at < NOW() - INTERVAL COALESCE(c.retention_days, 30) DAY`);
        const [res2] = await pool.execute(`
            DELETE s FROM voice_transcription_sessions s
            LEFT JOIN voice_transcription_config c ON c.guild_id = s.guild_id
            WHERE s.ended_at IS NOT NULL AND s.started_at < NOW() - INTERVAL COALESCE(c.retention_days, 30) DAY`);
        if (res.affectedRows || res2.affectedRows) {
            logger.info(`[Transcribe] Retention purge removed ${res.affectedRows} segments, ${res2.affectedRows} sessions`);
        }
    } catch (err) {
        logger.warn(`[Transcribe] Retention purge failed: ${err.message}`);
    }
}

/** Once per process: opt-outs, orphaned sessions from a restart, the retention sweep. */
export async function initTranscription() {
    if (cleanupTimer) return;
    await loadOptOuts().catch(() => {});
    // A restart kills every live session without running stop(); close their rows honestly.
    await pool.execute("UPDATE voice_transcription_sessions SET ended_at = NOW(), end_reason = 'restart' WHERE ended_at IS NULL")
        .catch(err => logger.warn(`[Transcribe] Could not close orphaned sessions: ${err.message}`));
    await purgeExpired();
    cleanupTimer = setInterval(purgeExpired, 60 * 60_000);
    cleanupTimer.unref?.();
}

export default {
    startSession, stopSession, getSession, setOptOut, isOptedOut, canControl,
    getTranscriptionConfig, invalidateTranscriptionConfig, handleVoiceStateUpdate, initTranscription,
};
