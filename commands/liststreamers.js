const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, escapeMarkdown, PermissionsBitField } = require('discord.js');
const db = require('../utils/db');

// A reusable pagination helper
async function sendPaginatedEmbed(interaction, pages) {
    if (!pages || pages.length === 0) return;
    let currentPage = 0;
    const uniqueId = `listpage:${interaction.id}`;
    
    const createButtons = (ended = false) => new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`prev:${uniqueId}`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === 0 || ended),
        new ButtonBuilder().setCustomId(`next:${uniqueId}`).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(currentPage >= pages.length - 1 || ended)
    );

    const message = await interaction.editReply({ embeds: [pages[currentPage]], components: pages.length > 1 ? [createButtons()] : [], ephemeral: true });

    // Ensure message was successfully sent before creating a collector
    if (!message || pages.length <= 1) return;

    const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: 300000 });

    collector.on('collect', async i => {
        if (i.user.id !== interaction.user.id) return i.reply({ content: 'You cannot use these buttons.', ephemeral: true });
        i.customId.startsWith('next') ? currentPage++ : currentPage--;
        await i.update({ embeds: [pages[currentPage]], components: [createButtons()] });
    });

    collector.on('end', (collected, reason) => {
        // Log the error if updating components fails on end
        message.edit({ components: [createButtons(true)] }).catch(e => console.error(`Error updating pagination buttons for interaction ${interaction.id} on collector end (reason: ${reason}):`, e));
    });
};

module.exports = {
  data: new SlashCommandBuilder().setName('liststreamers').setDescription('Lists all tracked streamers and their live status.').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    try {
      const [allStreamers] = await db.execute(`
        SELECT s.platform, s.username, s.discord_user_id, s.platform_user_id,
               a.announcement_id IS NOT NULL AS isLive
        FROM subscriptions sub
        JOIN streamers s ON sub.streamer_id = s.streamer_id
        LEFT JOIN announcements a ON s.streamer_id = a.streamer_id AND sub.guild_id = a.guild_id
        WHERE sub.guild_id = ?
        ORDER BY isLive DESC, s.platform, s.username`,
        [interaction.guild.id]
      );

      if (allStreamers.length === 0) return interaction.editReply({ content: 'No streamers are tracked on this server.' });
      
      const liveCount = allStreamers.filter(s => s.isLive).length;
      const totalCount = allStreamers.length;
      
      const pages = [];
      const pageSize = 15;
      for (let i = 0; i < totalCount; i += pageSize) {
        const chunk = allStreamers.slice(i, i + pageSize);
        const description = chunk.map(s => {
          const status = s.isLive ? '🟢' : '🔴';
          const user = s.discord_user_id ? `(<@${s.discord_user_id}>)` : '';
          let url;
          switch (s.platform) {
              case 'twitch': url = `https://www.twitch.tv/${s.username}`; break;
              case 'youtube': url = `https://www.youtube.com/channel/${s.platform_user_id}`; break;
              case 'kick': url = `https://kick.com/${s.username}`; break;
              case 'tiktok': url = `https://www.tiktok.com/@${s.username}`; break;
              case 'trovo': url = `https://trovo.live/s/${s.username}`; break;
              default: url = null; // Changed fallback to null for unknown platforms
          }
          // Display as plain text if URL is null, otherwise as a link
          const usernameDisplay = url ? `[**${escapeMarkdown(s.username)}**](${url})` : `**${escapeMarkdown(s.username)}**`;
          return `${status} ${usernameDisplay} (${s.platform}) ${user}`;
        }).join('\n');
        
        pages.push(new EmbedBuilder()
          .setTitle(`Tracked Streamers (${liveCount} Live / ${totalCount} Total)`)
          .setColor(liveCount > 0 ? '#57F287' : '#ED4245')
          .setDescription(description)
          .setFooter({ text: `Page ${Math.floor(i / pageSize) + 1} of ${Math.ceil(totalCount / pageSize)}` })
        );
      }
      
      await sendPaginatedEmbed(interaction, pages);
    } catch (e) { 
        console.error('Error in /liststreamers:', e);
        // interaction.editReply() is safe to call after deferReply, no need for !interaction.replied check
        await interaction.editReply({ content: 'An error occurred.' }).catch(error => console.error('Failed to send error reply:', error));
    }
  },
};