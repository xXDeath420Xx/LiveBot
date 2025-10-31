// EXPANDED LOG MANAGER - All Discord Event Types
// This file contains comprehensive logging for all Discord.js events

import logger from '../utils/logger';
import db from '../utils/db';
import {
    Message,
    GuildMember,
    VoiceState,
    GuildChannel,
    AuditLogEvent,
    ThreadChannel,
    Guild,
    GuildBan,
    Role,
    GuildEmoji,
    Sticker
} from 'discord.js';
import { ResultSetHeader } from 'mysql2';

// ==================== EXISTING FUNCTIONS ====================

async function logMessageDelete(message: Message): Promise<void> {
    if (!message.guild || !message.author || message.author.bot) return;
    logger.info(`[DELETE] Message by ${message.author.tag} in #${message.channel.name}: ${message.content}`, {
        guildId: message.guild.id,
        channelId: message.channel.id,
        userId: message.author.id,
        messageId: message.id,
        content: message.content,
        category: 'messageDelete'
    });

    await saveAuditLog(message.guild.id, 'MESSAGE_DELETE', message.author.id, message.id, null, message.channel.id,
        'Message deleted', null, message.content, null, {attachments: message.attachments.size});
}

async function logMessageUpdate(oldMessage: Message, newMessage: Message): Promise<void> {
    if (!newMessage.guild || !newMessage.author || oldMessage.content === newMessage.content || newMessage.author.bot) return;
    logger.info(`[EDIT] Message by ${newMessage.author.tag} in #${newMessage.channel.name}`, {
        guildId: newMessage.guild.id,
        channelId: newMessage.channel.id,
        userId: newMessage.author.id,
        messageId: newMessage.id,
        oldContent: oldMessage.content,
        newContent: newMessage.content,
        category: 'messageUpdate'
    });

    await saveAuditLog(newMessage.guild.id, 'MESSAGE_UPDATE', newMessage.author.id, newMessage.id, null, newMessage.channel.id,
        'Message edited', null, oldMessage.content, newMessage.content);
}

async function logMemberUpdate(oldMember: GuildMember, newMember: GuildMember): Promise<void> {
    if (oldMember.partial || newMember.partial) return;
    const guildId = newMember.guild.id;
    const userId = newMember.id;

    if (oldMember.nickname !== newMember.nickname) {
        logger.info(`[NICKNAME] ${newMember.user.tag}: "${oldMember.nickname || 'None'}" → "${newMember.nickname || 'None'}"`, {
            guildId, userId, oldNickname: oldMember.nickname, newNickname: newMember.nickname, category: 'memberUpdate'
        });
        await saveAuditLog(guildId, 'MEMBER_NICKNAME_UPDATE', userId, userId, null, null,
            'Nickname changed', null, oldMember.nickname || 'None', newMember.nickname || 'None');
    }

    const oldRoles = oldMember.roles.cache.map(r => r.id);
    const newRoles = newMember.roles.cache.map(r => r.id);
    const addedRoles = newRoles.filter(roleId => !oldRoles.includes(roleId));
    const removedRoles = oldRoles.filter(roleId => !newRoles.includes(roleId));

    if (addedRoles.length > 0) {
        const roleNames = addedRoles.map(id => newMember.guild.roles.cache.get(id)?.name || id).join(', ');
        logger.info(`[ROLES+] ${newMember.user.tag}: ${roleNames}`, {guildId, userId, addedRoles, category: 'memberUpdate'});
        await saveAuditLog(guildId, 'MEMBER_ROLE_ADD', userId, userId, null, null,
            'Roles added', null, null, roleNames, {roleIds: addedRoles});
    }

    if (removedRoles.length > 0) {
        const roleNames = removedRoles.map(id => newMember.guild.roles.cache.get(id)?.name || id).join(', ');
        logger.info(`[ROLES-] ${newMember.user.tag}: ${roleNames}`, {guildId, userId, removedRoles, category: 'memberUpdate'});
        await saveAuditLog(guildId, 'MEMBER_ROLE_REMOVE', userId, userId, null, null,
            'Roles removed', null, roleNames, null, {roleIds: removedRoles});
    }
}

async function logVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
    if (!newState.member || !newState.guild) return;
    const guildId = newState.guild.id;
    const userId = newState.member.id;
    const oldChannelName = oldState.channel ? `#${oldState.channel.name}` : 'None';
    const newChannelName = newState.channel ? `#${newState.channel.name}` : 'None';

    if (!oldState.channelId && newState.channelId) {
        logger.info(`[VOICE JOIN] ${newState.member.user.tag} → ${newChannelName}`, {guildId, userId, channelId: newState.channelId, category: 'voiceUpdate'});
        await saveAuditLog(guildId, 'VOICE_JOIN', userId, newState.channelId, null, newState.channelId,
            'Joined voice channel', null, null, newChannelName);
    }
    else if (oldState.channelId && !newState.channelId) {
        logger.info(`[VOICE LEAVE] ${newState.member.user.tag} ← ${oldChannelName}`, {guildId, userId, channelId: oldState.channelId, category: 'voiceUpdate'});
        await saveAuditLog(guildId, 'VOICE_LEAVE', userId, oldState.channelId, null, oldState.channelId,
            'Left voice channel', null, oldChannelName, null);
    }
    else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
        logger.info(`[VOICE MOVE] ${newState.member.user.tag}: ${oldChannelName} → ${newChannelName}`, {guildId, userId, oldChannelId: oldState.channelId, newChannelId: newState.channelId, category: 'voiceUpdate'});
        await saveAuditLog(guildId, 'VOICE_MOVE', userId, newState.channelId, null, newState.channelId,
            'Switched voice channel', null, oldChannelName, newChannelName);
    }
}

// ==================== NEW CHANNEL EVENTS ====================

async function logChannelCreate(channel: GuildChannel): Promise<void> {
    if (!channel.guild) return;
    logger.info(`[CHANNEL CREATE] #${channel.name} (${channel.type})`, {guildId: channel.guild.id, channelId: channel.id, category: 'channelCreate'});
    await saveAuditLog(channel.guild.id, 'CHANNEL_CREATE', null, channel.id, null, channel.id,
        'Channel created', null, null, channel.name, {type: channel.type});
}

async function logChannelDelete(channel: GuildChannel): Promise<void> {
    if (!channel.guild) return;
    logger.info(`[CHANNEL DELETE] #${channel.name} (${channel.type})`, {guildId: channel.guild.id, channelId: channel.id, category: 'channelDelete'});
    await saveAuditLog(channel.guild.id, 'CHANNEL_DELETE', null, channel.id, null, channel.id,
        'Channel deleted', null, channel.name, null, {type: channel.type});
}

async function logChannelUpdate(oldChannel: GuildChannel, newChannel: GuildChannel): Promise<void> {
    if (!newChannel.guild) return;
    const changes: string[] = [];

    if (oldChannel.name !== newChannel.name) changes.push(`Name: "${oldChannel.name}" → "${newChannel.name}"`);

    // Type guards for text channel properties
    if ('topic' in oldChannel && 'topic' in newChannel && oldChannel.topic !== newChannel.topic) {
        changes.push(`Topic: "${oldChannel.topic || 'None'}" → "${newChannel.topic || 'None'}"`);
    }
    if ('nsfw' in oldChannel && 'nsfw' in newChannel && oldChannel.nsfw !== newChannel.nsfw) {
        changes.push(`NSFW: ${oldChannel.nsfw} → ${newChannel.nsfw}`);
    }
    if ('rateLimitPerUser' in oldChannel && 'rateLimitPerUser' in newChannel && oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) {
        changes.push(`Slowmode: ${oldChannel.rateLimitPerUser}s → ${newChannel.rateLimitPerUser}s`);
    }

    if (changes.length > 0) {
        logger.info(`[CHANNEL UPDATE] #${newChannel.name}: ${changes.join(', ')}`, {guildId: newChannel.guild.id, channelId: newChannel.id, category: 'channelUpdate'});
        await saveAuditLog(newChannel.guild.id, 'CHANNEL_UPDATE', null, newChannel.id, null, newChannel.id,
            'Channel updated', null, JSON.stringify({name: oldChannel.name}),
            JSON.stringify({name: newChannel.name}));
    }
}

async function logThreadCreate(thread: ThreadChannel): Promise<void> {
    if (!thread.guild) return;
    logger.info(`[THREAD CREATE] ${thread.name} in #${thread.parent?.name}`, {guildId: thread.guild.id, threadId: thread.id, category: 'threadCreate'});
    await saveAuditLog(thread.guild.id, 'THREAD_CREATE', thread.ownerId, thread.id, null, thread.id,
        'Thread created', null, null, thread.name, {parentId: thread.parentId});
}

async function logThreadDelete(thread: ThreadChannel): Promise<void> {
    if (!thread.guild) return;
    logger.info(`[THREAD DELETE] ${thread.name}`, {guildId: thread.guild.id, threadId: thread.id, category: 'threadDelete'});
    await saveAuditLog(thread.guild.id, 'THREAD_DELETE', null, thread.id, null, thread.id,
        'Thread deleted', null, thread.name, null);
}

async function logThreadUpdate(oldThread: ThreadChannel, newThread: ThreadChannel): Promise<void> {
    if (!newThread.guild) return;
    const changes: string[] = [];

    if (oldThread.name !== newThread.name) changes.push(`Name: "${oldThread.name}" → "${newThread.name}"`);
    if (oldThread.archived !== newThread.archived) changes.push(`Archived: ${oldThread.archived} → ${newThread.archived}`);
    if (oldThread.locked !== newThread.locked) changes.push(`Locked: ${oldThread.locked} → ${newThread.locked}`);

    if (changes.length > 0) {
        logger.info(`[THREAD UPDATE] ${newThread.name}: ${changes.join(', ')}`, {guildId: newThread.guild.id, threadId: newThread.id, category: 'threadUpdate'});
        await saveAuditLog(newThread.guild.id, 'THREAD_UPDATE', null, newThread.id, null, newThread.id,
            'Thread updated', null, oldThread.name, newThread.name);
    }
}

// ==================== NEW GUILD/SERVER EVENTS ====================

async function logGuildUpdate(oldGuild: Guild, newGuild: Guild): Promise<void> {
    const changes: string[] = [];

    if (oldGuild.name !== newGuild.name) changes.push(`Name: "${oldGuild.name}" → "${newGuild.name}"`);
    if (oldGuild.icon !== newGuild.icon) changes.push(`Icon changed`);
    if (oldGuild.verificationLevel !== newGuild.verificationLevel) changes.push(`Verification: ${oldGuild.verificationLevel} → ${newGuild.verificationLevel}`);
    if (oldGuild.defaultMessageNotifications !== newGuild.defaultMessageNotifications) changes.push(`Notifications: ${oldGuild.defaultMessageNotifications} → ${newGuild.defaultMessageNotifications}`);

    if (changes.length > 0) {
        logger.info(`[GUILD UPDATE] ${newGuild.name}: ${changes.join(', ')}`, {guildId: newGuild.id, category: 'guildUpdate'});
        await saveAuditLog(newGuild.id, 'GUILD_UPDATE', null, newGuild.id, null, null,
            'Server updated', null, JSON.stringify({name: oldGuild.name}), JSON.stringify({name: newGuild.name}));
    }
}

async function logGuildBanAdd(ban: GuildBan): Promise<void> {
    logger.info(`[BAN] ${ban.user.tag} banned`, {guildId: ban.guild.id, userId: ban.user.id, reason: ban.reason, category: 'guildBan'});

    // Fetch audit log to get moderator
    try {
        const auditLogs = await ban.guild.fetchAuditLogs({type: AuditLogEvent.MemberBanAdd, limit: 1});
        const banLog = auditLogs.entries.first();
        const moderatorId = banLog?.executor?.id || null;

        await saveAuditLog(ban.guild.id, 'MEMBER_BAN', ban.user.id, ban.user.id, moderatorId, null,
            'User banned', ban.reason, null, null, {moderator: banLog?.executor?.tag});
    } catch (e) {
        await saveAuditLog(ban.guild.id, 'MEMBER_BAN', ban.user.id, ban.user.id, null, null,
            'User banned', ban.reason, null, null);
    }
}

async function logGuildBanRemove(ban: GuildBan): Promise<void> {
    logger.info(`[UNBAN] ${ban.user.tag} unbanned`, {guildId: ban.guild.id, userId: ban.user.id, category: 'guildUnban'});

    try {
        const auditLogs = await ban.guild.fetchAuditLogs({type: AuditLogEvent.MemberBanRemove, limit: 1});
        const unbanLog = auditLogs.entries.first();
        const moderatorId = unbanLog?.executor?.id || null;

        await saveAuditLog(ban.guild.id, 'MEMBER_UNBAN', ban.user.id, ban.user.id, moderatorId, null,
            'User unbanned', null, null, null, {moderator: unbanLog?.executor?.tag});
    } catch (e) {
        await saveAuditLog(ban.guild.id, 'MEMBER_UNBAN', ban.user.id, ban.user.id, null, null,
            'User unbanned', null, null, null);
    }
}

async function logGuildMemberRemove(member: GuildMember): Promise<void> {
    // Check if this was a kick via audit log
    try {
        const auditLogs = await member.guild.fetchAuditLogs({type: AuditLogEvent.MemberKick, limit: 1});
        const kickLog = auditLogs.entries.first();

        if (kickLog && kickLog.target && 'id' in kickLog.target && kickLog.target.id === member.id && Date.now() - kickLog.createdTimestamp < 5000) {
            logger.info(`[KICK] ${member.user.tag} kicked by ${kickLog.executor?.tag}`, {guildId: member.guild.id, userId: member.id, moderatorId: kickLog.executor?.id, reason: kickLog.reason, category: 'memberKick'});
            await saveAuditLog(member.guild.id, 'MEMBER_KICK', member.id, member.id, kickLog.executor?.id || null, null,
                'User kicked', kickLog.reason, null, null, {moderator: kickLog.executor?.tag});
        } else {
            logger.info(`[LEAVE] ${member.user.tag} left`, {guildId: member.guild.id, userId: member.id, category: 'memberLeave'});
            await saveAuditLog(member.guild.id, 'MEMBER_LEAVE', member.id, member.id, null, null,
                'User left', null, null, null);
        }
    } catch (e) {
        logger.info(`[LEAVE] ${member.user.tag} left`, {guildId: member.guild.id, userId: member.id, category: 'memberLeave'});
        await saveAuditLog(member.guild.id, 'MEMBER_LEAVE', member.id, member.id, null, null,
            'User left', null, null, null);
    }
}

// ==================== NEW ROLE EVENTS ====================

async function logRoleCreate(role: Role): Promise<void> {
    logger.info(`[ROLE CREATE] @${role.name}`, {guildId: role.guild.id, roleId: role.id, category: 'roleCreate'});
    await saveAuditLog(role.guild.id, 'ROLE_CREATE', null, role.id, null, null,
        'Role created', null, null, role.name, {color: role.hexColor, position: role.position});
}

async function logRoleDelete(role: Role): Promise<void> {
    logger.info(`[ROLE DELETE] @${role.name}`, {guildId: role.guild.id, roleId: role.id, category: 'roleDelete'});
    await saveAuditLog(role.guild.id, 'ROLE_DELETE', null, role.id, null, null,
        'Role deleted', null, role.name, null);
}

async function logRoleUpdate(oldRole: Role, newRole: Role): Promise<void> {
    const changes: string[] = [];

    if (oldRole.name !== newRole.name) changes.push(`Name: "@${oldRole.name}" → "@${newRole.name}"`);
    if (oldRole.color !== newRole.color) changes.push(`Color: ${oldRole.hexColor} → ${newRole.hexColor}`);
    if (oldRole.hoist !== newRole.hoist) changes.push(`Hoisted: ${oldRole.hoist} → ${newRole.hoist}`);
    if (oldRole.mentionable !== newRole.mentionable) changes.push(`Mentionable: ${oldRole.mentionable} → ${newRole.mentionable}`);
    if (oldRole.position !== newRole.position) changes.push(`Position: ${oldRole.position} → ${newRole.position}`);

    if (changes.length > 0) {
        logger.info(`[ROLE UPDATE] @${newRole.name}: ${changes.join(', ')}`, {guildId: newRole.guild.id, roleId: newRole.id, category: 'roleUpdate'});
        await saveAuditLog(newRole.guild.id, 'ROLE_UPDATE', null, newRole.id, null, null,
            'Role updated', null, oldRole.name, newRole.name);
    }
}

// ==================== NEW EMOJI/STICKER EVENTS ====================

async function logEmojiCreate(emoji: GuildEmoji): Promise<void> {
    logger.info(`[EMOJI CREATE] :${emoji.name}:`, {guildId: emoji.guild.id, emojiId: emoji.id, category: 'emojiCreate'});
    await saveAuditLog(emoji.guild.id, 'EMOJI_CREATE', null, emoji.id, null, null,
        'Emoji created', null, null, emoji.name, {animated: emoji.animated});
}

async function logEmojiDelete(emoji: GuildEmoji): Promise<void> {
    logger.info(`[EMOJI DELETE] :${emoji.name}:`, {guildId: emoji.guild.id, emojiId: emoji.id, category: 'emojiDelete'});
    await saveAuditLog(emoji.guild.id, 'EMOJI_DELETE', null, emoji.id, null, null,
        'Emoji deleted', null, emoji.name, null);
}

async function logEmojiUpdate(oldEmoji: GuildEmoji, newEmoji: GuildEmoji): Promise<void> {
    if (oldEmoji.name !== newEmoji.name) {
        logger.info(`[EMOJI UPDATE] :${oldEmoji.name}: → :${newEmoji.name}:`, {guildId: newEmoji.guild.id, emojiId: newEmoji.id, category: 'emojiUpdate'});
        await saveAuditLog(newEmoji.guild.id, 'EMOJI_UPDATE', null, newEmoji.id, null, null,
            'Emoji updated', null, oldEmoji.name, newEmoji.name);
    }
}

async function logStickerCreate(sticker: Sticker): Promise<void> {
    if (!sticker.guild) return;
    logger.info(`[STICKER CREATE] ${sticker.name}`, {guildId: sticker.guild.id, stickerId: sticker.id, category: 'stickerCreate'});
    await saveAuditLog(sticker.guild.id, 'STICKER_CREATE', null, sticker.id, null, null,
        'Sticker created', null, null, sticker.name);
}

async function logStickerDelete(sticker: Sticker): Promise<void> {
    if (!sticker.guild) return;
    logger.info(`[STICKER DELETE] ${sticker.name}`, {guildId: sticker.guild.id, stickerId: sticker.id, category: 'stickerDelete'});
    await saveAuditLog(sticker.guild.id, 'STICKER_DELETE', null, sticker.id, null, null,
        'Sticker deleted', null, sticker.name, null);
}

async function logStickerUpdate(oldSticker: Sticker, newSticker: Sticker): Promise<void> {
    if (!newSticker.guild) return;
    if (oldSticker.name !== newSticker.name) {
        logger.info(`[STICKER UPDATE] ${oldSticker.name} → ${newSticker.name}`, {guildId: newSticker.guild.id, stickerId: newSticker.id, category: 'stickerUpdate'});
        await saveAuditLog(newSticker.guild.id, 'STICKER_UPDATE', null, newSticker.id, null, null,
            'Sticker updated', null, oldSticker.name, newSticker.name);
    }
}

// ==================== WEBHOOK & INTEGRATION EVENTS ====================

async function logWebhookUpdate(channel: GuildChannel): Promise<void> {
    if (!channel.guild) return;
    logger.info(`[WEBHOOK] Webhooks updated in #${channel.name}`, {guildId: channel.guild.id, channelId: channel.id, category: 'webhookUpdate'});
    await saveAuditLog(channel.guild.id, 'WEBHOOK_UPDATE', null, channel.id, null, channel.id,
        'Webhooks updated', null, null, null);
}

async function logIntegrationUpdate(guild: Guild): Promise<void> {
    logger.info(`[INTEGRATION] Integrations updated`, {guildId: guild.id, category: 'integrationUpdate'});
    await saveAuditLog(guild.id, 'INTEGRATION_UPDATE', null, guild.id, null, null,
        'Integrations/bots updated', null, null, null);
}

// ==================== HELPER FUNCTION ====================

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
    metadata: Record<string, any> = {}
): Promise<void> {
    try {
        await db.execute<ResultSetHeader>(
            `INSERT INTO audit_logs (guild_id, event_type, user_id, target_id, moderator_id, channel_id, action, reason, old_value, new_value, metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [guildId, eventType, userId, targetId, moderatorId, channelId, action, reason, oldValue, newValue, JSON.stringify(metadata)]
        );
    } catch (error) {
        const err = _error as any;
        // Silent fail if table doesn't exist yet
        if (err.code !== 'ER_NO_SUCH_TABLE') {
            logger.error(`Failed to save audit log: ${err.message}`);
        }
    }
}

// ==================== EXPORTS ====================

export = {
    // Existing
    logMessageDelete,
    logMessageUpdate,
    logMemberUpdate,
    logVoiceStateUpdate,
    // Convenience exports
    logMemberRoleUpdate: logMemberUpdate,
    logMemberNicknameUpdate: logMemberUpdate,
    // New Channel Events
    logChannelCreate,
    logChannelDelete,
    logChannelUpdate,
    logThreadCreate,
    logThreadDelete,
    logThreadUpdate,
    // New Guild Events
    logGuildUpdate,
    logGuildBanAdd,
    logGuildBanRemove,
    logGuildMemberRemove,
    // New Role Events
    logRoleCreate,
    logRoleDelete,
    logRoleUpdate,
    // New Emoji/Sticker Events
    logEmojiCreate,
    logEmojiDelete,
    logEmojiUpdate,
    logStickerCreate,
    logStickerDelete,
    logStickerUpdate,
    // New Webhook/Integration Events
    logWebhookUpdate,
    logIntegrationUpdate
};
