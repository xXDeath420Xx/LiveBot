import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

/**
 * List all ticket panels
 */
async function handleList(interaction) {
    const guildId = interaction.guild.id;

    await interaction.deferReply({ ephemeral: true });

    const [panels] = await pool.execute(
        'SELECT * FROM ticket_panels WHERE guild_id = ? ORDER BY created_at DESC',
        [guildId]
    );

    if (panels.length === 0) {
        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('Ticket Panels')
            .setDescription('No ticket panels configured yet.\n\nUse `/support panel create` to create your first panel!')
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('Ticket Panels')
        .setDescription(`You have ${panels.length} ticket panel(s) configured:`)
        .setTimestamp();

    for (const panel of panels) {
        const status = panel.panel_message_id ? 'Deployed' : 'Not Deployed';
        const category = await interaction.guild.channels.fetch(panel.ticket_category_id).catch(() => null);
        const role = await interaction.guild.roles.fetch(panel.support_role_id).catch(() => null);

        embed.addFields({
            name: `ID: ${panel.panel_id} - ${panel.panel_name}`,
            value: [
                `**Status:** ${status}`,
                `**Category:** ${category ? category.name : 'Unknown'}`,
                `**Support Role:** ${role ? role.name : 'Unknown'}`,
                `**Transcripts:** ${panel.save_transcripts ? 'Enabled' : 'Disabled'}`
            ].join('\n'),
            inline: false
        });
    }

    embed.setFooter({ text: 'Use /support panel deploy <id> to deploy a panel' });

    await interaction.editReply({ embeds: [embed] });
}

/**
 * Create a new ticket panel (shows modal)
 */
async function handleCreate(interaction) {
    const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('Create Ticket Panel')
        .setDescription('Creating a ticket panel requires multiple configuration steps.\n\n**For the best experience, use the web dashboard:**\nhttps://certifriedmultitool.com/manage/' + interaction.guild.id + '?page=tickets\n\nAlternatively, click the button below to create a basic panel via Discord.')
        .setTimestamp();

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('panel_create_basic')
                .setLabel('Create Basic Panel')
                .setStyle(ButtonStyle.Primary)
        );

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

/**
 * Edit an existing ticket panel
 */
async function handleEdit(interaction) {
    const panelId = interaction.options.getInteger('panel_id');
    const guildId = interaction.guild.id;

    await interaction.deferReply({ ephemeral: true });

    const [panels] = await pool.execute(
        'SELECT * FROM ticket_panels WHERE panel_id = ? AND guild_id = ?',
        [panelId, guildId]
    );

    if (panels.length === 0) {
        await interaction.editReply({ content: `Panel with ID ${panelId} not found.` });
        return;
    }

    const panel = panels[0];

    const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`Edit Panel: ${panel.panel_name}`)
        .setDescription('For detailed editing with all customization options, please use the web dashboard:\n\nhttps://certifriedmultitool.com/manage/' + interaction.guild.id + '?page=tickets\n\n**Current Configuration:**')
        .addFields(
            { name: 'Panel Name', value: panel.panel_name, inline: true },
            { name: 'Embed Title', value: panel.embed_title || 'Support Ticket', inline: true },
            { name: 'Button Text', value: panel.button_text || 'Create Ticket', inline: true },
            { name: 'Embed Color', value: panel.embed_color || '#5865F2', inline: true },
            { name: 'Ticket Name Format', value: panel.ticket_name_format || 'ticket-{username}', inline: true },
            { name: 'Save Transcripts', value: panel.save_transcripts ? 'Yes' : 'No', inline: true }
        )
        .setTimestamp();

    if (panel.embed_description) {
        embed.addFields({ name: 'Embed Description', value: panel.embed_description.substring(0, 1024), inline: false });
    }

    await interaction.editReply({ embeds: [embed] });
}

/**
 * Deploy a ticket panel to its configured channel
 */
async function handleDeploy(interaction) {
    const panelId = interaction.options.getInteger('panel_id');
    const guildId = interaction.guild.id;

    await interaction.deferReply({ ephemeral: true });

    const [panels] = await pool.execute(
        'SELECT * FROM ticket_panels WHERE panel_id = ? AND guild_id = ?',
        [panelId, guildId]
    );

    if (panels.length === 0) {
        await interaction.editReply({ content: `Panel with ID ${panelId} not found.` });
        return;
    }

    const panel = panels[0];

    if (!panel.panel_channel_id) {
        await interaction.editReply({ content: 'This panel does not have a channel configured. Please configure it in the web dashboard.' });
        return;
    }

    // Fetch channel
    const channel = await interaction.guild.channels.fetch(panel.panel_channel_id).catch(() => null);
    if (!channel || !channel.isTextBased()) {
        await interaction.editReply({ content: 'Could not access the configured panel channel. Please check that the channel still exists and the bot has permission to post there.' });
        return;
    }

    // Delete old panel message if exists
    if (panel.panel_message_id) {
        try {
            const oldMessage = await channel.messages.fetch(panel.panel_message_id).catch(() => null);
            if (oldMessage) {
                await oldMessage.delete();
            }
        } catch (err) {
            logger.warn('[Panel Deploy] Could not delete old panel message:', err);
        }
    }

    // Create embed
    const panelEmbed = new EmbedBuilder()
        .setColor(panel.embed_color || '#5865F2')
        .setTitle(panel.embed_title || 'Support Ticket')
        .setDescription(panel.embed_description || 'Click the button below to create a support ticket. Our team will assist you shortly!')
        .setTimestamp();

    // Create button
    const button = new ButtonBuilder()
        .setCustomId(`ticket_create_panel_${panelId}`)
        .setLabel(panel.button_text || 'Create Ticket')
        .setStyle(ButtonStyle.Primary);

    if (panel.button_emoji) {
        button.setEmoji(panel.button_emoji);
    }

    const row = new ActionRowBuilder().addComponents(button);

    // Send message
    const message = await channel.send({
        embeds: [panelEmbed],
        components: [row]
    });

    // Update panel with message ID
    await pool.execute(
        'UPDATE ticket_panels SET panel_message_id = ? WHERE panel_id = ?',
        [message.id, panelId]
    );

    logger.info(`[Panel Command] Panel ${panelId} deployed by ${interaction.user.tag}`, {
        guildId,
        panelId,
        channelId: channel.id,
        messageId: message.id,
        category: 'tickets'
    });

    const successEmbed = new EmbedBuilder()
        .setColor('#22c55e')
        .setTitle('Panel Deployed')
        .setDescription(`Panel **${panel.panel_name}** has been deployed to ${channel}!`)
        .addFields(
            { name: 'Message ID', value: message.id, inline: true },
            { name: 'Jump to Panel', value: `[Click here](${message.url})`, inline: true }
        )
        .setTimestamp();

    await interaction.editReply({ embeds: [successEmbed] });
}

/**
 * Delete a ticket panel
 */
async function handleDelete(interaction) {
    const panelId = interaction.options.getInteger('panel_id');
    const guildId = interaction.guild.id;

    await interaction.deferReply({ ephemeral: true });

    const [panels] = await pool.execute(
        'SELECT * FROM ticket_panels WHERE panel_id = ? AND guild_id = ?',
        [panelId, guildId]
    );

    if (panels.length === 0) {
        await interaction.editReply({ content: `Panel with ID ${panelId} not found.` });
        return;
    }

    const panel = panels[0];

    // Check for active tickets
    const [activeTickets] = await pool.execute(
        "SELECT COUNT(*) as count FROM tickets WHERE panel_id = ? AND status != 'closed'",
        [panelId]
    );

    if (activeTickets[0].count > 0) {
        await interaction.editReply({
            content: `Cannot delete panel **${panel.panel_name}** because it has ${activeTickets[0].count} active ticket(s). Please close all tickets from this panel first.`
        });
        return;
    }

    // Delete panel message if exists
    if (panel.panel_message_id && panel.panel_channel_id) {
        try {
            const channel = await interaction.guild.channels.fetch(panel.panel_channel_id).catch(() => null);
            if (channel) {
                await channel.messages.delete(panel.panel_message_id).catch(() => {});
            }
        } catch (err) {
            logger.warn('[Panel Delete] Could not delete panel message:', err);
        }
    }

    // Delete panel from database
    await pool.execute(
        'DELETE FROM ticket_panels WHERE panel_id = ? AND guild_id = ?',
        [panelId, guildId]
    );

    logger.info(`[Panel Command] Panel ${panelId} deleted by ${interaction.user.tag}`, {
        guildId,
        panelId,
        panelName: panel.panel_name,
        category: 'tickets'
    });

    const embed = new EmbedBuilder()
        .setColor('#ef4444')
        .setTitle('Panel Deleted')
        .setDescription(`Panel **${panel.panel_name}** (ID: ${panelId}) has been permanently deleted.`)
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

/**
 * Execute handler for /support panel subcommands.
 * Routes to: list, create, edit, deploy, delete
 */
async function execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    try {
        switch (subcommand) {
            case 'list':
                await handleList(interaction);
                break;
            case 'create':
                await handleCreate(interaction);
                break;
            case 'edit':
                await handleEdit(interaction);
                break;
            case 'deploy':
                await handleDeploy(interaction);
                break;
            case 'delete':
                await handleDelete(interaction);
                break;
        }
    } catch (error) {
        logger.error('[Support Panel Command Error]', { error, subcommand });
        const errorMessage = { content: 'An error occurred while executing this command.', ephemeral: true };

        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(errorMessage).catch(() => {});
        } else {
            await interaction.reply(errorMessage).catch(() => {});
        }
    }
}

export { execute };
