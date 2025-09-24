const { EmbedBuilder, ActionRowBuilder, ChannelSelectMenuBuilder, ChannelType } = require('discord.js');

module.exports = {
    customId: /^setup_avatar_channel_select_/,
    async execute(interaction) {
        if (interaction.user.id !== interaction.customId.split('_')[4]) {
            return interaction.reply({ content: 'This is not your setup session.', ephemeral: true });
        }

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('Step 3: Select Avatar Upload Channel')
            .setDescription('Please select a private text channel. The bot will use this channel to upload and store avatar images for webhook announcements.');

        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId(`setup_avatar_channel_final_${interaction.user.id}`)
            .setPlaceholder('Select a channel for avatar uploads')
            .addChannelTypes([ChannelType.GuildText]);

        const row = new ActionRowBuilder().addComponents(channelSelect);

        await interaction.update({ embeds: [embed], components: [row] });
    },
};