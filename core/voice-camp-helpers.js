import { ChannelType } from 'discord.js';

/**
 * Decide whether the bot should relocate to its camp channel.
 * Pure channel-id comparison; queue-state (idle) checks live in the manager.
 *
 * @param {string|null|undefined} currentChannelId  where the bot is now
 * @param {string|null|undefined} campChannelId      configured camp, or null
 * @returns {boolean}
 */
export function shouldReturnToCamp(currentChannelId, campChannelId) {
    if (!campChannelId) return false;        // no camp configured
    if (!currentChannelId) return true;      // not connected -> go to camp
    return currentChannelId !== campChannelId; // elsewhere -> return home
}

/** True if a Discord channel type can host a voice connection. */
export function isVoiceChannelType(type) {
    return type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice;
}
