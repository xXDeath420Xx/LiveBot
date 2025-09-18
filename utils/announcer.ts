import { EmbedBuilder, WebhookClient, Client, TextBasedChannel, GuildChannel } from 'discord.js';
import db from './db';
import { LiveStatusResponse } from './api_checks'; // Assuming LiveStatusResponse is exported from api_checks

const platformColors: { [key: string]: string } = {
    twitch: '#9146FF', youtube: '#FF0000', kick: '#52E252',
    tiktok: '#00f2ea', trovo: '#21d464', default: '#36393f'
};

const WEBHOOK_NAME_PREFIX = 'CertiFried Announcer';

// --- Interfaces for DB-fetched data ---
interface StreamerSubscriptionContext {
    streamer_id: number;
    platform: string;
    username: string;
    profile_image_url: string | null;
    announcement_channel_id: string | null;
    custom_message: string | null;
    override_nickname: string | null;
    override_avatar_url: string | null;
    // Add other relevant fields from your `subscriptions` and `streamers` tables
}

interface ExistingAnnouncement {
    announcement_id: number;
    message_id: string;
    channel_id: string;
    // Add other relevant fields from your `announcements` table
}

interface GuildSettings {
    guild_id: string;
    announcement_channel_id: string | null;
    bot_nickname: string | null;
    webhook_avatar_url: string | null;
    // Add other relevant fields from your `guilds` table
}

interface ChannelSettings {
    guild_id: string;
    channel_id: string;
    override_nickname: string | null;
    override_avatar_url: string | null;
    // Add other relevant fields from your `channel_settings` table
}

interface TeamSettings {
    guild_id: string;
    announcement_channel_id: string;
    webhook_name: string | null;
    webhook_avatar_url: string | null;
    // Add other relevant fields from your `twitch_teams` table
}

async function getOrCreateWebhook(client: Client, channelId: string, defaultAvatarUrl: string | null): Promise<WebhookClient | null> {
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) return null;

        const textChannel = channel as TextBasedChannel; // Cast to TextBasedChannel for fetchWebhooks
        const webhooks = await textChannel.fetchWebhooks();
        let webhook = webhooks.find(wh => wh.owner?.id === client.user?.id && wh.name.startsWith(WEBHOOK_NAME_PREFIX));

        if (!webhook) {
            webhook = await textChannel.createWebhook({ name: WEBHOOK_NAME_PREFIX, avatar: defaultAvatarUrl || client.user?.displayAvatarURL(), reason: 'For custom announcements' });
        }
        // WebhookClient expects id and token, ensure they exist
        if (webhook.id && webhook.token) {
            return new WebhookClient({ id: webhook.id, token: webhook.token });
        } else {
            console.error(`[Webhook Manager] Created webhook is missing ID or token for channel ${channelId}.`);
            return null;
        }
    } catch (e: any) {
        console.error(`[Webhook Manager] Failed for channel ${channelId}:`, e.message);
        return null;
    }
}

export async function updateAnnouncement(
    client: Client,
    subContext: StreamerSubscriptionContext,
    liveData: LiveStatusResponse,
    existingAnnouncement: ExistingAnnouncement | undefined,
    guildSettings: GuildSettings | undefined,
    channelSettings: ChannelSettings | undefined,
    teamSettings: TeamSettings | undefined
): Promise<any | null> { // Return type can be more specific if you know the exact message object
    if (!liveData || typeof liveData.platform !== 'string') {
        console.error(`[Announcer] Invalid liveData for ${subContext.username}. Aborting.`, liveData);
        return null;
    }

    // Update streamer profile image URL if it has changed
    if (liveData.profileImageUrl && liveData.profileImageUrl !== subContext.profile_image_url) {
        try {
            await db.execute('UPDATE streamers SET profile_image_url = ? WHERE streamer_id = ?', [liveData.profileImageUrl, subContext.streamer_id]);
        } catch (dbError: any) {
            console.error(`[Announcer] Failed to update profile image for ${subContext.username}:`, dbError);
        }
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
    let content: string | null = null;
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
        let finalAvatarURL = guildSettings?.webhook_avatar_url || client.user?.displayAvatarURL() || null;

        if (channelSettings?.override_nickname) finalNickname = channelSettings.override_nickname;
        if (channelSettings?.override_avatar_url) finalAvatarURL = channelSettings.override_avatar_url;

        if (teamSettings?.webhook_name) finalNickname = teamSettings.webhook_name;
        if (teamSettings?.webhook_avatar_url) finalAvatarURL = teamSettings.webhook_avatar_url;

        if (subContext.override_nickname) finalNickname = subContext.override_nickname;
        if (subContext.override_avatar_url) finalAvatarURL = subContext.override_avatar_url;

        const webhookClient = await getOrCreateWebhook(client, channelId, finalAvatarURL);
        if (!webhookClient) return null;

        const messageOptions = { username: finalNickname, avatarURL: finalAvatarURL || undefined, content: content || undefined, embeds: [embed] };

        if (existingAnnouncement?.message_id) {
            try {
                return await webhookClient.editMessage(existingAnnouncement.message_id, messageOptions);
            } catch (e: any) {
                // If editing fails, post a new message and update the DB record.
                console.error(`[Announcer] Failed to edit message ${existingAnnouncement.message_id} for ${liveData.username}. Posting new message.`, e.message);
                const newMessage = await webhookClient.send(messageOptions);
                await db.execute('UPDATE announcements SET message_id = ? WHERE announcement_id = ?', [newMessage.id, existingAnnouncement.announcement_id]);
                return newMessage;
            }
        } else {
            return await webhookClient.send(messageOptions);
        }
    } catch (error: any) {
        console.error(`[Announcer] Failure for ${liveData.username} in #${channelId}:`, error.message);
        return null;
    }
}
