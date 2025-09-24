const { EmbedBuilder } = require('discord.js');

module.exports = {
    customId: /^setup_cancel_/,
    async execute(interaction) {
        if (interaction.user.id !== interaction.customId.split('_')[2]) {
            return interaction.reply({ content: 'This is not your setup session.', ephemeral: true });
        }

        const embed = new EmbedBuilder()
            .setColor('#ED4245')
            .setTitle('Setup Cancelled')
            .setDescription('The interactive setup has been cancelled. You can run `/setup` again at any time.');

        await interaction.update({ embeds: [embed], components: [] });
    },
};