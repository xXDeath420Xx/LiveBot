const { SlashCommandBuilder, EmbedBuilder, escapeMarkdown } = require('discord.js');
const db = require('../utils/db');
const { platformColors } = require('../utils/announcer'); // Reuse platform colors

module.exports = {
  data: new SlashCommandBuilder()
    .setName('check-live')
    .setDescription('Instantly lists all streamers with an active announcement on this server.'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
      // REWRITE: Query the 'announcements' table, which is the source of truth for who is live.
      const [liveStreamers] = await db.execute(` 
        SELECT 
            s.platform, s.username, s.discord_user_id, s.platform_user_id,
            a.stream_game, a.stream_title
        FROM announcements a
        JOIN streamers s ON a.streamer_id = s.streamer_id 
        WHERE a.guild_id = ?
        ORDER BY s.platform, s.username`,
        [interaction.guild.id]
      );

      if (liveStreamers.length === 0) {
        const embed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('No One is Live')
            .setDescription('None of the tracked streamers have a live announcement currently active on this server.');
        return interaction.editReply({ embeds: [embed] });
      }
      
      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle(`🟢 ${liveStreamers.length} Streamer(s) Currently Live`)
        .setDescription('This list reflects all streamers with an active announcement right now.')
        .setTimestamp();
        
      for (const streamer of liveStreamers) {
        const streamUrl = {
              twitch: `https://www.twitch.tv/${streamer.username}`,
              youtube: `https://www.youtube.com/watch?v=${streamer.stream_title}`, // A bit of a guess, but better than nothing
              kick: `https://kick.com/${streamer.username}`,
              tiktok: `https://www.tiktok.com/@${streamer.username}/live`,
              trovo: `https://trovo.live/s/${streamer.username}`
          }[streamer.platform] || '#';

          embed.addFields({
              name: `${streamer.platform.charAt(0).toUpperCase() + streamer.platform.slice(1)}: ${escapeMarkdown(streamer.username)}`,
              value: `[${escapeMarkdown(streamer.stream_title || "Untitled Stream")}](${streamUrl})\nPlaying: *${escapeMarkdown(streamer.stream_game || 'N/A')}*`,
              inline: true
          });
      }

      await interaction.editReply({ embeds: [embed] });

    } catch (e) {
      console.error('--- Critical Error in /check-live ---', e);
      await interaction.editReply({ content: 'A critical error occurred while fetching live statuses.' });
    }
  },
};