const db = require('../../utils/db');
const logger = require('../../utils/logger');
const { PermissionsBitField } = require('discord.js');

module.exports = {
    customId: /^ticket_close_(\d+)$/,
    async execute(interaction) {
        const channelId = interaction.customId.match(/^ticket_close_(\d+)$/)[1];
        const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);

        if (!channel) {
            return interaction.reply({ content: 'This ticket channel seems to have been deleted.', ephemeral: true });
        }

        const [[ticket]] = await db.execute('SELECT * FROM tickets WHERE channel_id = ?', [channelId]);
        const [[config]] = await db.execute('SELECT support_role_id FROM ticket_config WHERE guild_id = ?', [interaction.guild.id]);

        const isSupport = interaction.member.roles.cache.has(config.support_role_id);
        const isOwner = interaction.user.id === ticket.user_id;

        if (!isSupport && !isOwner) {
            return interaction.reply({ content: 'You do not have permission to close this ticket.', ephemeral: true });
        }

        await interaction.reply({ content: 'Closing this ticket in 5 seconds...', ephemeral: true });

        setTimeout(async () => {
            try {
                await channel.delete();
                await db.execute(
                    'UPDATE tickets SET status = ?, closed_at = NOW(), closed_by_id = ? WHERE channel_id = ?',
                    ['closed', interaction.user.id, channelId]
                );
            } catch (error) {
                logger.error(`Failed to close ticket channel ${channelId}:`, error);
                await interaction.followUp({ content: 'Failed to delete the channel. Do I have "Manage Channels" permission?', ephemeral: true });
            }
        }, 5000);
    },
};