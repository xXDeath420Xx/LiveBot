/*
 * Voice RECEIVE for the connections discord-player already holds.
 *
 * discord-player v7 runs on `discord-voip`, a fork of @discordjs/voice with the receive side
 * removed — it can send audio but has no VoiceReceiver. Opening a second connection with the
 * real @discordjs/voice is not an option: a bot has one voice session per guild, and the two
 * libraries would fight over it (the same trap commands/music/spotify.js documents).
 *
 * So this taps the existing connection instead. Everything receive needs is still there on
 * discord-voip's networking state: the UDP socket's 'message' event, the WebSocket's 'packet'
 * event (SPEAKING maps SSRC → user), the transport secret key + encryption mode, and the DAVE
 * session with its per-user decrypt(). This file is the glue, ported from @discordjs/voice
 * 0.19.2 src/receive/VoiceReceiver.ts (Apache-2.0, © Amish Shah and discord.js contributors).
 *
 * Three deliberate departures from upstream:
 *   - SSRC → user tracking lives on the CONNECTION from the moment its networking is created, not on
 *     the receiver (see SsrcTracker) — upstream gets that for free by being the library.
 *   - A packet that fails to decrypt is dropped, not fatal to the stream. DAVE epoch changes
 *     make a few failures normal, and upstream's destroy-on-error ends someone's sentence.
 *   - The receiver re-attaches itself whenever discord-voip swaps its networking/ws/udp
 *     (reconnects, region moves), because nothing in discord-voip will do it for us.
 */

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import sodium from 'libsodium-wrappers';
import logger from '../utils/logger.js';

const OP_SPEAKING = 5;
const OP_CLIENT_DISCONNECT = 13;
const NETWORKING_READY = 4;
const NETWORKING_RESUMING = 5;
const RTP_OPUS_PAYLOAD_TYPE = 0x78;
const HEADER_EXTENSION_BYTE = Buffer.from([0xbe, 0xde]);   // RFC 5285 one-byte header extension
const UNPADDED_NONCE_LENGTH = 4;
const AUTH_TAG_LENGTH = 16;
export const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);

let sodiumReady = sodium.ready.catch(err => logger.error(`[VoiceReceiver] libsodium failed to load: ${err.message}`));

/** One user's Opus packets, in arrival order. Ends itself after `silenceMs` without speech. */
class UserAudioStream extends Readable {
    constructor({ silenceMs, maxMs }) {
        super({ objectMode: true });
        this.silenceMs = silenceMs;
        this.startedAt = Date.now();
        this.silenceTimer = null;
        // A hard cap so one person talking non-stop still produces captions as they go.
        this.maxTimer = maxMs ? setTimeout(() => this.finish(), maxMs) : null;
        this.renew();
    }

    renew() {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = setTimeout(() => this.finish(), this.silenceMs);
    }

    pushPacket(packet) {
        if (this.destroyed || this.readableEnded) return;
        if (!packet.equals(SILENCE_FRAME)) this.renew();
        this.push(packet);
    }

    finish() {
        clearTimeout(this.silenceTimer);
        clearTimeout(this.maxTimer);
        if (!this.destroyed && !this.readableEnded) this.push(null);
    }

    _read() {}

    _destroy(err, cb) {
        clearTimeout(this.silenceTimer);
        clearTimeout(this.maxTimer);
        cb(err);
    }
}

/**
 * Which user each SSRC (audio stream id) belongs to, per voice connection, for its whole life.
 *
 * Discord announces a user's SSRC with a SPEAKING op roughly ONCE per voice session — around when
 * they first transmit — not on every burst of speech. A tracker that starts listening when a
 * transcription starts has missed every announcement made since the bot joined, so on a connection
 * that already existed (music, voice camp, the chat reader) every packet belonged to "nobody" and
 * was dropped without a sound: no decrypt errors, no Whisper calls, no captions.
 *
 * So tracking starts when a connection's networking is CREATED: VoiceConnection.configureNetworking
 * is wrapped once at import (discord-player and this module share discord-voip's single CJS
 * instance — its .mjs is a re-export wrapper), and the new WebSocket is watched before it opens.
 * A connection that somehow predates the hook is flagged `late` so the caller can refresh it.
 */
class SsrcTracker extends EventEmitter {
    constructor(connection, { late }) {
        super();
        this.connection = connection;
        this.map = new Map();               // ssrc -> userId
        this.late = late;
        this.speakingOps = 0;
        this.attached = { networking: null, ws: null };
        this.onWsPacket = this.onWsPacket.bind(this);
        this.onNetworkingState = () => this.syncWs();
        connection.on('stateChange', () => this.syncNetworking());
        this.syncNetworking();
    }

    syncNetworking() {
        const networking = this.connection.state?.networking ?? null;
        if (networking !== this.attached.networking) {
            this.attached.networking?.off('stateChange', this.onNetworkingState);
            this.attached.networking = networking;
            networking?.on('stateChange', this.onNetworkingState);
        }
        this.syncWs();
    }

    syncWs() {
        const ws = this.attached.networking?.state?.ws ?? null;
        if (ws === this.attached.ws) return;
        this.attached.ws?.off('packet', this.onWsPacket);
        this.attached.ws = ws;
        ws?.on('packet', this.onWsPacket);
    }

    onWsPacket(packet) {
        if (packet?.op === OP_SPEAKING && packet.d?.user_id && packet.d.ssrc) {
            this.speakingOps++;
            this.map.set(packet.d.ssrc, packet.d.user_id);
        } else if (packet?.op === OP_CLIENT_DISCONNECT && packet.d?.user_id) {
            for (const [ssrc, userId] of this.map) {
                if (userId === packet.d.user_id) this.map.delete(ssrc);
            }
            this.emit('clientDisconnect', packet.d.user_id);
        }
    }
}

const TRACKER = Symbol('certifriedSsrcTracker');

export function ensureSsrcTracker(connection, { late = true } = {}) {
    if (!connection[TRACKER]) connection[TRACKER] = new SsrcTracker(connection, { late });
    return connection[TRACKER];
}

(function installSsrcTracking() {
    try {
        const { VoiceConnection } = createRequire(import.meta.url)('discord-voip');
        const proto = VoiceConnection?.prototype;
        if (!proto?.configureNetworking || proto.configureNetworking[TRACKER]) return;
        const original = proto.configureNetworking;
        const wrapped = function configureNetworking(...args) {
            const result = original.apply(this, args);
            try {
                // Created here, the tracker sees the new WebSocket before it opens: nothing is missed.
                const tracker = ensureSsrcTracker(this, { late: false });
                // A new networking is a new voice session: SSRCs are reassigned and re-announced.
                tracker.map.clear();
                tracker.late = false;
                tracker.syncNetworking();
            } catch (err) {
                logger.warn(`[VoiceReceiver] SSRC tracking failed to attach: ${err.message}`);
            }
            return result;
        };
        wrapped[TRACKER] = true;
        proto.configureNetworking = wrapped;
    } catch (err) {
        logger.error(`[VoiceReceiver] Could not install SSRC tracking — transcription will not hear anyone: ${err.message}`);
    }
})();

/**
 * Attach to a discord-voip VoiceConnection.
 *
 * Events: 'unsubscribedAudio' (userId) — audio arrived from a user nobody is subscribed to.
 */
export class VoiceReceiver extends EventEmitter {
    constructor(connection) {
        super();
        this.connection = connection;
        this.tracker = ensureSsrcTracker(connection);
        this.subscriptions = new Map();     // userId -> UserAudioStream
        this.speakingTimers = new Map();    // userId -> timeout
        this.decryptFailures = 0;
        // Where packets stop, when captions don't appear. Surfaced by /voice transcribe status.
        this.stats = { udpPackets: 0, opusPackets: 0, unmappedPackets: 0, mappedPackets: 0, pushedPackets: 0 };
        this.attached = { networking: null, udp: null };

        this.onUdpMessage = this.onUdpMessage.bind(this);
        this.onNetworkingState = () => this.syncUdp();
        this.onConnectionState = () => this.syncNetworking();
        this.onClientDisconnect = userId => this.subscriptions.get(userId)?.finish();

        connection.on('stateChange', this.onConnectionState);
        this.tracker.on('clientDisconnect', this.onClientDisconnect);
        this.syncNetworking();
    }

    /** True when this connection's SSRC announcements may have been missed (it predates tracking). */
    get needsFreshNetworking() {
        return this.tracker.late;
    }

    syncNetworking() {
        const networking = this.connection.state?.networking ?? null;
        if (networking !== this.attached.networking) {
            this.attached.networking?.off('stateChange', this.onNetworkingState);
            this.attached.networking = networking;
            networking?.on('stateChange', this.onNetworkingState);
        }
        this.syncUdp();
    }

    syncUdp() {
        const udp = this.attached.networking?.state?.udp ?? null;
        if (udp === this.attached.udp) return;
        this.attached.udp?.off('message', this.onUdpMessage);
        this.attached.udp = udp;
        udp?.on('message', this.onUdpMessage);
    }

    markSpeaking(userId) {
        const timer = this.speakingTimers.get(userId);
        if (timer) clearTimeout(timer);
        else this.emit('speakingStart', userId);
        this.speakingTimers.set(userId, setTimeout(() => this.speakingTimers.delete(userId), 250));
    }

    onUdpMessage(msg) {
        this.stats.udpPackets++;
        if (msg.length <= 12) return;
        if ((msg[1] & 0x7f) !== RTP_OPUS_PAYLOAD_TYPE || (msg[0] >> 6) !== 2) return;
        this.stats.opusPackets++;
        const ssrc = msg.readUInt32BE(8);
        const userId = this.tracker.map.get(ssrc);
        if (!userId) { this.stats.unmappedPackets++; return; }
        this.stats.mappedPackets++;

        this.markSpeaking(userId);
        let stream = this.subscriptions.get(userId);
        if (!stream) {
            // Also ask on every unsubscribed packet, not just after a pause: when a phrase is cut
            // at its max length the speaker is still talking, so there is no fresh "start" to hear.
            // Listeners subscribe synchronously, so this packet is not lost.
            this.emit('unsubscribedAudio', userId);
            stream = this.subscriptions.get(userId);
            if (!stream) return;
        }

        const netState = this.attached.networking?.state;
        const data = netState?.connectionData;
        if (!data?.secretKey || !data?.encryptionMode) return;

        try {
            const packet = this.parsePacket(msg, data.encryptionMode, data.secretKey, userId, netState);
            if (packet?.length) {
                this.stats.pushedPackets++;
                stream.pushPacket(packet);
            }
        } catch (err) {
            // Normal around DAVE epoch transitions; only worth a line if it becomes a pattern.
            this.decryptFailures++;
            if (this.decryptFailures === 1 || this.decryptFailures % 500 === 0) {
                logger.warn(`[VoiceReceiver] Dropped undecryptable packet (${this.decryptFailures} so far): ${err.message}`);
            }
        }
    }

    decryptTransport(buffer, mode, secretKey) {
        const nonce = Buffer.alloc(mode === 'aead_aes256_gcm_rtpsize' ? 12 : 24);
        buffer.copy(nonce, 0, buffer.length - UNPADDED_NONCE_LENGTH);

        let headerSize = 12;
        if ((buffer[0] >> 4) & 0x01) headerSize += 4;   // extension present: its 4-byte header is unencrypted
        const header = buffer.subarray(0, headerSize);
        const encrypted = buffer.subarray(headerSize, buffer.length - AUTH_TAG_LENGTH - UNPADDED_NONCE_LENGTH);
        const authTag = buffer.subarray(buffer.length - AUTH_TAG_LENGTH - UNPADDED_NONCE_LENGTH, buffer.length - UNPADDED_NONCE_LENGTH);

        if (mode === 'aead_aes256_gcm_rtpsize') {
            const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey, nonce);
            decipher.setAAD(header);
            decipher.setAuthTag(authTag);
            return Buffer.concat([decipher.update(encrypted), decipher.final()]);
        }
        if (mode === 'aead_xchacha20_poly1305_rtpsize') {
            return Buffer.from(sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
                null, Buffer.concat([encrypted, authTag]), header, nonce, secretKey));
        }
        throw new RangeError(`Unsupported encryption mode ${mode}`);
    }

    parsePacket(buffer, mode, secretKey, userId, netState) {
        let packet = this.decryptTransport(buffer, mode, secretKey);

        if (buffer[0] & 0x20) {                          // RTP padding
            const pad = packet[packet.length - 1];
            if (pad < packet.length) packet = packet.subarray(0, packet.length - pad);
        }
        if (buffer.subarray(12, 14).equals(HEADER_EXTENSION_BYTE)) {
            const extLength = buffer.subarray(14).readUInt16BE();
            packet = packet.subarray(4 * extLength);
        }

        // End-to-end (DAVE) layer. Returns the packet untouched when the session passes it through.
        if ((netState.code === NETWORKING_READY || netState.code === NETWORKING_RESUMING) && netState.dave) {
            packet = netState.dave.decrypt(packet, userId);
        }
        return packet;
    }

    /** Stream of a user's Opus packets until they go quiet for `silenceMs` (or `maxMs` total). */
    subscribe(userId, { silenceMs = 900, maxMs = 20_000 } = {}) {
        const existing = this.subscriptions.get(userId);
        if (existing && !existing.destroyed && !existing.readableEnded) return existing;
        const stream = new UserAudioStream({ silenceMs, maxMs });
        const drop = () => { if (this.subscriptions.get(userId) === stream) this.subscriptions.delete(userId); };
        stream.once('end', drop);
        stream.once('close', drop);
        this.subscriptions.set(userId, stream);
        return stream;
    }

    isSubscribed(userId) {
        const s = this.subscriptions.get(userId);
        return !!s && !s.destroyed && !s.readableEnded;
    }

    destroy() {
        this.connection.off('stateChange', this.onConnectionState);
        this.tracker.off('clientDisconnect', this.onClientDisconnect);
        this.attached.networking?.off('stateChange', this.onNetworkingState);
        this.attached.udp?.off('message', this.onUdpMessage);
        this.attached = { networking: null, udp: null };
        for (const stream of this.subscriptions.values()) stream.destroy();
        this.subscriptions.clear();
        for (const t of this.speakingTimers.values()) clearTimeout(t);
        this.speakingTimers.clear();
        this.removeAllListeners();
    }
}

export async function ensureSodium() {
    await sodiumReady;
}

export default VoiceReceiver;
