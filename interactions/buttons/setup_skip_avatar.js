const { EmbedBuilder } = require('discord.js');

module.exports = {
    customId: /^setup_skip_avatar_/,
    async execute(interaction) {
        if (interaction.user.id !== interaction.customId.split('_')[3]) {
            return interaction.reply({ content: 'This is not your setup session.', ephemeral: true });
        }

        const embed = new EmbedBuilder()
            .setColor('#57F287')
            .setTitle('✅ Essential Setup Complete!')
            .setDescription('You have completed the essential setup for LiveBot!\n\nYou can always run `/config` to change these settings later or to explore more advanced customization options.');

        await interaction.update({ embeds: [embed], components: [] });
    },
};