const { ChannelType, PermissionsBitField } = require('discord.js');
const { db } = require('../../utils/db');
const { logger } = require('../../utils/logger');

module.exports = {
    customId: 'create_ticket',
    async execute(interaction) {
        const guildId = interaction.guild.id;
        try {
            const [[config]] = await db.execute('SELECT ticket_category_id, support_role_id FROM ticket_config WHERE guild_id = ?', [guildId]);
            if (!config || !config.ticket_category_id || !config.support_role_id) {
                return interaction.reply({ content: 'The ticket system has not been fully configured. Please contact an administrator.', ephemeral: true });
            }

            const category = await interaction.guild.channels.fetch(config.ticket_category_id).catch(() => null);
            if (!category || category.type !== ChannelType.GuildCategory) {
                return interaction.reply({ content: 'The configured ticket category no longer exists. Please contact an administrator.', ephemeral: true });
            }

            const thread = await interaction.guild.threads.create({
                name: `ticket-${interaction.user.username}`,
                type: ChannelType.PrivateThread,
                parent: category,
                invitable: false,
            });

            await thread.members.add(interaction.user.id);
            
            const supportRole = await interaction.guild.roles.fetch(config.support_role_id).catch(() => null);
            if (supportRole) {
                await thread.send(`Welcome ${interaction.user}! A member of the ${supportRole} team will be with you shortly.`);
            } else {
                await thread.send(`Welcome ${interaction.user}! A staff member will be with you shortly.`);
            }

            logger.info(`Created ticket thread #${thread.name} for ${interaction.user.tag}.`, { guildId, category: 'tickets' });

            await interaction.reply({ content: `Your ticket has been created: ${thread.toString()}`, ephemeral: true });

        } catch (error) {
            logger.error('Error creating ticket.', { guildId, category: 'tickets', error: error.stack });
            await interaction.reply({ content: 'An unexpected error occurred while creating your ticket. Please try again later.', ephemeral: true });
        }
    }
};