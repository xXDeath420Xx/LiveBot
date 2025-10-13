const logger = require('../utils/logger');
const db = require('../utils/db');

async function logMessageDelete(message) {
    // FIX: Add null check for message.author
    if (!message.guild || !message.author || message.author.bot) return;

    const guildId = message.guild.id;
    const channelId = message.channel.id;
    const userId = message.author.id;
    const messageId = message.id;
    const content = message.content;

    logger.info(`Message deleted in #${message.channel.name} by ${message.author.tag}: ${content}`, {
        guildId,
        channelId,
        userId,
        messageId,
        content,
        category: 'messageDelete'
    });
}

async function logMessageUpdate(oldMessage, newMessage) {
    if (!newMessage.guild || !newMessage.author || oldMessage.content === newMessage.content || newMessage.author.bot) return;

    const guildId = newMessage.guild.id;
    const channelId = newMessage.channel.id;
    const userId = newMessage.author.id;
    const messageId = newMessage.id;
    const oldContent = oldMessage.content;
    const newContent = newMessage.content;

    logger.info(`Message edited in #${newMessage.channel.name} by ${newMessage.author.tag}. Old: "${oldContent}" New: "${newContent}"`, {
        guildId,
        channelId,
        userId,
        messageId,
        oldContent,
        newContent,
        category: 'messageUpdate'
    });
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

module.exports = {
    logMessageDelete,
    logMessageUpdate,
    logMemberUpdate,
    logVoiceStateUpdate
};