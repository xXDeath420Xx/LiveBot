/*
 * One voice session per guild, shared by music, voice camp, the chat reader and transcription.
 *
 * A bot can only be in one voice channel per guild. discord-player owns that session through its
 * GuildQueue, so every other voice feature has to ride the queue's connection rather than open
 * its own — a second joinVoiceChannel() never reaches 'ready' and times out (see the long
 * comment in commands/music/spotify.js). This module is that rule in one place.
 */

import logger from '../utils/logger.js';

const READY_TIMEOUT_MS = 20_000;

function playerFor(client) {
    return client?.player || global.player || null;
}

export function getGuildQueue(client, guildId) {
    return playerFor(client)?.nodes?.get(guildId) ?? null;
}

/** The live connection for this guild, if the bot is in voice there. */
export function getGuildConnection(client, guildId) {
    const conn = getGuildQueue(client, guildId)?.connection;
    return conn && conn.state?.status !== 'destroyed' ? conn : null;
}

export function waitReady(connection, timeoutMs = READY_TIMEOUT_MS) {
    if (connection.state?.status === 'ready') return Promise.resolve(connection);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('Voice connection did not become ready')); }, timeoutMs);
        const onState = (_old, next) => {
            if (next.status === 'ready') { cleanup(); resolve(connection); }
            else if (next.status === 'destroyed') { cleanup(); reject(new Error('Voice connection was destroyed')); }
        };
        const cleanup = () => { clearTimeout(timer); connection.off('stateChange', onState); };
        connection.on('stateChange', onState);
    });
}

/** Is something other than `ownPlayer` currently sending audio on this connection? */
export function isConnectionBusy(connection, ownPlayer = null) {
    const player = connection?.state?.subscription?.player;
    if (!player || player === ownPlayer) return false;
    const status = player.state?.status;
    return status === 'playing' || status === 'buffering';
}

/**
 * Get the bot into `channel`, reusing the guild's existing session.
 *
 * @param {import('discord.js').VoiceBasedChannel} channel  resolved through the client that owns the guild
 * @param {{ selfDeaf?: boolean, allowMove?: boolean }} options
 *   selfDeaf  false is required to RECEIVE audio — Discord sends nothing to a deafened client.
 *   allowMove when the bot is elsewhere in this guild, may it leave? Never while music is playing.
 * @returns {Promise<{ connection, queue, created: boolean }>}
 */
export async function acquireVoice(client, channel, { selfDeaf = true, allowMove = true } = {}) {
    const player = playerFor(client);
    if (!player) throw new Error('The voice system is not initialised on this bot');

    const guildId = channel.guild.id;
    let queue = player.nodes.get(guildId);
    let created = false;

    if (queue?.connection && queue.connection.state?.status !== 'destroyed') {
        const currentId = queue.channel?.id ?? queue.connection.joinConfig?.channelId;
        if (currentId && currentId !== channel.id) {
            if (!allowMove || queue.isPlaying()) {
                const where = queue.channel ? `#${queue.channel.name}` : 'another voice channel';
                throw new Error(`I'm already busy in ${where} in this server`);
            }
            await queue.connect(channel, { deaf: selfDeaf });
        } else if (Boolean(queue.connection.joinConfig?.selfDeaf) !== selfDeaf) {
            queue.connection.rejoin({ channelId: channel.id, selfDeaf, selfMute: false });
        }
    } else {
        queue = player.nodes.create(channel.guild, {
            metadata: { voiceTools: true, channel: null },
            selfDeaf,
            // This queue exists to hold a voice session, not a playlist: nothing about the music
            // lifecycle should make it hang up on the reader or the transcriber.
            leaveOnEmpty: false,
            leaveOnEnd: false,
            leaveOnStop: false,
        });
        await queue.connect(channel, { deaf: selfDeaf });
        created = true;
    }

    const connection = queue.connection;
    if (!connection) throw new Error('Could not open a voice connection');
    await waitReady(connection);
    return { connection, queue, created };
}

/** Put the bot back to deafened if nothing needs to hear any more. */
export function redeafen(connection) {
    try {
        if (connection && connection.state?.status !== 'destroyed' && connection.joinConfig?.selfDeaf === false) {
            connection.rejoin({ channelId: connection.joinConfig.channelId, selfDeaf: true, selfMute: false });
        }
    } catch (err) {
        logger.debug(`[VoiceShare] redeafen failed: ${err.message}`);
    }
}

export default { acquireVoice, getGuildConnection, getGuildQueue, isConnectionBusy, waitReady, redeafen };
