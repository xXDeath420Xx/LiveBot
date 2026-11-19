/*
 * Voice channel recording (/music record). One mixed audio file per recording, posted to Discord.
 *
 * Consent and safety are built in, not optional:
 *   - Impossible unless a server admin switched it on (record_config.is_enabled, migration 292).
 *   - Only Manage Server or the server's allowed roles may start one, and only for the voice channel
 *     they are IN — never a channel they aren't listening to themselves.
 *   - Starting posts a consent notice in the voice channel's own chat and the command channel; anyone
 *     who joins mid-recording gets the notice too (no ping). The bot's nickname becomes "🔴 REC · …"
 *     for as long as it records, so the member list shows it.
 *   - Members who used `/voice privacy opt-out` (the transcription opt-out) are never recorded.
 *   - Every recording has a hard length cap (server setting, default 30 min) that also keeps the file
 *     under the server's Discord upload limit; it stops by itself when the channel empties.
 *   - The audio is not kept: the file is deleted once posted. One that could not be posted stays on
 *     disk for 7 days (and the admins are told), then the sweep removes it.
 *   - voice_recordings logs who recorded what, when and for how long.
 *
 * Capture rides the guild's shared voice session (core/voice-connection-share.js) through the
 * receive-side glue in core/voice-receiver.js — the same path transcription uses, so music, voice camp
 * and transcription keep working. Audio is decoded per speaker (mediaplex) and mixed onto one timeline
 * (core/voice-recording-mixer.js) that streams into ffmpeg → mono Opus/Ogg 32 kbit/s.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { AttachmentBuilder, PermissionFlagsBits, escapeMarkdown } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { displayNameFor } from '../utils/display-name.js';
import { VoiceReceiver, ensureSodium, SILENCE_FRAME } from './voice-receiver.js';
import { acquireVoice, redeafen, waitReady } from './voice-connection-share.js';
import { isOptedOut, getSession as getTranscriptionSession } from './voice-transcription-manager.js';
import { holdVoice, releaseVoice as releaseVoiceHold, leaveIfIdle } from './music-leave-policy.js';
import {
    TimelineMixer, SpeakerClock, SAMPLES_PER_MS, OPUS_BITRATE, effectiveMaxMinutes, uploadLimitBytes,
    parseRoleList, recordingFileName, recordingNickname, consentNotice, formatDuration,
} from './voice-recording-mixer.js';

const require = createRequire(import.meta.url);
const { OpusEncoder } = require('mediaplex');   // mediaplex's encoder also decodes

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(__dirname, '..', 'data', 'recordings');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

const FLUSH_INTERVAL_MS = 250;
const WATCH_INTERVAL_MS = 2000;
const EMPTY_STOP_MS = 60_000;
const START_GRACE_MS = 10_000;            // voice state settles after connecting
const ENCODER_EXIT_TIMEOUT_MS = 15_000;
const UNDELIVERED_KEEP_DAYS = 7;
const NICK_PREFIX = '🔴 REC · ';

const sessions = new Map();               // guildId -> RecordingSession
const starting = new Set();               // guildIds with a start in progress (two /music record at once)
const ownRowIds = new Set();              // voice_recordings rows started by this process
let sweepTimer = null;

const truthy = v => v === 1 || v === true || v === '1';

// ── configuration & permissions ─────────────────────────────────────────────

export async function getRecordConfig(guildId) {
    const [rows] = await pool.execute(
        'SELECT is_enabled, allowed_role_ids, output_channel_id, max_minutes FROM record_config WHERE guild_id = ?', [guildId]);
    const row = rows[0] || {};
    return {
        enabled: truthy(row.is_enabled),
        allowedRoleIds: parseRoleList(row.allowed_role_ids),
        outputChannelId: row.output_channel_id ? String(row.output_channel_id) : null,
        maxMinutes: Number(row.max_minutes) > 0 ? Number(row.max_minutes) : null,
    };
}

/** Partial update of record_config (keys: is_enabled, allowed_role_ids (array), output_channel_id, max_minutes). */
export async function updateRecordConfig(guildId, changes) {
    const current = await getRecordConfig(guildId);
    const next = {
        is_enabled: 'is_enabled' in changes ? (changes.is_enabled ? 1 : 0) : (current.enabled ? 1 : 0),
        allowed_role_ids: JSON.stringify('allowed_role_ids' in changes ? changes.allowed_role_ids : current.allowedRoleIds),
        output_channel_id: 'output_channel_id' in changes ? changes.output_channel_id : current.outputChannelId,
        max_minutes: 'max_minutes' in changes ? changes.max_minutes : current.maxMinutes,
    };
    await pool.execute(
        `INSERT INTO record_config (guild_id, is_enabled, allowed_role_ids, output_channel_id, max_minutes)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled), allowed_role_ids = VALUES(allowed_role_ids),
             output_channel_id = VALUES(output_channel_id), max_minutes = VALUES(max_minutes)`,
        [guildId, next.is_enabled, next.allowed_role_ids, next.output_channel_id, next.max_minutes]);
    return getRecordConfig(guildId);
}

/** May this member start/stop recordings? (Manage Server, or one of the allowed roles.) */
export function mayRecord(member, config) {
    if (!member) return false;
    if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
    return config.allowedRoleIds.some(id => member.roles?.cache?.has(id));
}

export function getRecording(guildId) {
    return sessions.get(guildId) ?? null;
}

export function isRecording(guildId) {
    const s = sessions.get(guildId);
    return !!s && !s.stopping;
}

async function loadOptOuts() {
    const [rows] = await pool.execute('SELECT user_id FROM voice_transcription_optouts');
    return new Set(rows.map(r => String(r.user_id)));
}

function canPost(channel) {
    if (!channel?.isTextBased?.()) return false;
    const me = channel.guild?.members?.me;
    const perms = me ? channel.permissionsFor(me) : null;
    return !!perms?.has(PermissionFlagsBits.ViewChannel) && !!perms.has(PermissionFlagsBits.SendMessages)
        && !!perms.has(PermissionFlagsBits.AttachFiles);
}

async function setRecNick(guild) {
    const me = guild.members.me;
    if (!me) return { changed: false, original: null };
    const perms = me.permissions;
    if (!perms?.has(PermissionFlagsBits.ChangeNickname) && !perms?.has(PermissionFlagsBits.ManageNicknames)) {
        return { changed: false, original: null };
    }
    const original = me.nickname ?? null;
    try {
        await me.setNickname(recordingNickname(me.displayName), 'Voice recording in progress');
        return { changed: true, original };
    } catch (err) {
        logger.debug(`[Recorder] could not set REC nickname in ${guild.id}: ${err.message}`);
        return { changed: false, original: null };
    }
}

async function restoreNick(guild, original) {
    const me = guild?.members?.me;
    if (!me?.nickname?.startsWith(NICK_PREFIX)) return true;   // someone already changed it back
    try {
        await me.setNickname(original || null, 'Voice recording ended');
        return true;
    } catch (err) {
        logger.warn(`[Recorder] could not restore nickname in ${guild.id}: ${err.message}`);
        return false;
    }
}

// ── the recording session ───────────────────────────────────────────────────

class RecordingSession {
    constructor({ client, channel, connection, created, starter, textChannel, outputChannel, maxMinutes, limitBytes, rowId, filePath, optOuts }) {
        this.client = client;
        this.guild = channel.guild;
        this.channel = channel;
        this.connection = connection;
        this.created = created;
        this.starter = starter;
        this.textChannel = textChannel;
        this.outputChannel = outputChannel;
        this.maxMinutes = maxMinutes;
        this.limitBytes = limitBytes;
        this.rowId = rowId;
        this.filePath = filePath;
        this.optOuts = optOuts;
        this.startedAt = Date.now();
        this.stopping = false;
        this.stopPromise = null;
        this.speakers = new Set();
        this.decoders = new Map();
        this.clocks = new Map();
        this.notified = new Set([starter.id]);
        this.emptySince = null;
        this.warned = false;
        this.nick = { changed: false, original: null };
        this.stats = { undecodable: 0, encoderBackpressure: 0 };
        this.encoderError = null;
    }

    nowSample() {
        return Math.round((Date.now() - this.startedAt) * SAMPLES_PER_MS);
    }

    startEncoder() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        // -fs: ffmpeg itself refuses to grow the file past the upload limit, whatever the timers do.
        this.ff = spawn(FFMPEG, [
            '-hide_banner', '-loglevel', 'error',
            '-f', 's16le', '-ar', '48000', '-ac', '1', '-i', 'pipe:0',
            '-c:a', 'libopus', '-b:a', `${OPUS_BITRATE / 1000}k`, '-application', 'voip',
            '-fs', String(Math.max(1024 * 1024, this.limitBytes - 256 * 1024)),
            '-metadata', `title=Recording of #${this.channel.name}`,
            '-metadata', `comment=Recorded in ${this.guild.name} starting ${new Date(this.startedAt).toISOString()}`,
            '-y', this.filePath,
        ], { stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        this.ff.stderr.on('data', d => { if (stderr.length < 2000) stderr += d; });
        this.ffExit = new Promise(resolve => {
            this.ff.once('exit', (code, signal) => {
                this.ffExited = true;
                if (code && code !== 0) logger.warn(`[Recorder] ffmpeg exited ${code}${signal ? ` (${signal})` : ''} in ${this.guild.id}: ${stderr.trim().slice(0, 500)}`);
                resolve(code);
                if (!this.stopping) this.stop(code === 0 ? 'size_limit' : 'encoder_error').catch(() => {});
            });
        });
        this.ff.once('error', err => {
            this.encoderError = err;
            logger.error(`[Recorder] ffmpeg failed to start in ${this.guild.id}: ${err.message}`);
            if (!this.stopping) this.stop('encoder_error').catch(() => {});
        });
        this.ff.stdin.on('error', err => {
            if (!this.stopping) logger.warn(`[Recorder] encoder input closed in ${this.guild.id}: ${err.message}`);
        });
        this.mixer = new TimelineMixer({
            write: (buf) => {
                if (this.ffExited || this.ff.stdin.destroyed || this.ff.stdin.writableEnded) return;
                if (!this.ff.stdin.write(buf)) this.stats.encoderBackpressure++;
            },
        });
    }

    async start() {
        this.startEncoder();
        this.receiver = new VoiceReceiver(this.connection);
        this.receiver.on('unsubscribedAudio', userId => this.onSpeaking(userId));
        if (this.receiver.needsFreshNetworking) {
            // Speaker announcements on this connection happened before anything tracked them.
            logger.info(`[Recorder] refreshing voice networking in ${this.guild.id} so speakers are re-announced`);
            this.connection.configureNetworking();
            await waitReady(this.connection).catch(err => logger.warn(`[Recorder] voice refresh did not settle: ${err.message}`));
        }
        this.flushTimer = setInterval(() => this.mixer.flushRealtime(this.nowSample()), FLUSH_INTERVAL_MS);
        this.watchTimer = setInterval(() => this.watch().catch(err => logger.warn(`[Recorder] watchdog: ${err.message}`)), WATCH_INTERVAL_MS);
        this.onVoiceState = (oldState, newState) => this.voiceStateChanged(oldState, newState);
        this.client.on('voiceStateUpdate', this.onVoiceState);
        this.nick = await setRecNick(this.guild);
        if (this.nick.changed) {
            await pool.execute('UPDATE voice_recordings SET nick_changed = 1, original_nick = ? WHERE id = ?', [this.nick.original, this.rowId])
                .catch(err => logger.warn(`[Recorder] could not note the nickname change: ${err.message}`));
        }
    }

    onSpeaking(userId) {
        if (this.stopping || this.receiver.isSubscribed(userId)) return;
        if (this.optOuts.has(userId) || isOptedOut(userId)) return;
        const member = this.guild.members.cache.get(userId);
        if (!member || member.user.bot) return;
        if (member.voice?.channelId !== this.channel.id) return;

        this.speakers.add(userId);
        let decoder = this.decoders.get(userId);
        if (!decoder) { decoder = new OpusEncoder(48000, 2); this.decoders.set(userId, decoder); }
        let clock = this.clocks.get(userId);
        if (!clock) { clock = new SpeakerClock(); this.clocks.set(userId, clock); }

        const stream = this.receiver.subscribe(userId, { silenceMs: 1000, maxMs: 0 });
        stream.on('data', packet => {
            if (this.stopping) return;
            if (isOptedOut(userId)) { stream.destroy(); return; }
            const now = this.nowSample();
            if (packet.equals(SILENCE_FRAME)) { clock.advance(now, 960); return; }
            let pcm;
            try { pcm = decoder.decode(packet); } catch { this.stats.undecodable++; return; }
            if (!pcm?.length) return;
            this.mixer.addStereo(clock.place(now, Math.floor(pcm.length / 4)), pcm);
        });
        stream.once('error', err => logger.debug(`[Recorder] stream error for ${userId}: ${err.message}`));
    }

    humans() {
        const live = this.guild.channels.cache.get(this.channel.id) ?? this.channel;
        return live.members?.filter(m => !m.user.bot) ?? new Map();
    }

    async watch() {
        if (this.stopping) return;
        const elapsed = Date.now() - this.startedAt;
        const maxMs = this.maxMinutes * 60_000;
        if (elapsed >= maxMs) return void this.stop('time_limit');
        if (!this.warned && maxMs - elapsed <= 60_000 && maxMs >= 3 * 60_000) {
            this.warned = true;
            this.channel.send({ content: '⏳ The recording stops automatically in 1 minute (length limit).', allowedMentions: { parse: [] } }).catch(() => {});
        }
        if (this.connection.state?.status === 'destroyed') return void this.stop('disconnected');
        if (elapsed > START_GRACE_MS && this.guild.members.me?.voice?.channelId !== this.channel.id) return void this.stop('bot_moved');
        // Something (music, camp, a transcription ending) re-deafened the bot: a deaf client hears nothing.
        if (this.connection.joinConfig?.selfDeaf) {
            try { this.connection.rejoin({ channelId: this.channel.id, selfDeaf: false, selfMute: false }); } catch { /* next tick */ }
        }
        if (this.humans().size === 0) {
            this.emptySince ??= Date.now();
            if (Date.now() - this.emptySince >= EMPTY_STOP_MS) return void this.stop('channel_empty');
        } else {
            this.emptySince = null;
        }
    }

    voiceStateChanged(oldState, newState) {
        if (this.stopping || newState.guild?.id !== this.guild.id) return;
        const member = newState.member;
        if (!member || member.user?.bot) return;
        if (newState.channelId === this.channel.id && oldState.channelId !== this.channel.id && !this.notified.has(member.id)) {
            this.notified.add(member.id);
            const name = escapeMarkdown(displayNameFor(member));
            const text = (this.optOuts.has(member.id) || isOptedOut(member.id))
                ? `ℹ️ ${name}, this channel is being recorded — you've opted out, so you won't be in it.`
                : `🔴 ${name}, this voice channel is being **recorded**. Leave if you don't want to be in it, or use \`/voice privacy opt-out\`.`;
            this.channel.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
        }
        if (oldState.channelId === this.channel.id && newState.channelId !== this.channel.id) {
            this.receiver?.subscriptions.get(member.id)?.finish?.();
        }
    }

    /** Stop capturing and close the file. Returns once the file is complete. */
    async finishCapture() {
        clearInterval(this.flushTimer);
        clearInterval(this.watchTimer);
        if (this.onVoiceState) this.client.off('voiceStateUpdate', this.onVoiceState);
        for (const stream of this.receiver?.subscriptions.values() || []) stream.finish?.();
        await new Promise(r => setTimeout(r, 100));
        try { this.mixer.finish(this.nowSample()); } catch (err) { logger.warn(`[Recorder] final mix failed: ${err.message}`); }
        this.receiver?.destroy();
        if (this.ff && this.ffExit && !this.ffExited && !this.encoderError) {
            try { this.ff.stdin.end(); } catch { /* already closed */ }
            let timer;
            const finished = await Promise.race([
                this.ffExit.then(() => true),
                new Promise(r => { timer = setTimeout(() => r(false), ENCODER_EXIT_TIMEOUT_MS); }),
            ]);
            clearTimeout(timer);
            if (!finished) {
                logger.warn(`[Recorder] ffmpeg did not finish in ${ENCODER_EXIT_TIMEOUT_MS / 1000}s in ${this.guild.id} — killing it`);
                try { this.ff.kill('SIGKILL'); } catch { /* gone */ }
            }
        }
    }

    /**
     * Hand the voice connection back: drop the recording's hold on it, re-deafen, and — when nothing
     * else needs it — leave right away by the music leave policy's rules (it stays for music that is
     * playing, 24/7, voice camp, a transcription or the chat reader).
     */
    async releaseConnection() {
        releaseVoiceHold(this.guild.id, 'recording');
        const transcribing = getTranscriptionSession(this.guild.id);
        if (transcribing && !transcribing.stopping) return;   // transcription still needs to hear
        redeafen(this.connection);
        const player = this.client.player || global.player;
        const queue = player?.nodes?.get(this.guild.id);
        if (queue) {
            await leaveIfIdle(queue, { reason: 'recording ended', player })
                .catch(err => logger.warn(`[Recorder] leave check after recording in ${this.guild.id} failed: ${err.message}`));
        }
    }

    async stop(reason, stoppedBy = null) {
        if (this.stopPromise) return this.stopPromise;
        this.stopping = true;
        this.stopPromise = this.doStop(reason, stoppedBy);
        return this.stopPromise;
    }

    async doStop(reason, stoppedBy) {
        sessions.delete(this.guild.id);
        await this.finishCapture();
        const durationMs = this.mixer?.writtenMs ?? (Date.now() - this.startedAt);
        if (this.nick.changed) {
            const restored = await restoreNick(this.guild, this.nick.original);
            if (restored) await pool.execute('UPDATE voice_recordings SET nick_changed = 0 WHERE id = ?', [this.rowId]).catch(() => {});
        }
        await this.releaseConnection();

        let size = 0;
        try { size = fs.statSync(this.filePath).size; } catch { size = 0; }
        const result = await deliver({
            guild: this.guild, filePath: this.filePath, size, limitBytes: this.limitBytes,
            targets: [this.outputChannel, this.textChannel],
            fileName: recordingFileName(this.channel.name, this.startedAt),
            content: `🎙️ Recording of ${this.channel} — ${formatDuration(durationMs)}, ${this.speakers.size} speaker${this.speakers.size === 1 ? '' : 's'}, `
                + `started by ${escapeMarkdown(displayNameFor(this.starter))} (${reasonText(reason)}).`,
            hadSpeech: this.speakers.size > 0,
        });

        await pool.execute(
            `UPDATE voice_recordings SET ended_at = NOW(), end_reason = ?, stopped_by = ?, duration_sec = ?, speaker_count = ?,
                 file_bytes = ?, delivered = ?, message_id = ?, file_path = ? WHERE id = ?`,
            [reason, stoppedBy, Math.round(durationMs / 1000), this.speakers.size, size || null, result.delivered ? 1 : 0,
                result.messageId, result.keptPath, this.rowId]
        ).catch(err => logger.warn(`[Recorder] could not close recording row ${this.rowId}: ${err.message}`));
        ownRowIds.delete(this.rowId);

        const tail = result.delivered ? ` The file was posted in ${result.channel}.`
            : result.keptPath ? ' The file could not be posted; a server admin has been told where it is kept (deleted after 7 days).'
            : this.speakers.size ? '' : ' Nobody spoke, so there is no file.';
        await this.channel.send({ content: `⏹️ Recording stopped (${reasonText(reason)}) after ${formatDuration(durationMs)}.${tail}`, allowedMentions: { parse: [] } }).catch(() => {});
        if (!result.delivered && result.keptPath) {
            await this.textChannel?.send({
                content: `⚠️ The recording of ${this.channel} (${formatDuration(durationMs)}) could not be uploaded here (${result.error || 'upload failed'}). `
                    + `It is kept on the bot's server as \`${path.basename(result.keptPath)}\` for ${UNDELIVERED_KEEP_DAYS} days — the bot owner can retrieve it.`,
                allowedMentions: { parse: [] },
            }).catch(() => {});
        }
        logger.info(`[Recorder] recording ${this.rowId} in ${this.guild.id} ended (${reason}) after ${Math.round(durationMs / 1000)}s, `
            + `${this.speakers.size} speakers, ${size} bytes, delivered=${result.delivered}, undecodable=${this.stats.undecodable}, late=${this.mixer?.droppedLate ?? 0}`);
        return { durationMs, delivered: result.delivered, speakers: this.speakers.size };
    }
}

function reasonText(reason) {
    return {
        stopped: 'stopped by command', time_limit: 'length limit reached', size_limit: 'upload size limit reached',
        channel_empty: 'everyone left', bot_moved: 'the bot was moved or disconnected', disconnected: 'voice connection lost',
        encoder_error: 'the audio encoder failed', restart: 'the bot restarted',
    }[reason] || reason;
}

/**
 * Post the file to the first channel that accepts it; delete it once posted. A file that could not be
 * posted is kept (its path returned) for the sweep to remove after UNDELIVERED_KEEP_DAYS.
 */
async function deliver({ guild, filePath, size, limitBytes, targets, fileName, content, hadSpeech }) {
    const out = { delivered: false, messageId: null, channel: null, keptPath: null, error: null };
    if (!size || !hadSpeech) {
        fs.promises.unlink(filePath).catch(() => {});
        return out;
    }
    if (size > limitBytes) {
        out.error = `the file is ${(size / 1048576).toFixed(1)} MB, over this server's ${Math.round(limitBytes / 1048576)} MB limit`;
    } else {
        const seen = new Set();
        for (const channel of targets) {
            if (!channel || seen.has(channel.id)) continue;
            seen.add(channel.id);
            if (!canPost(channel)) { out.error = `no permission to attach files in #${channel.name}`; continue; }
            try {
                const msg = await channel.send({ content, files: [new AttachmentBuilder(filePath, { name: fileName })], allowedMentions: { parse: [] } });
                out.delivered = true;
                out.messageId = msg.id;
                out.channel = `${channel}`;
                break;
            } catch (err) {
                out.error = err.message;
                logger.warn(`[Recorder] upload to #${channel.name} in ${guild.id} failed: ${err.message}`);
            }
        }
    }
    if (out.delivered) await fs.promises.unlink(filePath).catch(err => logger.warn(`[Recorder] could not delete ${filePath}: ${err.message}`));
    else out.keptPath = filePath;
    return out;
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Start recording the voice channel `starter` is in.
 * @returns {Promise<RecordingSession>}
 * @throws Error with a user-presentable message
 */
export async function startRecording({ client, starter, textChannel, minutes = null }) {
    const guild = starter.guild;
    const config = await getRecordConfig(guild.id);
    if (!config.enabled) throw new Error('Recording is turned off on this server. A server admin can enable it with `/music settings recording enabled:On` or on the dashboard.');
    if (!mayRecord(starter, config)) throw new Error('Only members with **Manage Server** or one of the roles allowed to record can start a recording.');
    const channel = starter.voice?.channel;
    if (!channel?.isVoiceBased?.()) throw new Error('Join the voice channel you want to record first — you can only record a channel you are in.');
    if (sessions.has(guild.id)) throw new Error(`Already recording ${sessions.get(guild.id).channel} — stop that first.`);
    if (starting.has(guild.id)) throw new Error('Already recording — a recording is just starting in this server.');

    const transcription = getTranscriptionSession(guild.id);
    if (transcription && !transcription.stopping && transcription.channel?.id !== channel.id) {
        throw new Error(`I'm transcribing ${transcription.channel} right now, so I can't record a different channel.`);
    }
    const me = guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.Connect)) {
        throw new Error(`I don't have permission to join ${channel}.`);
    }

    // From here the connection is the recording's: the leave policy must not hang up on it when the
    // music ends. Every way out below either hands the hold to the session or releases it.
    starting.add(guild.id);
    holdVoice(guild.id, 'recording');
    let acquired = null;
    try {
        return await beginRecording({ client, guild, channel, starter, textChannel, minutes, config, onAcquired: a => { acquired = a; } });
    } catch (err) {
        if (!sessions.has(guild.id)) {
            releaseVoiceHold(guild.id, 'recording');
            if (acquired?.connection) {
                redeafen(acquired.connection);
                const player = client.player || global.player;
                const queue = player?.nodes?.get(guild.id);
                if (queue) await leaveIfIdle(queue, { reason: 'recording failed to start', player }).catch(() => {});
            }
        }
        throw err;
    } finally {
        starting.delete(guild.id);
    }
}

async function beginRecording({ client, guild, channel, starter, textChannel, minutes, config, onAcquired }) {
    let optOuts;
    try { optOuts = await loadOptOuts(); }
    catch (err) {
        logger.error(`[Recorder] could not load privacy opt-outs: ${err.message}`);
        throw new Error('Could not check who opted out of being recorded, so recording was not started. Try again shortly.');
    }
    await ensureSodium();

    const limitBytes = uploadLimitBytes(guild.premiumTier);
    const maxMinutes = effectiveMaxMinutes({ requested: minutes, configured: config.maxMinutes, premiumTier: guild.premiumTier });
    const configuredOut = config.outputChannelId ? guild.channels.cache.get(config.outputChannelId) : null;
    const outputChannel = canPost(configuredOut) ? configuredOut : textChannel;

    const { connection, created } = await acquireVoice(client, channel, { selfDeaf: false, allowMove: true });
    onAcquired({ connection, created });

    const startedAt = Date.now();
    const filePath = path.join(RECORDINGS_DIR, guild.id, `${startedAt}-${channel.id}.ogg`);
    const [res] = await pool.execute(
        `INSERT INTO voice_recordings (guild_id, voice_channel_id, text_channel_id, output_channel_id, started_by, bot_user_id, max_minutes, file_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [guild.id, channel.id, textChannel?.id || null, outputChannel?.id || null, starter.id, client.user?.id || null, maxMinutes, filePath]);
    ownRowIds.add(res.insertId);

    const session = new RecordingSession({
        client, channel, connection, created, starter, textChannel, outputChannel,
        maxMinutes, limitBytes, rowId: res.insertId, filePath, optOuts,
    });
    sessions.set(guild.id, session);
    try {
        await session.start();
    } catch (err) {
        logger.error(`[Recorder] could not start recording ${res.insertId} in ${guild.id}: ${err.message}`, { stack: err.stack });
        await session.stop('encoder_error').catch(() => {});
        throw new Error(`Could not start recording: ${err.message}`);
    }

    const notice = consentNotice({
        starter: escapeMarkdown(displayNameFor(starter)), channel: `${channel}`, maxMinutes,
        output: outputChannel ? `${outputChannel}` : 'this server',
    });
    await channel.send({ content: notice, allowedMentions: { parse: [] } }).catch(() => {});
    if (textChannel && textChannel.id !== channel.id) await textChannel.send({ content: notice, allowedMentions: { parse: [] } }).catch(() => {});
    logger.info(`[Recorder] recording ${res.insertId} started in ${guild.id} #${channel.name} by ${starter.id} (max ${maxMinutes} min)`);
    return session;
}

/** Stop the guild's recording. Returns the summary, or null when nothing was recording. */
export async function stopRecording(guildId, { reason = 'stopped', stoppedBy = null } = {}) {
    const session = sessions.get(guildId);
    if (!session) return null;
    return session.stop(reason, stoppedBy);
}

export function recordingStatus(guildId) {
    const s = sessions.get(guildId);
    if (!s) return null;
    return {
        channel: s.channel, starter: s.starter, startedAt: s.startedAt, maxMinutes: s.maxMinutes,
        elapsedMs: Date.now() - s.startedAt, speakers: s.speakers.size, outputChannel: s.outputChannel,
    };
}

/**
 * For index.js shutdown(): close every recording's file quickly (no upload — there is no time), and
 * leave the rows for the next boot's initVoiceRecorder() to deliver and to put the nickname back.
 */
export async function shutdownRecordings(timeoutMs = 5000) {
    const list = [...sessions.values()];
    if (!list.length) return 0;
    let timer;
    await Promise.race([
        Promise.allSettled(list.map(async (s) => {
            s.stopping = true;
            sessions.delete(s.guild.id);
            releaseVoiceHold(s.guild.id, 'recording');
            await s.finishCapture();
            if (s.nick.changed && await restoreNick(s.guild, s.nick.original)) s.nick.changed = false;
            await pool.execute(
                "UPDATE voice_recordings SET ended_at = NOW(), end_reason = 'restart', duration_sec = ?, speaker_count = ?, nick_changed = ? WHERE id = ?",
                [Math.round((s.mixer?.writtenMs || 0) / 1000), s.speakers.size, s.nick.changed ? 1 : 0, s.rowId]).catch(() => {});
        })),
        new Promise(r => { timer = setTimeout(r, timeoutMs); }),
    ]);
    clearTimeout(timer);
    return list.length;
}

/** The bot that serves this guild, if it is online. */
function clientForGuild(guildId, fallback) {
    const c = global.botManager?.getClientForGuild?.(guildId) || fallback;
    return c?.isReady?.() && c.guilds?.cache?.has(guildId) ? c : null;
}

/** Recordings a restart interrupted: put the nickname back and deliver what was captured. */
async function recoverInterrupted(fallbackClient) {
    const [rows] = await pool.execute(
        `SELECT id, guild_id, voice_channel_id, text_channel_id, output_channel_id, file_path, nick_changed, original_nick,
                duration_sec, speaker_count, started_at, ended_at
           FROM voice_recordings
          WHERE (ended_at IS NULL OR nick_changed = 1 OR (delivered = 0 AND file_path IS NOT NULL))
            AND started_at > NOW() - INTERVAL ${UNDELIVERED_KEEP_DAYS} DAY`);
    let pending = 0;
    for (const row of rows) {
        if (ownRowIds.has(row.id)) continue;           // a live recording of this process
        const client = clientForGuild(String(row.guild_id), fallbackClient);
        if (!client) { pending++; continue; }
        const guild = client.guilds.cache.get(String(row.guild_id));
        if (row.ended_at == null) {
            await pool.execute("UPDATE voice_recordings SET ended_at = NOW(), end_reason = COALESCE(end_reason, 'restart') WHERE id = ?", [row.id]);
        }
        if (Number(row.nick_changed) && await restoreNick(guild, row.original_nick)) {
            await pool.execute('UPDATE voice_recordings SET nick_changed = 0 WHERE id = ?', [row.id]);
        }
        if (row.file_path && fs.existsSync(row.file_path)) {
            const size = fs.statSync(row.file_path).size;
            const targets = [row.output_channel_id, row.text_channel_id].map(id => (id ? guild.channels.cache.get(String(id)) : null));
            const voice = guild.channels.cache.get(String(row.voice_channel_id));
            const result = await deliver({
                guild, filePath: row.file_path, size, limitBytes: uploadLimitBytes(guild.premiumTier), targets,
                fileName: recordingFileName(voice?.name || 'voice', new Date(row.started_at).getTime() || Date.now()),
                content: `🎙️ A recording of ${voice ? `${voice}` : 'a voice channel'} was cut short by a bot restart — here is what was captured.`,
                hadSpeech: row.speaker_count == null || Number(row.speaker_count) > 0,   // unknown after a crash: deliver
            });
            await pool.execute('UPDATE voice_recordings SET delivered = ?, message_id = ?, file_path = ?, file_bytes = ? WHERE id = ?',
                [result.delivered ? 1 : 0, result.messageId, result.keptPath, size || null, row.id]);
        } else if (row.file_path) {
            await pool.execute('UPDATE voice_recordings SET file_path = NULL WHERE id = ?', [row.id]);
        }
    }
    return pending;
}

/** Delete undelivered files older than UNDELIVERED_KEEP_DAYS. */
async function sweepOldFiles() {
    const cutoff = Date.now() - UNDELIVERED_KEEP_DAYS * 86_400_000;
    let removed = 0;
    let dirs = [];
    try { dirs = await fs.promises.readdir(RECORDINGS_DIR); } catch { return 0; }
    for (const dir of dirs) {
        const full = path.join(RECORDINGS_DIR, dir);
        let files = [];
        try { files = await fs.promises.readdir(full); } catch { continue; }
        for (const f of files) {
            const p = path.join(full, f);
            try {
                const st = await fs.promises.stat(p);
                if (st.mtimeMs < cutoff) {
                    await fs.promises.unlink(p);
                    removed++;
                    await pool.execute('UPDATE voice_recordings SET file_path = NULL WHERE file_path = ?', [p]).catch(() => {});
                }
            } catch (err) {
                logger.debug(`[Recorder] sweep skipped ${p}: ${err.message}`);
            }
        }
    }
    if (removed) logger.info(`[Recorder] deleted ${removed} undelivered recording(s) older than ${UNDELIVERED_KEEP_DAYS} days`);
    return removed;
}

/**
 * Once per process, after the clients are up: recover recordings a restart interrupted (custom bots
 * come online later, so it retries for a few minutes), and sweep old undelivered files daily.
 */
export function initVoiceRecorder({ client = null } = {}) {
    if (sweepTimer) return;
    const run = async (attempt) => {
        try {
            const pending = await recoverInterrupted(client);
            if (pending && attempt < 6) setTimeout(() => run(attempt + 1), 60_000).unref?.();
        } catch (err) {
            logger.warn(`[Recorder] recovering interrupted recordings failed: ${err.message}`);
        }
    };
    setTimeout(() => run(1), 30_000).unref?.();
    sweepOldFiles().catch(err => logger.warn(`[Recorder] sweep failed: ${err.message}`));
    sweepTimer = setInterval(() => sweepOldFiles().catch(err => logger.warn(`[Recorder] sweep failed: ${err.message}`)), 24 * 3_600_000);
    sweepTimer.unref?.();
}

export default {
    startRecording, stopRecording, recordingStatus, getRecording, isRecording, getRecordConfig, updateRecordConfig,
    mayRecord, shutdownRecordings, initVoiceRecorder, RECORDINGS_DIR,
};
