const { SlashCommandBuilder, PermissionsBitField, ChannelType, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');

const logOptions = [
    { name: 'Message Deleted', value: 'messageDelete' },
    { name: 'Message Edited', value: 'messageUpdate' },
    { name: 'Member Roles Updated', value: 'memberUpdate' },
    // Add more loggable events here in the future
];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('logging')
        .setDescription('Configure the server audit log.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('The channel where logs will be sent.')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('event1')
                .setDescription('The first event to log.')
                .setRequired(true)
                .addChoices(...logOptions)
        )
        .addStringOption(option => option.setName('event2').setDescription('An additional event to log.').addChoices(...logOptions))
        .addStringOption(option => option.setName('event3').setDescription('An additional event to log.').addChoices(...logOptions)),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const channel = interaction.options.getChannel('channel');
        const enabledLogs = [
            interaction.options.getString('event1'),
            interaction.options.getString('event2'),
            interaction.options.getString('event3'),
        ].filter(Boolean); // Filter out null values

        try {
            await db.execute(
                'INSERT INTO log_config (guild_id, log_channel_id, enabled_logs) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE log_channel_id = VALUES(log_channel_id), enabled_logs = VALUES(enabled_logs)',
                [interaction.guild.id, channel.id, JSON.stringify(enabledLogs)]
            );

            const embed = new EmbedBuilder()
                .setColor('#57F287')
                .setTitle('✅ Logging Settings Updated')
                .setDescription(`Logs will now be sent to ${channel}.`)
                .addFields({ name: 'Enabled Events', value: enabledLogs.map(log => `\`${log}\``).join(', ') });
            
            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('[Logging Command Error]', error);
            await interaction.editReply({ content: 'An error occurred while saving logging settings.' });
        }
    },
};