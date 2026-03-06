import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

/**
 * Handle panel creation modal submission
 * Stores initial data and shows select menus for category, channel, and role
 */
export async function handlePanelCreateModal(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });

        // Extract form data
        const panelName = interaction.fields.getTextInputValue('panel_name');
        const embedTitle = interaction.fields.getTextInputValue('embed_title') || 'Support Ticket';
        const embedDescription = interaction.fields.getTextInputValue('embed_description') || 'Click the button below to create a support ticket. Our team will assist you shortly!';
        const buttonText = interaction.fields.getTextInputValue('button_text') || 'Create Ticket';
        const buttonEmoji = interaction.fields.getTextInputValue('button_emoji') || null;

        // Get all categories (for ticket channel creation)
        const categories = interaction.guild.channels.cache.filter(c => c.type === 4).map(c => ({
            id: c.id,
            name: c.name
        }));

        if (categories.length === 0) {
            await interaction.editReply({
                content: 'No categories found in this server. Please create at least one category for ticket channels.'
            });
            return;
        }

        // Get all text channels (for panel deployment)
        const channels = interaction.guild.channels.cache
            .filter(c => c.type === 0 && c.permissionsFor(interaction.guild.members.me).has('SendMessages'))
            .map(c => ({
                id: c.id,
                name: c.name
            }))
            .slice(0, 25); // Discord limit

        // Get all roles
        const roles = interaction.guild.roles.cache
            .filter(r => !r.managed && r.id !== interaction.guild.id)
            .map(r => ({
                id: r.id,
                name: r.name
            }))
            .slice(0, 25); // Discord limit

        // Store temporary data in a global map (in production, use Redis/database)
        if (!global.panelCreationCache) {
            global.panelCreationCache = new Map();
        }

        const cacheKey = `${interaction.guild.id}-${interaction.user.id}`;
        global.panelCreationCache.set(cacheKey, {
            panelName,
            embedTitle,
            embedDescription,
            buttonText,
            buttonEmoji,
            timestamp: Date.now()
        });

        // Clear old cache entries (older than 5 minutes)
        for (const [key, value] of global.panelCreationCache.entries()) {
            if (Date.now() - value.timestamp > 5 * 60 * 1000) {
                global.panelCreationCache.delete(key);
            }
        }

        // Create select menus
        const categorySelect = new StringSelectMenuBuilder()
            .setCustomId('panel_select_category')
            .setPlaceholder('Select ticket category...')
            .addOptions(
                categories.map(cat =>
                    new StringSelectMenuOptionBuilder()
                        .setLabel(cat.name)
                        .setValue(cat.id)
                )
            );

        const channelSelect = new StringSelectMenuBuilder()
            .setCustomId('panel_select_channel')
            .setPlaceholder('Select panel channel (optional)...')
            .addOptions(
                [
                    new StringSelectMenuOptionBuilder()
                        .setLabel('❌ No channel (deploy manually later)')
                        .setValue('none'),
                    ...channels.map(ch =>
                        new StringSelectMenuOptionBuilder()
                            .setLabel(`# ${ch.name}`)
                            .setValue(ch.id)
                    )
                ]
            );

        const roleSelect = new StringSelectMenuBuilder()
            .setCustomId('panel_select_role')
            .setPlaceholder('Select support role...')
            .addOptions(
                roles.map(role =>
                    new StringSelectMenuOptionBuilder()
                        .setLabel(role.name)
                        .setValue(role.id)
                )
            );

        const row1 = new ActionRowBuilder().addComponents(categorySelect);
        const row2 = new ActionRowBuilder().addComponents(channelSelect);
        const row3 = new ActionRowBuilder().addComponents(roleSelect);

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('🎫 Complete Panel Configuration')
            .setDescription(`**Panel Name:** ${panelName}\n\nPlease select the required settings below:`)
            .addFields(
                { name: '1️⃣ Ticket Category', value: 'Where ticket channels will be created', inline: false },
                { name: '2️⃣ Panel Channel', value: 'Where the panel button will be posted (optional)', inline: false },
                { name: '3️⃣ Support Role', value: 'Role that can view and manage tickets', inline: false }
            )
            .setFooter({ text: 'Select all three options to complete setup' })
            .setTimestamp();

        await interaction.editReply({
            embeds: [embed],
            components: [row1, row2, row3]
        });

    } catch (error) {
        logger.error('[Panel Create Modal Error]', error);
        await interaction.editReply({
            content: 'An error occurred while processing the panel creation form.',
            ephemeral: true
        }).catch(() => {});
    }
}

export default handlePanelCreateModal;
