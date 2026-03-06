import { EmbedBuilder, PermissionsBitField } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { closeTicket } from '../../core/ticket-manager.js';

/**
 * Handle ticket close button clicks
 * @param {ButtonInteraction} interaction
 */
export async function handleTicketClose(interaction) {
    try {
        const guildId = interaction.guild.id;
        const userId = interaction.user.id;
        const channelId = interaction.channel.id;

        // Get ticket from database
        const [tickets] = await pool.execute(
            "SELECT * FROM tickets WHERE guild_id = ? AND channel_id = ?",
            [guildId, channelId]
        );

        if (tickets.length === 0) {
            await interaction.reply({
                content: 'This is not a valid ticket channel.',
                ephemeral: true
            });
            return;
        }

        const ticket = tickets[0];

        if (ticket.status === 'closed') {
            await interaction.reply({
                content: 'This ticket has already been closed.',
                ephemeral: true
            });
            return;
        }

        // Get panel config (try new system first, fallback to old)
        let config = null;
        if (ticket.panel_id) {
            const [panels] = await pool.execute(
                "SELECT * FROM ticket_panels WHERE panel_id = ? AND guild_id = ?",
                [ticket.panel_id, guildId]
            );
            config = panels.length > 0 ? panels[0] : null;
        }

        // Fallback to old ticket_config
        if (!config) {
            const [configs] = await pool.execute(
                "SELECT support_role_id FROM ticket_config WHERE guild_id = ?",
                [guildId]
            );
            config = configs.length > 0 ? configs[0] : null;
        }
        const member = interaction.member;

        // Check if user is ticket owner or support staff
        const isTicketOwner = ticket.user_id === userId;
        const isSupportStaff = config && member.roles.cache.has(config.support_role_id);
        const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);

        if (!isTicketOwner && !isSupportStaff && !isAdmin) {
            await interaction.reply({
                content: 'You do not have permission to close this ticket.',
                ephemeral: true
            });
            return;
        }

        await interaction.deferReply();

        // Send closing message
        const closingEmbed = new EmbedBuilder()
            .setColor('#E74C3C')
            .setDescription(`🔒 Ticket closed by ${interaction.user}. Generating transcript and archiving...`);

        await interaction.editReply({ embeds: [closingEmbed] });

        // Close the ticket using ticket-manager
        const result = await closeTicket(
            interaction.client,
            interaction.guild,
            interaction.channel,
            ticket,
            interaction.user,
            config
        );

        if (!result.success) {
            logger.error('[Close Ticket Error]', result.error);
            await interaction.followUp({
                content: 'An error occurred while closing the ticket. The channel will be deleted in 10 seconds.',
                ephemeral: true
            });

            setTimeout(async () => {
                await interaction.channel.delete('Ticket close failed but channel cleanup needed.').catch(() => {});
            }, 10000);
        }

    } catch (error) {
        logger.error('[Ticket Close Button Error]', error);
        await interaction.reply({
            content: 'An error occurred while closing the ticket.',
            ephemeral: true
        }).catch(() => {});
    }
}

export default handleTicketClose;
