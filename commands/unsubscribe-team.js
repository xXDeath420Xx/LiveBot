const { SlashCommandBuilder, PermissionsBitField, ChannelType, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unsubscribe-team')
        .setDescription('Stops automatically syncing a Twitch Team with a channel.')
        .addStringOption(option =>
            option.setName('team')
                .setDescription('The name of the Twitch Team to stop monitoring.')
                .setRequired(true))
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('The channel the team was synced with.')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const teamName = interaction.options.getString('team').toLowerCase();
        const channel = interaction.options.getChannel('channel');

        try {
            const [result] = await db.execute(
                'DELETE FROM twitch_teams WHERE guild_id = ? AND announcement_channel_id = ? AND team_name = ?',
                [interaction.guild.id, channel.id, teamName]
            );

            if (result.affectedRows > 0) {
                 const embed = new EmbedBuilder()
                    .setColor('#ED4245')
                    .setTitle('🗑️ Team Subscription Deactivated')
                    .setDescription(`I will no longer automatically sync the Twitch Team **${teamName}** with the channel ${channel}. Note: Existing streamers will not be removed.`);
                await interaction.editReply({ embeds: [embed] });
            } else {
                await interaction.editReply({ content: `No subscription was found for the Twitch Team **${teamName}** in that channel.` });
            }

        } catch (error) {
            console.error('UnsubscribeTeam command error:', error);
            await interaction.editReply({ content: 'A database error occurred while trying to unsubscribe from the team.' });
        }
    },
};