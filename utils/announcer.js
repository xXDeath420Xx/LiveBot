const { EmbedBuilder, WebhookClient } = require('discord.js');
const db = require('./db');
const logger = require('./logger'); // Import the logger

const platformColors = {
    twitch: '#9146FF', youtube: '#FF0000', kick: '#52E252',
    tiktok: '#00f2ea', trovo: '#21d464', default: '#36393f'
};

const WEBHOOK_NAME_PREFIX = 'CertiFried Announcer';

function formatUptime(seconds) {
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours > 0 ? `${hours}h ` : ''}${minutes}m`;
}

async function getOrCreateWebhook(client, channelId, defaultAvatarUrl) {
    logger.debug(`[Announcer] Attempting to get or create webhook for channel ${channelId}`);
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased()) {
            logger.warn(`[Announcer] Channel ${channelId} is not text-based or not found.`);
            return null;
        }
        const webhooks = await channel.fetchWebhooks();
        let webhook = webhooks.find(wh => wh.owner?.id === client.user.id && wh.name.startsWith(WEBHOOK_NAME_PREFIX));
        if (!webhook) {
            logger.info(`[Announcer] Creating new webhook in channel ${channelId}.`);
            webhook = await channel.createWebhook({ name: WEBHOOK_NAME_PREFIX, avatar: defaultAvatarUrl || client.user.displayAvatarURL(), reason: 'For custom announcements' });
            logger.info(`[Announcer] Created webhook with ID: ${webhook.id}`);
        }
        logger.debug(`[Announcer] Webhook obtained for channel ${channelId}: ${webhook.id}`);
        return new WebhookClient({ id: webhook.id, token: webhook.token });
    } catch (e) {
        logger.error(`[Announcer] Failed to get or create webhook for channel ${channelId}:`, { error: e.message, stack: e.stack });
        return null;
    }
}

async function updateAnnouncement(client, subContext, liveData, existingAnnouncement, guildSettings, channelSettings, teamSettings) {
    if (!liveData || typeof liveData.platform !== 'string') {
        logger.error(`[Announcer] Invalid liveData for ${subContext.username}. Aborting.`, { liveData });
        return null;
    }

    if (liveData.profileImageUrl && liveData.profileImageUrl !== subContext.profile_image_url) {
        try {
            logger.debug(`[Announcer] Updating profile image for ${subContext.username}.`);
            await db.execute('UPDATE streamers SET profile_image_url = ? WHERE streamer_id = ?', [liveData.profileImageUrl, subContext.streamer_id]);
        } catch (dbError) {
            logger.error(`[Announcer] Failed to update profile image for ${subContext.username}:`, { error: dbError });
        }
    }

    const channelId = subContext.announcement_channel_id || guildSettings?.announcement_channel_id;
    if (!channelId) {
        logger.warn(`[Announcer] No announcement channel configured for ${subContext.username} in guild ${subContext.guild_id}.`);
        return null;
    }

    const platformName = liveData.platform.charAt(0).toUpperCase() + liveData.platform.slice(1);

    const embed = new EmbedBuilder()
        .setColor(platformColors[liveData.platform] || platformColors.default)
        .setAuthor({ name: `${liveData.username} is LIVE on ${platformName}!`, url: liveData.url })
        .setTitle(liveData.title || 'Untitled Stream').setURL(liveData.url)
        .setTimestamp();

    embed.addFields({ name: 'Playing', value: liveData.game || 'N/A', inline: true });
    if (liveData.viewers) {
        embed.addFields({ name: 'Viewers', value: liveData.viewers.toString(), inline: true });
    }
    if (liveData.uptime) {
        embed.addFields({ name: 'Uptime', value: formatUptime(liveData.uptime), inline: true });
    }

    if (liveData.gameArtUrl) {
        embed.setImage(liveData.gameArtUrl);
        if (liveData.thumbnailUrl) embed.setThumbnail(liveData.thumbnailUrl);
    } else if (liveData.thumbnailUrl) {
        embed.setImage(`${liveData.thumbnailUrl}?t=${Date.now()}`);
    }

    let content = null;
    if (subContext.custom_message) {
        content = subContext.custom_message
            .replaceAll(/{username}/g, liveData.username)
            .replaceAll(/{platform}/g, platformName)
            .replaceAll(/{url}/g, liveData.url)
            .replaceAll(/{title}/g, liveData.title || 'Untitled Stream')
            .replaceAll(/{game}/g, liveData.game || 'N/A')
            .replaceAll(/{viewer_count}/g, liveData.viewers || '0')
            .replaceAll(/{uptime}/g, formatUptime(liveData.uptime || 0));
    }

    try {
        let finalNickname = guildSettings?.bot_nickname || WEBHOOK_NAME_PREFIX;
        let finalAvatarURL = guildSettings?.webhook_avatar_url || client.user.displayAvatarURL();

        if (channelSettings?.override_nickname) finalNickname = channelSettings.override_nickname;
        if (channelSettings?.override_avatar_url) finalAvatarURL = channelSettings.override_avatar_url;
        if (teamSettings?.webhook_name) finalNickname = teamSettings.webhook_name;
        if (teamSettings?.webhook_avatar_url) finalAvatarURL = teamSettings.webhook_avatar_url;
        if (subContext.override_nickname) finalNickname = subContext.override_nickname;
        if (subContext.override_avatar_url) finalAvatarURL = subContext.override_avatar_url;

        logger.debug(`[Announcer] Final webhook settings for ${subContext.username}: Nickname=${finalNickname}, Avatar=${finalAvatarURL}`);

        const webhookClient = await getOrCreateWebhook(client, channelId, finalAvatarURL);
        if (!webhookClient) {
            logger.error(`[Announcer] Could not get webhook client for channel ${channelId}. Aborting announcement.`);
            return null;
        }

        const messageOptions = { username: finalNickname, avatarURL: finalAvatarURL, content, embeds: [embed] };
        let finalMessage = null;

        // --- Start Duplicate Message Cleanup ---
        const [duplicateAnnouncements] = await db.execute(
            'SELECT announcement_id, message_id FROM announcements WHERE streamer_id = ? AND channel_id = ? AND announcement_id != ?',
            [subContext.streamer_id, channelId, existingAnnouncement?.announcement_id || 0] // Exclude the current existing one
        );

        for (const dup of duplicateAnnouncements) {
            logger.info(`[Announcer] Deleting duplicate message ${dup.message_id} for ${subContext.username} in channel ${channelId}.`);
            try {
                await webhookClient.deleteMessage(dup.message_id);
            } catch (e) {
                logger.warn(`[Announcer] Failed to delete Discord message ${dup.message_id} (might already be deleted): ${e.message}`);
            }
            await db.execute('DELETE FROM announcements WHERE announcement_id = ?', [dup.announcement_id]);
            logger.debug(`[Announcer] Deleted duplicate announcement record ${dup.announcement_id} from DB.`);
        }
        // --- End Duplicate Message Cleanup ---

        if (existingAnnouncement?.message_id) {
            logger.info(`[Announcer] Attempting to edit existing message ${existingAnnouncement.message_id} for ${subContext.username}.`);
            try {
                const editedMessage = await webhookClient.editMessage(existingAnnouncement.message_id, messageOptions);
                logger.debug(`[Announcer] Result of editMessage for ${subContext.username}:`, { editedMessageId: editedMessage?.id, editedMessageChannelId: editedMessage?.channel?.id });
                if (editedMessage && editedMessage.id) {
                    finalMessage = editedMessage;
                } else {
                    logger.error(`[Announcer] Edited message did not return a valid message object with an ID for ${subContext.username}. Full response:`, editedMessage);
                }
            } catch (e) {
                logger.error(`[Announcer] Failed to edit message ${existingAnnouncement.message_id} for ${subContext.username}:`, { error: e.message, stack: e.stack });
                logger.info(`[Announcer] Attempting to send new message for ${subContext.username} instead.`);
                try {
                    const newMessage = await webhookClient.send(messageOptions);
                    logger.debug(`[Announcer] Result of send (after edit failure) for ${subContext.username}:`, { newMessageId: newMessage?.id, newMessageChannelId: newMessage?.channel?.id });
                    if (newMessage && newMessage.id) {
                        await db.execute('UPDATE announcements SET message_id = ? WHERE announcement_id = ?', [newMessage.id, existingAnnouncement.announcement_id]);
                        finalMessage = newMessage;
                    } else {
                        logger.error(`[Announcer] New message (after edit failure) did not return a valid message object with an ID for ${subContext.username}. Full response:`, newMessage);
                    }
                } catch (sendError) {
                    logger.error(`[Announcer] Failed to send new message after edit failure for ${subContext.username}:`, { error: sendError.message, stack: sendError.stack });
                }
            }
        } else {
            logger.info(`[Announcer] Sending new announcement message for ${subContext.username}.`);
            try {
                const newMessage = await webhookClient.send(messageOptions);
                logger.debug(`[Announcer] Result of send for ${subContext.username}:`, { newMessageId: newMessage?.id, newMessageChannelId: newMessage?.channel?.id });
                if (newMessage && newMessage.id) {
                    finalMessage = newMessage;
                } else {
                    logger.error(`[Announcer] New message did not return a valid message object with an ID for ${subContext.username}. Full response:`, newMessage);
                }
            } catch (sendError) {
                logger.error(`[Announcer] Failed to send new announcement message for ${subContext.username}:`, { error: sendError.message, stack: sendError.stack });
            }
        }
        return finalMessage;
    } catch (error) {
        logger.error(`[Announcer] Critical failure in updateAnnouncement for ${liveData.username} in #${channelId}:`, { error: error.message, stack: error.stack });
        return null;
    }
} 

module.exports = { updateAnnouncement };