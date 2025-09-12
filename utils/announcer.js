const { EmbedBuilder, WebhookClient } = require('discord.js');
const db = require('./db');

const platformColors = {
    twitch: '#9146FF', youtube: '#FF0000', kick: '#52E252',
    tiktok: '#00f2ea', trovo: '#21d464', default: '#36393f'
};

const WEBHOOK_NAME_PREFIX = 'CertiFried Announcer';

async function getOrCreateWebhook(client, channelId, defaultAvatarUrl) {
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased()) return null;
        const webhooks = await channel.fetchWebhooks();
        let webhook = webhooks.find(wh => wh.owner?.id === client.user.id && wh.name.startsWith(WEBHOOK_NAME_PREFIX));
        if (!webhook) {
            webhook = await channel.createWebhook({ name: WEBHOOK_NAME_PREFIX, avatar: defaultAvatarUrl || client.user.displayAvatarURL(), reason: 'For custom announcements' });
        }
        return new WebhookClient({ id: webhook.id, token: webhook.token });
    } catch (e) {
        console.error(`[Webhook Manager] Failed for channel ${channelId}:`, e.message);
        return null;
    }
}

async function updateAnnouncement(client, subContext, liveData, existingAnnouncement, guildSettings, channelSettings) {
    if (!liveData || typeof liveData.platform !== 'string') {
        console.error(`[Announcer] Invalid liveData for ${subContext.username}. Aborting.`, liveData);
        return null;
    }

    const channelId = subContext.announcement_channel_id || guildSettings?.announcement_channel_id;
    if (!channelId) return null;

    const platformName = liveData.platform.charAt(0).toUpperCase() + liveData.platform.slice(1);

    const embed = new EmbedBuilder()
        .setColor(platformColors[liveData.platform] || platformColors.default)
        .setAuthor({ name: `${liveData.username} is LIVE on ${platformName}!`, url: liveData.url })
        .setTitle(liveData.title || 'Untitled Stream').setURL(liveData.url)
        .addFields({ name: 'Playing', value: liveData.game || 'N/A', inline: true })
        .setTimestamp();
    if (liveData.thumbnailUrl) embed.setImage(`${liveData.thumbnailUrl}?t=${Date.now()}`);

    // This section correctly checks for and applies the custom message.
    let content = null;
    if (subContext.custom_message) {
        content = subContext.custom_message
            .replaceAll(/{username}/g, liveData.username)
            .replaceAll(/{platform}/g, platformName)
            .replaceAll(/{url}/g, liveData.url)
            .replaceAll(/{title}/g, liveData.title || 'Untitled Stream')
            .replaceAll(/{game}/g, liveData.game || 'N/A');
    }

    try {
        // This section correctly cascades all appearance settings.
        let finalNickname = guildSettings?.bot_nickname || WEBHOOK_NAME_PREFIX;
        let finalAvatarURL = guildSettings?.webhook_avatar_url || client.user.displayAvatarURL();
        if (channelSettings?.override_nickname) finalNickname = channelSettings.override_nickname;
        if (channelSettings?.override_avatar_url) finalAvatarURL = channelSettings.override_avatar_url;
        if (subContext.override_nickname) finalNickname = subContext.override_nickname;
        if (subContext.override_avatar_url) finalAvatarURL = subContext.override_avatar_url;

        const webhookClient = await getOrCreateWebhook(client, channelId, finalAvatarURL);
        if (!webhookClient) return null;

        const messageOptions = { username: finalNickname, avatarURL: finalAvatarURL, content, embeds: [embed] };

        if (existingAnnouncement?.message_id) {
            try {
                return await webhookClient.editMessage(existingAnnouncement.message_id, messageOptions);
            } catch (e) {
                // If editing fails, post a new message and update the DB record.
                const newMessage = await webhookClient.send(messageOptions);
                await db.execute('UPDATE announcements SET message_id = ? WHERE announcement_id = ?', [newMessage.id, existingAnnouncement.announcement_id]);
                return newMessage;
            }
        } else {
            return await webhookClient.send(messageOptions);
        }
    } catch (error) {
        console.error(`[Announcer] Failure for ${liveData.username} in #${channelId}:`, error.message);
        return null;
    }
}

module.exports = { updateAnnouncement };