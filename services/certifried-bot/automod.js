/**
 * Auto-moderation for CertiFriedUtility Twitch Bot
 * Handles automated message filtering and deletion
 */

import axios from 'axios';
import logger from '../../utils/logger.js';

// Cached bot token info (resolved once via token validation)
let botTokenInfo = null;

/**
 * Validate the bot's OAuth token and cache the client_id + user_id.
 * Twitch's validate endpoint returns the correct client_id for any token,
 * which avoids the mismatch between TWITCH_CLIENT_ID and TWITCH_BOT_OAUTH.
 */
async function getBotTokenInfo() {
    if (botTokenInfo) return botTokenInfo;

    const token = (process.env.TWITCH_BOT_OAUTH || '').replace(/^oauth:/i, '');
    try {
        const response = await axios.get('https://id.twitch.tv/oauth2/validate', {
            headers: { 'Authorization': `OAuth ${token}` }
        });
        botTokenInfo = {
            clientId: response.data.client_id,
            userId: response.data.user_id,
            token
        };
        logger.debug(`[Automod] Bot token validated — user_id: ${botTokenInfo.userId}`);
        return botTokenInfo;
    } catch (error) {
        logger.error('[Automod] Failed to validate bot token', { error: error.response?.data || error.message });
        return null;
    }
}

/**
 * Delete a chat message using the Twitch Helix API
 * @param {string} broadcasterId - The broadcaster's Twitch user ID
 * @param {string} messageId - The message ID to delete
 */
async function deleteMessage(broadcasterId, messageId) {
    const info = await getBotTokenInfo();
    if (!info) throw new Error('Could not validate bot token');

    await axios.delete('https://api.twitch.tv/helix/moderation/chat', {
        headers: {
            'Client-ID': info.clientId,
            'Authorization': `Bearer ${info.token}`
        },
        params: {
            broadcaster_id: broadcasterId,
            moderator_id: info.userId,
            message_id: messageId
        }
    });
}

/**
 * Check if a message contains only Twitch emotes with no other text.
 * Uses emote position data from Twitch IRC tags to determine coverage.
 * @param {string} message - The raw message text
 * @param {Object|null} emotes - Emote data from Twitch IRC tags (emoteId -> ["start-end", ...])
 * @returns {boolean} True if the message is entirely emotes and whitespace
 */
export function isEmoteOnlyMessage(message, emotes) {
    // No emotes means it can't be emote-only
    if (!emotes || Object.keys(emotes).length === 0) {
        return false;
    }

    // Empty or whitespace-only messages are not emote-only
    if (!message || message.trim().length === 0) {
        return false;
    }

    // Build a set of all character indices covered by emotes
    const emoteCoverage = new Set();
    for (const positions of Object.values(emotes)) {
        for (const range of positions) {
            const [start, end] = range.split('-').map(Number);
            for (let i = start; i <= end; i++) {
                emoteCoverage.add(i);
            }
        }
    }

    // Every character must be either part of an emote or whitespace
    for (let i = 0; i < message.length; i++) {
        if (!emoteCoverage.has(i) && message[i].trim() !== '') {
            return false;
        }
    }

    return true;
}

/**
 * Run automod checks on an incoming Twitch message.
 * Deletes messages that contain only emotes with no other text.
 * @param {Object} params
 * @param {string} params.channel - The channel name (with # prefix)
 * @param {Object} params.tags - Twitch IRC message tags
 * @param {string} params.message - The raw message text
 * @returns {boolean} True if the message was deleted, false to continue normal processing
 */
export async function checkAutomod({ channel, tags, message }) {
    // VIPs, mods, and the broadcaster are exempt
    if (tags.badges?.vip || tags.badges?.moderator || tags.badges?.broadcaster || tags.mod) {
        return false;
    }

    if (isEmoteOnlyMessage(message, tags.emotes)) {
        try {
            await deleteMessage(tags['room-id'], tags.id);
            logger.debug(`[Automod] Deleted emote-only message from ${tags['display-name'] || tags.username} in ${channel}`);
        } catch (error) {
            logger.warn(`[Automod] Failed to delete message in ${channel}`, { error: error.response?.data || error.message });
        }
        return true;
    }

    return false;
}
