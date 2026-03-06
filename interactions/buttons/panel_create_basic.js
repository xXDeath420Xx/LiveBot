import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import logger from '../../utils/logger.js';

/**
 * Handle basic panel creation button
 * Shows a modal to gather initial panel configuration
 */
export async function handlePanelCreateBasic(interaction) {
    try {
        const modal = new ModalBuilder()
            .setCustomId('panel_create_modal')
            .setTitle('Create Ticket Panel');

        // Panel Name
        const panelNameInput = new TextInputBuilder()
            .setCustomId('panel_name')
            .setLabel('Panel Name')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., General Support, Bug Reports')
            .setRequired(true)
            .setMaxLength(100);

        // Embed Title
        const embedTitleInput = new TextInputBuilder()
            .setCustomId('embed_title')
            .setLabel('Embed Title')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Support Ticket')
            .setValue('Support Ticket')
            .setRequired(false)
            .setMaxLength(255);

        // Embed Description
        const embedDescInput = new TextInputBuilder()
            .setCustomId('embed_description')
            .setLabel('Embed Description')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Click the button below to create a support ticket.')
            .setValue('Click the button below to create a support ticket. Our team will assist you shortly!')
            .setRequired(false)
            .setMaxLength(1000);

        // Button Text
        const buttonTextInput = new TextInputBuilder()
            .setCustomId('button_text')
            .setLabel('Button Text')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Create Ticket')
            .setValue('Create Ticket')
            .setRequired(false)
            .setMaxLength(80);

        // Button Emoji (optional)
        const buttonEmojiInput = new TextInputBuilder()
            .setCustomId('button_emoji')
            .setLabel('Button Emoji (optional)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('🎫')
            .setRequired(false)
            .setMaxLength(10);

        // Add inputs to action rows
        const row1 = new ActionRowBuilder().addComponents(panelNameInput);
        const row2 = new ActionRowBuilder().addComponents(embedTitleInput);
        const row3 = new ActionRowBuilder().addComponents(embedDescInput);
        const row4 = new ActionRowBuilder().addComponents(buttonTextInput);
        const row5 = new ActionRowBuilder().addComponents(buttonEmojiInput);

        modal.addComponents(row1, row2, row3, row4, row5);

        await interaction.showModal(modal);

    } catch (error) {
        logger.error('[Panel Create Basic Button Error]', error);
        await interaction.reply({
            content: 'An error occurred while showing the panel creation form.',
            ephemeral: true
        }).catch(() => {});
    }
}

export default handlePanelCreateBasic;
