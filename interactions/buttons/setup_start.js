const { EmbedBuilder, ActionRowBuilder, ChannelSelectMenuBuilder, ChannelType } = require('discord.js');

module.exports = {
    customId: /^setup_start_/,
    async execute(interaction) {
        if (interaction.user.id !== interaction.customId.split('_')[2]) {
            return interaction.reply({ content: 'This is not your setup session.', ephemeral: true });
        }

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('Step 1: Default Announcement Channel')
            .setDescription('Please select the channel where you want live stream announcements to be posted by default. You can override this on a per-streamer basis later.');

        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId(`setup_channel_${interaction.user.id}`)
            .setPlaceholder('Select an announcement channel')
            .addChannelTypes([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

        const row = new ActionRowBuilder().addComponents(channelSelect);

        await interaction.update({ embeds: [embed], components: [row] });
    },
};