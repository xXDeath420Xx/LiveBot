import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    PermissionsBitField,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

/**
 * Handle ticket creation button clicks
 * @param {ButtonInteraction} interaction
 */
export async function handleTicketCreate(interaction) {
    try {
        const guildId = interaction.guild.id;
        const userId = interaction.user.id;

        // Check if user already has an open ticket
        const [existingTickets] = await pool.execute(
            "SELECT * FROM tickets WHERE guild_id = ? AND user_id = ? AND status != 'closed'",
            [guildId, userId]
        );

        if (existingTickets.length > 0) {
            await interaction.reply({
                content: `You already have an open ticket: <#${existingTickets[0].channel_id}>`,
                ephemeral: true
            });
            return;
        }

        // Extract panel_id from custom ID (format: ticket_create_panel_{panel_id})
        const customId = interaction.customId;
        let panelId = null;

        if (customId.startsWith('ticket_create_panel_')) {
            panelId = customId.split('_')[3];
        } else if (customId.startsWith('ticket_create_form_')) {
            const formId = customId.split('_')[3];

            // Get form questions
            const [questions] = await pool.execute(
                "SELECT question_id, question_text, question_type FROM ticket_form_questions WHERE form_id = ? ORDER BY question_id LIMIT 5",
                [formId]
            );

            if (questions.length === 0) {
                // No questions, create ticket directly
                await createTicket(interaction, null, formId, panelId);
                return;
            }

            // Create modal with questions
            const modal = new ModalBuilder()
                .setCustomId(`ticket_form_submit_${formId}_${panelId || ''}`)
                .setTitle('Create Ticket');

            for (const question of questions) {
                const textInput = new TextInputBuilder()
                    .setCustomId(`question_${question.question_id}`)
                    .setLabel(question.question_text.substring(0, 45)) // Discord limit
                    .setStyle(question.question_type === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
                    .setRequired(true);

                const row = new ActionRowBuilder().addComponents(textInput);
                modal.addComponents(row);
            }

            await interaction.showModal(modal);
            return;
        }

        // Standard ticket creation (no form)
        await createTicket(interaction, null, null, panelId);

    } catch (error) {
        logger.error('[Ticket Create Button Error]', error);
        await interaction.reply({
            content: 'An error occurred while creating your ticket. Please try again later.',
            ephemeral: true
        }).catch(() => {});
    }
}

/**
 * Create a ticket channel
 * @param {Interaction} interaction
 * @param {string|null} formResponses - JSON string of form responses
 * @param {number|null} formId - Form ID if using a form
 * @param {number|null} panelId - Panel ID for panel-specific settings
 */
export async function createTicket(interaction, formResponses = null, formId = null, panelId = null) {
    try {
        const guildId = interaction.guild.id;
        const userId = interaction.user.id;
        let config = null;

        // Try to get panel-specific config first (new system)
        if (panelId) {
            const [panels] = await pool.execute(
                "SELECT * FROM ticket_panels WHERE panel_id = ? AND guild_id = ? AND is_active = 1",
                [panelId, guildId]
            );
            if (panels.length > 0) {
                config = panels[0];
                config.category_id = config.ticket_category_id; // Map to expected field name
            }
        }

        // Fallback to old ticket_config system
        if (!config) {
            const [configs] = await pool.execute(
                "SELECT * FROM ticket_config WHERE guild_id = ?",
                [guildId]
            );

            if (configs.length === 0) {
                await interaction.reply({
                    content: 'The ticket system has not been configured on this server yet.',
                    ephemeral: true
                });
                return;
            }

            config = configs[0];
        }

        // Defer reply if not already deferred
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ ephemeral: true });
        }

        // Get next ticket number
        const [ticketCount] = await pool.execute(
            "SELECT COUNT(*) as count FROM tickets WHERE guild_id = ?",
            [guildId]
        );
        const ticketNumber = ticketCount[0].count + 1;

        // Generate channel name using format from panel (or default)
        let channelName = config.ticket_name_format || 'ticket-{username}';
        channelName = channelName
            .replace(/{username}/g, interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '-'))
            .replace(/{number}/g, ticketNumber)
            .replace(/{id}/g, userId);

        // Ensure valid channel name (Discord limits)
        channelName = channelName.substring(0, 100).toLowerCase();

        // Create ticket channel
        const permissionOverwrites = [
            {
                id: interaction.guild.id,
                deny: [PermissionsBitField.Flags.ViewChannel]
            },
            {
                id: userId,
                allow: [
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                    PermissionsBitField.Flags.ReadMessageHistory
                ]
            }
        ];

        // Only add support role permissions if a support role is configured
        if (config.support_role_id) {
            permissionOverwrites.push({
                id: config.support_role_id,
                allow: [
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                    PermissionsBitField.Flags.ReadMessageHistory
                ]
            });
        }

        const channel = await interaction.guild.channels.create({
            name: channelName,
            type: 0, // Text channel
            parent: config.category_id,
            permissionOverwrites: permissionOverwrites
        });

        // Insert ticket into database
        const [result] = await pool.execute(
            "INSERT INTO tickets (guild_id, panel_id, user_id, channel_id, status, form_id, form_responses) VALUES (?, ?, ?, ?, 'open', ?, ?)",
            [guildId, panelId, userId, channel.id, formId, formResponses]
        );

        const ticketId = result.insertId;

        // Create welcome embed
        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle(`Ticket #${ticketNumber}`)
            .setDescription(`Welcome ${interaction.user}! A support staff member will be with you shortly.\n\nPlease describe your issue in detail.`)
            .setTimestamp();

        // Add form responses to embed if available
        if (formResponses) {
            const responses = JSON.parse(formResponses);
            let responseText = '';
            for (const [question, answer] of Object.entries(responses)) {
                responseText += `**${question}**\n${answer}\n\n`;
            }
            embed.addFields({ name: 'Form Responses', value: responseText });
        }

        // Create close button
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`ticket_close_${ticketId}`)
                    .setLabel('Close Ticket')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('🔒')
            );

        // Build content with optional support role ping
        let messageContent = `${interaction.user}`;
        if (config.support_role_id) {
            messageContent += ` - <@&${config.support_role_id}>`;
        }

        await channel.send({
            content: messageContent,
            embeds: [embed],
            components: [row]
        });

        // Reply to user
        const replyMessage = interaction.replied || interaction.deferred
            ? await interaction.editReply({ content: `Your ticket has been created: ${channel}` })
            : await interaction.reply({ content: `Your ticket has been created: ${channel}`, ephemeral: true });

        logger.info(`Ticket #${ticketId} created by ${interaction.user.tag}`, { guildId, category: 'tickets' });

        // Send alert to ticket-alert channel (Tickets v2 style)
        if (config.alert_channel_id) {
            try {
                const alertChannel = await interaction.guild.channels.fetch(config.alert_channel_id).catch(() => null);
                if (alertChannel) {
                    const alertEmbed = new EmbedBuilder()
                        .setColor('#2ECC71')
                        .setTitle('🎫 New Ticket Opened')
                        .setDescription(`**${channelName}** with ID: ${ticketId} has been opened.`)
                        .addFields(
                            { name: '📨 Opened By', value: `${interaction.user}`, inline: true },
                            { name: '📋 Panel', value: config.panel_name || 'Default', inline: true },
                            { name: '📌 Channel', value: `<#${channel.id}>`, inline: true }
                        )
                        .setFooter({ text: `Ticket #${ticketId}` })
                        .setTimestamp();

                    const joinRow = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setStyle(ButtonStyle.Link)
                                .setLabel('Join Ticket')
                                .setEmoji('➕')
                                .setURL(`https://discord.com/channels/${guildId}/${channel.id}`)
                        );

                    await alertChannel.send({ embeds: [alertEmbed], components: [joinRow] });
                }
            } catch (alertErr) {
                logger.warn('[Ticket Alert] Failed to send alert', { error: alertErr.message, guildId });
            }
        }

    } catch (error) {
        logger.error('[Create Ticket Error]', error);
        const errorMsg = { content: 'An error occurred while creating your ticket.', ephemeral: true };

        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(errorMsg).catch(() => {});
        } else {
            await interaction.reply(errorMsg).catch(() => {});
        }
    }
}

export default handleTicketCreate;
