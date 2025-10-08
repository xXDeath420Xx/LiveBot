const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('claim')
        .setDescription('Claims the current ticket for yourself.'),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const guildId = interaction.guild.id;
        const channelId = interaction.channel.id;
        const staffMember = interaction.member;

        try {
            const [[ticket]] = await db.execute('SELECT * FROM tickets WHERE guild_id = ? AND channel_id = ?', [guildId, channelId]);
            if (!ticket) {
                return interaction.editReply('This command can only be used in an active ticket channel.');
            }

            if (ticket.status === 'closed') {
                return interaction.editReply('This ticket has already been closed.');
            }

            const [[config]] = await db.execute('SELECT support_role_id FROM ticket_config WHERE guild_id = ?', [guildId]);
            if (!config || !staffMember.roles.cache.has(config.support_role_id)) {
                return interaction.editReply('You do not have the required support role to claim tickets.');
            }

            if (ticket.claimed_by_id) {
                const claimedUser = await interaction.client.users.fetch(ticket.claimed_by_id).catch(() => null);
                const claimedBy = claimedUser ? claimedUser.tag : 'an unknown user';
                return interaction.editReply(`This ticket has already been claimed by ${claimedBy}.`);
            }

            await db.execute('UPDATE tickets SET claimed_by_id = ? WHERE id = ?', [staffMember.id, ticket.id]);

            const claimEmbed = new EmbedBuilder()
                .setColor('#F1C40F')
                .setDescription(`🎟️ This ticket has been claimed by ${staffMember}.`);
            
            await interaction.channel.send({ embeds: [claimEmbed] });
            await interaction.editReply('You have successfully claimed this ticket.');

            logger.info(`Ticket #${ticket.id} claimed by ${staffMember.user.tag}`, { guildId, category: 'tickets' });

        } catch (error) {
            if (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_FIELD_ERROR') {
                await interaction.editReply('The database tables for this feature have not been fully updated yet. Please ask the bot owner to update the schema.');
            } else {
                logger.error('[Claim Command Error]', error);
                await interaction.editReply('An error occurred while trying to claim this ticket.');
            }
        }
    },
};