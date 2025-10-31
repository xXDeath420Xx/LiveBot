const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, PermissionsBitField, ChannelType, EmbedBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { db } = require('../../utils/db');
const { logger } = require('../../utils/logger');

module.exports = {
    customId: 'ticket_create',
    async execute(interaction) {
        const guildId = interaction.guild.id;

        try {
            // Fetch config based on the message ID of the panel the button is on
            const [[config]] = await db.execute('SELECT * FROM ticket_config WHERE guild_id = ? AND panel_message_id = ?', [guildId, interaction.message.id]);
            if (!config) {
                return interaction.reply({ content: 'This ticket panel appears to be outdated or misconfigured.', ephemeral: true });
            }

            const ticketChannelName = `ticket-${interaction.user.username.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`;
            const existingChannel = interaction.guild.channels.cache.find(c => c.name === ticketChannelName && c.parentId === config.ticket_category_id);

            if (existingChannel) {
                return interaction.reply({ content: `You already have an open ticket: ${existingChannel}`, ephemeral: true });
            }

            // If a form is linked, show the modal
            if (config.form_id) {
                const [questions] = await db.execute('SELECT question_text, question_type FROM ticket_form_questions WHERE form_id = ? ORDER BY question_id ASC', [config.form_id]);
                if (questions.length === 0) {
                    return interaction.reply({ content: 'This ticket form has no questions. Please contact an administrator.', ephemeral: true });
                }

                const modal = new ModalBuilder()
                    .setCustomId(`ticket_form_submit_${interaction.message.id}`)
                    .setTitle('Submit a New Ticket');

                const components = questions.map((q, index) => {
                    const style = q.question_type === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short;
                    return new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId(`question_${index}`)
                            .setLabel(q.question_text.substring(0, 45))
                            .setStyle(style)
                            .setRequired(true)
                    );
                });

                modal.addComponents(components);
                await interaction.showModal(modal);

            } else {
                // No form linked, create ticket directly
                await interaction.deferReply({ ephemeral: true });
                
                const ticketChannel = await interaction.guild.channels.create({
                    name: ticketChannelName,
                    type: ChannelType.GuildText,
                    parent: config.ticket_category_id,
                    permissionOverwrites: [
                        { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                        { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] },
                        { id: config.support_role_id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageMessages] },
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
                
                const closeButton = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`ticket_close_${ticketChannel.id}`)
                        .setLabel('Close Ticket')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('🔒')
                );

                await ticketChannel.send({ content: `${interaction.user} <@&${config.support_role_id}>`, embeds: [welcomeEmbed], components: [closeButton] });
                await interaction.editReply(`Your ticket has been created: ${ticketChannel}`);
            }

        } catch (error) {
            if (error.code === 'ER_NO_SUCH_TABLE') {
                return interaction.reply({ content: 'The database tables for this feature have not been created yet. Please ask the bot owner to update the schema.', ephemeral: true });
            }
            logger.error('Error during ticket creation trigger:', error);
            await interaction.reply({ content: 'Could not create ticket. The category might be full or I am missing permissions.', ephemeral: true });
        }
    },
};