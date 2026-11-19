import { PermissionFlagsBits } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { getMusicConfig } from '../utils/music_helpers.js';
import { shouldReturnToCamp, isVoiceChannelType } from './voice-camp-helpers.js';

/** Delay before reconnecting after an involuntary disconnect (ms). */
export const CAMP_REJOIN_DELAY_MS = 3000;

/**
 * The bot that actually serves this guild — NOT necessarily the one that asked.
 *
 * Every automatic rejoin path (the player 'disconnect' handler, the two track-error handlers,
 * returnToCamp via player.client) is registered once inside initializeSchedulersAndDashboard,
 * whose `client` is the DEFAULT bot, and the shared global.player carries that same default
 * client. But camping is configured on a guild served by a CUSTOM bot, and the default bot is
 * not in that guild at all — `channels.fetch` answers 404, resolveCampChannel returns null, and
 * the rejoin silently does nothing.
 *
 * That is why camp only ever came back on a full process restart: the startup path in index.js
 * passes the custom client explicitly, and every recovery path afterwards did not.
 *
 * Resolving here rather than at the four call sites means a future caller cannot reintroduce it.
 */
function clientForGuild(fallbackClient, guildId) {
    const owner = global.botManager?.getClientForGuild?.(guildId);
    if (owner) return owner;
    // No bot manager (tests, or a single-bot deployment) — the caller's client is all there is.
    return fallbackClient;
}

/**
 * Read the configured camp channel id for a guild, or null.
 *
 * Camping REQUIRES 24/7 to be on. These were two independent settings — `default_voice_channel_id`
 * (which channel) and `twenty_four_seven` (whether to stay) — and camp only ever consulted the
 * first. So a guild that had a camp channel set but 24/7 switched OFF still had the bot silently
 * park itself in voice with nobody interacting with it, and nothing in the UI explained why.
 * The channel is now only WHERE to camp; 24/7 is WHETHER to camp.
 */
export async function getCampChannelId(guildId) {
    const config = await getMusicConfig(guildId);
    if (!config?.twenty_four_seven) return null;
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
    const owner = clientForGuild(client, guildId);
    const channel = await resolveCampChannel(owner, guildId);
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

    // player.client is the default bot on a shared global.player — resolve the real owner.
    const channel = await resolveCampChannel(clientForGuild(player.client, guildId), guildId);
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

/**
 * Every guild that has camping switched on, straight from the database.
 *
 * Deliberately NOT routed through getMusicConfig's cache: that cache is only invalidated on
 * write, and the reconciler's whole job is to be right about the current state rather than fast.
 */
export async function listCampGuilds() {
    const [rows] = await pool.execute(
        `SELECT guild_id, default_voice_channel_id FROM music_config
          WHERE twenty_four_seven = 1 AND default_voice_channel_id IS NOT NULL AND default_voice_channel_id <> ''`);
    return rows;
}

/**
 * Put the bot back in its camp channel wherever it has silently fallen out.
 *
 * WHY THIS IS NEEDED WHEN THERE IS ALREADY A 'disconnect' HANDLER
 *
 * The recovery paths are all event-driven, and the event does not always come. A voice websocket
 * that drops, a Discord voice-server move, a node that goes away — discord-player emits nothing
 * for several of these, so `disconnect` never fires and nothing notices. Guild 844406178799943730
 * sat out of its camp channel from 2026-08-31 until this was written, with not one line in the log
 * about it: no rejoin, no failure, no warning. An event that never arrives cannot be handled.
 *
 * The authority here is `guild.members.me.voice.channelId` — the gateway's own view of where this
 * bot is — NOT the player's queue state. A queue can happily believe it is connected long after
 * the underlying voice connection has gone; that belief is precisely what made this invisible.
 *
 * MUSIC IS NEVER INTERRUPTED. If a queue is playing or has tracks pending, the bot is out of camp
 * on purpose (somebody ran /play in another channel) and is left exactly where it is. Camp is a
 * resting place, not a leash.
 */
export async function reconcileCamps(player) {
    const guilds = await listCampGuilds();
    const stats = { checked: 0, rejoined: 0, busy: 0, unreachable: 0 };

    for (const { guild_id: guildId, default_voice_channel_id: campId } of guilds) {
        const client = global.botManager?.getClientForGuild?.(guildId);
        const guild = client?.guilds?.cache?.get(guildId);
        if (!guild) { stats.unreachable++; continue; }   // served by no connected bot right now
        stats.checked++;

        const queue = player?.nodes?.get(guildId);
        if (queue?.isPlaying?.() || queue?.tracks?.size > 0) { stats.busy++; continue; }

        const where = guild.members.me?.voice?.channelId ?? null;
        if (where === campId) continue;                  // already home

        logger.warn(`[VoiceCamp] ${guild.name} is ${where ? `in ${where}` : 'NOT in voice'} but should be camped in ${campId} — reconnecting`);
        await rejoinCamp(client, player, guildId);
        stats.rejoined++;
    }

    if (stats.rejoined > 0 || stats.unreachable > 0) {
        logger.info(`[VoiceCamp] reconcile — checked ${stats.checked}, rejoined ${stats.rejoined}, left alone (music playing) ${stats.busy}, no connected bot ${stats.unreachable}`);
    }
    return stats;
}
