import { PermissionFlagsBits } from 'discord.js';
import logger from '../utils/logger.js';
import { getMusicConfig } from '../utils/music_helpers.js';
import { shouldReturnToCamp, isVoiceChannelType } from './voice-camp-helpers.js';

/** Delay before reconnecting after an involuntary disconnect (ms). */
export const CAMP_REJOIN_DELAY_MS = 3000;

/** Read the configured camp channel id for a guild, or null. */
export async function getCampChannelId(guildId) {
    const config = await getMusicConfig(guildId);
    return config?.default_voice_channel_id || null;
}

/**
 * Resolve + validate a guild's camp channel on a given client.
 * Returns the channel, or null (with a logged reason) if unusable.
 */
async function resolveCampChannel(client, guildId) {
    const campId = await getCampChannelId(guildId);
    if (!campId) return null;

    const channel = await client.channels.fetch(campId).catch(() => null);
    if (!channel || !isVoiceChannelType(channel.type)) {
        logger.warn(`[VoiceCamp] Camp channel ${campId} for guild ${guildId} is missing or not a voice channel`);
        return null;
    }

    const me = channel.guild.members.me;
    if (me && !channel.permissionsFor(me)?.has(PermissionFlagsBits.Connect)) {
        logger.warn(`[VoiceCamp] Missing Connect permission for camp channel ${campId} in guild ${guildId}`);
        return null;
    }
    return channel;
}

/** Connect idle to a guild's camp channel (creating a queue if needed). */
export async function rejoinCamp(client, player, guildId) {
    const channel = await resolveCampChannel(client, guildId);
    if (!channel) return;

    try {
        const queue = player.nodes.get(guildId) ?? player.nodes.create(channel.guild, {
            metadata: { camp: true },
            selfDeaf: true,
            leaveOnEmpty: false,
            leaveOnEnd: false
        });
        if (queue.channel?.id === channel.id) return; // already there
        await queue.connect(channel);
        logger.info(`[VoiceCamp] Connected to camp channel ${channel.id} in guild ${guildId}`);
    } catch (err) {
        logger.error(`[VoiceCamp] Failed to join camp in guild ${guildId}: ${err.message}`);
    }
}

/** On client ready: join every configured camp channel in this client's own guilds. */
export async function joinCampChannels(client, player) {
    // Each client only sees its own guild subset — iterate this client's cache only.
    for (const [guildId] of client.guilds.cache) {
        await rejoinCamp(client, player, guildId);
    }
}

/**
 * Move an idle queue back to its guild's camp channel.
 * No-op if music is still active, no camp is set, or it's already in camp.
 * @returns {Promise<boolean>} whether it relocated
 */
export async function returnToCamp(player, queue) {
    const guildId = queue?.guild?.id;
    if (!guildId) return false;
    if (queue.isPlaying() || queue.tracks.size > 0) return false; // not idle yet

    const campId = await getCampChannelId(guildId);
    if (!shouldReturnToCamp(queue.channel?.id, campId)) return false;

    const client = player.client;
    const channel = await resolveCampChannel(client, guildId);
    if (!channel) return false;

    try {
        await queue.connect(channel);
        logger.info(`[VoiceCamp] Returned to camp channel ${channel.id} in guild ${guildId}`);
        return true;
    } catch (err) {
        logger.error(`[VoiceCamp] Failed to return to camp in guild ${guildId}: ${err.message}`);
        return false;
    }
}
