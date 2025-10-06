const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('invites')
        .setDescription('Shows your or another user\'s invite statistics.')
        .addUserOption(option => option.setName('user').setDescription('The user to check stats for (defaults to you).')),
    async execute(interaction) {
        await interaction.deferReply();

        const user = interaction.options.getUser('user') || interaction.user;
        const guildId = interaction.guild.id;

        try {
            const [joinsResult] = await db.execute(
                'SELECT COUNT(*) as count FROM invite_tracker_logs WHERE guild_id = ? AND inviter_id = ? AND event_type = "join"',
                [guildId, user.id]
            );
            const [leavesResult] = await db.execute(
                'SELECT COUNT(*) as count FROM invite_tracker_logs WHERE guild_id = ? AND inviter_id = ? AND event_type = "leave"',
                [guildId, user.id]
            );

            const totalJoins = joinsResult[0].count || 0;
            const totalLeaves = leavesResult[0].count || 0;
            const realInvites = totalJoins - totalLeaves;

            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setAuthor({ name: `${user.username}'s Invite Stats`, iconURL: user.displayAvatarURL() })
                .setDescription(`**${realInvites}** real invites`)
                .addFields(
                    { name: '✅ Joins', value: `${totalJoins}`, inline: true },
                    { name: '❌ Leaves', value: `${totalLeaves}`, inline: true }
                );

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('[Invites Command Error]', error);
            await interaction.editReply({ content: 'An error occurred while fetching invite stats.' });
        }
    },
};