const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('server-stats')
        .setDescription('Displays statistics about server activity.'),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const [stats] = await db.execute(
                'SELECT * FROM server_stats WHERE guild_id = ? ORDER BY date DESC LIMIT 1',
                [interaction.guild.id]
            );

            if (!stats || stats.length === 0) {
                return interaction.editReply('I have not collected enough data for this server yet. Please check back tomorrow.');
            }
            
            const todayStats = stats[0];

            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle(`📊 Server Statistics for ${interaction.guild.name}`)
                .setDescription(`Showing data recorded for **${new Date(todayStats.date).toDateString()}**. For more detailed graphs, check the web dashboard.`)
                .addFields(
                    { name: 'Total Members', value: todayStats.total_members.toLocaleString(), inline: true },
                    { name: 'Online Members', value: todayStats.online_members.toLocaleString(), inline: true },
                    { name: 'Messages Today', value: todayStats.message_count.toLocaleString(), inline: true }
                )
                .setThumbnail(interaction.guild.iconURL())
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('[ServerStats Command Error]', error);
            await interaction.editReply('An error occurred while fetching server statistics.');
        }
    },
};