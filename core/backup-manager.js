const { ChannelType } = require('discord.js');
const db = require('../utils/db');
const logger = require('../utils/logger');

async function createSnapshot(guild) {
    await guild.roles.fetch();
    await guild.channels.fetch();

    const roles = guild.roles.cache
        .filter(role => !role.managed && role.id !== guild.id)
        .sort((a, b) => b.position - a.position)
        .map(role => ({
            name: role.name,
            color: role.hexColor,
            hoist: role.hoist,
            permissions: role.permissions.bitfield.toString(),
            mentionable: role.mentionable
        }));
    
    const serializeChannel = (channel) => {
        const serialized = {
            name: channel.name,
            type: channel.type,
            position: channel.position,
            permissionOverwrites: Array.from(channel.permissionOverwrites.cache.values()).map(ow => ({
                id: ow.id,
                type: ow.type,
                allow: ow.allow.bitfield.toString(),
                deny: ow.deny.bitfield.toString()
            }))
        };
        if ('topic' in channel) serialized.topic = channel.topic;
        if ('nsfw' in channel) serialized.nsfw = channel.nsfw;
        if ('rateLimitPerUser' in channel) serialized.rateLimitPerUser = channel.rateLimitPerUser;

        if (channel.type === ChannelType.GuildCategory) {
             serialized.children = Array.from(channel.children.cache.values())
                .sort((a,b) => a.position - b.position)
                .map(serializeChannel);
        }
        return serialized;
    };
    
    const channels = guild.channels.cache
        .filter(c => c.parentId === null)
        .sort((a, b) => a.position - b.position)
        .map(serializeChannel);
    
    return { roles, channels };
}

async function loadSnapshot(guild, snapshot) {
    logger.warn(`[Backup] STARTING DESTRUCTIVE RESTORE for guild: ${guild.name} (${guild.id})`);

    // Delete existing channels
    for (const channel of guild.channels.cache.values()) {
        await channel.delete('Backup Restore').catch(e => logger.error(`[Backup-Restore] Failed to delete channel ${channel.name}: ${e.message}`));
    }
    // Delete existing roles
    for (const role of guild.roles.cache.values()) {
        if (!role.managed && role.id !== guild.id) {
            await role.delete('Backup Restore').catch(e => logger.error(`[Backup-Restore] Failed to delete role ${role.name}: ${e.message}`));
        }
    }

    // Restore Roles
    const roleIdMap = new Map();
    roleIdMap.set(guild.id, '@everyone'); // Special case for @everyone
    for (const roleData of snapshot.roles.reverse()) {
        const newRole = await guild.roles.create({
            name: roleData.name,
            color: roleData.color,
            hoist: roleData.hoist,
            permissions: BigInt(roleData.permissions),
            mentionable: roleData.mentionable,
            reason: 'Backup Restore'
        });
        roleIdMap.set(newRole.name, newRole.id); // Map old name to new ID
    }

    // Restore Channels and Permissions
    const restoreChannel = async (channelData, parent) => {
        const permissionOverwrites = channelData.permissionOverwrites.map(ow => {
            let id;
            if (ow.type === 0) { // role
                const roleName = guild.roles.cache.find(r => r.id === ow.id)?.name;
                id = roleIdMap.get(roleName);
            } else { // member
                id = ow.id;
            }
            return {
                id: id || ow.id,
                allow: BigInt(ow.allow),
                deny: BigInt(ow.deny)
            };
        });

        const channelOptions = {
            name: channelData.name,
            type: channelData.type,
            topic: channelData.topic,
            nsfw: channelData.nsfw,
            parent: parent || null,
            permissionOverwrites: permissionOverwrites,
            reason: 'Backup Restore'
        };

        const newChannel = await guild.channels.create(channelOptions);

        if (channelData.children && channelData.children.length > 0) {
            for (const childData of channelData.children) {
                await restoreChannel(childData, newChannel.id);
            }
        }
    };

    for (const channelData of snapshot.channels) {
        await restoreChannel(channelData, null);
    }
    
    logger.warn(`[Backup] RESTORE COMPLETE for guild: ${guild.name} (${guild.id})`);
}

module.exports = { createSnapshot, loadSnapshot };