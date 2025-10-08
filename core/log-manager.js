const { EmbedBuilder, AuditLogEvent } = require('discord.js');
const db = require('../utils/db');
const logger = require('../utils/logger');

// This function saves a record to the database for long-term audit trails.
async function logAction(guildId, eventType, userId, targetId, details) {
    try {
        await db.execute(
            'INSERT INTO action_logs (guild_id, event_type, user_id, target_id, details) VALUES (?, ?, ?, ?, ?)',
            [guildId, eventType, userId, targetId, JSON.stringify(details)]
        );
    } catch (e) {
        logger.error('Failed to save action to database.', { guildId, category: 'system', error: e.stack });
    }
}

// Fetches the user who performed an action from the audit log.
async function getAuditLogUser(guild, event, target) {
    try {
        const fetchedLogs = await guild.fetchAuditLogs({
            limit: 1,
            type: event,
        });
        const log = fetchedLogs.entries.first();
        if (log && log.target.id === target.id) {
            return log.executor;
        }
    } catch (e) {
        // Ignore errors, likely due to missing permissions
    }
    return null;
}

// --- Event Handlers ---

async function logMessageDelete(message) {
    if (!message.guild || !message.author || message.author.bot) return;
    const guildId = message.guild.id;
    try {
        const executor = await getAuditLogUser(message.guild, AuditLogEvent.MessageDelete, message.author);
        const details = { 
            content: message.content || ' ', 
            channelName: message.channel.name,
            executor: executor ? executor.tag : 'Unknown'
        };
        await logAction(guildId, 'Message Deleted', message.author.id, message.channel.id, details);

        logger.info(`Message by ${message.author.tag} deleted in #${message.channel.name}`, {
            guildId,
            category: 'messageDelete',
            Author: `${message.author.tag} (${message.author.id})`,
            Executor: executor ? `${executor.tag} (${executor.id})` : 'Unknown',
            Content: message.content || ' '
        });
    } catch (e) {
        logger.error('Error in logMessageDelete', { guildId, category: 'system', error: e.stack });
    }
}

async function logMessageUpdate(oldMessage, newMessage) {
    if (!newMessage.guild || !newMessage.author || newMessage.author.bot || oldMessage.content === newMessage.content) return;
    const guildId = newMessage.guild.id;
    try {
        const details = { before: oldMessage.content, after: newMessage.content, messageUrl: newMessage.url };
        await logAction(guildId, 'Message Edited', newMessage.author.id, newMessage.channel.id, details);

        logger.info(`Message edited in #${newMessage.channel.name}`, {
            guildId,
            category: 'messageUpdate',
            Author: `${newMessage.author.tag} (${newMessage.author.id})`,
            Link: `[Jump to Message](${newMessage.url})`,
            Before: (oldMessage.content || ' ').substring(0, 1024),
            After: (newMessage.content || ' ').substring(0, 1024)
        });
    } catch (e) {
        logger.error('Error in logMessageUpdate', { guildId, category: 'system', error: e.stack });
    }
}

async function logMemberRoleUpdate(oldMember, newMember) {
    const guildId = newMember.guild.id;
    try {
        const oldRoles = oldMember.roles.cache;
        const newRoles = newMember.roles.cache;
        if (oldRoles.size === newRoles.size) return;

        const executor = await getAuditLogUser(newMember.guild, AuditLogEvent.MemberRoleUpdate, newMember.user);

        if (oldRoles.size > newRoles.size) {
            const removedRole = oldRoles.find(role => !newRoles.has(role.id));
            if (!removedRole) return;
            await logAction(guildId, 'Role Removed', executor ? executor.id : 'System', newMember.id, { roleName: removedRole.name });
            logger.info(`Role ${removedRole.name} removed from ${newMember.user.tag}`, { 
                guildId, 
                category: 'memberUpdate', 
                User: `${newMember.user.tag} (${newMember.id})`,
                Role: `${removedRole.name} (${removedRole.id})`,
                Executor: executor ? `${executor.tag} (${executor.id})` : 'Unknown'
            });
        } else {
            const addedRole = newRoles.find(role => !oldRoles.has(role.id));
            if (!addedRole) return;
            await logAction(guildId, 'Role Added', executor ? executor.id : 'System', newMember.id, { roleName: addedRole.name });
            logger.info(`Role ${addedRole.name} added to ${newMember.user.tag}`, { 
                guildId, 
                category: 'memberUpdate', 
                User: `${newMember.user.tag} (${newMember.id})`,
                Role: `${addedRole.name} (${addedRole.id})`,
                Executor: executor ? `${executor.tag} (${executor.id})` : 'Unknown'
            });
        }
    } catch (e) {
        logger.error('Error in logMemberRoleUpdate', { guildId, category: 'system', error: e.stack });
    }
}

async function logMemberNicknameUpdate(oldMember, newMember) {
    const guildId = newMember.guild.id;
    if (oldMember.nickname === newMember.nickname) return;
    try {
        const executor = await getAuditLogUser(newMember.guild, AuditLogEvent.MemberUpdate, newMember.user);
        const details = { oldNickname: oldMember.nickname, newNickname: newMember.nickname };
        await logAction(guildId, 'Nickname Changed', executor ? executor.id : newMember.id, newMember.id, details);

        logger.info(`Nickname changed for ${newMember.user.tag}`, {
            guildId,
            category: 'memberUpdate',
            User: `${newMember.user.tag} (${newMember.id})`,
            Before: oldMember.nickname || 'None',
            After: newMember.nickname || 'None',
            Executor: executor ? `${executor.tag} (${executor.id})` : 'Unknown'
        });
    } catch (e) {
        logger.error('Error in logMemberNicknameUpdate', { guildId, category: 'system', error: e.stack });
    }
}

async function logChannelCreate(channel) {
    if (!channel.guild) return;
    const guildId = channel.guild.id;
    try {
        const executor = await getAuditLogUser(channel.guild, AuditLogEvent.ChannelCreate, channel);
        await logAction(guildId, 'Channel Created', executor ? executor.id : 'System', channel.id, { channelName: channel.name, channelType: channel.type });

        logger.info(`Channel #${channel.name} created`, {
            guildId,
            category: 'channelUpdate',
            Channel: `${channel.name} (${channel.id})`,
            Type: channel.type,
            Executor: executor ? `${executor.tag} (${executor.id})` : 'Unknown'
        });
    } catch (e) {
        logger.error('Error in logChannelCreate', { guildId, category: 'system', error: e.stack });
    }
}

async function logChannelDelete(channel) {
    if (!channel.guild) return;
    const guildId = channel.guild.id;
    try {
        const executor = await getAuditLogUser(channel.guild, AuditLogEvent.ChannelDelete, channel);
        await logAction(guildId, 'Channel Deleted', executor ? executor.id : 'System', channel.id, { channelName: channel.name, channelType: channel.type });

        logger.info(`Channel #${channel.name} deleted`, {
            guildId,
            category: 'channelUpdate',
            Channel: `${channel.name} (${channel.id})`,
            Type: channel.type,
            Executor: executor ? `${executor.tag} (${executor.id})` : 'Unknown'
        });
    } catch (e) {
        logger.error('Error in logChannelDelete', { guildId, category: 'system', error: e.stack });
    }
}

async function logRoleCreate(role) {
    const guildId = role.guild.id;
    try {
        const executor = await getAuditLogUser(role.guild, AuditLogEvent.RoleCreate, role);
        await logAction(guildId, 'Role Created', executor ? executor.id : 'System', role.id, { roleName: role.name });

        logger.info(`Role ${role.name} created`, {
            guildId,
            category: 'roleUpdate',
            Role: `${role.name} (${role.id})`,
            Executor: executor ? `${executor.tag} (${executor.id})` : 'Unknown'
        });
    } catch (e) {
        logger.error('Error in logRoleCreate', { guildId, category: 'system', error: e.stack });
    }
}

async function logRoleDelete(role) {
    const guildId = role.guild.id;
    try {
        const executor = await getAuditLogUser(role.guild, AuditLogEvent.RoleDelete, role);
        await logAction(guildId, 'Role Deleted', executor ? executor.id : 'System', role.id, { roleName: role.name });

        logger.info(`Role ${role.name} deleted`, {
            guildId,
            category: 'roleUpdate',
            Role: `${role.name} (${role.id})`,
            Executor: executor ? `${executor.tag} (${executor.id})` : 'Unknown'
        });
    } catch (e) {
        logger.error('Error in logRoleDelete', { guildId, category: 'system', error: e.stack });
    }
}

async function logVoiceStateUpdate(oldState, newState) {
    const guildId = newState.guild.id;
    try {
        const user = newState.member.user;
        if (oldState.channelId === newState.channelId) return; // Ignore mute/deafen events

        if (oldState.channelId && !newState.channelId) {
            // User left a channel
            const channel = oldState.channel;
            logger.info(`${user.tag} left voice channel #${channel.name}`, { guildId, category: 'voiceUpdate', User: user.tag, Channel: channel.name });
        } else if (!oldState.channelId && newState.channelId) {
            // User joined a channel
            const channel = newState.channel;
            logger.info(`${user.tag} joined voice channel #${channel.name}`, { guildId, category: 'voiceUpdate', User: user.tag, Channel: channel.name });
        } else {
            // User moved channels
            const oldChannel = oldState.channel;
            const newChannel = newState.channel;
            logger.info(`${user.tag} moved voice channel from #${oldChannel.name} to #${newChannel.name}`, { guildId, category: 'voiceUpdate', User: user.tag, From: oldChannel.name, To: newChannel.name });
        }
    } catch (e) {
        logger.error('Error in logVoiceStateUpdate', { guildId, category: 'system', error: e.stack });
    }
}

module.exports = { 
    logMessageDelete, 
    logMessageUpdate, 
    logMemberRoleUpdate,
    logMemberNicknameUpdate,
    logChannelCreate,
    logChannelDelete,
    logRoleCreate,
    logRoleDelete,
    logVoiceStateUpdate
};