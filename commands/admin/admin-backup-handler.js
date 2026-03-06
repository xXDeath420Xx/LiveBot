import { EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

export async function handleCreate(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guild.id;
    const userId = interaction.user.id;
    const name = interaction.options.getString('name');
    const guild = interaction.guild;

    const snapshot = {
        version: '2.0',
        guildName: guild.name,
        guildIcon: guild.iconURL({ size: 1024 }),
        guildBanner: guild.bannerURL({ size: 1024 }),
        createdAt: new Date().toISOString(),
        channels: [],
        roles: [],
        categories: [],
        emoji: [],
        stickers: [],
        webhooks: [],
        memberRoles: []
    };

    // Backup roles (excluding @everyone and bot roles)
    const roles = Array.from(guild.roles.cache.values())
        .filter(role => !role.managed && role.id !== guild.id)
        .sort((a, b) => b.position - a.position);

    for (const role of roles) {
        snapshot.roles.push({
            name: role.name,
            color: role.color,
            hoist: role.hoist,
            permissions: role.permissions.bitfield.toString(),
            mentionable: role.mentionable,
            position: role.position
        });
    }

    // Backup categories
    const categories = guild.channels.cache.filter(ch => ch.type === 4);
    for (const [id, category] of categories) {
        snapshot.categories.push({
            name: category.name,
            position: category.position,
            channels: []
        });
    }

    // Backup channels
    const channels = guild.channels.cache.filter(ch => ch.type !== 4);
    for (const [id, channel] of channels) {
        const channelData = {
            name: channel.name,
            type: channel.type,
            position: channel.position,
            topic: channel.topic || null,
            nsfw: channel.nsfw || false,
            rateLimitPerUser: channel.rateLimitPerUser || 0,
            bitrate: channel.bitrate || null,
            userLimit: channel.userLimit || null,
            parentName: channel.parent?.name || null
        };

        if (channel.parent) {
            const catIndex = snapshot.categories.findIndex(c => c.name === channel.parent.name);
            if (catIndex !== -1) {
                snapshot.categories[catIndex].channels.push(channelData);
            }
        } else {
            snapshot.channels.push(channelData);
        }
    }

    // Backup emoji
    for (const [id, emoji] of guild.emojis.cache) {
        snapshot.emoji.push({
            name: emoji.name,
            url: emoji.url,
            animated: emoji.animated,
            requireColons: emoji.requireColons
        });
    }

    // Backup stickers
    for (const [id, sticker] of guild.stickers.cache) {
        snapshot.stickers.push({
            name: sticker.name,
            description: sticker.description,
            tags: sticker.tags,
            url: sticker.url
        });
    }

    // Backup webhooks
    const webhooks = await guild.fetchWebhooks().catch(() => new Map());
    for (const [id, webhook] of webhooks) {
        snapshot.webhooks.push({
            name: webhook.name,
            channelName: webhook.channel?.name,
            avatar: webhook.avatarURL(),
            url: webhook.url
        });
    }

    // Backup member roles (limit to 500 members)
    const members = await guild.members.fetch({ limit: 500 }).catch(() => new Map());
    for (const [id, member] of members) {
        if (!member.user.bot) {
            const memberRoles = Array.from(member.roles.cache.values())
                .filter(role => role.id !== guild.id)
                .map(role => role.name);

            if (memberRoles.length > 0) {
                snapshot.memberRoles.push({
                    userId: member.id,
                    username: member.user.tag,
                    roles: memberRoles
                });
            }
        }
    }

    const snapshotJson = JSON.stringify(snapshot);
    const [result] = await pool.execute(
        `INSERT INTO server_backups (guild_id, snapshot_name, snapshot_json, created_by_id) VALUES (?, ?, ?, ?)`,
        [guildId, name, snapshotJson, userId]
    );

    const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('✅ Backup Created')
        .setDescription(`Server backup **${name}** has been created successfully!`)
        .addFields(
            { name: 'Backup ID', value: `${result.insertId}`, inline: true },
            { name: 'Roles', value: `${snapshot.roles.length}`, inline: true },
            { name: 'Channels', value: `${channels.size}`, inline: true },
            { name: 'Categories', value: `${snapshot.categories.length}`, inline: true },
            { name: 'Emoji', value: `${snapshot.emoji.length}`, inline: true },
            { name: 'Stickers', value: `${snapshot.stickers.length}`, inline: true },
            { name: 'Webhooks', value: `${snapshot.webhooks.length}`, inline: true },
            { name: 'Member Roles', value: `${snapshot.memberRoles.length}`, inline: true },
            { name: '\u200B', value: '\u200B', inline: true }
        )
        .setFooter({ text: `Use /admin backup restore ${result.insertId} to restore this backup` })
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

    logger.info('[Backup] Created backup', {
        guildId,
        backupId: result.insertId,
        name,
        userId
    });
}

export async function handleList(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guild.id;
    const [backups] = await pool.execute(
        `SELECT id, snapshot_name, created_by_id, created_at FROM server_backups WHERE guild_id = ? ORDER BY created_at DESC`,
        [guildId]
    );

    if (backups.length === 0) {
        return await interaction.editReply({
            content: 'No backups found for this server. Create one with `/admin backup create`!'
        });
    }

    const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('📦 Server Backups')
        .setDescription(`Found ${backups.length} backup${backups.length !== 1 ? 's' : ''} for this server:\n`);

    for (const backup of backups.slice(0, 10)) {
        const creator = await interaction.guild.members.fetch(backup.created_by_id).catch(() => null);
        const creatorName = creator ? creator.user.tag : 'Unknown User';
        const date = new Date(backup.created_at).toLocaleString();

        embed.addFields({
            name: `ID: ${backup.id} - ${backup.snapshot_name}`,
            value: `Created by ${creatorName} on ${date}`,
            inline: false
        });
    }

    if (backups.length > 10) {
        embed.setFooter({ text: `Showing 10 of ${backups.length} backups` });
    }

    await interaction.editReply({ embeds: [embed] });
}

export async function handleRestore(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guild.id;
    const userId = interaction.user.id;
    const backupId = interaction.options.getInteger('backup_id');

    const [backups] = await pool.execute(
        `SELECT * FROM server_backups WHERE id = ? AND guild_id = ?`,
        [backupId, guildId]
    );

    if (backups.length === 0) {
        return await interaction.editReply({
            content: `Backup with ID ${backupId} not found for this server!`
        });
    }

    const snapshot = JSON.parse(backups[0].snapshot_json);
    const guild = interaction.guild;

    await interaction.editReply({
        content: '⚠️ **WARNING**: Restore will DELETE all existing channels and roles!\n\nStarting restore process...'
    });

    let deletedChannels = 0;
    let deletedRoles = 0;
    let createdChannels = 0;
    let createdRoles = 0;

    try {
        // Delete existing channels (except system channels)
        for (const [id, channel] of guild.channels.cache) {
            if (channel.id !== guild.rulesChannelId && channel.id !== guild.publicUpdatesChannelId) {
                try {
                    await channel.delete('Backup restore');
                    deletedChannels++;
                } catch (err) {
                    logger.warn('[Backup] Could not delete channel', { channelId: id, error: err.message });
                }
            }
        }

        // Delete existing roles (except @everyone and managed roles)
        for (const [id, role] of guild.roles.cache) {
            if (!role.managed && id !== guild.id) {
                try {
                    await role.delete('Backup restore');
                    deletedRoles++;
                } catch (err) {
                    logger.warn('[Backup] Could not delete role', { roleId: id, error: err.message });
                }
            }
        }

        // Recreate roles
        for (const roleData of snapshot.roles) {
            try {
                await guild.roles.create({
                    name: roleData.name,
                    color: roleData.color,
                    hoist: roleData.hoist,
                    permissions: BigInt(roleData.permissions),
                    mentionable: roleData.mentionable,
                    reason: 'Backup restore'
                });
                createdRoles++;
            } catch (err) {
                logger.warn('[Backup] Could not create role', { roleName: roleData.name, error: err.message });
            }
        }

        // Recreate categories
        const categoryMap = new Map();
        for (const catData of snapshot.categories) {
            try {
                const category = await guild.channels.create({
                    name: catData.name,
                    type: 4,
                    position: catData.position,
                    reason: 'Backup restore'
                });
                categoryMap.set(catData.name, category);
            } catch (err) {
                logger.warn('[Backup] Could not create category', { categoryName: catData.name, error: err.message });
            }
        }

        // Recreate channels in categories
        for (const catData of snapshot.categories) {
            const category = categoryMap.get(catData.name);
            if (!category) continue;

            for (const channelData of catData.channels) {
                try {
                    const createData = {
                        name: channelData.name,
                        type: channelData.type,
                        parent: category.id,
                        position: channelData.position,
                        topic: channelData.topic,
                        nsfw: channelData.nsfw,
                        rateLimitPerUser: channelData.rateLimitPerUser,
                        reason: 'Backup restore'
                    };

                    if (channelData.bitrate) createData.bitrate = channelData.bitrate;
                    if (channelData.userLimit) createData.userLimit = channelData.userLimit;

                    await guild.channels.create(createData);
                    createdChannels++;
                } catch (err) {
                    logger.warn('[Backup] Could not create channel', { channelName: channelData.name, error: err.message });
                }
            }
        }

        // Recreate root channels (no parent)
        for (const channelData of snapshot.channels) {
            try {
                const createData = {
                    name: channelData.name,
                    type: channelData.type,
                    position: channelData.position,
                    topic: channelData.topic,
                    nsfw: channelData.nsfw,
                    rateLimitPerUser: channelData.rateLimitPerUser,
                    reason: 'Backup restore'
                };

                if (channelData.bitrate) createData.bitrate = channelData.bitrate;
                if (channelData.userLimit) createData.userLimit = channelData.userLimit;

                await guild.channels.create(createData);
                createdChannels++;
            } catch (err) {
                logger.warn('[Backup] Could not create channel', { channelName: channelData.name, error: err.message });
            }
        }

        // Restore emoji (v2.0+)
        let createdEmoji = 0;
        if (snapshot.emoji && snapshot.emoji.length > 0) {
            for (const emojiData of snapshot.emoji) {
                try {
                    await guild.emojis.create({
                        attachment: emojiData.url,
                        name: emojiData.name,
                        reason: 'Backup restore'
                    });
                    createdEmoji++;
                } catch (err) {
                    logger.warn('[Backup] Could not create emoji', { emojiName: emojiData.name, error: err.message });
                }
            }
        }

        // Restore stickers (v2.0+)
        let createdStickers = 0;
        if (snapshot.stickers && snapshot.stickers.length > 0) {
            for (const stickerData of snapshot.stickers) {
                try {
                    await guild.stickers.create({
                        file: stickerData.url,
                        name: stickerData.name,
                        tags: stickerData.tags,
                        description: stickerData.description,
                        reason: 'Backup restore'
                    });
                    createdStickers++;
                } catch (err) {
                    logger.warn('[Backup] Could not create sticker', { stickerName: stickerData.name, error: err.message });
                }
            }
        }

        // Restore webhooks (v2.0+)
        let createdWebhooks = 0;
        if (snapshot.webhooks && snapshot.webhooks.length > 0) {
            for (const webhookData of snapshot.webhooks) {
                try {
                    const channel = guild.channels.cache.find(ch => ch.name === webhookData.channelName);
                    if (channel && channel.isTextBased()) {
                        await channel.createWebhook({
                            name: webhookData.name,
                            avatar: webhookData.avatar,
                            reason: 'Backup restore'
                        });
                        createdWebhooks++;
                    }
                } catch (err) {
                    logger.warn('[Backup] Could not create webhook', { webhookName: webhookData.name, error: err.message });
                }
            }
        }

        // Restore server icon and banner (v2.0+)
        try {
            if (snapshot.guildIcon) {
                await guild.setIcon(snapshot.guildIcon).catch(() => {});
            }
            if (snapshot.guildBanner) {
                await guild.setBanner(snapshot.guildBanner).catch(() => {});
            }
        } catch (err) {
            logger.warn('[Backup] Could not restore server icon/banner', { error: err.message });
        }

        // Restore member roles (v2.0+)
        let restoredMemberRoles = 0;
        if (snapshot.memberRoles && snapshot.memberRoles.length > 0) {
            for (const memberData of snapshot.memberRoles) {
                try {
                    const member = await guild.members.fetch(memberData.userId).catch(() => null);
                    if (member) {
                        const rolesToAdd = [];
                        for (const roleName of memberData.roles) {
                            const role = guild.roles.cache.find(r => r.name === roleName);
                            if (role) rolesToAdd.push(role);
                        }
                        if (rolesToAdd.length > 0) {
                            await member.roles.add(rolesToAdd);
                            restoredMemberRoles++;
                        }
                    }
                } catch (err) {
                    logger.warn('[Backup] Could not restore member roles', { userId: memberData.userId, error: err.message });
                }
            }
        }

        const embed = new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle('✅ Backup Restored')
            .setDescription(`Successfully restored backup **${backups[0].snapshot_name}**!`)
            .addFields(
                { name: 'Channels Deleted', value: `${deletedChannels}`, inline: true },
                { name: 'Channels Created', value: `${createdChannels}`, inline: true },
                { name: '\u200B', value: '\u200B', inline: true },
                { name: 'Roles Deleted', value: `${deletedRoles}`, inline: true },
                { name: 'Roles Created', value: `${createdRoles}`, inline: true },
                { name: '\u200B', value: '\u200B', inline: true },
                { name: 'Emoji Created', value: `${createdEmoji}`, inline: true },
                { name: 'Stickers Created', value: `${createdStickers}`, inline: true },
                { name: 'Webhooks Created', value: `${createdWebhooks}`, inline: true },
                { name: 'Member Roles Restored', value: `${restoredMemberRoles}`, inline: true }
            )
            .setTimestamp();

        await interaction.editReply({ content: null, embeds: [embed] });

        logger.info('[Backup] Restored backup', {
            guildId,
            backupId,
            userId,
            deletedChannels,
            deletedRoles,
            createdChannels,
            createdRoles
        });

    } catch (error) {
        logger.error('[Backup] Restore failed', { error: error.message, stack: error.stack });
        throw new Error(`Restore failed: ${error.message}`);
    }
}

export async function handleDelete(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guild.id;
    const backupId = interaction.options.getInteger('backup_id');

    const [result] = await pool.execute(
        `DELETE FROM server_backups WHERE id = ? AND guild_id = ?`,
        [backupId, guildId]
    );

    if (result.affectedRows === 0) {
        return await interaction.editReply({
            content: `Backup with ID ${backupId} not found for this server!`
        });
    }

    await interaction.editReply({
        content: `✅ Deleted backup ID ${backupId}`
    });

    logger.info('[Backup] Deleted backup', { guildId, backupId });
}

export async function handleInfo(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guild.id;
    const backupId = interaction.options.getInteger('backup_id');

    const [backups] = await pool.execute(
        `SELECT * FROM server_backups WHERE id = ? AND guild_id = ?`,
        [backupId, guildId]
    );

    if (backups.length === 0) {
        return await interaction.editReply({
            content: `Backup with ID ${backupId} not found for this server!`
        });
    }

    const backup = backups[0];
    const snapshot = JSON.parse(backup.snapshot_json);
    const creator = await interaction.guild.members.fetch(backup.created_by_id).catch(() => null);
    const creatorName = creator ? creator.user.tag : 'Unknown User';

    const channelCount = snapshot.channels.length + snapshot.categories.reduce((sum, cat) => sum + cat.channels.length, 0);

    const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle(`📦 Backup: ${backup.snapshot_name}`)
        .setDescription(`Detailed information about backup ID ${backupId}`)
        .addFields(
            { name: 'Created By', value: creatorName, inline: true },
            { name: 'Created At', value: new Date(backup.created_at).toLocaleString(), inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: 'Total Channels', value: `${channelCount}`, inline: true },
            { name: 'Categories', value: `${snapshot.categories.length}`, inline: true },
            { name: 'Roles', value: `${snapshot.roles.length}`, inline: true },
            { name: 'Backup Version', value: snapshot.version || '1.0', inline: true },
            { name: 'Original Server Name', value: snapshot.guildName, inline: true }
        )
        .setFooter({ text: `Use /admin backup restore ${backupId} to restore this backup` })
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}
