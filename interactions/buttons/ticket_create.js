import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    PermissionsBitField
} from 'discord.js';
import pool from '../../utils/db.js';
import { nextTicketNumber } from '../../core/ticket-number.js';
import { rememberTicketChannel } from '../../core/ticket-activity.js';
import { buildTicketChannelName } from '../../utils/ticket-channel-name.js';
import logger from '../../utils/logger.js';
import { themeColor } from '../../core/guild-theme.js';
import { buildFormModal, MODAL_FIELD_LIMIT } from '../../core/form-questions.js';
import { logFeatureEvent, userLabel } from '../../core/feature-log.js';

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
            // If this panel has an attached form, open it as a modal — and thread the
            // panelId into the modal customId so the ticket uses THIS panel's config
            // (category, support role, extra viewer), not the guild-wide fallback.
            const [prows] = await pool.execute(
                "SELECT form_id FROM ticket_panels WHERE panel_id = ? AND guild_id = ?",
                [panelId, guildId]
            );
            const panelFormId = prows[0]?.form_id;
            if (panelFormId) {
                const [questions] = await pool.execute(
                    `SELECT * FROM ticket_form_questions WHERE form_id = ?
                      ORDER BY question_order ASC, question_id ASC LIMIT ${MODAL_FIELD_LIMIT}`,
                    [panelFormId]
                );
                if (questions.length > 0) {
                    await interaction.showModal(
                        buildFormModal(questions, `ticket_form_submit_${panelFormId}_${panelId}`, 'Application'));
                    return;
                }
            }
        } else if (customId.startsWith('ticket_create_form_')) {
            const formId = customId.split('_')[3];

            // Get form questions
            const [questions] = await pool.execute(
                `SELECT * FROM ticket_form_questions WHERE form_id = ?
                  ORDER BY question_order ASC, question_id ASC LIMIT ${MODAL_FIELD_LIMIT}`,
                [formId]
            );

            if (questions.length === 0) {
                // No questions, create ticket directly
                await createTicket(interaction, null, formId, panelId);
                return;
            }

            await interaction.showModal(
                buildFormModal(questions, `ticket_form_submit_${formId}_${panelId || ''}`, 'Create Ticket'));
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

        // The server's next ticket number (core/ticket-number.js): stored on the ticket and shown everywhere,
        // never reused. It used to be the server's ticket count + 1, which repeats after deletions (H-661).
        const ticketNumber = await nextTicketNumber(guildId);

        // Generate channel name using format from panel (or default)
        const channelName = buildTicketChannelName(config.ticket_name_format, {
            username: interaction.user.username,
            userId,
            number: ticketNumber,
        });

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

        // Extra viewer (e.g. the server owner for application-style panels). With
        // support_role_id NULL, this makes the ticket opener + this-user-only.
        if (config.extra_viewer_id) {
            permissionOverwrites.push({
                id: config.extra_viewer_id,
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
            "INSERT INTO tickets (guild_id, ticket_number, panel_id, user_id, channel_id, status, form_id, form_responses) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)",
            [guildId, ticketNumber, panelId, userId, channel.id, formId, formResponses]
        );

        const ticketId = result.insertId;
        // Count the opener's first messages towards "Waiting on staff" straight away (core/ticket-activity.js).
        rememberTicketChannel(channel.id, ticketId, userId);

        // Create welcome embed
        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'primary'))
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

        // Build content with optional support role / extra-viewer ping
        let messageContent = `${interaction.user}`;
        if (config.support_role_id) {
            messageContent += ` - <@&${config.support_role_id}>`;
        } else if (config.extra_viewer_id) {
            messageContent += ` - <@${config.extra_viewer_id}>`;
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

        logger.info(`Ticket #${ticketNumber} (id ${ticketId}) created by ${interaction.user.tag}`, { guildId, category: 'tickets' });

        void logFeatureEvent(() => (interaction.guild), 'tickets.opened', () => ({
            title: '🎫 Ticket Opened',
            fields: [
                ['Opened By', userLabel(interaction.user)], ['Ticket', `<#${channel.id}> (#${ticketNumber})`],
                ['Panel', config.panel_name || 'Default'], ['Form', formResponses ? 'Answered' : null],
            ],
            url: `https://discord.com/channels/${guildId}/${channel.id}`,
            avoidChannelIds: [config.alert_channel_id],
        }));

        // "New Ticket Opened" to the panel's alert channel (ticket_panels or, for the default panel, ticket_config).
        await sendTicketAlert({ guild: interaction.guild, config, user: interaction.user, channelId: channel.id, channelName, ticketNumber });

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

/**
 * Post "New Ticket Opened" with a Join Ticket link to config.alert_channel_id (H-714). Set on the Tickets page
 * (each panel, and the default panel) or with /support ticket setup alert-channel. Never throws.
 * @returns {Promise<boolean>} whether the alert was posted
 */
export async function sendTicketAlert({ guild, config, user, channelId, channelName, ticketNumber }) {
    if (!config?.alert_channel_id || !guild) return false;
    try {
        const alertChannel = await guild.channels.fetch(config.alert_channel_id).catch(() => null);
        if (!alertChannel?.send) {
            logger.warn('[Ticket Alert] Alert channel not found', { guildId: guild.id, channelId: config.alert_channel_id });
            return false;
        }
        const alertEmbed = new EmbedBuilder()
            .setColor(themeColor(guild.id, 'success'))
            .setTitle('🎫 New Ticket Opened')
            .setDescription(`**${channelName}** (ticket #${ticketNumber}) has been opened.`)
            .addFields(
                { name: '📨 Opened By', value: `${user}`, inline: true },
                { name: '📋 Panel', value: config.panel_name || 'Default', inline: true },
                { name: '📌 Channel', value: `<#${channelId}>`, inline: true }
            )
            .setFooter({ text: `Ticket #${ticketNumber}` })
            .setTimestamp();

        const joinRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Link)
                    .setLabel('Join Ticket')
                    .setEmoji('➕')
                    .setURL(`https://discord.com/channels/${guild.id}/${channelId}`)
            );

        await alertChannel.send({ embeds: [alertEmbed], components: [joinRow] });
        return true;
    } catch (alertErr) {
        logger.warn('[Ticket Alert] Failed to send alert', { error: alertErr.message, guildId: guild.id });
        return false;
    }
}

export default handleTicketCreate;
