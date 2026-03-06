import { EmbedBuilder } from 'discord.js';
import logger from '../../utils/logger.js';

/**
 * Handle embed creation modal submission
 */
export async function handleEmbedCreate(interaction) {
    const customId = interaction.customId;
    // Extract channel ID from customId: embed_create_<channelId>
    const channelId = customId.replace('embed_create_', '');

    const title = interaction.fields.getTextInputValue('embed_title') || null;
    const description = interaction.fields.getTextInputValue('embed_description') || null;
    const color = interaction.fields.getTextInputValue('embed_color') || '#5865F2';
    const image = interaction.fields.getTextInputValue('embed_image') || null;
    const footer = interaction.fields.getTextInputValue('embed_footer') || null;

    if (!title && !description) {
        return interaction.reply({ content: 'You must provide at least a title or description.', ephemeral: true });
    }

    const embed = new EmbedBuilder().setTimestamp();

    if (title) embed.setTitle(title);
    if (description) embed.setDescription(description);
    try {
        const hex = color.startsWith('#') ? color : `#${color}`;
        embed.setColor(parseInt(hex.replace('#', ''), 16));
    } catch {
        embed.setColor(0x5865F2);
    }
    if (image) embed.setImage(image);
    if (footer) embed.setFooter({ text: footer });

    try {
        const channel = await interaction.guild.channels.fetch(channelId);
        const msg = await channel.send({ embeds: [embed] });

        return interaction.reply({
            content: `Embed sent to ${channel}! [Jump to message](${msg.url})`,
            ephemeral: true
        });
    } catch (error) {
        logger.error('[EmbedModal] Error sending embed:', error);
        return interaction.reply({ content: `Failed to send embed: ${error.message}`, ephemeral: true });
    }
}

/**
 * Handle embed edit modal submission
 */
export async function handleEmbedEdit(interaction) {
    const customId = interaction.customId;
    // Extract channel ID and message ID: embed_edit_<channelId>_<messageId>
    const parts = customId.replace('embed_edit_', '').split('_');
    const channelId = parts[0];
    const messageId = parts[1];

    const title = interaction.fields.getTextInputValue('embed_title') || null;
    const description = interaction.fields.getTextInputValue('embed_description') || null;
    const color = interaction.fields.getTextInputValue('embed_color') || '#5865F2';
    const image = interaction.fields.getTextInputValue('embed_image') || null;
    const footer = interaction.fields.getTextInputValue('embed_footer') || null;

    if (!title && !description) {
        return interaction.reply({ content: 'You must provide at least a title or description.', ephemeral: true });
    }

    const embed = new EmbedBuilder().setTimestamp();

    if (title) embed.setTitle(title);
    if (description) embed.setDescription(description);
    try {
        const hex = color.startsWith('#') ? color : `#${color}`;
        embed.setColor(parseInt(hex.replace('#', ''), 16));
    } catch {
        embed.setColor(0x5865F2);
    }
    if (image) embed.setImage(image);
    if (footer) embed.setFooter({ text: footer });

    try {
        const channel = await interaction.guild.channels.fetch(channelId);
        const message = await channel.messages.fetch(messageId);
        await message.edit({ embeds: [embed] });

        return interaction.reply({
            content: `Embed updated! [Jump to message](${message.url})`,
            ephemeral: true
        });
    } catch (error) {
        logger.error('[EmbedModal] Error editing embed:', error);
        return interaction.reply({ content: `Failed to edit embed: ${error.message}`, ephemeral: true });
    }
}
