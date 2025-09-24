const { EmbedBuilder, ButtonBuilder, ActionRowBuilder } = require('discord.js');

module.exports = {
    customId: /^request_submit_/,
    async execute(interaction) {
        const parts = interaction.customId.split('_');
        const requestsChannelId = parts[2];
        const platforms = parts[3].split(',');
        const requestData = platforms.map(platform => {
            const username = interaction.fields.getTextInputValue(`${platform}_username`);
            return { platform, username };
        });

        const requestsChannel = await interaction.client.channels.fetch(requestsChannelId);
        if (!requestsChannel) {
            return interaction.reply({ content: 'Error: The requests channel could not be found.', ephemeral: true });
        }

        const serializedData = requestData.map(d => `${d.platform}:${d.username}`).join(';');
        const approveButton = new ButtonBuilder().setCustomId(`approve_request_${interaction.user.id}_${serializedData}`).setLabel('Approve').setStyle(ButtonStyle.Success);
        const denyButton = new ButtonBuilder().setCustomId(`deny_request_${interaction.user.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger);
        const row = new ActionRowBuilder().addComponents(approveButton, denyButton);

        const embed = new EmbedBuilder()
            .setColor('#FFA500')
            .setTitle('New Streamer Request')
            .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
            .addFields(requestData.map(d => ({ name: d.platform.charAt(0).toUpperCase() + d.platform.slice(1), value: d.username, inline: true })))
            .setFooter({ text: `User ID: ${interaction.user.id}` });

        await requestsChannel.send({ embeds: [embed], components: [row] });
        await interaction.reply({ content: 'Your request has been submitted for approval.', ephemeral: true });
    },
};