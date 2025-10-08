const { SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('find')
        .setDescription('Finds users, roles, or channels in the server.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages)
        .addSubcommand(subcommand =>
            subcommand
                .setName('user')
                .setDescription('Finds a user by their username or nickname.')
                .addStringOption(option => option.setName('query').setDescription('The name to search for.').setRequired(true))
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('role')
                .setDescription('Finds a role by its name.')
                .addStringOption(option => option.setName('query').setDescription('The name to search for.').setRequired(true))
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('channel')
                .setDescription('Finds a channel by its name.')
                .addStringOption(option => option.setName('query').setDescription('The name to search for.').setRequired(true))
        ),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const subcommand = interaction.options.getSubcommand();
        const query = interaction.options.getString('query').toLowerCase();
        const guild = interaction.guild;

        const embed = new EmbedBuilder()
            .setColor('#3498DB');

        try {
            if (subcommand === 'user') {
                await guild.members.fetch(); // Ensure cache is up-to-date
                const members = guild.members.cache.filter(member => 
                    member.user.username.toLowerCase().includes(query) || 
                    (member.nickname && member.nickname.toLowerCase().includes(query))
                ).first(20);

                embed.setTitle(`🔍 User Search Results for "${query}"`);
                if (members.length === 0) {
                    embed.setDescription('No users found.');
                } else {
                    embed.setDescription(members.map(m => `• ${m.user.tag} (${m.id})`).join('\n'));
                }
            } 
            else if (subcommand === 'role') {
                const roles = guild.roles.cache.filter(role => 
                    role.name.toLowerCase().includes(query)
                ).first(20);

                embed.setTitle(`🔍 Role Search Results for "${query}"`);
                if (roles.length === 0) {
                    embed.setDescription('No roles found.');
                } else {
                    embed.setDescription(roles.map(r => `• ${r.name} (${r.id})`).join('\n'));
                }
            } 
            else if (subcommand === 'channel') {
                const channels = guild.channels.cache.filter(channel => 
                    channel.name.toLowerCase().includes(query)
                ).first(20);

                embed.setTitle(`🔍 Channel Search Results for "${query}"`);
                if (channels.length === 0) {
                    embed.setDescription('No channels found.');
                } else {
                    embed.setDescription(channels.map(c => `• ${c.name} (${c.id})`).join('\n'));
                }
            }

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            logger.error('[Find Command Error]', error);
            await interaction.editReply('An error occurred while performing the search.');
        }
    },
};