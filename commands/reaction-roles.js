const { SlashCommandBuilder, PermissionsBitField, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('reaction-roles')
        .setDescription('Manage reaction roles on this server.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('create')
                .setDescription('Creates a new reaction role panel in a channel.')
                .addChannelOption(option =>
                    option.setName('channel')
                        .setDescription('The channel where the panel will be created.')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('title')
                        .setDescription('The title of the reaction role embed.')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('description')
                        .setDescription('The description of the embed (e.g., "React to get your roles!").')
                        .setRequired(true))
        ),
    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'create') {
            await interaction.deferReply({ ephemeral: true });

            const channel = interaction.options.getChannel('channel');
            const title = interaction.options.getString('title');
            const description = interaction.options.getString('description');

            try {
                const embed = new EmbedBuilder()
                    .setColor('#5865F2')
                    .setTitle(title)
                    .setDescription(description);

                const panelMessage = await channel.send({ embeds: [embed] });

                const manageButton = new ButtonBuilder()
                    .setCustomId(`rr_manage_${panelMessage.id}`)
                    .setLabel('Manage Roles')
                    .setStyle(ButtonStyle.Primary);
                
                const row = new ActionRowBuilder().addComponents(manageButton);

                await interaction.editReply({
                    content: `✅ Reaction Role panel created in ${channel}. Use the "Manage Roles" button below to add your emoji-to-role mappings.`,
                    components: [row]
                });

            } catch (error) {
                logger.error("Failed to create reaction role panel:", error);
                await interaction.editReply({ content: 'Could not create the panel. Please ensure I have permissions to send messages and embeds in that channel.' });
            }
        }
    },
};