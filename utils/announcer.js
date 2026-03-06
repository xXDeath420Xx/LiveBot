import { EmbedBuilder, WebhookClient, DiscordAPIError } from 'discord.js';
import pool from './db.js';
import logger from './logger.js';

// Webhook client cache to reduce Discord API calls (5 minute TTL)
const webhookCache = new Map();
const WEBHOOK_CACHE_TTL = 5 * 60 * 1000;
const MAX_WEBHOOK_CACHE = 500;

/**
 * Get cached webhook client or null if expired/missing
 */
function getCachedWebhook(channelId) {
    const cached = webhookCache.get(channelId);
    if (cached && Date.now() - cached.timestamp < WEBHOOK_CACHE_TTL) {
        return cached.client;
    }
    if (cached) {
        webhookCache.delete(channelId);
    }
    return null;
}

/**
 * Cache a webhook client
 */
function cacheWebhook(channelId, webhookClient) {
    // Enforce max size
    if (webhookCache.size >= MAX_WEBHOOK_CACHE && !webhookCache.has(channelId)) {
        const oldestKey = webhookCache.keys().next().value;
        webhookCache.delete(oldestKey);
    }
    webhookCache.set(channelId, {
        client: webhookClient,
        timestamp: Date.now()
    });
}

/**
 * Clear cached webhook for a channel (call when webhook is deleted/changed)
 */
function invalidateWebhookCache(channelId) {
    webhookCache.delete(channelId);
}

// Platform color definitions
const platformColors = {
    twitch: '#9146FF',
    youtube: '#FF0000',
    kick: '#52E252',
    tiktok: '#00f2ea',
    trovo: '#21d464',
    default: '#36393f'
};

const WEBHOOK_NAME_PREFIX = 'CertiFried MultiTool';

/**
 * Retrieves or creates a webhook client for a given channel (with caching)
 */
async function getWebhookClient(client, channelId, desiredName, desiredAvatarURL) {
    // Helper to safely get guild ID from cached channel
    const getCachedGuildId = (chId) => {
        const ch = client.channels.cache.get(chId);
        if (ch && 'guild' in ch) {
            return ch.guild?.id;
        }
        return undefined;
    };

    // Check cache first to avoid API calls
    const cachedClient = getCachedWebhook(channelId);
    if (cachedClient) {
        logger.debug(`[Webhook Manager] Using cached webhook for channel ${channelId}.`, {
            guildId: getCachedGuildId(channelId),
            category: 'announcer'
        });
        return cachedClient;
    }

    logger.debug(`[Webhook Manager] Processing channel ${channelId}.`, {
        guildId: getCachedGuildId(channelId),
        category: 'announcer'
    });

    try {
        // Priority 1: Check for custom webhook URL from channel_settings
        const [rows] = await pool.execute(
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
            const webhookClient = new WebhookClient({ url: channelSettings.webhook_url });
            cacheWebhook(channelId, webhookClient);
            return webhookClient;
        }

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
            logger.warn(`[Webhook Manager] Channel ${channelId} not found, not in a guild, or not a text channel.`, {
                category: 'announcer'
            });
            return null;
        }

        // Type guard for text channels with guild
        if (!('guild' in channel) || !channel.guild) {
            logger.warn(`[Webhook Manager] Channel ${channelId} not found, not in a guild, or not a text channel.`, {
                category: 'announcer'
            });
            return null;
        }

        const textChannel = channel;

        const botMember = await textChannel.guild.members.fetch(client.user.id).catch(() => null);
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
        let webhook = webhooks.find(wh => wh.owner?.id === client.user.id && wh.name.startsWith(WEBHOOK_NAME_PREFIX));

        if (webhook) {
            // Reuse existing webhook
            logger.info(`[Webhook Manager] Reusing existing webhook ${webhook.id} in channel ${channelId}.`, {
                guildId: textChannel.guild.id,
                channelId,
                webhookId: webhook.id,
                category: 'announcer'
            });
            const webhookClient = new WebhookClient({ id: webhook.id, token: webhook.token });
            cacheWebhook(channelId, webhookClient);
            return webhookClient;
        }

        // If no existing webhook, check limit before creating
        if (webhooks.size >= 15) {
            logger.error(`[Webhook Manager] Maximum number of webhooks (15) reached in channel ${channelId}. Cannot create new webhook.`, {
                guildId: textChannel.guild.id,
                channelId,
                category: 'announcer'
            });
            return null;
        }

        // Create new webhook with generic name
        logger.info(`[Webhook Manager] Creating new webhook in channel ${channelId}.`, {
            guildId: textChannel.guild.id,
            channelId,
            category: 'announcer'
        });
        const newWebhook = await textChannel.createWebhook({
            name: WEBHOOK_NAME_PREFIX,
            avatar: client.user.displayAvatarURL(),
            reason: 'For stream announcements - username/avatar set per message'
        });
        const webhookClient = new WebhookClient({ id: newWebhook.id, token: newWebhook.token });
        cacheWebhook(channelId, webhookClient);
        return webhookClient;

    } catch (e) {
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
 */
async function updateAnnouncement(
    client,
    subContext,
    liveData,
    existingAnnouncement,
    guildSettings,
    channelSettings,
    teamSettings,
    targetChannelId
) {
    if (!liveData || typeof liveData.platform !== 'string') {
        logger.error(`[Announcer] Invalid liveData for ${subContext.username}.`, {
            guildId: subContext.guild_id,
            category: 'announcer'
        });
        return null;
    }

    // Update profile image if changed
    if (liveData.profileImageUrl && liveData.profileImageUrl !== subContext.profile_image_url) {
        pool.execute(
            'UPDATE streamers SET profile_image_url = ? WHERE streamer_id = ?',
            [liveData.profileImageUrl, subContext.streamer_id]
        ).catch((dbError) => {
            logger.error(`[Announcer] Failed to update profile image.`, {
                error: dbError,
                guildId: subContext.guild_id,
                category: 'announcer'
            });
        });
    }

    if (!targetChannelId) return null;

    const platformName = liveData.platform.charAt(0).toUpperCase() + liveData.platform.slice(1);
    const platformColor = (platformColors[liveData.platform] || platformColors.default);

    const embed = new EmbedBuilder()
        .setColor(platformColor)
        .setAuthor({ name: `${liveData.username} is LIVE on ${platformName}!`, url: liveData.url })
        .setTitle(liveData.title || 'Untitled Stream')
        .setURL(liveData.url)
        .addFields({ name: 'Playing', value: liveData.game || 'N/A', inline: true })
        .setTimestamp();

    // Debug: Log thumbnail URL
    logger.info(`[Announcer] Thumbnail check for ${liveData.username}:`, {
        hasThumbnailUrl: !!liveData.thumbnailUrl,
        thumbnailUrl: liveData.thumbnailUrl,
        platform: liveData.platform,
        category: 'announcer'
    });

    if (liveData.thumbnailUrl) {
        // New messages: cache-bust so Discord fetches a fresh thumbnail
        // Edits: use stable URL so Discord reuses the cached image (no flicker)
        const imageUrl = existingAnnouncement?.message_id
            ? liveData.thumbnailUrl
            : `${liveData.thumbnailUrl}?t=${Date.now()}`;
        embed.setImage(imageUrl);
    }

    let content = subContext.custom_message
        ? subContext.custom_message
            .replace(/{username}/g, liveData.username)
            .replace(/{streamer}/g, liveData.username)
            .replace(/{platform}/g, platformName)
            .replace(/{url}/g, liveData.url)
            .replace(/{title}/g, liveData.title || 'Untitled Stream')
            .replace(/{game}/g, liveData.game || 'N/A')
        : null;

    try {
        // Determine if this guild uses webhook persona (streamer name/avatar) or bot-direct mode
        const useWebhookPersona = guildSettings?.use_webhook_persona === 1;

        // Always use platform username, not Discord username
        let finalNickname = liveData.username;
        // Start with default bot avatar or team avatar (ignore guild-level customization)
        let finalAvatarURL = teamSettings?.webhook_avatar_url || client.user.displayAvatarURL();

        if (useWebhookPersona) {
            // If streamer has linked Discord account, use their Discord avatar
            if (subContext.discord_user_id) {
                try {
                    const discordUser = await client.users.fetch(subContext.discord_user_id);
                    if (discordUser) {
                        finalAvatarURL = discordUser.displayAvatarURL({ size: 256 });
                    }
                } catch (error) {
                    logger.warn(`[Announcer] Failed to fetch Discord user avatar for ${liveData.username}`, {
                        discordUserId: subContext.discord_user_id,
                        error,
                        category: 'announcer'
                    });
                    finalAvatarURL = liveData.profileImageUrl || finalAvatarURL;
                }
            } else {
                finalAvatarURL = liveData.profileImageUrl || finalAvatarURL;
            }

            // Allow channel/subscriber-specific overrides
            if (channelSettings?.override_avatar_url) finalAvatarURL = channelSettings.override_avatar_url;
            if (subContext.override_avatar_url) finalAvatarURL = subContext.override_avatar_url;
            if (subContext.override_nickname) finalNickname = subContext.override_nickname;
            else if (channelSettings?.override_nickname) finalNickname = channelSettings.override_nickname;
        }

        // ── Bot-direct mode: send as the bot via channel.send() ──
        if (!useWebhookPersona) {
            const channel = client.channels.cache.get(targetChannelId)
                || await client.channels.fetch(targetChannelId).catch(() => null);

            if (!channel) {
                logger.error(`[Announcer] Channel ${targetChannelId} not found for bot-direct send.`, {
                    guildId: subContext.guild_id, category: 'announcer'
                });
                return null;
            }

            const botMessageOptions = {
                content: content || undefined,
                embeds: [embed]
            };

            let shouldSendNew = !existingAnnouncement?.message_id;

            if (existingAnnouncement?.message_id) {
                try {
                    const existingMsg = await channel.messages.fetch(existingAnnouncement.message_id);
                    // Only the message author can edit — if this was a webhook message, edit will fail
                    if (existingMsg.author.id === client.user.id) {
                        const editedMessage = await existingMsg.edit(botMessageOptions);
                        logger.info(`[Announcer] Bot-direct message edited for ${liveData.username} - Message ID: ${editedMessage?.id || 'NO_ID'}`, {
                            username: liveData.username, channelId: targetChannelId, messageId: editedMessage?.id, category: 'announcer'
                        });
                        return editedMessage;
                    } else {
                        // Existing message was sent by webhook — leave it alone until stream ends
                        logger.info(`[Announcer] Existing announcement for ${liveData.username} is a webhook message — skipping edit, will use bot-direct on next stream`, {
                            username: liveData.username, channelId: targetChannelId, messageId: existingAnnouncement.message_id, category: 'announcer'
                        });
                        return existingMsg;
                    }
                } catch (e) {
                    if (e instanceof DiscordAPIError && e.code === 10008) {
                        logger.warn(`[Announcer] Old message not found (code 10008) - sending new bot-direct message for ${liveData.username}`, {
                            username: liveData.username, messageId: existingAnnouncement.message_id, channelId: targetChannelId, category: 'announcer'
                        });
                        shouldSendNew = true;
                    } else {
                        // Message exists but edit failed for other reason — don't spam a new one
                        logger.warn(`[Announcer] Failed to edit existing bot-direct announcement — keeping existing message - ${e.message}`, {
                            guildId: subContext.guild_id, messageId: existingAnnouncement.message_id, error: e.message, category: 'announcer'
                        });
                        return null;
                    }
                }
            }

            if (shouldSendNew) {
                const sentMessage = await channel.send(botMessageOptions);
                logger.info(`[Announcer] Bot-direct message sent for ${liveData.username} - Message ID: ${sentMessage?.id || 'NO_ID'}`, {
                    username: liveData.username, channelId: targetChannelId, messageId: sentMessage?.id, category: 'announcer'
                });
                pool.execute(
                    'INSERT INTO global_stats (id, total_announcements) VALUES (1, 1) ON DUPLICATE KEY UPDATE total_announcements = total_announcements + 1'
                );
                return sentMessage;
            }
            return null;
        }

        // ── Webhook persona mode: send as the streamer via webhook ──
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

        // Debug: Log embed structure for Kick
        if (liveData.platform === 'kick') {
            const embedData = embed.toJSON();
            logger.info(`[Announcer] Embed data for ${liveData.username}:`, {
                hasImage: !!embedData.image,
                imageUrl: embedData.image?.url,
                embedKeys: Object.keys(embedData),
                category: 'announcer'
            });
        }

        // Try to edit existing message if it exists
        let shouldSendNew = !existingAnnouncement?.message_id;

        if (existingAnnouncement?.message_id) {
            try {
                const editedMessage = await webhookClient.editMessage(existingAnnouncement.message_id, messageOptions);
                logger.info(`[Announcer] Message edited for ${liveData.username} - Message ID: ${editedMessage?.id || 'NO_ID'}`, {
                    username: liveData.username,
                    channelId: targetChannelId,
                    messageId: editedMessage?.id,
                    category: 'announcer'
                });
                return editedMessage;
            } catch (e) {
                if (e instanceof DiscordAPIError && e.code === 10008) { // Unknown Message
                    logger.warn(`[Announcer] Old message not found (code 10008) - sending new message for ${liveData.username}`, {
                        username: liveData.username,
                        messageId: existingAnnouncement.message_id,
                        channelId: targetChannelId,
                        category: 'announcer'
                    });
                } else {
                    logger.warn(`[Announcer] Failed to edit existing announcement, will send new message - ${e.message}`, {
                        guildId: subContext.guild_id,
                        messageId: existingAnnouncement.message_id,
                        error: e.message,
                        category: 'announcer'
                    });
                }
                shouldSendNew = true;
            }
        }

        // Send new message if no existing message or if old message was deleted
        if (shouldSendNew) {
            const sentMessage = await webhookClient.send(messageOptions);
            logger.info(`[Announcer] Message sent for ${liveData.username} - Message ID: ${sentMessage?.id || 'NO_ID'}`, {
                username: liveData.username,
                channelId: targetChannelId,
                messageId: sentMessage?.id,
                hasId: !!sentMessage?.id,
                category: 'announcer'
            });
            pool.execute(
                'INSERT INTO global_stats (id, total_announcements) VALUES (1, 1) ON DUPLICATE KEY UPDATE total_announcements = total_announcements + 1'
            );
            return sentMessage;
        }
    } catch (error) {
        logger.error(`[Announcer] CRITICAL Failure for ${liveData.username}.`, {
            error,
            guildId: subContext.guild_id,
            channelId: targetChannelId,
            category: 'announcer'
        });
        return null;
    }
}

/**
 * Deletes an announcement message
 */
async function deleteAnnouncement(client, channelId, messageId) {
    try {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
            logger.warn(`[Announcer] Channel ${channelId} not found or not text-based for message deletion.`, {
                category: 'announcer'
            });
            return false;
        }

        const message = await channel.messages.fetch(messageId).catch(() => null);
        if (message) {
            await message.delete();
            logger.info(`[Announcer] Deleted announcement message ${messageId} in channel ${channelId}`, {
                channelId,
                messageId,
                category: 'announcer'
            });
            return true;
        } else {
            logger.warn(`[Announcer] Message ${messageId} not found in channel ${channelId}`, {
                channelId,
                messageId,
                category: 'announcer'
            });
            return false;
        }
    } catch (error) {
        logger.error(`[Announcer] Failed to delete announcement message ${messageId}:`, {
            error,
            channelId,
            messageId,
            category: 'announcer'
        });
        return false;
    }
}

/**
 * Edits an announcement to show "stream has ended" with optional VOD link.
 * Used instead of deleting for specific guild/channel combos.
 *
 * @param {import('discord.js').Client} client - Discord client
 * @param {string} channelId - Channel containing the message
 * @param {string} messageId - Message to edit
 * @param {string} username - Streamer username
 * @param {string} platform - Platform name
 * @param {{ url: string, title: string } | null} vod - VOD info or null
 * @returns {Promise<boolean>} true if edited successfully
 */
async function editAnnouncementStreamEnded(client, channelId, messageId, username, platform, vod) {
    try {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
            logger.warn(`[Announcer] Channel ${channelId} not found for stream-ended edit`, { category: 'announcer' });
            return false;
        }

        const message = await channel.messages.fetch(messageId).catch(() => null);
        if (!message) {
            logger.warn(`[Announcer] Message ${messageId} not found for stream-ended edit`, { category: 'announcer' });
            return false;
        }

        const platformName = platform.charAt(0).toUpperCase() + platform.slice(1);
        const existingEmbed = message.embeds[0];

        const embed = new EmbedBuilder()
            .setColor('#808080')
            .setAuthor({ name: `${username} was LIVE on ${platformName}`, url: existingEmbed?.url || undefined })
            .setTitle('Stream has ended')
            .setTimestamp();

        if (existingEmbed?.url) embed.setURL(existingEmbed.url);

        if (vod) {
            embed.setDescription(`**[Watch the VOD](${vod.url})**\n${vod.title}`);
        } else {
            embed.setDescription('This streamer does not have VODs enabled — sorry you missed the stream!');
        }

        await message.edit({ embeds: [embed] });

        logger.info(`[Announcer] Edited announcement to stream-ended for ${username}`, {
            channelId, messageId, hasVod: !!vod, category: 'announcer'
        });
        return true;
    } catch (error) {
        logger.error(`[Announcer] Failed to edit announcement for stream-ended: ${error.message}`, {
            channelId, messageId, username, error: error.message, category: 'announcer'
        });
        return false;
    }
}

export { updateAnnouncement, getWebhookClient, deleteAnnouncement, editAnnouncementStreamEnded, invalidateWebhookCache };
export default { updateAnnouncement, getWebhookClient, deleteAnnouncement, editAnnouncementStreamEnded, invalidateWebhookCache };
