const { PermissionsBitField, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('../../utils/db');
const logger = require('../../utils/logger');

module.exports = {
    customId: 'ticket_create',
    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const guildId = interaction.guild.id;

        try {
            const [[config]] = await db.execute('SELECT * FROM ticket_config WHERE guild_id = ?', [guildId]);
            if (!config) {
                return interaction.editReply('The ticket system has not been configured properly on this server.');
            }

            const ticketChannelName = `ticket-${interaction.user.username}`;
            const existingChannel = interaction.guild.channels.cache.find(c => c.name === ticketChannelName && c.parentId === config.ticket_category_id);

            if (existingChannel) {
                return interaction.editReply(`You already have an open ticket: ${existingChannel}`);
            }

            const ticketChannel = await interaction.guild.channels.create({
                name: ticketChannelName,
                type: ChannelType.GuildText,
                parent: config.ticket_category_id,
                permissionOverwrites: [
                    {
                        id: interaction.guild.id, // @everyone
                        deny: [PermissionsBitField.Flags.ViewChannel],
                    },
                    {
                        id: interaction.user.id,
                        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles],
                    },
                    {
                        id: config.support_role_id,
                        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageMessages],
                    },
                ],
            });

            await db.execute(
                'INSERT INTO tickets (guild_id, channel_id, user_id, status) VALUES (?, ?, ?, ?)',
                [guildId, ticketChannel.id, interaction.user.id, 'open']
            );

            const welcomeEmbed = new EmbedBuilder()
                .setColor('#57F287')
                .setTitle(`Welcome, ${interaction.user.username}`)
                .setDescription(`Support will be with you shortly. Please describe your issue in as much detail as possible.\n\nA <@&${config.support_role_id}> will be here to help.`);
            
            const closeButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`ticket_close_${ticketChannel.id}`)
                        .setLabel('Close Ticket')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('🔒')
                );

            await ticketChannel.send({ content: `${interaction.user} <@&${config.support_role_id}>`, embeds: [welcomeEmbed], components: [closeButton] });
            
            await interaction.editReply(`Your ticket has been created: ${ticketChannel}`);

        } catch (error) {
            logger.error('Error creating ticket:', error);
            await interaction.editReply('Could not create ticket. The category might be full or I am missing permissions.');
        }
    },
};