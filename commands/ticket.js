const { SlashCommandBuilder, PermissionsBitField, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('../utils/db');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('Manage the ticket system.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('setup')
                .setDescription('Sets up the ticket panel in a channel.')
                .addChannelOption(option =>
                    option.setName('channel')
                        .setDescription('The channel to create the ticket panel in.')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true)
                )
                .addChannelOption(option =>
                    option.setName('category')
                        .setDescription('The category where new ticket channels will be created.')
                        .addChannelTypes(ChannelType.GuildCategory)
                        .setRequired(true)
                )
                .addRoleOption(option =>
                    option.setName('support-role')
                        .setDescription('The role that can view and manage tickets.')
                        .setRequired(true)
                )
        ),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'setup') {
            await interaction.deferReply({ ephemeral: true });

            const panelChannel = interaction.options.getChannel('channel');
            const category = interaction.options.getChannel('category');
            const supportRole = interaction.options.getRole('support-role');
            const guildId = interaction.guild.id;

            try {
                const panelEmbed = new EmbedBuilder()
                    .setColor('#5865F2')
                    .setTitle('Support Ticket')
                    .setDescription('Click the button below to create a new support ticket. Please do not create a ticket unless you have a genuine issue.')
                    .setFooter({ text: `${interaction.guild.name} Support` });

                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('ticket_create')
                            .setLabel('Create Ticket')
                            .setStyle(ButtonStyle.Primary)
                            .setEmoji('🎟️')
                    );

                const panelMessage = await panelChannel.send({ embeds: [panelEmbed], components: [row] });

                await db.execute(
                    `INSERT INTO ticket_config (guild_id, panel_channel_id, panel_message_id, ticket_category_id, support_role_id) 
                     VALUES (?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE 
                        panel_channel_id = VALUES(panel_channel_id),
                        panel_message_id = VALUES(panel_message_id),
                        ticket_category_id = VALUES(ticket_category_id),
                        support_role_id = VALUES(support_role_id)`,
                    [guildId, panelChannel.id, panelMessage.id, category.id, supportRole.id]
                );

                await interaction.editReply(`✅ Ticket panel has been successfully created in ${panelChannel}.`);

            } catch (error) {
                logger.error('Error setting up ticket panel:', error);
                await interaction.editReply('I seem to be missing permissions to send messages or manage channels in the selected locations. Please check my permissions and try again.');
            }
        }
    },
};