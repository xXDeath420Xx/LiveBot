const db = require('../../utils/db');
const logger = require('../../utils/logger');
const { PermissionsBitField } = require('discord.js');
const { closeTicket } = require('../../core/ticket-manager');

module.exports = {
    customId: /^ticket_close_(\d+)$/,
    async execute(interaction) {
        const channelId = interaction.customId.match(/^ticket_close_(\d+)$/)[1];
        const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);

        if (!channel) {
            return interaction.reply({ content: 'This ticket channel seems to have been deleted.', ephemeral: true });
        }

        const [[ticket]] = await db.execute('SELECT * FROM tickets WHERE channel_id = ?', [channelId]);
        if (!ticket) {
            // If the ticket isn't in the DB for some reason, just delete the channel if the user has perms.
            logger.warn(`Orphaned ticket channel ${channel.id} is being closed manually.`);
            await channel.delete();
            return interaction.reply({ content: 'This was an orphaned ticket channel, but it has now been deleted.', ephemeral: true });
        }

        const [[config]] = await db.execute('SELECT support_role_id FROM ticket_config WHERE guild_id = ?', [interaction.guild.id]);

        const isSupport = config && interaction.member.roles.cache.has(config.support_role_id);
        const isOwner = ticket.user_id === interaction.user.id;
        const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);

        if (!isSupport && !isOwner && !isAdmin) {
            return interaction.reply({ content: 'You do not have permission to close this ticket.', ephemeral: true });
        }

        await interaction.reply({ content: 'Saving transcript and closing this ticket... This may take a moment.', ephemeral: true });

        // Call the centralized function
        const result = await closeTicket(interaction.client, interaction.guild, channel, ticket, interaction.user);

        if (!result.success) {
            await interaction.followUp({ content: 'An error occurred while archiving the ticket. The channel has not been deleted.', ephemeral: true });
        }
        // Success is implied, as the channel will be deleted and the user DMed.
    },
};