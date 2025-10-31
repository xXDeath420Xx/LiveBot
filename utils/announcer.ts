import { EmbedBuilder, WebhookClient, DiscordAPIError, Client, TextChannel, Message } from 'discord.js';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { pool as db } from './db';
import { logger } from './logger';

// Platform color definitions
interface PlatformColors {
    twitch: string;
    youtube: string;
    kick: string;
    tiktok: string;
    trovo: string;
    default: string;
    [key: string]: string;
}

const platformColors: PlatformColors = {
    twitch: '#9146FF',
    youtube: '#FF0000',
    kick: '#52E252',
    tiktok: '#00f2ea',
    trovo: '#21d464',
    default: '#36393f'
};

const WEBHOOK_NAME_PREFIX = 'CertiFried MultiTool';

// Database row interfaces
interface ChannelSettingsRow extends RowDataPacket {
    webhook_url: string | null;
    override_nickname: string | null;
    override_avatar_url: string | null;
}

interface SubContext {
    streamer_id: string | number;
    username: string;
    guild_id: string;
    profile_image_url: string | null;
    custom_message: string | null;
    override_nickname: string | null;
    override_avatar_url: string | null;
    discord_user_id?: string | null;
}

interface LiveData {
    platform: string;
    username: string;
    url: string;
    title: string | null;
    game: string | null;
    thumbnailUrl: string | null;
    profileImageUrl: string | null;
}

interface ExistingAnnouncement {
    message_id: string;
    channel_id?: string;
}

interface GuildSettings {
    guild_id: string;
    bot_nickname: string | null;
    webhook_avatar_url: string | null;
}

interface ChannelSettings {
    channel_id: string;
    webhook_url: string | null;
    override_nickname: string | null;
    override_avatar_url: string | null;
}

interface TeamSettings {
    team_id: string;
    webhook_name: string | null;
    webhook_avatar_url: string | null;
}

interface MessageResult extends Message {
    deleted?: boolean;
}

/**
 * Retrieves or creates a webhook client for a given channel
 * @param client - Discord client instance
 * @param channelId - ID of the channel to get webhook for
 * @param desiredName - Desired webhook name (unused in current implementation)
 * @param desiredAvatarURL - Desired webhook avatar URL (unused in current implementation)
 * @returns WebhookClient or null if failed
 */
async function getWebhookClient(
    client: Client,
    channelId: string,
    _desiredName: string,
    _desiredAvatarURL: string
): Promise<WebhookClient | null> {
    // Helper to safely get guild ID from cached channel
    const getCachedGuildId = (chId: string): string | undefined => {
        const ch = client.channels.cache.get(chId);
        if (ch && 'guild' in ch) {
            return (ch as TextChannel).guild?.id;
        }
        return undefined;
    };

    logger.debug(`[Webhook Manager] Processing channel ${channelId}.`, {
        guildId: getCachedGuildId(channelId),
        category: 'announcer'
    });

    try {
        // Priority 1: Check for custom webhook URL from channel_settings
        const [rows] = await db.execute<ChannelSettingsRow[]>(
            'SELECT webhook_url FROM channel_settings WHERE channel_id = ?',
            [channelId]
        );
        const channelSettings = rows[0];

        if (channelSettings && channelSettings.webhook_url) {
            logger.info(`[Webhook Manager] Using custom webhook URL for channel ${channelId}.`, {
                guildId: getCachedGuildId(channelId),
                channelId,
                category: 'announcer'
            });
            return new WebhookClient({ url: channelSettings.webhook_url });
        }

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
            logger.warn(`[Webhook Manager] Channel ${channelId} not found, not in a guild, or not a text channel.`, {
                category: 'announcer'
            });
            return null;
        }

        // Type guard for text channels with guild - must be TextChannel for webhook operations
        if (!('guild' in channel) || !channel.guild) {
            logger.warn(`[Webhook Manager] Channel ${channelId} not found, not in a guild, or not a text channel.`, {
                category: 'announcer'
            });
            return null;
        }

        const textChannel = channel as TextChannel;

        const botMember = await textChannel.guild.members.fetch(client.user!.id).catch(() => null);
        if (!botMember) {
            logger.error(`[Webhook Manager] Could not fetch bot's own member object in guild ${textChannel.guild.id}.`, {
                guildId: textChannel.guild.id,
                category: 'announcer'
            });
            return null;
        }

        const permissions = textChannel.permissionsFor(botMember);
        if (!permissions || !permissions.has(['ManageWebhooks', 'SendMessages'])) {
            logger.warn(`[Webhook Manager] Missing ManageWebhooks or SendMessages permission in channel ${channelId}.`, {
                guildId: textChannel.guild.id,
                category: 'announcer'
            });
            return null;
        }

        const webhooks = await textChannel.fetchWebhooks();
        let webhook = webhooks.find(wh => wh.owner?.id === client.user!.id && wh.name.startsWith(WEBHOOK_NAME_PREFIX));

        if (webhook) {
            // Reuse existing webhook - DO NOT edit it, username/avatar are overridden per message
            logger.debug(`[Webhook Manager] Reusing existing webhook ${webhook.id} in channel ${channelId}.`, {
                guildId: textChannel.guild.id,
                channelId,
                category: 'announcer'
            });
            return new WebhookClient({ id: webhook.id, token: webhook.token! });
        }

        // If no existing webhook, check limit before creating
        if (webhooks.size >= 15) {
            logger.error(`[Webhook Manager] Maximum number of webhooks (15) reached in channel ${channelId}. Cannot create new webhook. Please clear some or add a custom webhook URL in the dashboard.`, {
                guildId: textChannel.guild.id,
                channelId,
                category: 'announcer'
            });
            return null;
        }

        // Create new webhook with generic name - username/avatar are overridden per message
        logger.info(`[Webhook Manager] Creating new webhook in channel ${channelId}.`, {
            guildId: textChannel.guild.id,
            channelId,
            category: 'announcer'
        });
        const newWebhook = await textChannel.createWebhook({
            name: WEBHOOK_NAME_PREFIX,
            avatar: client.user!.displayAvatarURL(),
            reason: 'For stream announcements - username/avatar set per message'
        });
        return new WebhookClient({ id: newWebhook.id, token: newWebhook.token! });

    } catch (e: any) {
        logger.error(`[Webhook Manager] Failed to get or update webhook.`, {
            guildId: getCachedGuildId(channelId) || 'N/A',
            channelId: channelId,
            errorMessage: e.message,
            errorStack: e.stack,
            category: 'announcer'
        });
        return null;
    }
}

/**
 * Updates or creates a stream announcement
 * @param client - Discord client instance
 * @param subContext - Streamer subscription context
 * @param liveData - Live stream data
 * @param existingAnnouncement - Existing announcement to edit (if any)
 * @param guildSettings - Guild-level settings
 * @param channelSettings - Channel-level settings
 * @param teamSettings - Team-level settings
 * @param targetChannelId - Channel ID to send announcement to
 * @returns Message result or null if failed
 */
async function updateAnnouncement(
    client: Client,
    subContext: SubContext,
    liveData: LiveData,
    existingAnnouncement: ExistingAnnouncement | null,
    guildSettings: GuildSettings | null,
    channelSettings: ChannelSettings | null,
    teamSettings: TeamSettings | null,
    targetChannelId: string | null
): Promise<MessageResult | null> {
    if (!liveData || typeof liveData.platform !== 'string') {
        logger.error(`[Announcer] Invalid liveData for ${subContext.username}.`, {
            guildId: subContext.guild_id,
            category: 'announcer'
        });
        return null;
    }

    if (liveData.profileImageUrl && liveData.profileImageUrl !== subContext.profile_image_url) {
        db.execute<ResultSetHeader>(
            'UPDATE streamers SET profile_image_url = ? WHERE streamer_id = ?',
            [liveData.profileImageUrl, subContext.streamer_id]
        ).catch((dbError: any) => {
            logger.error(`[Announcer] Failed to update profile image.`, {
                error: dbError,
                guildId: subContext.guild_id,
                category: 'announcer'
            });
        });
    }

    if (!targetChannelId) return null;

    const platformName = liveData.platform.charAt(0).toUpperCase() + liveData.platform.slice(1);

    const platformColor = (platformColors[liveData.platform] || platformColors.default) as `#${string}`;

    const embed = new EmbedBuilder()
        .setColor(platformColor)
        .setAuthor({ name: `${liveData.username} is LIVE on ${platformName}!`, url: liveData.url })
        .setTitle(liveData.title || 'Untitled Stream')
        .setURL(liveData.url)
        .addFields({ name: 'Playing', value: liveData.game || 'N/A', inline: true })
        .setTimestamp();

    if (liveData.thumbnailUrl) {
        embed.setImage(`${liveData.thumbnailUrl}?t=${Date.now()}`);
    }

    let content: string | null = subContext.custom_message
        ? subContext.custom_message
            .replace(/{username}/g, liveData.username)
            .replace(/{platform}/g, platformName)
            .replace(/{url}/g, liveData.url)
            .replace(/{title}/g, liveData.title || 'Untitled Stream')
            .replace(/{game}/g, liveData.game || 'N/A')
        : null;

    try {
        // IMPORTANT: Always use platform username, not Discord username
        let finalNickname = liveData.username;
        let finalAvatarURL = teamSettings?.webhook_avatar_url || guildSettings?.webhook_avatar_url || client.user!.displayAvatarURL();

        // If streamer has linked Discord account, use their Discord avatar
        if (subContext.discord_user_id) {
            try {
                const discordUser = await client.users.fetch(subContext.discord_user_id);
                if (discordUser) {
                    finalAvatarURL = discordUser.displayAvatarURL({ size: 256 });
                    logger.info(`[Announcer] Using Discord avatar for ${liveData.username} (Discord ID: ${subContext.discord_user_id})`, {
                        username: liveData.username,
                        discordUserId: subContext.discord_user_id,
                        category: 'announcer'
                    });
                }
            } catch (error) {
                logger.warn(`[Announcer] Failed to fetch Discord user avatar for ${liveData.username}`, {
                    discordUserId: subContext.discord_user_id,
                    error,
                    category: 'announcer'
                });
                // Fall back to platform avatar or bot avatar
                finalAvatarURL = liveData.profileImageUrl || finalAvatarURL;
            }
        } else {
            // No Discord link - use platform avatar or bot avatar
            finalAvatarURL = liveData.profileImageUrl || finalAvatarURL;
        }

        // Allow channel/subscriber-specific overrides (only if explicitly set)
        if (channelSettings?.override_avatar_url) finalAvatarURL = channelSettings.override_avatar_url;
        if (subContext.override_avatar_url) finalAvatarURL = subContext.override_avatar_url;

        // Override nickname only if explicitly set (otherwise keep platform username)
        if (subContext.override_nickname) finalNickname = subContext.override_nickname;
        else if (channelSettings?.override_nickname) finalNickname = channelSettings.override_nickname;

        const webhookClient = await getWebhookClient(client, targetChannelId, finalNickname, finalAvatarURL);
        if (!webhookClient) {
            logger.error(`[Announcer] Webhook client is null for channel ${targetChannelId}. Cannot send/edit message.`, {
                guildId: subContext.guild_id,
                channelId: targetChannelId,
                category: 'announcer'
            });
            return null;
        }

        const messageOptions = {
            username: finalNickname,
            avatarURL: finalAvatarURL,
            content: content || undefined,
            embeds: [embed]
        };

        if (existingAnnouncement?.message_id) {
            try {
                const editedMessage = await webhookClient.editMessage(existingAnnouncement.message_id, messageOptions);
                return editedMessage as unknown as MessageResult;
            } catch (e: any) {
                if (e instanceof DiscordAPIError && e.code === 10008) { // Unknown Message
                    return { deleted: true } as unknown as MessageResult;
                } else {
                    logger.error(`[Announcer] Failed to edit existing announcement.`, {
                        guildId: subContext.guild_id,
                        messageId: existingAnnouncement.message_id,
                        error: e,
                        category: 'announcer'
                    });
                    return null;
                }
            }
        } else {
            const sentMessage = await webhookClient.send(messageOptions);
            db.execute<ResultSetHeader>(
                'INSERT INTO global_stats (id, total_announcements) VALUES (1, 1) ON DUPLICATE KEY UPDATE total_announcements = total_announcements + 1'
            );
            return sentMessage as unknown as MessageResult;
        }
    } catch (error: any) {
        logger.error(`[Announcer] CRITICAL Failure for ${liveData.username}.`, {
            error,
            guildId: subContext.guild_id,
            channelId: targetChannelId,
            category: 'announcer'
        });
        return null;
    }
}

export { updateAnnouncement, getWebhookClient };
export { getWebhookClient as getAndUpdateWebhook };
export { getWebhookClient as getOrCreateWebhook };
export default { updateAnnouncement, getWebhookClient, getAndUpdateWebhook: getWebhookClient, getOrCreateWebhook: getWebhookClient };
