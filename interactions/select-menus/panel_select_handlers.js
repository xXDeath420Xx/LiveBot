import { EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

// Temporary storage for panel configuration
if (!global.panelConfigState) {
    global.panelConfigState = new Map();
}

/**
 * Handle category selection
 */
export async function handlePanelSelectCategory(interaction) {
    const categoryId = interaction.values[0];
    const cacheKey = `${interaction.guild.id}-${interaction.user.id}`;

    // Get or create state
    let state = global.panelConfigState.get(cacheKey) || {};
    state.ticket_category_id = categoryId;
    state.timestamp = Date.now();
    global.panelConfigState.set(cacheKey, state);

    await interaction.update({
        components: interaction.message.components.map(row => {
            const menu = row.components[0];
            if (menu.data.custom_id === 'panel_select_category') {
                menu.data.placeholder = `✅ Category selected`;
            }
            return row;
        })
    });

    await checkAndCreatePanel(interaction);
}

/**
 * Handle channel selection
 */
export async function handlePanelSelectChannel(interaction) {
    const channelId = interaction.values[0];
    const cacheKey = `${interaction.guild.id}-${interaction.user.id}`;

    // Get or create state
    let state = global.panelConfigState.get(cacheKey) || {};
    state.panel_channel_id = channelId === 'none' ? null : channelId;
    state.timestamp = Date.now();
    global.panelConfigState.set(cacheKey, state);

    await interaction.update({
        components: interaction.message.components.map(row => {
            const menu = row.components[0];
            if (menu.data.custom_id === 'panel_select_channel') {
                menu.data.placeholder = `✅ Channel selected`;
            }
            return row;
        })
    });

    await checkAndCreatePanel(interaction);
}

/**
 * Handle role selection
 */
export async function handlePanelSelectRole(interaction) {
    const roleId = interaction.values[0];
    const cacheKey = `${interaction.guild.id}-${interaction.user.id}`;

    // Get or create state
    let state = global.panelConfigState.get(cacheKey) || {};
    state.support_role_id = roleId;
    state.timestamp = Date.now();
    global.panelConfigState.set(cacheKey, state);

    await interaction.update({
        components: interaction.message.components.map(row => {
            const menu = row.components[0];
            if (menu.data.custom_id === 'panel_select_role') {
                menu.data.placeholder = `✅ Role selected`;
            }
            return row;
        })
    });

    await checkAndCreatePanel(interaction);
}

/**
 * Check if all required fields are selected and create the panel
 */
async function checkAndCreatePanel(interaction) {
    const cacheKey = `${interaction.guild.id}-${interaction.user.id}`;
    const state = global.panelConfigState.get(cacheKey);
    const cachedData = global.panelCreationCache?.get(cacheKey);

    if (!state || !cachedData) {
        return; // Not ready yet
    }

    // Check if all required fields are present
    if (!state.ticket_category_id || !state.support_role_id) {
        return; // Still waiting for selections
    }

    // All required fields present - create the panel
    try {
        const [result] = await pool.execute(
            `INSERT INTO ticket_panels (
                guild_id, panel_name, panel_channel_id,
                embed_title, embed_description, embed_color,
                button_text, button_emoji,
                ticket_category_id, support_role_id, ticket_name_format,
                save_transcripts, is_active
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            [
                interaction.guild.id,
                cachedData.panelName,
                state.panel_channel_id,
                cachedData.embedTitle,
                cachedData.embedDescription,
                '#5865F2', // Default color
                cachedData.buttonText,
                cachedData.buttonEmoji,
                state.ticket_category_id,
                state.support_role_id,
                'ticket-{username}', // Default format
                1 // save_transcripts enabled by default
            ]
        );

        const panelId = result.insertId;

        logger.info(`[Panel Creation] Panel created via command by ${interaction.user.tag}`, {
            guildId: interaction.guild.id,
            panelId,
            panelName: cachedData.panelName,
            category: 'tickets'
        });

        // Clear cache
        global.panelConfigState.delete(cacheKey);
        global.panelCreationCache?.delete(cacheKey);

        const embed = new EmbedBuilder()
            .setColor('#22c55e')
            .setTitle('✅ Panel Created Successfully')
            .setDescription(`Ticket panel **${cachedData.panelName}** has been created!`)
            .addFields(
                { name: 'Panel ID', value: panelId.toString(), inline: true },
                { name: 'Category', value: `<#${state.ticket_category_id}>`, inline: true },
                { name: 'Support Role', value: `<@&${state.support_role_id}>`, inline: true }
            )
            .setFooter({ text: 'Use /panel deploy ' + panelId + ' to deploy this panel to a channel' })
            .setTimestamp();

        if (state.panel_channel_id) {
            embed.addFields({ name: 'Panel Channel', value: `<#${state.panel_channel_id}>`, inline: false });
            embed.setFooter({ text: 'Use /panel deploy ' + panelId + ' to deploy this panel' });
        } else {
            embed.addFields({ name: 'Panel Channel', value: 'Not configured (deploy manually later)', inline: false });
        }

        await interaction.followUp({
            embeds: [embed],
            components: [], // Remove select menus
            ephemeral: true
        });

    } catch (error) {
        logger.error('[Panel Creation Error]', error);

        const errorEmbed = new EmbedBuilder()
            .setColor('#ef4444')
            .setTitle('❌ Panel Creation Failed')
            .setDescription('An error occurred while creating the panel. Please try again or use the web dashboard.')
            .setTimestamp();

        await interaction.followUp({
            embeds: [errorEmbed],
            components: [],
            ephemeral: true
        });
    }
}

// Cleanup old cache entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    const fiveMinutes = 5 * 60 * 1000;

    for (const [key, value] of global.panelConfigState.entries()) {
        if (now - value.timestamp > fiveMinutes) {
            global.panelConfigState.delete(key);
        }
    }
}, 5 * 60 * 1000);
