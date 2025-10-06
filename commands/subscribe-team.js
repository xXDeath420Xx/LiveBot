const { SlashCommandBuilder, PermissionsBitField, ChannelType, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('subscribe-team')
        .setDescription('Automate syncing a Twitch Team with a channel (adds/removes members).')
        .addStringOption(option =>
            option.setName('team')
                .setDescription('The name of the Twitch Team to monitor (e.g., reeferrealm).')
                .setRequired(true))
        /*
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('The channel to sync the team members with.')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(true))
        */
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const teamName = interaction.options.getString('team').toLowerCase();
        // const channel = interaction.options.getChannel('channel'); // Commented out for now

        try {
            // Modified SQL to remove channel_id for testing
            await db.execute(
                'INSERT INTO twitch_teams (guild_id, team_name) VALUES (?, ?) ON DUPLICATE KEY UPDATE team_name = VALUES(team_name)',
                [interaction.guild.id, teamName]
            );

            const embed = new EmbedBuilder()
                .setColor('#57F287')
                .setTitle('✅ Team Subscription Activated (Channel option temporarily removed)')
                .setDescription(`I will now automatically keep the member list for the Twitch Team **${teamName}** in sync. (Channel option temporarily removed for debugging)`)
                .setFooter({ text: 'The team will be checked for updates approximately every 15 minutes.' });
                
            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('SubscribeTeam command error:', error);
            await interaction.editReply({ content: 'A database error occurred while trying to subscribe to the team.' });
        }
    },
};