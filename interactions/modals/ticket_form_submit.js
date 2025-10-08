const { PermissionsBitField, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('../../utils/db');
const logger = require('../../utils/logger');

module.exports = {
    customId: /^ticket_form_submit_/,
    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const guildId = interaction.guild.id;
        const panelMessageId = interaction.customId.replace('ticket_form_submit_', '');

        try {
            const [[config]] = await db.execute('SELECT * FROM ticket_config WHERE guild_id = ? AND panel_message_id = ?', [guildId, panelMessageId]);
            if (!config) {
                return interaction.editReply('This ticket panel appears to be outdated or misconfigured.');
            }

            const ticketChannelName = `ticket-${interaction.user.username.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`;
            const existingChannel = interaction.guild.channels.cache.find(c => c.name === ticketChannelName && c.parentId === config.ticket_category_id);

            if (existingChannel) {
                return interaction.editReply(`You already have an open ticket: ${existingChannel}`);
            }

            // Fetch questions to match with answers
            const [questions] = await db.execute('SELECT question_text FROM ticket_form_questions WHERE form_id = ? ORDER BY question_id ASC', [config.form_id]);

            const submissionEmbed = new EmbedBuilder()
                .setColor('#5865F2')
                .setAuthor({ name: `${interaction.user.tag}'s Ticket Submission`, iconURL: interaction.user.displayAvatarURL() })
                .setTimestamp();

            const fields = [];
            for (let i = 0; i < questions.length; i++) {
                const answer = interaction.fields.getTextInputValue(`question_${i}`);
                fields.push({ name: questions[i].question_text, value: answer });
            }
            submissionEmbed.addFields(fields);

            // Create the ticket channel
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

            const closeButton = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`ticket_close_${ticketChannel.id}`)
                    .setLabel('Close Ticket')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('🔒')
            );

            await ticketChannel.send({ content: `**New Ticket** from ${interaction.user} <@&${config.support_role_id}>`, embeds: [submissionEmbed], components: [closeButton] });
            await interaction.editReply(`Your ticket has been created: ${ticketChannel}`);

        } catch (error) {
            logger.error('Error processing ticket form submission:', error);
            await interaction.editReply('Could not create your ticket due to an unexpected error.');
        }
    },
};