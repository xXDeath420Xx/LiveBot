import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import logger from '../../utils/logger.js';

export async function handleRequestAnnouncementButton(interaction) {
    try {
        logger.info(`[Request Announcement] Button clicked by ${interaction.user.tag}`, {
            guildId: interaction.guildId,
            userId: interaction.user.id
        });

        // Extract the requests channel ID from the custom ID
        const requestsChannelId = interaction.customId.split('_').pop();

        // Create modal for user to fill in their stream info
        const modal = new ModalBuilder()
            .setCustomId(`announcement_request_form_${requestsChannelId}`)
            .setTitle('Request Stream Announcements');

        // Stream platform (Twitch, Kick, YouTube, etc.)
        const platformInput = new TextInputBuilder()
            .setCustomId('stream_platform')
            .setLabel('Streaming Platform')
            .setPlaceholder('e.g., Twitch, Kick, YouTube, Facebook Gaming')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(50);

        // Stream username
        const usernameInput = new TextInputBuilder()
            .setCustomId('stream_username')
            .setLabel('Your Stream Username/Channel Name')
            .setPlaceholder('e.g., YourTwitchUsername')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100);

        // Profile link
        const profileLinkInput = new TextInputBuilder()
            .setCustomId('stream_link')
            .setLabel('Direct Link to Your Stream Profile')
            .setPlaceholder('e.g., https://twitch.tv/yourusername')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(200);

        // Additional info
        const additionalInfoInput = new TextInputBuilder()
            .setCustomId('additional_info')
            .setLabel('Additional Information (Optional)')
            .setPlaceholder('Any other details you want to share...')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(500);

        // Create action rows
        const platformRow = new ActionRowBuilder().addComponents(platformInput);
        const usernameRow = new ActionRowBuilder().addComponents(usernameInput);
        const linkRow = new ActionRowBuilder().addComponents(profileLinkInput);
        const additionalRow = new ActionRowBuilder().addComponents(additionalInfoInput);

        // Add all rows to modal
        modal.addComponents(platformRow, usernameRow, linkRow, additionalRow);

        // Show the modal
        await interaction.showModal(modal);

    } catch (error) {
        logger.error('[Request Announcement] Error showing modal', {
            error: error.message,
            stack: error.stack
        });

        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: 'An error occurred while opening the request form. Please try again or contact an administrator.',
                ephemeral: true
            }).catch(() => {});
        }
    }
}
