import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import logger from '../../utils/logger.js';

export async function handleAnnouncementRequestForm(interaction) {
    try {
        logger.info(`[Announcement Request] Form submitted by ${interaction.user.tag}`, {
            guildId: interaction.guildId,
            userId: interaction.user.id
        });

        // Extract the requests channel ID from the custom ID
        const requestsChannelId = interaction.customId.split('_').pop();

        // Get form values
        const platform = interaction.fields.getTextInputValue('stream_platform');
        const username = interaction.fields.getTextInputValue('stream_username');
        const link = interaction.fields.getTextInputValue('stream_link');
        const additionalInfo = interaction.fields.getTextInputValue('additional_info') || 'None provided';

        // Get the requests channel
        const requestsChannel = await interaction.guild.channels.fetch(requestsChannelId).catch(() => null);

        if (!requestsChannel) {
            await interaction.reply({
                content: 'Error: The requests channel has been deleted or I no longer have access to it. Please contact an administrator.',
                ephemeral: true
            });
            return;
        }

        // Create embed for the request
        const requestEmbed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('New Stream Announcement Request')
            .setDescription(`**User:** ${interaction.user.tag} (${interaction.user.id})\n**Discord Mention:** ${interaction.user}`)
            .addFields(
                { name: '📺 Platform', value: platform, inline: true },
                { name: '👤 Username', value: username, inline: true },
                { name: '🔗 Link', value: link, inline: false },
                { name: '📝 Additional Info', value: additionalInfo, inline: false }
            )
            .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
            .setFooter({ text: `User ID: ${interaction.user.id}` })
            .setTimestamp();

        // Create approve/deny buttons
        const approveButton = new ButtonBuilder()
            .setCustomId(`approve_announcement_${interaction.user.id}_${platform}_${username}`)
            .setLabel('Approve')
            .setStyle(ButtonStyle.Success)
            .setEmoji('✅');

        const denyButton = new ButtonBuilder()
            .setCustomId(`deny_announcement_${interaction.user.id}`)
            .setLabel('Deny')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌');

        const row = new ActionRowBuilder().addComponents(approveButton, denyButton);

        // Send to requests channel
        try {
            await requestsChannel.send({
                content: `<@&${interaction.guild.roles.everyone.id}>`, // Notify admins (or configure a specific role)
                embeds: [requestEmbed],
                components: [row]
            });

            // Confirm to user
            await interaction.reply({
                content: `✅ Your request has been submitted successfully! Administrators will review it soon.\n\n**Platform:** ${platform}\n**Username:** ${username}`,
                ephemeral: true
            });

            logger.info(`[Announcement Request] Request sent to channel ${requestsChannelId}`, {
                userId: interaction.user.id,
                platform,
                username
            });

        } catch (error) {
            logger.error('[Announcement Request] Failed to send request to channel', {
                error: error.message,
                stack: error.stack,
                channelId: requestsChannelId
            });

            await interaction.reply({
                content: 'An error occurred while submitting your request. Please contact an administrator.',
                ephemeral: true
            });
        }

    } catch (error) {
        logger.error('[Announcement Request] Error processing form', {
            error: error.message,
            stack: error.stack
        });

        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: 'An error occurred while processing your request. Please try again.',
                ephemeral: true
            }).catch(() => {});
        }
    }
}
