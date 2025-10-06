const { SlashCommandBuilder, PermissionsBitField, ChannelType, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('lock')
        .setDescription('Locks the current channel, preventing @everyone from sending messages.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
        .addStringOption(option => 
            option.setName('reason')
                .setDescription('The reason for locking the channel.')
        ),

    async execute(interaction) {
        const channel = interaction.channel;
        const reason = interaction.options.getString('reason') || 'No reason provided.';

        if (channel.type !== ChannelType.GuildText) {
            return interaction.reply({ content: 'This command can only be used in text channels.', ephemeral: true });
        }

        try {
            await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
                SendMessages: false,
            });

            const embed = new EmbedBuilder()
                .setColor('#E74C3C')
                .setTitle('🔒 Channel Locked')
                .setDescription(`This channel has been locked by a moderator.`)
                .addFields({ name: 'Reason', value: reason })
                .setTimestamp();

            await channel.send({ embeds: [embed] });
            await interaction.reply({ content: 'Channel locked successfully.', ephemeral: true });

        } catch (error) {
            console.error('[Lock Command Error]', error);
            await interaction.reply({ content: 'Failed to lock the channel. Do I have the Manage Channels permission?', ephemeral: true });
        }
    },
};