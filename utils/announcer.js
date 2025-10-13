const { EmbedBuilder, WebhookClient, DiscordAPIError } = require('discord.js');
const db = require('./db');
const logger = require('./logger');

const platformColors = {
    twitch: '#9146FF', youtube: '#FF0000', kick: '#52E252',
    tiktok: '#00f2ea', trovo: '#21d464', default: '#36393f'
};

const WEBHOOK_NAME_PREFIX = 'CertiFried Announcer';

async function getWebhookClient(client, channelId, desiredName, desiredAvatarURL) {
    logger.debug(`[Webhook Manager] Processing channel ${channelId}.`, { guildId: client.channels.cache.get(channelId)?.guild?.id, category: 'announcer' });
    try {
        // Priority 1: Check for custom webhook URL from channel_settings
        const [[channelSettings]] = await db.execute('SELECT webhook_url FROM channel_settings WHERE channel_id = ?', [channelId]);
        if (channelSettings && channelSettings.webhook_url) {
            logger.info(`[Webhook Manager] Using custom webhook URL for channel ${channelId}.`, { guildId: client.channels.cache.get(channelId)?.guild?.id, channelId, category: 'announcer' });
            return new WebhookClient({ url: channelSettings.webhook_url });
        }

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.guild || !channel.isTextBased()) {
            logger.warn(`[Webhook Manager] Channel ${channelId} not found, not in a guild, or not a text channel.`, { category: 'announcer' });
            return null;
        }

        const botMember = await channel.guild.members.fetch(client.user.id).catch(() => null);
        if (!botMember) {
            logger.error(`[Webhook Manager] Could not fetch bot's own member object in guild ${channel.guild.id}.`, { guildId: channel.guild.id, category: 'announcer' });
            return null;
        }

        const permissions = channel.permissionsFor(botMember);
        if (!permissions || !permissions.has(['ManageWebhooks', 'SendMessages'])) {
            logger.warn(`[Webhook Manager] Missing ManageWebhooks or SendMessages permission in channel ${channelId}.`, { guildId: channel.guild.id, category: 'announcer' });
            return null;
        }

        const webhooks = await channel.fetchWebhooks();
        let webhook = webhooks.find(wh => wh.owner?.id === client.user.id && wh.name.startsWith(WEBHOOK_NAME_PREFIX));

        if (webhook) {
            // Reuse existing webhook
            if (webhook.name !== desiredName || webhook.avatarURL() !== desiredAvatarURL) {
                await webhook.edit({ name: desiredName, avatar: desiredAvatarURL });
            }
            logger.debug(`[Webhook Manager] Reusing existing webhook ${webhook.id} in channel ${channelId}.`, { guildId: channel.guild.id, channelId, category: 'announcer' });
            return new WebhookClient({ id: webhook.id, token: webhook.token });
        }

        // If no existing webhook, check limit before creating
        if (webhooks.size >= 15) {
            logger.error(`[Webhook Manager] Maximum number of webhooks (15) reached in channel ${channelId}. Cannot create new webhook. Please clear some or add a custom webhook URL in the dashboard.`, { guildId: channel.guild.id, channelId, category: 'announcer' });
            return null;
        }

        // Create new webhook
        logger.info(`[Webhook Manager] Creating new webhook in channel ${channelId}.`, { guildId: channel.guild.id, channelId, category: 'announcer' });
        const newWebhook = await channel.createWebhook({ name: desiredName, avatar: desiredAvatarURL, reason: 'For custom announcements' });
        return new WebhookClient({ id: newWebhook.id, token: newWebhook.token });

    } catch (e) {
        logger.error(`[Webhook Manager] Failed to get or update webhook.`, {
            guildId: client.channels.cache.get(channelId)?.guild?.id || 'N/A',
            channelId: channelId,
            errorMessage: e.message,
            errorStack: e.stack,
            category: 'announcer'
        });
        return null;
    }
}

async function updateAnnouncement(client, subContext, liveData, existingAnnouncement, guildSettings, channelSettings, teamSettings, targetChannelId) {
    if (!liveData || typeof liveData.platform !== 'string') {
        logger.error(`[Announcer] Invalid liveData for ${subContext.username}.`, { guildId: subContext.guild_id, category: 'announcer' });
        return null;
    }

    if (liveData.profileImageUrl && liveData.profileImageUrl !== subContext.profile_image_url) {
        db.execute('UPDATE streamers SET profile_image_url = ? WHERE streamer_id = ?', [liveData.profileImageUrl, subContext.streamer_id]).catch(dbError => {
            logger.error(`[Announcer] Failed to update profile image.`, { error: dbError, guildId: subContext.guild_id, category: 'announcer' });
        });
    }

    if (!targetChannelId) return null;

    const platformName = liveData.platform.charAt(0).toUpperCase() + liveData.platform.slice(1);

    const embed = new EmbedBuilder()
        .setColor(platformColors[liveData.platform] || platformColors.default)
        .setAuthor({ name: `${liveData.username} is LIVE on ${platformName}!`, url: liveData.url })
        .setTitle(liveData.title || 'Untitled Stream').setURL(liveData.url)
        .addFields({ name: 'Playing', value: liveData.game || 'N/A', inline: true })
        .setTimestamp();
    if (liveData.thumbnailUrl) embed.setImage(`${liveData.thumbnailUrl}?t=${Date.now()}`);

    let content = subContext.custom_message ? subContext.custom_message
        .replaceAll(/{username}/g, liveData.username)
        .replaceAll(/{platform}/g, platformName)
        .replaceAll(/{url}/g, liveData.url)
        .replaceAll(/{title}/g, liveData.title || 'Untitled Stream')
        .replaceAll(/{game}/g, liveData.game || 'N/A') : null;

    try {
        let finalNickname = teamSettings?.webhook_name || guildSettings?.bot_nickname || WEBHOOK_NAME_PREFIX;
        let finalAvatarURL = teamSettings?.webhook_avatar_url || guildSettings?.webhook_avatar_url || client.user.displayAvatarURL();

        if (channelSettings?.override_nickname) finalNickname = channelSettings.override_nickname;
        if (channelSettings?.override_avatar_url) finalAvatarURL = channelSettings.override_avatar_url;

        if (subContext.override_nickname) finalNickname = subContext.override_nickname;
        if (subContext.override_avatar_url) finalAvatarURL = subContext.override_avatar_url;

        const webhookClient = await getWebhookClient(client, targetChannelId, finalNickname, finalAvatarURL);
        if (!webhookClient) {
            logger.error(`[Announcer] Webhook client is null for channel ${targetChannelId}. Cannot send/edit message.`, { guildId: subContext.guild_id, channelId: targetChannelId, category: 'announcer' });
            return null;
        }

        const messageOptions = { username: finalNickname, avatarURL: finalAvatarURL, content, embeds: [embed] };

        if (existingAnnouncement?.message_id) {
            try {
                const editedMessage = await webhookClient.editMessage(existingAnnouncement.message_id, messageOptions);
                return editedMessage;
            } catch (e) {
                if (e instanceof DiscordAPIError && e.code === 10008) { // Unknown Message
                    return { deleted: true };
                } else {
                    logger.error(`[Announcer] Failed to edit existing announcement.`, { guildId: subContext.guild_id, messageId: existingAnnouncement.message_id, error: e, category: 'announcer' });
                    return null;
                }
            }
        } else {
            const sentMessage = await webhookClient.send(messageOptions);
            db.execute('INSERT INTO global_stats (id, total_announcements) VALUES (1, 1) ON DUPLICATE KEY UPDATE total_announcements = total_announcements + 1');
            return sentMessage;
        }
    } catch (error) {
        logger.error(`[Announcer] CRITICAL Failure for ${liveData.username}.`, { error, guildId: subContext.guild_id, channelId: targetChannelId, category: 'announcer' });
        return null;
    }
}

module.exports = { updateAnnouncement };