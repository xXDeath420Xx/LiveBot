const { SlashCommandBuilder, PermissionsBitField, ChannelType, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');
const apiChecks = require('../utils/api_checks');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('removeteam')
        .setDescription('Removes all members of a Twitch Team from a channel and purges their active announcements.')
        .addStringOption(option =>
            option.setName('team')
                .setDescription('The name of the Twitch Team to remove (e.g., reeferrealm).')
                .setRequired(true))
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('The channel to remove the team members and announcements from.')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const teamName = interaction.options.getString('team').toLowerCase();
        const channel = interaction.options.getChannel('channel');
        const guildId = interaction.guild.id;
        let purgedMessageCount = 0;

        try {
            const teamMembers = await apiChecks.getTwitchTeamMembers(teamName);
            if (!teamMembers) {
                return interaction.editReply({ content: `❌ Could not find a Twitch Team named \`${teamName}\`.` });
            }
            if (teamMembers.length === 0) {
                return interaction.editReply({ content: `ℹ️ The Twitch Team \`${teamName}\` has no members to remove.` });
            }

            const memberUserIds = teamMembers.map(m => m.user_id);
            if (memberUserIds.length === 0) {
                 return interaction.editReply({ content: `ℹ️ No valid members found for team \`${teamName}\`.` });
            }

            const placeholders = memberUserIds.map(() => '?').join(',');
            const [streamers] = await db.execute(`SELECT streamer_id FROM streamers WHERE platform = 'twitch' AND platform_user_id IN (${placeholders})`, [...memberUserIds]);

            if (streamers.length === 0) {
                return interaction.editReply({ content: `ℹ️ None of the members of team \`${teamName}\` were found in this server's subscription list for that channel.`});
            }

            const streamerIdsToRemove = streamers.map(s => s.streamer_id);
            const subPlaceholders = streamerIdsToRemove.map(() => '?').join(',');

            const [announcementsToPurge] = await db.execute(
                `SELECT message_id, channel_id FROM announcements WHERE guild_id = ? AND channel_id = ? AND streamer_id IN (${subPlaceholders})`,
                [guildId, channel.id, ...streamerIdsToRemove]
            );

            if (announcementsToPurge.length > 0) {
                const purgePromises = announcementsToPurge.map(announcement => {
                    return interaction.client.channels.fetch(announcement.channel_id)
                        .then(announcementChannel => announcementChannel.messages.delete(announcement.message_id))
                        .catch(() => {});
                });
                await Promise.all(purgePromises);
                purgedMessageCount = announcementsToPurge.length;
            }

            const [deleteResult] = await db.execute(
                `DELETE FROM subscriptions WHERE guild_id = ? AND announcement_channel_id = ? AND streamer_id IN (${subPlaceholders})`,
                [guildId, channel.id, ...streamerIdsToRemove]
            );

            const embed = new EmbedBuilder()
                .setTitle(`Twitch Team Removal Report for "${teamName}""`)
                .setDescription(`Successfully processed team removal from ${channel}.`)
                .setColor('#ED4245')
                .addFields(
                    { name: 'Subscriptions Removed', value: `${deleteResult.affectedRows}`, inline: true },
                    { name: 'Announcements Purged', value: `${purgedMessageCount}`, inline: true }
                )
                .setTimestamp();
            
            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('RemoveTeam Command Error:', error);
            await interaction.editReply({ content: 'A critical error occurred while executing the command.' });
        }
    },
};