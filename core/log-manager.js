import logger from '../utils/logger.js';
import db from '../utils/db.js';
import { EmbedBuilder, WebhookClient } from 'discord.js';
import { safeJsonArray } from '../utils/safeJson.js';
import { getMessageById } from '../utils/message-cache.js';

// ===========================
// HELPER FUNCTIONS
// ===========================

/**
 * Get webhook client for a channel, checking for custom webhook URL first
 */
async function getLogWebhookClient(client, channelId) {
    try {
        // Check for custom webhook URL from channel_settings
        const [rows] = await db.execute(
            'SELECT webhook_url FROM channel_settings WHERE channel_id = ?',
            [channelId]
        );

        if (rows && rows.length > 0 && rows[0].webhook_url) {
            logger.info(`[Log Webhook] Using custom webhook for channel ${channelId}`);
            return new WebhookClient({ url: rows[0].webhook_url });
        }

        // Fallback: return null to use regular channel.send()
        return null;
    } catch (error) {
        logger.error('[Log Webhook] Error fetching webhook', { channelId, error: error.message });
        return null;
    }
}

/**
 * Send a log embed to the configured Discord channel
 */
async function sendLogEmbed(guild, eventType, embed) {
    try {
        // Get logging configuration for this guild
        const [configRows] = await db.execute(
            'SELECT log_channel_id, enabled_events, enabled FROM logging_config WHERE guild_id = ?',
            [guild.id]
        );

        if (!configRows || configRows.length === 0) {
            logger.debug(`[sendLogEmbed] No logging config found for guild ${guild.id}`);
            return;
        }

        const config = configRows[0];

        // Check if logging is globally disabled for this guild
        if (config.enabled === 0) {
            logger.debug(`[sendLogEmbed] Logging disabled for guild ${guild.id}`);
            return;
        }

        const enabledEvents = safeJsonArray(config.enabled_events, 'logging enabled_events');

        // Check if this event type is enabled
        if (!enabledEvents.includes(eventType)) {
            logger.debug(`[sendLogEmbed] Event type '${eventType}' not enabled for guild ${guild.id}. Enabled: ${enabledEvents.join(', ')}`);
            return;
        }

        logger.debug(`[sendLogEmbed] Event type '${eventType}' is enabled for guild ${guild.id}`);

        // Check for category-specific channel override
        const [eventConfigRows] = await db.execute(
            'SELECT log_channel_id, enabled FROM log_event_config WHERE guild_id = ? AND event_type = ?',
            [guild.id, eventType]
        );

        let targetChannelId = config.log_channel_id;

        if (eventConfigRows && eventConfigRows.length > 0) {
            const eventConfig = eventConfigRows[0];

            // If event is explicitly disabled in log_event_config, don't log
            if (eventConfig.enabled === 0) {
                logger.debug(`[sendLogEmbed] Event '${eventType}' explicitly disabled in log_event_config for guild ${guild.id}`);
                return;
            }

            // Use category override channel if set
            if (eventConfig.log_channel_id) {
                targetChannelId = eventConfig.log_channel_id;
                logger.debug(`[sendLogEmbed] Using override channel ${targetChannelId} for event ${eventType}`);
            }
        }

        if (!targetChannelId) {
            logger.debug(`[sendLogEmbed] No target channel configured for guild ${guild.id}, event ${eventType}`);
            return;
        }

        logger.debug(`[sendLogEmbed] Attempting to send ${eventType} log to channel ${targetChannelId} for guild ${guild.id}`);

        // Try to use webhook first (respects custom webhooks from dashboard)
        const webhookClient = await getLogWebhookClient(guild.client, targetChannelId);

        if (webhookClient) {
            try {
                await webhookClient.send({ embeds: [embed] });
                logger.debug(`[sendLogEmbed] Sent via webhook to channel ${targetChannelId}`);
                return;
            } catch (webhookError) {
                logger.warn('[sendLogEmbed] Webhook send failed, falling back to channel.send()', {
                    error: webhookError.message
                });
            }
        }

        // Fallback: Send via regular channel
        const logChannel = await guild.channels.fetch(targetChannelId).catch((err) => {
            logger.warn(`[sendLogEmbed] Failed to fetch channel ${targetChannelId}:`, err.message);
            return null;
        });

        if (!logChannel || !logChannel.isTextBased()) {
            logger.warn(`[sendLogEmbed] Channel ${targetChannelId} not found or not text-based for guild ${guild.id}`);
            return;
        }

        await logChannel.send({ embeds: [embed] });
        logger.debug(`[sendLogEmbed] Successfully sent via channel.send() to channel ${targetChannelId}`);
    } catch (error) {
        logger.error('[sendLogEmbed] Error sending log embed', {
            guildId: guild.id,
            eventType,
            error: error.message
        });
    }
}

async function saveAuditLog(
    guildId,
    eventType,
    userId,
    targetId,
    moderatorId,
    channelId,
    action,
    reason,
    oldValue,
    newValue,
    metadata = {}
) {
    try {
        await db.execute(
            `INSERT INTO audit_logs (guild_id, event_type, user_id, target_id, moderator_id, channel_id, action, reason, old_value, new_value, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [guildId, eventType, userId || null, targetId || null, moderatorId || null, channelId || null,
             action, reason || null, oldValue || null, newValue || null, JSON.stringify(metadata)]
        );
    } catch (error) {
        logger.error(`[AUDIT LOG] Failed to save audit log: ${error.message}`, { guildId, eventType, error: error.message });
    }
}

// ===========================
// EXISTING LOG FUNCTIONS
// ===========================

async function logMessageDelete(message) {
    if (!message.guild) return;

    // Skip bot messages if we have author info
    if (message.author && message.author.bot) return;

    const guildId = message.guild.id;
    const channelId = message.channel.id;
    const messageId = message.id;

    let content;
    let authorInfo;
    let authorDisplay;

    if (message.content || message.author) {
        // Discord.js cache hit — use cached data
        content = message.content || 'No content';
        authorInfo = message.author
            ? `${message.author.tag} (${message.author.id})`
            : 'Unknown User';
        authorDisplay = message.author || 'Unknown User';
    } else {
        // Cache miss — look up from database
        const cached = await getMessageById(messageId);
        if (cached) {
            content = cached.content || 'No content';
            authorInfo = `${cached.author_tag} (${cached.author_id})`;
            authorDisplay = cached.author_tag;
        } else {
            content = 'Message not cached';
            authorInfo = 'Unknown User';
            authorDisplay = 'Unknown User';
        }
    }

    const botIdentifier = message.client.isDefaultBot
        ? 'Default Bot'
        : `Custom Bot ${message.client.botId}`;

    logger.info(`[${botIdentifier}] Message deleted in #${message.channel?.name || channelId}${message.author ? ` by ${message.author.tag}` : ''}: ${content}`, {
        guildId,
        channelId,
        userId: message.author?.id,
        messageId,
        content,
        botId: message.client.botId || 'default',
        category: 'messageDelete'
    });

    const embed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('💬 Message Deleted')
        .setDescription(`Message${message.author ? ` by ${authorDisplay}` : ''} was deleted in ${message.channel}`)
        .addFields(
            { name: 'Author', value: authorInfo, inline: true },
            { name: 'Channel', value: `${message.channel.name}`, inline: true },
            { name: 'Message ID', value: messageId, inline: true },
            { name: 'Content', value: content.substring(0, 1024), inline: false }
        )
        .setTimestamp();

    await sendLogEmbed(message.guild, 'messageDelete', embed);
}

async function logMessageUpdate(oldMessage, newMessage) {
    if (!newMessage.guild) return;

    // Skip if no content change or if author is a bot (when available)
    if (oldMessage.content === newMessage.content) return;
    if (newMessage.author && newMessage.author.bot) return;

    // Skip if we don't have author information (partial message)
    if (!newMessage.author) return;

    const guildId = newMessage.guild.id;
    const channelId = newMessage.channel.id;
    const userId = newMessage.author.id;
    const messageId = newMessage.id;
    const oldContent = oldMessage.content;
    const newContent = newMessage.content;

    const botIdentifier = newMessage.client.isDefaultBot
        ? 'Default Bot'
        : `Custom Bot ${newMessage.client.botId}`;

    logger.info(`[${botIdentifier}] Message edited in #${newMessage.channel.toString()} by ${newMessage.author.tag}. Old: "${oldContent}" New: "${newContent}"`, {
        guildId,
        channelId,
        userId,
        messageId,
        oldContent,
        newContent,
        botId: newMessage.client.botId || 'default',
        category: 'messageUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle('✏️ Message Edited')
        .setDescription(`Message by ${newMessage.author} was edited in ${newMessage.channel}`)
        .addFields(
            { name: 'Author', value: `${newMessage.author.tag} (${newMessage.author.id})`, inline: true },
            { name: 'Channel', value: `${newMessage.channel.name}`, inline: true },
            { name: 'Before', value: oldContent ? oldContent.substring(0, 1024) : 'No content', inline: false },
            { name: 'After', value: newContent ? newContent.substring(0, 1024) : 'No content', inline: false }
        )
        .setTimestamp();

    await sendLogEmbed(newMessage.guild, 'messageUpdate', embed);
}

async function logMemberUpdate(oldMember, newMember) {
    if (oldMember.partial || newMember.partial) return;

    const guildId = newMember.guild.id;
    const userId = newMember.id;

    if (oldMember.nickname !== newMember.nickname) {
        logger.info(`Member ${newMember.user.tag} nickname changed from "${oldMember.nickname || 'None'}" to "${newMember.nickname || 'None'}".`, {
            guildId,
            userId,
            oldNickname: oldMember.nickname,
            newNickname: newMember.nickname,
            category: 'memberUpdate'
        });

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('👤 Nickname Changed')
            .setDescription(`${newMember} updated their nickname`)
            .addFields(
                { name: 'User', value: `${newMember.user.tag} (${newMember.id})`, inline: false },
                { name: 'Before', value: oldMember.nickname || 'None', inline: true },
                { name: 'After', value: newMember.nickname || 'None', inline: true }
            )
            .setTimestamp();

        await sendLogEmbed(newMember.guild, 'memberUpdate', embed);
    }

    const oldRoles = oldMember.roles.cache.map(r => r.id);
    const newRoles = newMember.roles.cache.map(r => r.id);

    const addedRoles = newRoles.filter(roleId => !oldRoles.includes(roleId));
    const removedRoles = oldRoles.filter(roleId => !newRoles.includes(roleId));

    if (addedRoles.length > 0) {
        const roleNames = addedRoles.map(id => newMember.guild.roles.cache.get(id)?.name || id).join(', ');
        logger.info(`Roles added to ${newMember.user.tag}: ${roleNames}.`, {
            guildId,
            userId,
            addedRoles,
            category: 'memberUpdate'
        });

        const embed = new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle('🎭 Roles Added')
            .setDescription(`${newMember} received new roles`)
            .addFields(
                { name: 'User', value: `${newMember.user.tag} (${newMember.id})`, inline: false },
                { name: 'Roles Added', value: roleNames, inline: false }
            )
            .setTimestamp();

        await sendLogEmbed(newMember.guild, 'memberUpdate', embed);
    }

    if (removedRoles.length > 0) {
        const roleNames = removedRoles.map(id => newMember.guild.roles.cache.get(id)?.name || id).join(', ');
        logger.info(`Roles removed from ${newMember.user.tag}: ${roleNames}.`, {
            guildId,
            userId,
            removedRoles,
            category: 'memberUpdate'
        });

        const embed = new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle('🎭 Roles Removed')
            .setDescription(`${newMember} lost roles`)
            .addFields(
                { name: 'User', value: `${newMember.user.tag} (${newMember.id})`, inline: false },
                { name: 'Roles Removed', value: roleNames, inline: false }
            )
            .setTimestamp();

        await sendLogEmbed(newMember.guild, 'memberUpdate', embed);
    }
}

async function logVoiceStateUpdate(oldState, newState) {
    // FIX: Add null checks for member and guild
    if (!newState.member || !newState.guild) return;

    const guildId = newState.guild.id;
    const userId = newState.member.id;

    // FIX: Add null checks for oldState.channel and newState.channel
    const oldChannelName = oldState.channel ? `#${oldState.channel.name}` : 'Unknown Channel';
    const newChannelName = newState.channel ? `#${newState.channel.name}` : 'Unknown Channel';

    if (!oldState.channelId && newState.channelId) {
        logger.info(`Member ${newState.member.user.tag} joined voice channel ${newChannelName}.`, {
            guildId,
            userId,
            channelId: newState.channelId,
            category: 'voiceUpdate'
        });
    }
    else if (oldState.channelId && !newState.channelId) {
        logger.info(`Member ${newState.member.user.tag} left voice channel ${oldChannelName}.`, {
            guildId,
            userId,
            channelId: oldState.channelId,
            category: 'voiceUpdate'
        });
    }
    else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
        logger.info(`Member ${newState.member.user.tag} switched voice channel from ${oldChannelName} to ${newChannelName}.`, {
            guildId,
            userId,
            oldChannelId: oldState.channelId,
            newChannelId: newState.channelId,
            category: 'voiceUpdate'
        });
    }
}

// ===========================
// MEMBER EVENT HANDLERS
// ===========================

async function logMemberJoin(member) {
    if (!member.guild) return;

    // Try to determine who invited this member
    let inviteInfo = null;
    try {
        // Get current invites
        const currentInvites = await member.guild.invites.fetch();

        // Check our tracked invites in database
        const [trackedInvites] = await db.execute(
            'SELECT invite_code, inviter_id, uses FROM invite_tracking WHERE guild_id = ?',
            [member.guild.id]
        );

        // Find which invite was used (uses increased by 1)
        for (const [code, invite] of currentInvites) {
            const tracked = trackedInvites.find(t => t.invite_code === code);
            if (tracked && invite.uses > tracked.uses) {
                // This invite was used!
                inviteInfo = {
                    code: code,
                    inviterId: invite.inviter?.id || tracked.inviter_id,
                    inviterTag: invite.inviter?.tag || 'Unknown'
                };

                // Update the uses count
                await db.execute(
                    'UPDATE invite_tracking SET uses = ? WHERE guild_id = ? AND invite_code = ?',
                    [invite.uses, member.guild.id, code]
                );

                // Log who used which invite
                await db.execute(
                    `INSERT INTO invite_tracker_logs (guild_id, user_id, inviter_id, invite_code, event_type)
                     VALUES (?, ?, ?, ?, 'join')`,
                    [member.guild.id, member.id, inviteInfo.inviterId, code]
                );

                break;
            }
        }

        // Check for vanity URL
        if (!inviteInfo && member.guild.vanityURLCode) {
            try {
                const vanity = await member.guild.fetchVanityData();
                // Can't track vanity invites per-user, but note if it was likely used
            } catch (e) {
                // No vanity or no access
            }
        }
    } catch (error) {
        logger.debug(`[MemberJoin] Could not determine invite source: ${error.message}`);
    }

    logger.info(`[JOIN] ${member.user.tag} joined the server${inviteInfo ? ` (invited by ${inviteInfo.inviterTag} via ${inviteInfo.code})` : ''}`, {
        guildId: member.guild.id,
        userId: member.id,
        inviteCode: inviteInfo?.code,
        inviterId: inviteInfo?.inviterId,
        category: 'memberJoin'
    });

    const joinedTimestamp = Math.floor(member.joinedTimestamp / 1000);
    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('👋 Member Joined')
        .setDescription(`${member} joined the server`)
        .addFields(
            { name: 'User', value: `${member.user.tag} (${member.id})`, inline: true },
            { name: 'Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
            { name: 'Joined At', value: `<t:${joinedTimestamp}:f>`, inline: true }
        )
        .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
        .setTimestamp(member.joinedAt);

    // Add invite info if available
    if (inviteInfo) {
        embed.addFields(
            { name: 'Invited By', value: `<@${inviteInfo.inviterId}> (${inviteInfo.inviterTag})`, inline: true },
            { name: 'Invite Code', value: `\`${inviteInfo.code}\``, inline: true }
        );
    }

    await sendLogEmbed(member.guild, 'memberJoin', embed);

    await saveAuditLog(
        member.guild.id,
        'GUILD_MEMBER_JOIN',
        member.id,
        member.id,
        inviteInfo?.inviterId || null,
        null,
        'Member joined',
        null,
        null,
        null,
        {
            username: member.user.tag,
            createdAt: member.user.createdAt.toISOString(),
            inviteCode: inviteInfo?.code,
            invitedBy: inviteInfo?.inviterTag
        }
    );
}

async function logMemberLeave(member) {
    // This is an alias for logGuildMemberRemove for consistency with event naming
    return logGuildMemberRemove(member);
}

async function logMemberNicknameUpdate(oldMember, newMember) {
    if (oldMember.partial || newMember.partial) return;
    if (oldMember.nickname === newMember.nickname) return;

    const guildId = newMember.guild.id;
    const userId = newMember.id;

    logger.info(`Member ${newMember.user.tag} nickname changed from "${oldMember.nickname || 'None'}" to "${newMember.nickname || 'None'}".`, {
        guildId,
        userId,
        oldNickname: oldMember.nickname,
        newNickname: newMember.nickname,
        category: 'memberUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x5865F2) // Blurple
        .setTitle('✏️ Nickname Changed')
        .setDescription(`${newMember}'s nickname was changed`)
        .addFields(
            { name: 'User', value: `${newMember.user.tag} (${newMember.id})`, inline: false },
            { name: 'Old Nickname', value: oldMember.nickname || 'None', inline: true },
            { name: 'New Nickname', value: newMember.nickname || 'None', inline: true }
        )
        .setTimestamp();

    await sendLogEmbed(newMember.guild, 'memberUpdate', embed);

    await saveAuditLog(
        guildId,
        'MEMBER_NICKNAME_UPDATE',
        userId,
        userId,
        null,
        null,
        'Nickname updated',
        null,
        oldMember.nickname || 'None',
        newMember.nickname || 'None',
        { username: newMember.user.tag }
    );
}

async function logMemberRoleUpdate(oldMember, newMember) {
    if (oldMember.partial || newMember.partial) return;

    const guildId = newMember.guild.id;
    const userId = newMember.id;

    const oldRoles = oldMember.roles.cache.map(r => r.id);
    const newRoles = newMember.roles.cache.map(r => r.id);

    const addedRoles = newRoles.filter(roleId => !oldRoles.includes(roleId));
    const removedRoles = oldRoles.filter(roleId => !newRoles.includes(roleId));

    if (addedRoles.length > 0) {
        const roleNames = addedRoles.map(id => newMember.guild.roles.cache.get(id)?.name || id).join(', ');
        logger.info(`Roles added to ${newMember.user.tag}: ${roleNames}.`, {
            guildId,
            userId,
            addedRoles,
            category: 'memberUpdate'
        });

        const embed = new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle('🎭 Roles Added')
            .setDescription(`${newMember} received new roles`)
            .addFields(
                { name: 'User', value: `${newMember.user.tag} (${newMember.id})`, inline: false },
                { name: 'Roles Added', value: roleNames, inline: false }
            )
            .setTimestamp();

        await sendLogEmbed(newMember.guild, 'memberUpdate', embed);

        await saveAuditLog(
            guildId,
            'MEMBER_ROLES_ADDED',
            userId,
            userId,
            null,
            null,
            'Roles added',
            null,
            null,
            roleNames,
            { username: newMember.user.tag, roleIds: addedRoles }
        );
    }

    if (removedRoles.length > 0) {
        const roleNames = removedRoles.map(id => newMember.guild.roles.cache.get(id)?.name || id).join(', ');
        logger.info(`Roles removed from ${newMember.user.tag}: ${roleNames}.`, {
            guildId,
            userId,
            removedRoles,
            category: 'memberUpdate'
        });

        const embed = new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle('🎭 Roles Removed')
            .setDescription(`${newMember} lost roles`)
            .addFields(
                { name: 'User', value: `${newMember.user.tag} (${newMember.id})`, inline: false },
                { name: 'Roles Removed', value: roleNames, inline: false }
            )
            .setTimestamp();

        await sendLogEmbed(newMember.guild, 'memberUpdate', embed);

        await saveAuditLog(
            guildId,
            'MEMBER_ROLES_REMOVED',
            userId,
            userId,
            null,
            null,
            'Roles removed',
            null,
            roleNames,
            null,
            { username: newMember.user.tag, roleIds: removedRoles }
        );
    }
}

async function logVoiceJoin(newState) {
    if (!newState.member || !newState.guild || !newState.channel) return;

    logger.info(`Member ${newState.member.user.tag} joined voice channel #${newState.channel.name}.`, {
        guildId: newState.guild.id,
        userId: newState.member.id,
        channelId: newState.channelId,
        category: 'voiceUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('🔊 Voice Channel Join')
        .setDescription(`${newState.member} joined ${newState.channel}`)
        .addFields(
            { name: 'User', value: `${newState.member.user.tag} (${newState.member.id})`, inline: true },
            { name: 'Channel', value: newState.channel.name, inline: true }
        )
        .setTimestamp();

    await sendLogEmbed(newState.guild, 'voiceUpdate', embed);

    await saveAuditLog(
        newState.guild.id,
        'VOICE_JOIN',
        newState.member.id,
        newState.member.id,
        null,
        newState.channelId,
        'Joined voice channel',
        null,
        null,
        newState.channel.name,
        { username: newState.member.user.tag }
    );
}

async function logVoiceLeave(oldState) {
    // Only require guild and channelId - member might be partial
    if (!oldState.guild || !oldState.channelId) return;

    // Try to get member info, fallback to basic data
    const member = oldState.member || oldState.guild.members.cache.get(oldState.id);
    const channelName = oldState.channel?.name || `Unknown Channel (${oldState.channelId})`;
    const userName = member?.user?.tag || `Unknown User (${oldState.id})`;

    logger.info(`Member ${userName} left voice channel #${channelName}.`, {
        guildId: oldState.guild.id,
        userId: oldState.id,
        channelId: oldState.channelId,
        category: 'voiceUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('🔇 Voice Channel Leave')
        .setDescription(`${member || `<@${oldState.id}>`} left ${oldState.channel || channelName}`)
        .addFields(
            { name: 'User', value: `${userName} (${oldState.id})`, inline: true },
            { name: 'Channel', value: channelName, inline: true }
        )
        .setTimestamp();

    await sendLogEmbed(oldState.guild, 'voiceUpdate', embed);

    await saveAuditLog(
        oldState.guild.id,
        'VOICE_LEAVE',
        oldState.member.id,
        oldState.member.id,
        null,
        oldState.channelId,
        'Left voice channel',
        null,
        oldState.channel.name,
        null,
        { username: oldState.member.user.tag }
    );
}

async function logVoiceMove(oldState, newState) {
    if (!newState.member || !newState.guild || !oldState.channel || !newState.channel) return;

    logger.info(`Member ${newState.member.user.tag} switched voice channel from #${oldState.channel.name} to #${newState.channel.name}.`, {
        guildId: newState.guild.id,
        userId: newState.member.id,
        oldChannelId: oldState.channelId,
        newChannelId: newState.channelId,
        category: 'voiceUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🔀 Voice Channel Move')
        .setDescription(`${newState.member} moved voice channels`)
        .addFields(
            { name: 'User', value: `${newState.member.user.tag} (${newState.member.id})`, inline: false },
            { name: 'From', value: oldState.channel.name, inline: true },
            { name: 'To', value: newState.channel.name, inline: true }
        )
        .setTimestamp();

    await sendLogEmbed(newState.guild, 'voiceUpdate', embed);

    await saveAuditLog(
        newState.guild.id,
        'VOICE_MOVE',
        newState.member.id,
        newState.member.id,
        null,
        newState.channelId,
        'Switched voice channels',
        null,
        oldState.channel.name,
        newState.channel.name,
        { username: newState.member.user.tag }
    );
}

// ===========================
// CHANNEL EVENT HANDLERS
// ===========================

async function logChannelCreate(channel) {
    if (!channel.guild) return;

    logger.info(`[CHANNEL CREATE] #${channel.name} (${channel.type})`, {
        guildId: channel.guild.id,
        channelId: channel.id,
        category: 'channelCreate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('➕ Channel Created')
        .setDescription(`${channel} was created`)
        .addFields(
            { name: 'Channel', value: `${channel.name} (${channel.id})`, inline: true },
            { name: 'Type', value: `${channel.type}`, inline: true }
        )
        .setTimestamp();

    await sendLogEmbed(channel.guild, 'channelCreate', embed);

    await saveAuditLog(
        channel.guild.id,
        'CHANNEL_CREATE',
        null,
        channel.id,
        null,
        channel.id,
        'Channel created',
        null,
        null,
        channel.name,
        { type: channel.type }
    );
}

async function logChannelDelete(channel) {
    if (!channel.guild) return;

    logger.info(`[CHANNEL DELETE] #${channel.name} (${channel.type})`, {
        guildId: channel.guild.id,
        channelId: channel.id,
        category: 'channelDelete'
    });

    const embed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('➖ Channel Deleted')
        .setDescription(`#${channel.name} was deleted`)
        .addFields(
            { name: 'Channel', value: `${channel.name} (${channel.id})`, inline: true },
            { name: 'Type', value: `${channel.type}`, inline: true }
        )
        .setTimestamp();

    await sendLogEmbed(channel.guild, 'channelDelete', embed);

    await saveAuditLog(
        channel.guild.id,
        'CHANNEL_DELETE',
        null,
        channel.id,
        null,
        channel.id,
        'Channel deleted',
        null,
        channel.name,
        null,
        { type: channel.type }
    );
}

async function logChannelUpdate(oldChannel, newChannel) {
    if (!newChannel.guild) return;

    const changes = [];

    // Name change
    if (oldChannel.name !== newChannel.name) {
        changes.push(`**Name:** ${oldChannel.name} → ${newChannel.name}`);
    }

    // Topic change (text channels)
    if ('topic' in oldChannel && 'topic' in newChannel && oldChannel.topic !== newChannel.topic) {
        const oldTopic = oldChannel.topic || '(none)';
        const newTopic = newChannel.topic || '(none)';
        changes.push(`**Topic:** ${oldTopic.substring(0, 50)}${oldTopic.length > 50 ? '...' : ''} → ${newTopic.substring(0, 50)}${newTopic.length > 50 ? '...' : ''}`);
    }

    // NSFW toggle
    if ('nsfw' in oldChannel && 'nsfw' in newChannel && oldChannel.nsfw !== newChannel.nsfw) {
        changes.push(`**NSFW:** ${oldChannel.nsfw ? 'Yes' : 'No'} → ${newChannel.nsfw ? 'Yes' : 'No'}`);
    }

    // Slowmode change
    if ('rateLimitPerUser' in oldChannel && 'rateLimitPerUser' in newChannel && oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) {
        changes.push(`**Slowmode:** ${oldChannel.rateLimitPerUser}s → ${newChannel.rateLimitPerUser}s`);
    }

    // Category/parent change
    if (oldChannel.parentId !== newChannel.parentId) {
        const oldParent = oldChannel.parent?.name || '(none)';
        const newParent = newChannel.parent?.name || '(none)';
        changes.push(`**Category:** ${oldParent} → ${newParent}`);
    }

    // Skip position-only changes — too noisy (reordering channels fires for every channel)
    // if (oldChannel.position !== newChannel.position) {
    //     changes.push(`**Position:** ${oldChannel.position} → ${newChannel.position}`);
    // }

    // Voice channel specific
    if ('bitrate' in oldChannel && 'bitrate' in newChannel && oldChannel.bitrate !== newChannel.bitrate) {
        changes.push(`**Bitrate:** ${oldChannel.bitrate / 1000}kbps → ${newChannel.bitrate / 1000}kbps`);
    }
    if ('userLimit' in oldChannel && 'userLimit' in newChannel && oldChannel.userLimit !== newChannel.userLimit) {
        changes.push(`**User Limit:** ${oldChannel.userLimit || 'Unlimited'} → ${newChannel.userLimit || 'Unlimited'}`);
    }

    // Permission overwrites change
    const oldPerms = oldChannel.permissionOverwrites?.cache;
    const newPerms = newChannel.permissionOverwrites?.cache;
    if (oldPerms && newPerms) {
        const oldPermIds = new Set(oldPerms.keys());
        const newPermIds = new Set(newPerms.keys());

        // Check for added permissions
        for (const id of newPermIds) {
            if (!oldPermIds.has(id)) {
                const overwrite = newPerms.get(id);
                const targetType = overwrite.type === 0 ? 'role' : 'member';
                changes.push(`**Permissions Added:** ${targetType} override`);
                break; // Just note that permissions changed, don't spam
            }
        }

        // Check for removed permissions
        for (const id of oldPermIds) {
            if (!newPermIds.has(id)) {
                changes.push(`**Permissions Removed:** override removed`);
                break;
            }
        }

        // Check for modified permissions
        for (const id of oldPermIds) {
            if (newPermIds.has(id)) {
                const oldOverwrite = oldPerms.get(id);
                const newOverwrite = newPerms.get(id);
                if (oldOverwrite.allow.bitfield !== newOverwrite.allow.bitfield ||
                    oldOverwrite.deny.bitfield !== newOverwrite.deny.bitfield) {
                    changes.push(`**Permissions Modified:** override updated`);
                    break;
                }
            }
        }
    }

    // Default auto-archive duration (threads)
    if ('defaultAutoArchiveDuration' in oldChannel && 'defaultAutoArchiveDuration' in newChannel &&
        oldChannel.defaultAutoArchiveDuration !== newChannel.defaultAutoArchiveDuration) {
        changes.push(`**Auto-Archive:** ${oldChannel.defaultAutoArchiveDuration}min → ${newChannel.defaultAutoArchiveDuration}min`);
    }

    if (changes.length === 0) return;

    logger.info(`[CHANNEL UPDATE] #${newChannel.name}: ${changes.join(', ')}`, {
        guildId: newChannel.guild.id,
        channelId: newChannel.id,
        category: 'channelUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🔧 Channel Updated')
        .setDescription(`${newChannel} was updated`)
        .addFields(
            { name: 'Channel', value: `${newChannel.name} (${newChannel.id})`, inline: false },
            { name: 'Changes', value: changes.join('\n'), inline: false }
        )
        .setTimestamp();

    await sendLogEmbed(newChannel.guild, 'channelUpdate', embed);

    await saveAuditLog(
        newChannel.guild.id,
        'CHANNEL_UPDATE',
        null,
        newChannel.id,
        null,
        newChannel.id,
        'Channel updated',
        null,
        JSON.stringify({
            name: oldChannel.name,
            topic: 'topic' in oldChannel ? oldChannel.topic : null,
            nsfw: 'nsfw' in oldChannel ? oldChannel.nsfw : null,
            slowmode: 'rateLimitPerUser' in oldChannel ? oldChannel.rateLimitPerUser : null
        }),
        JSON.stringify({
            name: newChannel.name,
            topic: 'topic' in newChannel ? newChannel.topic : null,
            nsfw: 'nsfw' in newChannel ? newChannel.nsfw : null,
            slowmode: 'rateLimitPerUser' in newChannel ? newChannel.rateLimitPerUser : null
        }),
        { changes }
    );
}

// ===========================
// THREAD EVENT HANDLERS
// ===========================

async function logThreadCreate(thread) {
    if (!thread.guild) return;

    logger.info(`[THREAD CREATE] ${thread.name} in #${thread.parent?.name || 'Unknown'}`, {
        guildId: thread.guild.id,
        threadId: thread.id,
        category: 'threadCreate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('🧵 Thread Created')
        .setDescription(`Thread **${thread.name}** was created`)
        .addFields(
            { name: 'Thread', value: `${thread.name} (${thread.id})`, inline: false },
            { name: 'Parent Channel', value: thread.parent ? `${thread.parent.name}` : 'Unknown', inline: true },
            { name: 'Owner', value: thread.ownerId ? `<@${thread.ownerId}>` : 'Unknown', inline: true }
        )
        .setTimestamp();

    await sendLogEmbed(thread.guild, 'threadCreate', embed);

    await saveAuditLog(
        thread.guild.id,
        'THREAD_CREATE',
        thread.ownerId,
        thread.id,
        null,
        thread.parentId,
        'Thread created',
        null,
        null,
        thread.name,
        { parentChannel: thread.parent?.name }
    );
}

async function logThreadDelete(thread) {
    if (!thread.guild) return;

    logger.info(`[THREAD DELETE] ${thread.name} in #${thread.parent?.name || 'Unknown'}`, {
        guildId: thread.guild.id,
        threadId: thread.id,
        category: 'threadDelete'
    });

    const embed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('🗑️ Thread Deleted')
        .setDescription(`Thread **${thread.name}** was deleted`)
        .addFields(
            { name: 'Thread', value: `${thread.name} (${thread.id})`, inline: false },
            { name: 'Parent Channel', value: thread.parent ? `${thread.parent.name}` : 'Unknown', inline: true },
            { name: 'Owner', value: thread.ownerId ? `<@${thread.ownerId}>` : 'Unknown', inline: true }
        )
        .setTimestamp();

    await sendLogEmbed(thread.guild, 'threadDelete', embed);

    await saveAuditLog(
        thread.guild.id,
        'THREAD_DELETE',
        thread.ownerId,
        thread.id,
        null,
        thread.parentId,
        'Thread deleted',
        null,
        thread.name,
        null,
        { parentChannel: thread.parent?.name }
    );
}

async function logThreadUpdate(oldThread, newThread) {
    if (!newThread.guild) return;

    const changes = [];
    if (oldThread.name !== newThread.name) changes.push(`name: ${oldThread.name} → ${newThread.name}`);
    if (oldThread.archived !== newThread.archived) changes.push(`archived: ${oldThread.archived} → ${newThread.archived}`);
    if (oldThread.locked !== newThread.locked) changes.push(`locked: ${oldThread.locked} → ${newThread.locked}`);

    if (changes.length === 0) return;

    logger.info(`[THREAD UPDATE] ${newThread.name}: ${changes.join(', ')}`, {
        guildId: newThread.guild.id,
        threadId: newThread.id,
        category: 'threadUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📝 Thread Updated')
        .setDescription(`Thread **${newThread.name}** was updated`)
        .addFields(
            { name: 'Thread', value: `${newThread.name} (${newThread.id})`, inline: false },
            { name: 'Changes', value: changes.join('\n'), inline: false }
        )
        .setTimestamp();

    await sendLogEmbed(newThread.guild, 'threadUpdate', embed);

    await saveAuditLog(
        newThread.guild.id,
        'THREAD_UPDATE',
        newThread.ownerId,
        newThread.id,
        null,
        newThread.parentId,
        'Thread updated',
        null,
        JSON.stringify({ name: oldThread.name, archived: oldThread.archived, locked: oldThread.locked }),
        JSON.stringify({ name: newThread.name, archived: newThread.archived, locked: newThread.locked }),
        { changes }
    );
}

// ===========================
// GUILD/SERVER EVENT HANDLERS
// ===========================

async function logGuildUpdate(oldGuild, newGuild) {
    const changes = [];
    if (oldGuild.name !== newGuild.name) changes.push(`name: ${oldGuild.name} → ${newGuild.name}`);
    if (oldGuild.iconURL() !== newGuild.iconURL()) changes.push(`icon changed`);
    if (oldGuild.verificationLevel !== newGuild.verificationLevel) changes.push(`verification: ${oldGuild.verificationLevel} → ${newGuild.verificationLevel}`);
    if (oldGuild.explicitContentFilter !== newGuild.explicitContentFilter) changes.push(`content filter changed`);

    if (changes.length === 0) return;

    logger.info(`[GUILD UPDATE] ${newGuild.name}: ${changes.join(', ')}`, {
        guildId: newGuild.id,
        category: 'guildUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🏛️ Server Updated')
        .setDescription(`Server settings were updated`)
        .addFields(
            { name: 'Server', value: `${newGuild.name} (${newGuild.id})`, inline: false },
            { name: 'Changes', value: changes.join('\n'), inline: false }
        )
        .setTimestamp();

    if (newGuild.iconURL()) {
        embed.setThumbnail(newGuild.iconURL({ dynamic: true }));
    }

    await sendLogEmbed(newGuild, 'guildUpdate', embed);

    await saveAuditLog(
        newGuild.id,
        'GUILD_UPDATE',
        null,
        newGuild.id,
        null,
        null,
        'Server updated',
        null,
        JSON.stringify({ name: oldGuild.name, verification: oldGuild.verificationLevel }),
        JSON.stringify({ name: newGuild.name, verification: newGuild.verificationLevel }),
        { changes }
    );
}

async function logGuildBanAdd(ban) {
    if (!ban.guild) return;

    try {
        const auditLogs = await ban.guild.fetchAuditLogs({ type: 22, limit: 1 });
        const banLog = auditLogs.entries.first();
        const moderator = banLog?.executor;

        // Get reason from audit log first (most reliable), fallback to ban object
        const reason = banLog?.reason || ban.reason || 'No reason provided';

        logger.info(`[BAN] ${ban.user.tag} banned by ${moderator?.tag || 'Unknown'}. Reason: ${reason}`, {
            guildId: ban.guild.id,
            userId: ban.user.id,
            moderatorId: moderator?.id,
            category: 'ban'
        });

        const embed = new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle('🔨 Member Banned')
            .setDescription(`${ban.user.tag} was banned from the server`)
            .addFields(
                { name: 'User', value: `${ban.user.tag} (${ban.user.id})`, inline: true },
                { name: 'Moderator', value: moderator ? `${moderator.tag} (${moderator.id})` : 'Unknown', inline: true },
                { name: 'Reason', value: reason, inline: false }
            )
            .setThumbnail(ban.user.displayAvatarURL({ dynamic: true }))
            .setTimestamp();

        await sendLogEmbed(ban.guild, 'ban', embed);

        await saveAuditLog(
            ban.guild.id,
            'GUILD_BAN_ADD',
            ban.user.id,
            ban.user.id,
            moderator?.id || null,
            null,
            'Member banned',
            reason,
            null,
            null,
            { username: ban.user.tag, moderator: moderator?.tag }
        );
    } catch (error) {
        logger.error(`[BAN] Failed to log ban: ${error.message}`);
    }
}

async function logGuildBanRemove(ban) {
    if (!ban.guild) return;

    try {
        const auditLogs = await ban.guild.fetchAuditLogs({ type: 23, limit: 1 });
        const unbanLog = auditLogs.entries.first();
        const moderator = unbanLog?.executor;

        logger.info(`[UNBAN] ${ban.user.tag} unbanned by ${moderator?.tag || 'Unknown'}`, {
            guildId: ban.guild.id,
            userId: ban.user.id,
            moderatorId: moderator?.id,
            category: 'unban'
        });

        const embed = new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle('🔓 Member Unbanned')
            .setDescription(`${ban.user.tag} was unbanned`)
            .addFields(
                { name: 'User', value: `${ban.user.tag} (${ban.user.id})`, inline: true },
                { name: 'Moderator', value: moderator ? `${moderator.tag} (${moderator.id})` : 'Unknown', inline: true }
            )
            .setThumbnail(ban.user.displayAvatarURL({ dynamic: true }))
            .setTimestamp();

        await sendLogEmbed(ban.guild, 'unban', embed);

        await saveAuditLog(
            ban.guild.id,
            'GUILD_BAN_REMOVE',
            ban.user.id,
            ban.user.id,
            moderator?.id || null,
            null,
            'Member unbanned',
            null,
            null,
            null,
            { username: ban.user.tag, moderator: moderator?.tag }
        );
    } catch (error) {
        logger.error(`[UNBAN] Failed to log unban: ${error.message}`);
    }
}

async function logGuildMemberRemove(member) {
    if (!member.guild) return;

    try {
        const auditLogs = await member.guild.fetchAuditLogs({ type: 20, limit: 1 });
        const kickLog = auditLogs.entries.first();

        const isKick = kickLog && kickLog.target && 'id' in kickLog.target && kickLog.target.id === member.id && (Date.now() - kickLog.createdTimestamp) < 5000;

        if (isKick) {
            const moderator = kickLog.executor;
            logger.info(`[KICK] ${member.user.tag} kicked by ${moderator?.tag || 'Unknown'}. Reason: ${kickLog.reason || 'None'}`, {
                guildId: member.guild.id,
                userId: member.id,
                moderatorId: moderator?.id,
                category: 'kick'
            });

            const embed = new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle('🚪 Member Kicked')
                .setDescription(`${member.user.tag} was kicked from the server`)
                .addFields(
                    { name: 'User', value: `${member.user.tag} (${member.id})`, inline: true },
                    { name: 'Moderator', value: moderator ? `${moderator.tag} (${moderator.id})` : 'Unknown', inline: true },
                    { name: 'Reason', value: kickLog.reason || 'No reason provided', inline: false }
                )
                .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
                .setTimestamp();

            await sendLogEmbed(member.guild, 'memberKick', embed);

            await saveAuditLog(
                member.guild.id,
                'GUILD_MEMBER_KICK',
                member.id,
                member.id,
                moderator?.id || null,
                null,
                'Member kicked',
                kickLog.reason,
                null,
                null,
                { username: member.user.tag, moderator: moderator?.tag }
            );
        } else {
            logger.info(`[LEAVE] ${member.user.tag} left the server`, {
                guildId: member.guild.id,
                userId: member.id,
                category: 'memberLeave'
            });

            const embed = new EmbedBuilder()
                .setColor(0xFEE75C)
                .setTitle('👋 Member Left')
                .setDescription(`${member.user.tag} left the server`)
                .addFields(
                    { name: 'User', value: `${member.user.tag} (${member.id})`, inline: true },
                    { name: 'Member Count', value: `${member.guild.memberCount}`, inline: true }
                )
                .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
                .setTimestamp();

            await sendLogEmbed(member.guild, 'memberLeave', embed);

            await saveAuditLog(
                member.guild.id,
                'GUILD_MEMBER_LEAVE',
                member.id,
                member.id,
                null,
                null,
                'Member left',
                null,
                null,
                null,
                { username: member.user.tag }
            );
        }
    } catch (error) {
        logger.error(`[MEMBER REMOVE] Failed to log member removal: ${error.message}`);
    }
}

// ===========================
// ROLE EVENT HANDLERS
// ===========================

async function logRoleCreate(role) {
    if (!role.guild) return;

    logger.info(`[ROLE CREATE] ${role.name}`, {
        guildId: role.guild.id,
        roleId: role.id,
        category: 'roleCreate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('🎭 Role Created')
        .setDescription(`Role **${role.name}** was created`)
        .addFields(
            { name: 'Role', value: `${role.name} (${role.id})`, inline: false },
            { name: 'Color', value: role.hexColor || 'Default', inline: true },
            { name: 'Position', value: `${role.position}`, inline: true }
        )
        .setTimestamp();

    await sendLogEmbed(role.guild, 'roleCreate', embed);

    await saveAuditLog(
        role.guild.id,
        'ROLE_CREATE',
        null,
        role.id,
        null,
        null,
        'Role created',
        null,
        null,
        role.name,
        { color: role.hexColor, permissions: role.permissions.bitfield.toString() }
    );
}

async function logRoleDelete(role) {
    if (!role.guild) return;

    logger.info(`[ROLE DELETE] ${role.name}`, {
        guildId: role.guild.id,
        roleId: role.id,
        category: 'roleDelete'
    });

    const embed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('❌ Role Deleted')
        .setDescription(`Role **${role.name}** was deleted`)
        .addFields(
            { name: 'Role', value: `${role.name} (${role.id})`, inline: false },
            { name: 'Color', value: role.hexColor || 'Default', inline: true }
        )
        .setTimestamp();

    await sendLogEmbed(role.guild, 'roleDelete', embed);

    await saveAuditLog(
        role.guild.id,
        'ROLE_DELETE',
        null,
        role.id,
        null,
        null,
        'Role deleted',
        null,
        role.name,
        null,
        { color: role.hexColor }
    );
}

async function logRoleUpdate(oldRole, newRole) {
    if (!newRole.guild) return;

    const changes = [];
    if (oldRole.name !== newRole.name) changes.push(`name: ${oldRole.name} → ${newRole.name}`);
    if (oldRole.hexColor !== newRole.hexColor) changes.push(`color: ${oldRole.hexColor} → ${newRole.hexColor}`);
    if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) changes.push(`permissions changed`);
    // Skip position-only changes — too noisy (reordering roles fires for every role in the hierarchy)
    // if (oldRole.position !== newRole.position) changes.push(`position: ${oldRole.position} → ${newRole.position}`);

    if (changes.length === 0) return;

    logger.info(`[ROLE UPDATE] ${newRole.name}: ${changes.join(', ')}`, {
        guildId: newRole.guild.id,
        roleId: newRole.id,
        category: 'roleUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🎨 Role Updated')
        .setDescription(`Role **${newRole.name}** was updated`)
        .addFields(
            { name: 'Role', value: `${newRole.name} (${newRole.id})`, inline: false },
            { name: 'Changes', value: changes.join('\n'), inline: false }
        )
        .setTimestamp();

    await sendLogEmbed(newRole.guild, 'roleUpdate', embed);

    await saveAuditLog(
        newRole.guild.id,
        'ROLE_UPDATE',
        null,
        newRole.id,
        null,
        null,
        'Role updated',
        null,
        JSON.stringify({ name: oldRole.name, color: oldRole.hexColor, position: oldRole.position }),
        JSON.stringify({ name: newRole.name, color: newRole.hexColor, position: newRole.position }),
        { changes }
    );
}

// ===========================
// EMOJI EVENT HANDLERS
// ===========================

async function logEmojiCreate(emoji) {
    if (!emoji.guild) return;

    logger.info(`[EMOJI CREATE] :${emoji.name}: (${emoji.id})`, {
        guildId: emoji.guild.id,
        emojiId: emoji.id,
        category: 'emojiCreate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('😀 Emoji Added')
        .setDescription(`Emoji :${emoji.name}: was added`)
        .addFields(
            { name: 'Name', value: emoji.name || 'unknown', inline: true },
            { name: 'ID', value: emoji.id, inline: true },
            { name: 'Animated', value: emoji.animated ? 'Yes' : 'No', inline: true }
        )
        .setThumbnail(emoji.url)
        .setTimestamp();

    await sendLogEmbed(emoji.guild, 'emojiCreate', embed);

    await saveAuditLog(
        emoji.guild.id,
        'EMOJI_CREATE',
        null,
        emoji.id,
        null,
        null,
        'Emoji created',
        null,
        null,
        emoji.name || 'unknown',
        { animated: emoji.animated }
    );
}

async function logEmojiDelete(emoji) {
    if (!emoji.guild) return;

    logger.info(`[EMOJI DELETE] :${emoji.name}: (${emoji.id})`, {
        guildId: emoji.guild.id,
        emojiId: emoji.id,
        category: 'emojiDelete'
    });

    const embed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('😢 Emoji Removed')
        .setDescription(`Emoji :${emoji.name}: was removed`)
        .addFields(
            { name: 'Name', value: emoji.name || 'unknown', inline: true },
            { name: 'ID', value: emoji.id, inline: true },
            { name: 'Animated', value: emoji.animated ? 'Yes' : 'No', inline: true }
        )
        .setThumbnail(emoji.url)
        .setTimestamp();

    await sendLogEmbed(emoji.guild, 'emojiDelete', embed);

    await saveAuditLog(
        emoji.guild.id,
        'EMOJI_DELETE',
        null,
        emoji.id,
        null,
        null,
        'Emoji deleted',
        null,
        emoji.name || 'unknown',
        null,
        { animated: emoji.animated }
    );
}

async function logEmojiUpdate(oldEmoji, newEmoji) {
    if (!newEmoji.guild) return;

    if (oldEmoji.name === newEmoji.name) return;

    logger.info(`[EMOJI UPDATE] :${oldEmoji.name}: → :${newEmoji.name}:`, {
        guildId: newEmoji.guild.id,
        emojiId: newEmoji.id,
        category: 'emojiUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('😎 Emoji Updated')
        .setDescription(`Emoji was renamed`)
        .addFields(
            { name: 'Before', value: `:${oldEmoji.name}:`, inline: true },
            { name: 'After', value: `:${newEmoji.name}:`, inline: true },
            { name: 'ID', value: newEmoji.id, inline: true }
        )
        .setThumbnail(newEmoji.url)
        .setTimestamp();

    await sendLogEmbed(newEmoji.guild, 'emojiUpdate', embed);

    await saveAuditLog(
        newEmoji.guild.id,
        'EMOJI_UPDATE',
        null,
        newEmoji.id,
        null,
        null,
        'Emoji updated',
        null,
        oldEmoji.name || 'unknown',
        newEmoji.name || 'unknown',
        {}
    );
}

// ===========================
// STICKER EVENT HANDLERS
// ===========================

async function logStickerCreate(sticker) {
    if (!sticker.guild) return;

    logger.info(`[STICKER CREATE] ${sticker.name} (${sticker.id})`, {
        guildId: sticker.guild.id,
        stickerId: sticker.id,
        category: 'stickerCreate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('🏷️ Sticker Added')
        .setDescription(`Sticker **${sticker.name}** was added`)
        .addFields(
            { name: 'Name', value: sticker.name, inline: true },
            { name: 'ID', value: sticker.id, inline: true },
            { name: 'Description', value: sticker.description || 'No description', inline: false }
        )
        .setThumbnail(sticker.url)
        .setTimestamp();

    await sendLogEmbed(sticker.guild, 'stickerCreate', embed);

    await saveAuditLog(
        sticker.guild.id,
        'STICKER_CREATE',
        sticker.user?.id || null,
        sticker.id,
        null,
        null,
        'Sticker created',
        null,
        null,
        sticker.name,
        { description: sticker.description }
    );
}

async function logStickerDelete(sticker) {
    if (!sticker.guild) return;

    logger.info(`[STICKER DELETE] ${sticker.name} (${sticker.id})`, {
        guildId: sticker.guild.id,
        stickerId: sticker.id,
        category: 'stickerDelete'
    });

    const embed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('🗑️ Sticker Removed')
        .setDescription(`Sticker **${sticker.name}** was removed`)
        .addFields(
            { name: 'Name', value: sticker.name, inline: true },
            { name: 'ID', value: sticker.id, inline: true }
        )
        .setThumbnail(sticker.url)
        .setTimestamp();

    await sendLogEmbed(sticker.guild, 'stickerDelete', embed);

    await saveAuditLog(
        sticker.guild.id,
        'STICKER_DELETE',
        null,
        sticker.id,
        null,
        null,
        'Sticker deleted',
        null,
        sticker.name,
        null,
        {}
    );
}

async function logStickerUpdate(oldSticker, newSticker) {
    if (!newSticker.guild) return;

    const changes = [];
    if (oldSticker.name !== newSticker.name) changes.push(`name: ${oldSticker.name} → ${newSticker.name}`);
    if (oldSticker.description !== newSticker.description) changes.push(`description changed`);

    if (changes.length === 0) return;

    logger.info(`[STICKER UPDATE] ${newSticker.name}: ${changes.join(', ')}`, {
        guildId: newSticker.guild.id,
        stickerId: newSticker.id,
        category: 'stickerUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('✨ Sticker Updated')
        .setDescription(`Sticker **${newSticker.name}** was updated`)
        .addFields(
            { name: 'Sticker', value: `${newSticker.name} (${newSticker.id})`, inline: false },
            { name: 'Changes', value: changes.join('\n'), inline: false }
        )
        .setThumbnail(newSticker.url)
        .setTimestamp();

    await sendLogEmbed(newSticker.guild, 'stickerUpdate', embed);

    await saveAuditLog(
        newSticker.guild.id,
        'STICKER_UPDATE',
        null,
        newSticker.id,
        null,
        null,
        'Sticker updated',
        null,
        JSON.stringify({ name: oldSticker.name, description: oldSticker.description }),
        JSON.stringify({ name: newSticker.name, description: newSticker.description }),
        { changes }
    );
}

// ===========================
// INVITE EVENT HANDLERS
// ===========================

async function logInviteCreate(invite) {
    if (!invite.guild) return;

    const inviter = invite.inviter;
    const channel = invite.channel;

    logger.info(`[INVITE CREATE] ${invite.code} by ${inviter?.tag || 'Unknown'}`, {
        guildId: invite.guild.id,
        inviteCode: invite.code,
        inviterId: inviter?.id,
        channelId: channel?.id,
        maxUses: invite.maxUses,
        maxAge: invite.maxAge,
        category: 'inviteCreate'
    });

    const expiresIn = invite.maxAge === 0 ? 'Never' : `${Math.round(invite.maxAge / 3600)}h`;
    const maxUses = invite.maxUses === 0 ? 'Unlimited' : invite.maxUses;

    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('🔗 Invite Created')
        .setDescription(`New invite link was created`)
        .addFields(
            { name: 'Code', value: `\`${invite.code}\``, inline: true },
            { name: 'Created By', value: inviter ? `${inviter.tag} (${inviter.id})` : 'Unknown', inline: true },
            { name: 'Channel', value: channel ? `${channel.name}` : 'Unknown', inline: true },
            { name: 'Max Uses', value: `${maxUses}`, inline: true },
            { name: 'Expires', value: expiresIn, inline: true },
            { name: 'Temporary', value: invite.temporary ? 'Yes' : 'No', inline: true }
        )
        .setTimestamp();

    if (inviter) {
        embed.setThumbnail(inviter.displayAvatarURL({ dynamic: true }));
    }

    await sendLogEmbed(invite.guild, 'inviteCreate', embed);

    await saveAuditLog(
        invite.guild.id,
        'INVITE_CREATE',
        inviter?.id || null,
        invite.code,
        null,
        channel?.id || null,
        'Invite created',
        null,
        null,
        invite.code,
        { maxUses: invite.maxUses, maxAge: invite.maxAge, temporary: invite.temporary }
    );
}

async function logInviteDelete(invite) {
    if (!invite.guild) return;

    logger.info(`[INVITE DELETE] ${invite.code}`, {
        guildId: invite.guild.id,
        inviteCode: invite.code,
        category: 'inviteDelete'
    });

    const embed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('🗑️ Invite Deleted')
        .setDescription(`Invite link was deleted or expired`)
        .addFields(
            { name: 'Code', value: `\`${invite.code}\``, inline: true },
            { name: 'Channel', value: invite.channel ? `${invite.channel.name}` : 'Unknown', inline: true },
            { name: 'Uses', value: `${invite.uses || 0}`, inline: true }
        )
        .setTimestamp();

    await sendLogEmbed(invite.guild, 'inviteDelete', embed);

    await saveAuditLog(
        invite.guild.id,
        'INVITE_DELETE',
        null,
        invite.code,
        null,
        invite.channel?.id || null,
        'Invite deleted',
        null,
        invite.code,
        null,
        { uses: invite.uses }
    );
}

// ===========================
// WEBHOOK/INTEGRATION HANDLERS
// ===========================

async function logWebhookUpdate(channel) {
    if (!channel.guild) return;

    logger.info(`[WEBHOOK UPDATE] Webhooks modified in #${channel.name}`, {
        guildId: channel.guild.id,
        channelId: channel.id,
        category: 'webhookUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle('🔗 Webhook Modified')
        .setDescription(`Webhooks were modified in ${channel}`)
        .addFields(
            { name: 'Channel', value: `${channel.name} (${channel.id})`, inline: false }
        )
        .setTimestamp();

    await sendLogEmbed(channel.guild, 'webhookUpdate', embed);

    await saveAuditLog(
        channel.guild.id,
        'WEBHOOK_UPDATE',
        null,
        channel.id,
        null,
        channel.id,
        'Webhook updated',
        null,
        null,
        null,
        { channelName: channel.name }
    );
}

async function logIntegrationUpdate(guild) {
    logger.info(`[INTEGRATION UPDATE] Integrations modified in ${guild.name}`, {
        guildId: guild.id,
        category: 'integrationUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle('🤖 Integration Updated')
        .setDescription(`Server integrations were modified`)
        .addFields(
            { name: 'Server', value: `${guild.name} (${guild.id})`, inline: false }
        )
        .setTimestamp();

    await sendLogEmbed(guild, 'integrationUpdate', embed);

    await saveAuditLog(
        guild.id,
        'INTEGRATION_UPDATE',
        null,
        guild.id,
        null,
        null,
        'Integration updated',
        null,
        null,
        null,
        {}
    );
}

export {
    // Helper functions
    sendLogEmbed,
    saveAuditLog,

    // Message events
    logMessageDelete,
    logMessageUpdate,

    // Member events (existing)
    logMemberUpdate,

    // Member events (new)
    logMemberJoin,
    logMemberLeave,
    logMemberNicknameUpdate,
    logMemberRoleUpdate,

    // Voice events (existing)
    logVoiceStateUpdate,

    // Voice events (new)
    logVoiceJoin,
    logVoiceLeave,
    logVoiceMove,

    // Channel events
    logChannelCreate,
    logChannelDelete,
    logChannelUpdate,

    // Thread events
    logThreadCreate,
    logThreadDelete,
    logThreadUpdate,

    // Guild/Server events
    logGuildUpdate,
    logGuildBanAdd,
    logGuildBanRemove,
    logGuildMemberRemove,

    // Role events
    logRoleCreate,
    logRoleDelete,
    logRoleUpdate,

    // Emoji events
    logEmojiCreate,
    logEmojiDelete,
    logEmojiUpdate,

    // Sticker events
    logStickerCreate,
    logStickerDelete,
    logStickerUpdate,

    // Invite events
    logInviteCreate,
    logInviteDelete,

    // Webhook/Integration events
    logWebhookUpdate,
    logIntegrationUpdate
};
