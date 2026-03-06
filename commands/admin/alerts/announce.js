import { EmbedBuilder } from 'discord.js';
import logger from '../../../utils/logger.js';
import { getAnnouncementsManager } from '../../../jobs/announcement-scheduler.js';

export async function execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const manager = getAnnouncementsManager(interaction.guild.id);

    if (!manager) {
        return interaction.reply({
            content: 'Announcement system is not initialized. Please contact the bot administrator.',
            ephemeral: true
        });
    }

    switch (subcommand) {
        case 'create':
            return await createAnnouncement(interaction, manager);
        case 'list':
            return await listAnnouncements(interaction, manager);
        case 'delete':
            return await deleteAnnouncement(interaction, manager);
        case 'toggle':
            return await toggleAnnouncement(interaction, manager);
        case 'edit':
            return await editAnnouncement(interaction, manager);
    }
}

async function createAnnouncement(interaction, manager) {
    const channel = interaction.options.getChannel('channel');
    const message = interaction.options.getString('message');
    const scheduleType = interaction.options.getString('schedule-type');
    const scheduleValue = interaction.options.getString('schedule-value');
    const embedTitle = interaction.options.getString('embed-title');
    const embedDescription = interaction.options.getString('embed-description');
    const embedColor = interaction.options.getString('embed-color');
    const embedImage = interaction.options.getString('embed-image');
    const embedThumbnail = interaction.options.getString('embed-thumbnail');

    // Build embed data if any embed options were provided
    let embedData = null;
    if (embedTitle || embedDescription || embedColor || embedImage || embedThumbnail) {
        embedData = {};
        if (embedTitle) embedData.title = embedTitle;
        if (embedDescription) embedData.description = embedDescription;
        if (embedColor) embedData.color = parseInt(embedColor.replace('#', ''), 16);
        if (embedImage) embedData.image = { url: embedImage };
        if (embedThumbnail) embedData.thumbnail = { url: embedThumbnail };
    }

    try {
        const announcementId = await manager.createAnnouncement(
            interaction.guild.id,
            channel.id,
            message,
            scheduleType,
            scheduleValue,
            embedData,
            interaction.user.id
        );

        const embed = new EmbedBuilder()
            .setTitle('Scheduled Announcement Created')
            .setColor(0x00FF00)
            .setDescription(`Successfully created announcement #${announcementId}`)
            .addFields(
                { name: 'Channel', value: `<#${channel.id}>`, inline: true },
                { name: 'Schedule Type', value: scheduleType, inline: true },
                { name: 'Schedule Value', value: scheduleValue, inline: true },
                { name: 'Message', value: message.length > 100 ? message.substring(0, 100) + '...' : message }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });

        logger.info('[Alerts Announce] Created scheduled announcement', {
            guildId: interaction.guild.id,
            userId: interaction.user.id,
            announcementId
        });
    } catch (error) {
        logger.error('[Alerts Announce] Failed to create announcement', {
            error: error.message,
            guildId: interaction.guild.id
        });
        await interaction.reply({
            content: `Failed to create announcement: ${error.message}`,
            ephemeral: true
        });
    }
}

async function listAnnouncements(interaction, manager) {
    try {
        const announcements = await manager.getGuildAnnouncements(interaction.guild.id);

        if (announcements.length === 0) {
            return interaction.reply({
                content: 'No scheduled announcements found for this server.',
                ephemeral: true
            });
        }

        const embed = new EmbedBuilder()
            .setTitle('Scheduled Announcements')
            .setColor(0x0099FF)
            .setDescription(`Found ${announcements.length} scheduled announcement(s)`)
            .setTimestamp();

        for (const announcement of announcements.slice(0, 10)) {
            const status = announcement.enabled ? '✅ Enabled' : '❌ Disabled';
            const nextRun = announcement.next_run
                ? `<t:${Math.floor(new Date(announcement.next_run).getTime() / 1000)}:R>`
                : 'Never';

            embed.addFields({
                name: `#${announcement.id} - ${status}`,
                value: `**Channel:** <#${announcement.channel_id}>\n**Type:** ${announcement.schedule_type}\n**Next Run:** ${nextRun}\n**Runs:** ${announcement.run_count}`,
                inline: false
            });
        }

        if (announcements.length > 10) {
            embed.setFooter({ text: `Showing first 10 of ${announcements.length} announcements` });
        }

        await interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (error) {
        logger.error('[Alerts Announce] Failed to list announcements', {
            error: error.message,
            guildId: interaction.guild.id
        });
        await interaction.reply({
            content: `Failed to list announcements: ${error.message}`,
            ephemeral: true
        });
    }
}

async function deleteAnnouncement(interaction, manager) {
    const announcementId = interaction.options.getInteger('announcement-id');

    try {
        // Check if announcement exists and belongs to this guild
        const announcement = await manager.getAnnouncement(announcementId);
        if (!announcement) {
            return interaction.reply({
                content: `Announcement #${announcementId} not found.`,
                ephemeral: true
            });
        }

        if (announcement.guild_id !== interaction.guild.id) {
            return interaction.reply({
                content: `Announcement #${announcementId} does not belong to this server.`,
                ephemeral: true
            });
        }

        const success = await manager.deleteAnnouncement(announcementId);

        if (success) {
            await interaction.reply({
                content: `Successfully deleted announcement #${announcementId}`,
                ephemeral: true
            });

            logger.info('[Alerts Announce] Deleted announcement', {
                guildId: interaction.guild.id,
                userId: interaction.user.id,
                announcementId
            });
        } else {
            await interaction.reply({
                content: `Failed to delete announcement #${announcementId}`,
                ephemeral: true
            });
        }
    } catch (error) {
        logger.error('[Alerts Announce] Failed to delete announcement', {
            error: error.message,
            guildId: interaction.guild.id
        });
        await interaction.reply({
            content: `Failed to delete announcement: ${error.message}`,
            ephemeral: true
        });
    }
}

async function toggleAnnouncement(interaction, manager) {
    const announcementId = interaction.options.getInteger('announcement-id');
    const enabled = interaction.options.getBoolean('enabled');

    try {
        // Check if announcement exists and belongs to this guild
        const announcement = await manager.getAnnouncement(announcementId);
        if (!announcement) {
            return interaction.reply({
                content: `Announcement #${announcementId} not found.`,
                ephemeral: true
            });
        }

        if (announcement.guild_id !== interaction.guild.id) {
            return interaction.reply({
                content: `Announcement #${announcementId} does not belong to this server.`,
                ephemeral: true
            });
        }

        const success = await manager.toggleAnnouncement(announcementId, enabled);

        if (success) {
            await interaction.reply({
                content: `Successfully ${enabled ? 'enabled' : 'disabled'} announcement #${announcementId}`,
                ephemeral: true
            });

            logger.info('[Alerts Announce] Toggled announcement', {
                guildId: interaction.guild.id,
                userId: interaction.user.id,
                announcementId,
                enabled
            });
        } else {
            await interaction.reply({
                content: `Failed to toggle announcement #${announcementId}`,
                ephemeral: true
            });
        }
    } catch (error) {
        logger.error('[Alerts Announce] Failed to toggle announcement', {
            error: error.message,
            guildId: interaction.guild.id
        });
        await interaction.reply({
            content: `Failed to toggle announcement: ${error.message}`,
            ephemeral: true
        });
    }
}

async function editAnnouncement(interaction, manager) {
    const announcementId = interaction.options.getInteger('announcement-id');
    const message = interaction.options.getString('message');
    const scheduleType = interaction.options.getString('schedule-type');
    const scheduleValue = interaction.options.getString('schedule-value');

    try {
        // Check if announcement exists and belongs to this guild
        const announcement = await manager.getAnnouncement(announcementId);
        if (!announcement) {
            return interaction.reply({
                content: `Announcement #${announcementId} not found.`,
                ephemeral: true
            });
        }

        if (announcement.guild_id !== interaction.guild.id) {
            return interaction.reply({
                content: `Announcement #${announcementId} does not belong to this server.`,
                ephemeral: true
            });
        }

        // Validate that both schedule type and value are provided together
        if ((scheduleType && !scheduleValue) || (!scheduleType && scheduleValue)) {
            return interaction.reply({
                content: 'Both schedule-type and schedule-value must be provided together.',
                ephemeral: true
            });
        }

        const updates = {};
        if (message) updates.messageContent = message;
        if (scheduleType && scheduleValue) {
            updates.scheduleType = scheduleType;
            updates.scheduleValue = scheduleValue;
        }

        if (Object.keys(updates).length === 0) {
            return interaction.reply({
                content: 'No changes specified. Please provide at least one field to update.',
                ephemeral: true
            });
        }

        const success = await manager.updateAnnouncement(announcementId, updates);

        if (success) {
            await interaction.reply({
                content: `Successfully updated announcement #${announcementId}`,
                ephemeral: true
            });

            logger.info('[Alerts Announce] Updated announcement', {
                guildId: interaction.guild.id,
                userId: interaction.user.id,
                announcementId
            });
        } else {
            await interaction.reply({
                content: `Failed to update announcement #${announcementId}`,
                ephemeral: true
            });
        }
    } catch (error) {
        logger.error('[Alerts Announce] Failed to update announcement', {
            error: error.message,
            guildId: interaction.guild.id
        });
        await interaction.reply({
            content: `Failed to update announcement: ${error.message}`,
            ephemeral: true
        });
    }
}
