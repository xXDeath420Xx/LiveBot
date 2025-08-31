const { SlashCommandBuilder, PermissionsBitField, AttachmentBuilder } = require('discord.js');
const db = require('../utils/db');
const Papa = require('papaparse');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('exportcsv')
        .setDescription('Exports all tracked streamers on this server to a CSV file.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        try {
            const [streamers] = await db.execute(
                `SELECT s.platform, s.username, s.discord_user_id, sub.custom_message 
                 FROM streamers s 
                 JOIN subscriptions sub ON s.streamer_id = sub.streamer_id 
                 WHERE sub.guild_id = ?`,
                [interaction.guild.id]
            );

            if (streamers.length === 0) {
                return interaction.editReply('There are no streamers to export from this server.');
            }
            
            const formattedData = streamers.map(s => ({
                platform: s.platform,
                username: s.username,
                discord_user_id: s.discord_user_id || '',
                custom_message: s.custom_message || ''
            }));


            const csv = Papa.unparse(formattedData);
            const attachment = new AttachmentBuilder(Buffer.from(csv), { name: `streamers_export_${interaction.guild.id}.csv` });
            
            await interaction.editReply({ 
                content: `Here is the export of ${streamers.length} streamers.`, 
                files: [attachment] 
            });

        } catch (error) {
            console.error('Export CSV Error:', error);
            await interaction.editReply('An error occurred while exporting the streamer list.');
        }
    },
};
