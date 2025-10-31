import logger from '../utils/logger';
import db from '../utils/db';
import { Message, GuildMember, VoiceState, BaseGuildVoiceChannel, Guild, GuildBan, Role, GuildEmoji, Sticker, GuildChannel, ThreadChannel, NonThreadGuildBasedChannel } from 'discord.js';

// ===========================
// HELPER FUNCTIONS
// ===========================

async function saveAuditLog(
    guildId: string,
    eventType: string,
    userId: string | null,
    targetId: string | null,
    moderatorId: string | null,
    channelId: string | null,
    action: string,
    reason: string | null,
    oldValue: string | null,
    newValue: string | null,
    metadata: any = {}
): Promise<void> {
    try {
        await db.execute(
            `INSERT INTO audit_logs (guild_id, event_type, user_id, target_id, moderator_id, channel_id, action, reason, old_value, new_value, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [guildId, eventType, userId || null, targetId || null, moderatorId || null, channelId || null,
             action, reason || null, oldValue || null, newValue || null, JSON.stringify(metadata)]
        );
    } catch (error: any) {
        logger.error(`[AUDIT LOG] Failed to save audit log: ${error.message}`, { guildId, eventType, error: error.message });
    }
}

// ===========================
// EXISTING LOG FUNCTIONS
// ===========================

async function logMessageDelete(message: Message): Promise<void> {
    // FIX: Add null check for message.author
    if (!message.guild || !message.author || message.author.bot) return;

    const guildId = message.guild.id;
    const channelId = message.channel.id;
    const userId = message.author.id;
    const messageId = message.id;
    const content = message.content;

    logger.info(`Message deleted in #${message.channel.toString()} by ${message.author.tag}: ${content}`, {
        guildId,
        channelId,
        userId,
        messageId,
        content,
        category: 'messageDelete'
    });
}

async function logMessageUpdate(oldMessage: Message, newMessage: Message): Promise<void> {
    if (!newMessage.guild || !newMessage.author || oldMessage.content === newMessage.content || newMessage.author.bot) return;

    const guildId = newMessage.guild.id;
    const channelId = newMessage.channel.id;
    const userId = newMessage.author.id;
    const messageId = newMessage.id;
    const oldContent = oldMessage.content;
    const newContent = newMessage.content;

    logger.info(`Message edited in #${newMessage.channel.toString()} by ${newMessage.author.tag}. Old: "${oldContent}" New: "${newContent}"`, {
        guildId,
        channelId,
        userId,
        messageId,
        oldContent,
        newContent,
        category: 'messageUpdate'
    });
}

async function logMemberUpdate(oldMember: GuildMember, newMember: GuildMember): Promise<void> {
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
    }

    if (removedRoles.length > 0) {
        const roleNames = removedRoles.map(id => newMember.guild.roles.cache.get(id)?.name || id).join(', ');
        logger.info(`Roles removed from ${newMember.user.tag}: ${roleNames}.`, {
            guildId,
            userId,
            removedRoles,
            category: 'memberUpdate'
        });
    }
}

async function logVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
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
// CHANNEL EVENT HANDLERS
// ===========================

async function logChannelCreate(channel: NonThreadGuildBasedChannel): Promise<void> {
    if (!channel.guild) return;

    logger.info(`[CHANNEL CREATE] #${channel.name} (${channel.type})`, {
        guildId: channel.guild.id,
        channelId: channel.id,
        category: 'channelCreate'
    });

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

async function logChannelDelete(channel: NonThreadGuildBasedChannel): Promise<void> {
    if (!channel.guild) return;

    logger.info(`[CHANNEL DELETE] #${channel.name} (${channel.type})`, {
        guildId: channel.guild.id,
        channelId: channel.id,
        category: 'channelDelete'
    });

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

async function logChannelUpdate(oldChannel: NonThreadGuildBasedChannel, newChannel: NonThreadGuildBasedChannel): Promise<void> {
    if (!newChannel.guild) return;

    const changes: string[] = [];
    if (oldChannel.name !== newChannel.name) changes.push(`name: ${oldChannel.name} → ${newChannel.name}`);

    if ('topic' in oldChannel && 'topic' in newChannel && oldChannel.topic !== newChannel.topic) changes.push(`topic changed`);
    if ('nsfw' in oldChannel && 'nsfw' in newChannel && oldChannel.nsfw !== newChannel.nsfw) changes.push(`NSFW: ${oldChannel.nsfw} → ${newChannel.nsfw}`);
    if ('rateLimitPerUser' in oldChannel && 'rateLimitPerUser' in newChannel && oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) {
        changes.push(`slowmode: ${oldChannel.rateLimitPerUser}s → ${newChannel.rateLimitPerUser}s`);
    }

    if (changes.length === 0) return;

    logger.info(`[CHANNEL UPDATE] #${newChannel.name}: ${changes.join(', ')}`, {
        guildId: newChannel.guild.id,
        channelId: newChannel.id,
        category: 'channelUpdate'
    });

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

async function logThreadCreate(thread: ThreadChannel): Promise<void> {
    if (!thread.guild) return;

    logger.info(`[THREAD CREATE] ${thread.name} in #${thread.parent?.name || 'Unknown'}`, {
        guildId: thread.guild.id,
        threadId: thread.id,
        category: 'threadCreate'
    });

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

async function logThreadDelete(thread: ThreadChannel): Promise<void> {
    if (!thread.guild) return;

    logger.info(`[THREAD DELETE] ${thread.name} in #${thread.parent?.name || 'Unknown'}`, {
        guildId: thread.guild.id,
        threadId: thread.id,
        category: 'threadDelete'
    });

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

async function logThreadUpdate(oldThread: ThreadChannel, newThread: ThreadChannel): Promise<void> {
    if (!newThread.guild) return;

    const changes: string[] = [];
    if (oldThread.name !== newThread.name) changes.push(`name: ${oldThread.name} → ${newThread.name}`);
    if (oldThread.archived !== newThread.archived) changes.push(`archived: ${oldThread.archived} → ${newThread.archived}`);
    if (oldThread.locked !== newThread.locked) changes.push(`locked: ${oldThread.locked} → ${newThread.locked}`);

    if (changes.length === 0) return;

    logger.info(`[THREAD UPDATE] ${newThread.name}: ${changes.join(', ')}`, {
        guildId: newThread.guild.id,
        threadId: newThread.id,
        category: 'threadUpdate'
    });

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

async function logGuildUpdate(oldGuild: Guild, newGuild: Guild): Promise<void> {
    const changes: string[] = [];
    if (oldGuild.name !== newGuild.name) changes.push(`name: ${oldGuild.name} → ${newGuild.name}`);
    if (oldGuild.iconURL() !== newGuild.iconURL()) changes.push(`icon changed`);
    if (oldGuild.verificationLevel !== newGuild.verificationLevel) changes.push(`verification: ${oldGuild.verificationLevel} → ${newGuild.verificationLevel}`);
    if (oldGuild.explicitContentFilter !== newGuild.explicitContentFilter) changes.push(`content filter changed`);

    if (changes.length === 0) return;

    logger.info(`[GUILD UPDATE] ${newGuild.name}: ${changes.join(', ')}`, {
        guildId: newGuild.id,
        category: 'guildUpdate'
    });

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

async function logGuildBanAdd(ban: GuildBan): Promise<void> {
    if (!ban.guild) return;

    try {
        const auditLogs = await ban.guild.fetchAuditLogs({ type: 22, limit: 1 });
        const banLog = auditLogs.entries.first();
        const moderator = banLog?.executor;

        logger.info(`[BAN] ${ban.user.tag} banned by ${moderator?.tag || 'Unknown'}. Reason: ${ban.reason || 'None'}`, {
            guildId: ban.guild.id,
            userId: ban.user.id,
            moderatorId: moderator?.id,
            category: 'ban'
        });

        await saveAuditLog(
            ban.guild.id,
            'GUILD_BAN_ADD',
            ban.user.id,
            ban.user.id,
            moderator?.id || null,
            null,
            'Member banned',
            ban.reason,
            null,
            null,
            { username: ban.user.tag, moderator: moderator?.tag }
        );
    } catch (error: any) {
        logger.error(`[BAN] Failed to log ban: ${error.message}`);
    }
}

async function logGuildBanRemove(ban: GuildBan): Promise<void> {
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
    } catch (error: any) {
        logger.error(`[UNBAN] Failed to log unban: ${error.message}`);
    }
}

async function logGuildMemberRemove(member: GuildMember): Promise<void> {
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
    } catch (error: any) {
        logger.error(`[MEMBER REMOVE] Failed to log member removal: ${error.message}`);
    }
}

// ===========================
// ROLE EVENT HANDLERS
// ===========================

async function logRoleCreate(role: Role): Promise<void> {
    if (!role.guild) return;

    logger.info(`[ROLE CREATE] ${role.name}`, {
        guildId: role.guild.id,
        roleId: role.id,
        category: 'roleCreate'
    });

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

async function logRoleDelete(role: Role): Promise<void> {
    if (!role.guild) return;

    logger.info(`[ROLE DELETE] ${role.name}`, {
        guildId: role.guild.id,
        roleId: role.id,
        category: 'roleDelete'
    });

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

async function logRoleUpdate(oldRole: Role, newRole: Role): Promise<void> {
    if (!newRole.guild) return;

    const changes: string[] = [];
    if (oldRole.name !== newRole.name) changes.push(`name: ${oldRole.name} → ${newRole.name}`);
    if (oldRole.hexColor !== newRole.hexColor) changes.push(`color: ${oldRole.hexColor} → ${newRole.hexColor}`);
    if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) changes.push(`permissions changed`);
    if (oldRole.position !== newRole.position) changes.push(`position: ${oldRole.position} → ${newRole.position}`);

    if (changes.length === 0) return;

    logger.info(`[ROLE UPDATE] ${newRole.name}: ${changes.join(', ')}`, {
        guildId: newRole.guild.id,
        roleId: newRole.id,
        category: 'roleUpdate'
    });

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

async function logEmojiCreate(emoji: GuildEmoji): Promise<void> {
    if (!emoji.guild) return;

    logger.info(`[EMOJI CREATE] :${emoji.name}: (${emoji.id})`, {
        guildId: emoji.guild.id,
        emojiId: emoji.id,
        category: 'emojiCreate'
    });

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

async function logEmojiDelete(emoji: GuildEmoji): Promise<void> {
    if (!emoji.guild) return;

    logger.info(`[EMOJI DELETE] :${emoji.name}: (${emoji.id})`, {
        guildId: emoji.guild.id,
        emojiId: emoji.id,
        category: 'emojiDelete'
    });

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

async function logEmojiUpdate(oldEmoji: GuildEmoji, newEmoji: GuildEmoji): Promise<void> {
    if (!newEmoji.guild) return;

    if (oldEmoji.name === newEmoji.name) return;

    logger.info(`[EMOJI UPDATE] :${oldEmoji.name}: → :${newEmoji.name}:`, {
        guildId: newEmoji.guild.id,
        emojiId: newEmoji.id,
        category: 'emojiUpdate'
    });

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

async function logStickerCreate(sticker: Sticker): Promise<void> {
    if (!sticker.guild) return;

    logger.info(`[STICKER CREATE] ${sticker.name} (${sticker.id})`, {
        guildId: sticker.guild.id,
        stickerId: sticker.id,
        category: 'stickerCreate'
    });

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

async function logStickerDelete(sticker: Sticker): Promise<void> {
    if (!sticker.guild) return;

    logger.info(`[STICKER DELETE] ${sticker.name} (${sticker.id})`, {
        guildId: sticker.guild.id,
        stickerId: sticker.id,
        category: 'stickerDelete'
    });

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

async function logStickerUpdate(oldSticker: Sticker, newSticker: Sticker): Promise<void> {
    if (!newSticker.guild) return;

    const changes: string[] = [];
    if (oldSticker.name !== newSticker.name) changes.push(`name: ${oldSticker.name} → ${newSticker.name}`);
    if (oldSticker.description !== newSticker.description) changes.push(`description changed`);

    if (changes.length === 0) return;

    logger.info(`[STICKER UPDATE] ${newSticker.name}: ${changes.join(', ')}`, {
        guildId: newSticker.guild.id,
        stickerId: newSticker.id,
        category: 'stickerUpdate'
    });

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
// WEBHOOK/INTEGRATION HANDLERS
// ===========================

async function logWebhookUpdate(channel: GuildChannel): Promise<void> {
    if (!channel.guild) return;

    logger.info(`[WEBHOOK UPDATE] Webhooks modified in #${channel.name}`, {
        guildId: channel.guild.id,
        channelId: channel.id,
        category: 'webhookUpdate'
    });

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

async function logIntegrationUpdate(guild: Guild): Promise<void> {
    logger.info(`[INTEGRATION UPDATE] Integrations modified in ${guild.name}`, {
        guildId: guild.id,
        category: 'integrationUpdate'
    });

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
    // Existing functions
    logMessageDelete,
    logMessageUpdate,
    logMemberUpdate,
    logVoiceStateUpdate,

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

    // Webhook/Integration events
    logWebhookUpdate,
    logIntegrationUpdate
};
