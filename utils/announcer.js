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

async function updateAnnouncement(client, subContext, liveData, existingAnnouncement, guildSettings, channelSettings, teamSettings) {
    if (!liveData || typeof liveData.platform !== 'string') {
        console.error(`[Announcer] Invalid liveData for ${subContext.username}. Aborting.`, liveData);
        return null;
    }

    // Update streamer profile image URL if it has changed
    if (liveData.profileImageUrl && liveData.profileImageUrl !== subContext.profile_image_url) {
        try {
            await db.execute('UPDATE streamers SET profile_image_url = ? WHERE streamer_id = ?', [liveData.profileImageUrl, subContext.streamer_id]);
        } catch (dbError) {
            console.error(`[Announcer] Failed to update profile image for ${subContext.username}:`, dbError);
        }
    }

    const channelId = subContext.announcement_channel_id || teamSettings?.announcement_channel_id || guildSettings?.announcement_channel_id;
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
        // Determine final webhook name and avatar based on precedence
        let finalNickname = guildSettings?.bot_nickname || WEBHOOK_NAME_PREFIX;
        let finalAvatarURL = guildSettings?.webhook_avatar_url || client.user.displayAvatarURL();

        if (channelSettings?.override_nickname) finalNickname = channelSettings.override_nickname;
        if (channelSettings?.override_avatar_url) finalAvatarURL = channelSettings.override_avatar_url;

        if (teamSettings?.webhook_name) finalNickname = teamSettings.webhook_name;
        if (teamSettings?.webhook_avatar_url) finalAvatarURL = teamSettings.webhook_avatar_url;

        if (subContext.override_nickname) finalNickname = subContext.override_nickname;
        if (subContext.override_avatar_url) finalAvatarURL = subContext.override_avatar_url;

        const webhookClient = await getOrCreateWebhook(client, channelId, finalAvatarURL);
        if (!webhookClient) return null;

        const messageOptions = { username: finalNickname, avatarURL: finalAvatarURL, content, embeds: [embed] };

        console.log(`[Announcer Debug] Processing ${liveData.username} (Sub ID: ${subContext.subscription_id}) in channel ${channelId}. Existing announcement:`, existingAnnouncement);

        if (existingAnnouncement?.message_id) {
            try {
                console.log(`[Announcer Debug] Attempting to EDIT message ${existingAnnouncement.message_id} for ${liveData.username}.`);
                const editedMessage = await webhookClient.editMessage(existingAnnouncement.message_id, messageOptions);
                console.log(`[Announcer Debug] Successfully EDITED message ${editedMessage.id} for ${liveData.username}.`);
                return editedMessage;
            } catch (e) {
                console.error(`[Announcer] Failed to EDIT message ${existingAnnouncement.message_id} for ${liveData.username} in #${channelId}:`, e.message);
                // If editing fails, post a new message and update the DB record.
                const newMessage = await webhookClient.send(messageOptions);
                console.log(`[Announcer Debug] Posted NEW message ${newMessage.id} after edit failure for ${liveData.username}.`);
                await db.execute('UPDATE announcements SET message_id = ?, stream_url = ? WHERE announcement_id = ?', [newMessage.id, liveData.url || null, existingAnnouncement.announcement_id]);
                return newMessage;
            }
        } else {
            console.log(`[Announcer Debug] No existing message_id found for ${liveData.username}. Posting NEW message.`);
            return await webhookClient.send(messageOptions);
        }
    } catch (error) {
        console.error(`[Announcer] CRITICAL Failure for ${liveData.username} in #${channelId}:`, error.message);
        return null;
    }
}

module.exports = { updateAnnouncement };