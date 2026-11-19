import {
    PermissionsBitField,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} from 'discord.js';
import pool from '../../../utils/db.js';
import { ticketLabel } from '../../../core/ticket-number.js';
import logger from '../../../utils/logger.js';
import { themeColor } from '../../../core/guild-theme.js';
import { logFeatureEvent, userLabel } from '../../../core/feature-log.js';

// Website Stream Team applications store user_id '0' (no Discord account behind them).
const ticketOwnerLabel = (ticket) => (ticket.user_id && ticket.user_id !== '0' ? userLabel(ticket.user_id) : 'Website applicant');

async function handleSetup(interaction, guildId) {
    const member = interaction.member;
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        await interaction.reply({
            content: "You must have the 'Manage Server' permission to setup the ticket system.",
            ephemeral: true
        });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const supportRole = interaction.options.getRole('support-role');
        const category = interaction.options.getChannel('category');
        const logChannel = interaction.options.getChannel('log-channel');
        // "New Ticket Opened" posts (H-714). Left out = keep the one saved (the Tickets page's choice, say).
        const alertChannel = interaction.options.getChannel('alert-channel');

        // Upsert ticket config (ticket_create reads ticket_category_id as the new ticket's parent)
        await pool.execute(
            `INSERT INTO ticket_config (guild_id, support_role_id, ticket_category_id, log_channel_id, alert_channel_id)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
             support_role_id = VALUES(support_role_id),
             ticket_category_id = VALUES(ticket_category_id),
             log_channel_id = VALUES(log_channel_id),
             alert_channel_id = IF(? = 1, VALUES(alert_channel_id), alert_channel_id)`,
            [guildId, supportRole.id, category.id, logChannel?.id || null, alertChannel?.id || null, alertChannel ? 1 : 0]
        );

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'primary'))
            .setTitle('Ticket System Setup Complete')
            .addFields(
                { name: 'Support Role', value: `${supportRole}`, inline: true },
                { name: 'Category', value: `${category}`, inline: true }
            );

        if (logChannel) {
            embed.addFields({ name: 'Log Channel', value: `${logChannel}`, inline: true });
        }
        if (alertChannel) {
            embed.addFields({ name: 'Alert Channel', value: `${alertChannel}`, inline: true });
        }

        await interaction.editReply({ embeds: [embed] });
        logger.info(`Ticket system configured for guild ${guildId}`, { guildId, category: 'tickets' });

    } catch (error) {
        logger.error('[Ticket Setup Error]', error);
        await interaction.editReply('An error occurred while setting up the ticket system.');
    }
}

async function handlePanel(interaction, guildId) {
    const member = interaction.member;
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        await interaction.reply({
            content: "You must have the 'Manage Server' permission to create ticket panels.",
            ephemeral: true
        });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const title = interaction.options.getString('title') || 'Support Tickets';
        const description = interaction.options.getString('description') || 'Click the button below to create a support ticket.';
        const formName = interaction.options.getString('form-name');

        let formId = null;
        if (formName) {
            const [forms] = await pool.execute(
                'SELECT form_id FROM ticket_forms WHERE guild_id = ? AND form_name = ?',
                [guildId, formName]
            );
            if (forms.length > 0) {
                formId = forms[0].form_id;
            }
        }

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'primary'))
            .setTitle(title)
            .setDescription(description);

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(formId ? `ticket_create_form_${formId}` : 'ticket_create')
                    .setLabel('Create Ticket')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('🎫')
            );

        await interaction.channel.send({ embeds: [embed], components: [row] });
        await interaction.editReply('Ticket panel created successfully!');

    } catch (error) {
        logger.error('[Ticket Panel Error]', error);
        await interaction.editReply('An error occurred while creating the ticket panel.');
    }
}

async function handleTicketManagement(interaction, subcommand, guildId) {
    await interaction.deferReply({ ephemeral: true });

    const channelId = interaction.channel.id;
    const staffMember = interaction.member;

    try {
        const [tickets] = await pool.execute(
            "SELECT * FROM tickets WHERE guild_id = ? AND channel_id = ?",
            [guildId, channelId]
        );

        if (tickets.length === 0) {
            await interaction.editReply("This command can only be used in an active ticket channel.");
            return;
        }

        const ticket = tickets[0];

        if (ticket.status === "closed") {
            await interaction.editReply("This ticket has already been closed.");
            return;
        }

        const [configs] = await pool.execute(
            "SELECT support_role_id FROM ticket_config WHERE guild_id = ?",
            [guildId]
        );

        const config = configs.length > 0 ? configs[0] : null;
        const isSupportStaff = config && staffMember.roles.cache.has(config.support_role_id);

        if (!isSupportStaff) {
            await interaction.editReply("You do not have the required support role to manage tickets.");
            return;
        }

        if (subcommand === "claim") {
            if (ticket.claimed_by_id) {
                const claimedUser = await interaction.client.users.fetch(ticket.claimed_by_id).catch(() => null);
                const claimedBy = claimedUser ? claimedUser.tag : "an unknown user";
                await interaction.editReply(`This ticket has already been claimed by ${claimedBy}.`);
                return;
            }

            // Only claimed_by_id changes: tickets.status is enum('open','closed'), and setting it to
            // 'claimed' was rejected by strict SQL mode, so claiming always failed (H-118).
            await pool.execute(
                "UPDATE tickets SET claimed_by_id = ? WHERE id = ?",
                [staffMember.id, ticket.id]
            );

            const claimEmbed = new EmbedBuilder()
                .setColor(themeColor(interaction.guildId, 'warning'))
                .setDescription(`🎟️ This ticket has been claimed by ${staffMember}.`);

            await interaction.channel.send({ embeds: [claimEmbed] });
            await interaction.editReply("You have successfully claimed this ticket.");
            logger.info(`Ticket #${ticket.id} claimed by ${staffMember.user.tag}`, { guildId, category: "tickets" });
            void logFeatureEvent(() => (interaction.guild), 'tickets.claimed', () => ({
                title: '🙋 Ticket Claimed',
                fields: [['Ticket', `<#${channelId}> (${ticketLabel(ticket)})`], ['Claimed By', userLabel(staffMember)], ['Opened By', ticketOwnerLabel(ticket)]],
                url: `https://discord.com/channels/${guildId}/${channelId}`,
            }));

        } else if (subcommand === "unclaim") {
            const isAdmin = staffMember.permissions.has(PermissionsBitField.Flags.Administrator);

            if (!ticket.claimed_by_id) {
                await interaction.editReply("This ticket is not currently claimed.");
                return;
            }

            if (ticket.claimed_by_id !== staffMember.id && !isAdmin) {
                await interaction.editReply("You can only unclaim a ticket that you have claimed yourself.");
                return;
            }

            await pool.execute(
                "UPDATE tickets SET claimed_by_id = NULL WHERE id = ?",
                [ticket.id]
            );

            const unclaimEmbed = new EmbedBuilder()
                .setColor(themeColor(interaction.guildId, 'warning'))
                .setDescription(`🎟️ This ticket has been unclaimed by ${staffMember} and is now open for anyone to handle.`);

            await interaction.channel.send({ embeds: [unclaimEmbed] });
            await interaction.editReply("You have successfully unclaimed this ticket.");
            logger.info(`Ticket #${ticket.id} unclaimed by ${staffMember.user.tag}`, { guildId, category: "tickets" });
            void logFeatureEvent(() => (interaction.guild), 'tickets.unclaimed', () => ({
                title: '↩️ Ticket Unclaimed',
                fields: [
                    ['Ticket', `<#${channelId}> (${ticketLabel(ticket)})`], ['Unclaimed By', userLabel(staffMember)],
                    ['Was Claimed By', ticket.claimed_by_id !== staffMember.id ? userLabel(ticket.claimed_by_id) : null],
                ],
                url: `https://discord.com/channels/${guildId}/${channelId}`,
            }));

        } else if (subcommand === "transfer") {
            const newStaff = interaction.options.getMember("member");

            if (!newStaff || !config || !newStaff.roles.cache.has(config.support_role_id)) {
                await interaction.editReply("The selected user is not a valid support staff member.");
                return;
            }

            if (ticket.claimed_by_id === newStaff.id) {
                await interaction.editReply("This ticket is already claimed by that staff member.");
                return;
            }

            await pool.execute(
                "UPDATE tickets SET claimed_by_id = ? WHERE id = ?",
                [newStaff.id, ticket.id]
            );

            const transferEmbed = new EmbedBuilder()
                .setColor(themeColor(interaction.guildId, 'primary'))
                .setDescription(`🎟️ This ticket has been transferred from ${staffMember} to ${newStaff}.`);

            await interaction.channel.send({ embeds: [transferEmbed] });
            await interaction.editReply(`You have successfully transferred the ticket to ${newStaff.user.tag}.`);
            logger.info(`Ticket #${ticket.id} transferred from ${staffMember.user.tag} to ${newStaff.user.tag}`, { guildId, category: "tickets" });
            void logFeatureEvent(() => (interaction.guild), 'tickets.transferred', () => ({
                title: '🔁 Ticket Transferred',
                fields: [
                    ['Ticket', `<#${channelId}> (${ticketLabel(ticket)})`], ['To', userLabel(newStaff)],
                    ['Previously Claimed By', ticket.claimed_by_id ? userLabel(ticket.claimed_by_id) : 'Nobody'], ['Transferred By', userLabel(staffMember)],
                ],
                url: `https://discord.com/channels/${guildId}/${channelId}`,
            }));

        } else if (subcommand === "close") {
            const reason = interaction.options.getString("reason");

            // Import ticket-manager and close ticket
            const { closeTicket } = await import('../../../core/ticket-manager.js');

            const closingEmbed = new EmbedBuilder()
                .setColor(themeColor(interaction.guildId, 'danger'))
                .setDescription(`🔒 Ticket closed by ${interaction.user}${reason ? `\n**Reason:** ${reason}` : ''}. Generating transcript and archiving...`);

            await interaction.editReply({ embeds: [closingEmbed] });

            // Close with the ticket's panel settings (log channel, transcripts), as the Close button does.
            // `config` here is only ticket_config's support role; closeTicket falls back to its log channel.
            let panelConfig = null;
            if (ticket.panel_id) {
                const [[panel]] = await pool.execute(
                    'SELECT * FROM ticket_panels WHERE panel_id = ? AND guild_id = ?',
                    [ticket.panel_id, interaction.guildId]
                ).catch(() => [[null]]);
                panelConfig = panel || null;
            }

            // Close the ticket
            const result = await closeTicket(
                interaction.client,
                interaction.guild,
                interaction.channel,
                ticket,
                interaction.user,
                panelConfig,
                reason
            );

            if (!result.success) {
                logger.error('[Close Ticket Command Error]', result.error);
                await interaction.followUp({
                    content: 'An error occurred while closing the ticket. The channel will be deleted in 10 seconds.',
                    ephemeral: true
                });

                setTimeout(async () => {
                    await interaction.channel.delete('Ticket close failed but channel cleanup needed.').catch(() => {});
                }, 10000);
            }

            logger.info(`Ticket #${ticket.id} closed via command by ${interaction.user.tag}${reason ? ` - Reason: ${reason}` : ''}`, { guildId, category: "tickets" });

        } else if (subcommand === "add") {
            const userToAdd = interaction.options.getUser("user");

            if (!userToAdd) {
                await interaction.editReply("Invalid user specified.");
                return;
            }

            // Add user to ticket channel permissions
            try {
                await interaction.channel.permissionOverwrites.create(userToAdd, {
                    ViewChannel: true,
                    SendMessages: true,
                    ReadMessageHistory: true
                });

                const addEmbed = new EmbedBuilder()
                    .setColor(themeColor(interaction.guildId, 'success'))
                    .setDescription(`✅ ${userToAdd} has been added to this ticket.`);

                await interaction.channel.send({ embeds: [addEmbed] });
                await interaction.editReply(`Successfully added ${userToAdd.tag} to the ticket.`);
                logger.info(`User ${userToAdd.tag} added to ticket #${ticket.id} by ${interaction.user.tag}`, { guildId, category: "tickets" });
                void logFeatureEvent(() => (interaction.guild), 'tickets.memberAdded', () => ({
                    title: '➕ Member Added to Ticket',
                    fields: [['Ticket', `<#${channelId}> (${ticketLabel(ticket)})`], ['Member', userLabel(userToAdd)], ['Added By', userLabel(interaction.user)]],
                    url: `https://discord.com/channels/${guildId}/${channelId}`,
                }));
            } catch (error) {
                logger.error('[Add User to Ticket Error]', error);
                await interaction.editReply("Failed to add user to the ticket.");
            }

        } else if (subcommand === "remove") {
            const userToRemove = interaction.options.getUser("user");

            if (!userToRemove) {
                await interaction.editReply("Invalid user specified.");
                return;
            }

            // Prevent removing the ticket owner
            if (userToRemove.id === ticket.user_id) {
                await interaction.editReply("You cannot remove the ticket owner from their own ticket.");
                return;
            }

            // Remove user from ticket channel permissions
            try {
                await interaction.channel.permissionOverwrites.delete(userToRemove);

                const removeEmbed = new EmbedBuilder()
                    .setColor(themeColor(interaction.guildId, 'danger'))
                    .setDescription(`❌ ${userToRemove} has been removed from this ticket.`);

                await interaction.channel.send({ embeds: [removeEmbed] });
                await interaction.editReply(`Successfully removed ${userToRemove.tag} from the ticket.`);
                logger.info(`User ${userToRemove.tag} removed from ticket #${ticket.id} by ${interaction.user.tag}`, { guildId, category: "tickets" });
                void logFeatureEvent(() => (interaction.guild), 'tickets.memberRemoved', () => ({
                    title: '➖ Member Removed from Ticket',
                    fields: [['Ticket', `<#${channelId}> (${ticketLabel(ticket)})`], ['Member', userLabel(userToRemove)], ['Removed By', userLabel(interaction.user)]],
                    url: `https://discord.com/channels/${guildId}/${channelId}`,
                }));
            } catch (error) {
                logger.error('[Remove User from Ticket Error]', error);
                await interaction.editReply("Failed to remove user from the ticket.");
            }
        }
    } catch (error) {
        if (error.code === "ER_NO_SUCH_TABLE" || error.code === "ER_BAD_FIELD_ERROR") {
            await interaction.editReply("The database tables for this feature have not been fully updated yet. Please ask the bot owner to update the schema.");
        } else {
            logger.error(`[Ticket Command: ${subcommand}] Error`, error);
            await interaction.editReply("An error occurred while processing this ticket command.");
        }
    }
}

export async function execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (subcommand === 'setup') {
        await handleSetup(interaction, guildId);
    } else if (subcommand === 'panel') {
        await handlePanel(interaction, guildId);
    } else {
        await handleTicketManagement(interaction, subcommand, guildId);
    }
}

export async function autocomplete(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const focusedOption = interaction.options.getFocused(true);

    // Handle form-name autocomplete for the panel subcommand
    if (subcommand === 'panel' && focusedOption.name === 'form-name') {
        try {
            const [forms] = await pool.execute(
                "SELECT form_name FROM ticket_forms WHERE guild_id = ? AND form_name LIKE ?",
                [interaction.guild.id, `${focusedOption.value}%`]
            );
            await interaction.respond(
                forms.map(form => ({ name: form.form_name, value: form.form_name }))
            );
        } catch (e) {
            await interaction.respond([]);
        }
    }
}
