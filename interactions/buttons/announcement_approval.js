import { EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

export async function handleApproveAnnouncement(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });

        // Parse the custom ID: approve_announcement_${userId}_${platform}_${username}
        const parts = interaction.customId.split('_');
        const userId = parts[2];
        const platform = parts[3];
        const username = parts.slice(4).join('_'); // In case username has underscores

        logger.info(`[Announcement Approval] Admin ${interaction.user.tag} approved request`, {
            userId,
            platform,
            username,
            adminId: interaction.user.id
        });

        // Get the user
        const user = await interaction.client.users.fetch(userId).catch(() => null);
        if (!user) {
            await interaction.editReply({
                content: '❌ Could not find the user who made this request.'
            });
            return;
        }

        // Check if streamer already exists in database
        let connection;
        try {
            connection = await pool.getConnection();

            // Check if streamer exists
            const [existingStreamers] = await connection.query(
                'SELECT streamer_id FROM streamers WHERE LOWER(username) = LOWER(?) AND platform = ?',
                [username, platform.toLowerCase()]
            );

            let streamerId;
            if (existingStreamers.length > 0) {
                streamerId = existingStreamers[0].streamer_id;

                // Update discord_user_id if not set
                await connection.query(
                    'UPDATE streamers SET discord_user_id = ? WHERE streamer_id = ? AND discord_user_id IS NULL',
                    [userId, streamerId]
                );
            } else {
                // Create new streamer
                const [result] = await connection.query(
                    'INSERT INTO streamers (username, platform, discord_user_id) VALUES (?, ?, ?)',
                    [username, platform.toLowerCase(), userId]
                );
                streamerId = result.insertId;
            }

            // Create subscription for the guild
            const [existingSub] = await connection.query(
                'SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ?',
                [interaction.guildId, streamerId]
            );

            if (existingSub.length > 0) {
                await interaction.editReply({
                    content: `⚠️ **${username}** on **${platform}** is already being tracked in this server!`
                });
            } else {
                // Get guild's default announcement channel
                const [guildConfig] = await connection.query(
                    'SELECT announcement_channel_id FROM guilds WHERE guild_id = ?',
                    [interaction.guildId]
                );

                const announcementChannelId = guildConfig.length > 0 ? guildConfig[0].announcement_channel_id : null;

                await connection.query(
                    'INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, delete_on_end) VALUES (?, ?, ?, 1)',
                    [interaction.guildId, streamerId, announcementChannelId]
                );

                // Update the embed to show it was approved
                const originalEmbed = interaction.message.embeds[0];
                const approvedEmbed = EmbedBuilder.from(originalEmbed)
                    .setColor('#57F287') // Green
                    .setFooter({ text: `Approved by ${interaction.user.tag} • User ID: ${userId}` });

                await interaction.message.edit({
                    embeds: [approvedEmbed],
                    components: [] // Remove buttons
                });

                // Notify the user
                try {
                    await user.send({
                        embeds: [
                            new EmbedBuilder()
                                .setColor('#57F287')
                                .setTitle('✅ Stream Announcement Request Approved!')
                                .setDescription(`Your request to add **${username}** (${platform}) to the announcement list has been **approved** by the admins in **${interaction.guild.name}**!`)
                                .addFields(
                                    { name: 'Platform', value: platform, inline: true },
                                    { name: 'Username', value: username, inline: true }
                                )
                                .setTimestamp()
                        ]
                    });
                } catch (dmError) {
                    logger.warn('[Announcement Approval] Could not DM user', {
                        userId,
                        error: dmError.message
                    });
                }

                await interaction.editReply({
                    content: `✅ Successfully added **${username}** (${platform}) to the tracked streamers for this server!\n\nThe user has been notified via DM.`
                });
            }

        } finally {
            if (connection) connection.release();
        }

    } catch (error) {
        logger.error('[Announcement Approval] Error approving request', {
            error: error.message,
            stack: error.stack
        });

        const errorMessage = {
            content: 'An error occurred while approving the request. Please try manually adding the streamer using `/streamer add`.'
        };

        if (interaction.deferred) {
            await interaction.editReply(errorMessage);
        } else {
            await interaction.reply({ ...errorMessage, ephemeral: true });
        }
    }
}

export async function handleDenyAnnouncement(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });

        // Parse the custom ID: deny_announcement_${userId}
        const userId = interaction.customId.split('_')[2];

        logger.info(`[Announcement Denial] Admin ${interaction.user.tag} denied request`, {
            userId,
            adminId: interaction.user.id
        });

        // Get the user
        const user = await interaction.client.users.fetch(userId).catch(() => null);

        // Update the embed to show it was denied
        const originalEmbed = interaction.message.embeds[0];
        const deniedEmbed = EmbedBuilder.from(originalEmbed)
            .setColor('#ED4245') // Red
            .setFooter({ text: `Denied by ${interaction.user.tag} • User ID: ${userId}` });

        await interaction.message.edit({
            embeds: [deniedEmbed],
            components: [] // Remove buttons
        });

        // Notify the user if possible
        if (user) {
            try {
                const platform = originalEmbed.fields.find(f => f.name === '📺 Platform')?.value || 'Unknown';
                const username = originalEmbed.fields.find(f => f.name === '👤 Username')?.value || 'Unknown';

                await user.send({
                    embeds: [
                        new EmbedBuilder()
                            .setColor('#ED4245')
                            .setTitle('❌ Stream Announcement Request Denied')
                            .setDescription(`Your request to add **${username}** (${platform}) to the announcement list in **${interaction.guild.name}** has been **denied** by the admins.`)
                            .addFields(
                                { name: 'Platform', value: platform, inline: true },
                                { name: 'Username', value: username, inline: true }
                            )
                            .setFooter({ text: 'You may contact the server admins for more information.' })
                            .setTimestamp()
                    ]
                });
            } catch (dmError) {
                logger.warn('[Announcement Denial] Could not DM user', {
                    userId,
                    error: dmError.message
                });
            }
        }

        await interaction.editReply({
            content: '✅ Request has been denied and the user has been notified.'
        });

    } catch (error) {
        logger.error('[Announcement Denial] Error denying request', {
            error: error.message,
            stack: error.stack
        });

        const errorMessage = {
            content: 'An error occurred while denying the request.'
        };

        if (interaction.deferred) {
            await interaction.editReply(errorMessage);
        } else {
            await interaction.reply({ ...errorMessage, ephemeral: true });
        }
    }
}
