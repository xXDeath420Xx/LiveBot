import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';

export default {
    category: 'tools',
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check the bot\'s latency and uptime'),

  cooldown: 5,

  async execute(interaction) {
    const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true });
    const roundtripLatency = sent.createdTimestamp - interaction.createdTimestamp;
    const websocketLatency = interaction.client.ws.ping;

    // Calculate uptime
    const uptime = process.uptime();
    const days = Math.floor(uptime / 86400);
    const hours = Math.floor(uptime / 3600) % 24;
    const minutes = Math.floor(uptime / 60) % 60;
    const seconds = Math.floor(uptime % 60);

    const uptimeString = [
      days > 0 ? `${days}d` : '',
      hours > 0 ? `${hours}h` : '',
      minutes > 0 ? `${minutes}m` : '',
      `${seconds}s`
    ].filter(Boolean).join(' ');

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('🏓 Pong!')
      .addFields(
        { name: 'Roundtrip Latency', value: `${roundtripLatency}ms`, inline: true },
        { name: 'WebSocket Latency', value: `${websocketLatency}ms`, inline: true },
        { name: 'Uptime', value: uptimeString, inline: true }
      )
      .setTimestamp()
      .setFooter({ text: 'CertiFried Utility' });

    await interaction.editReply({ content: null, embeds: [embed] });
  }
};
