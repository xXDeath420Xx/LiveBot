const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, escapeMarkdown } = require('discord.js');
const db = require('../utils/db');
const { checkTwitch, checkYouTube, checkKick, checkTikTok, checkTrovo } = require('../utils/api_checks');
const { platformPriority } = require('../utils/announcer');

const sendPaginatedEmbeds = async (interaction, pages, isFirstReply, initialContent = null) => {
    if (pages.length === 0) return;
    let currentPage = 0;
    const uniqueId = `${pages[0].data.title.split(' ')[0]}:${interaction.id}`;
    const prevButtonId = `prev_page:${uniqueId}`;
    const nextButtonId = `next_page:${uniqueId}`;

    const createButtons = () => new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(prevButtonId).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === 0),
        new ButtonBuilder().setCustomId(nextButtonId).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(currentPage >= pages.length - 1)
    );

    const messagePayload = { content: null, embeds: [pages[currentPage]], components: pages.length > 1 ? [createButtons()] : [], ephemeral: true };
    
    if (isFirstReply && initialContent) {
        messagePayload.content = initialContent;
    }

    const response = isFirstReply ? await interaction.editReply(messagePayload) : await interaction.followUp(messagePayload);
    if (pages.length <= 1) return;

    const collector = response.createMessageComponentCollector({ componentType: ComponentType.Button, time: 300000 });

    collector.on('collect', async buttonInteraction => {
        if (buttonInteraction.user.id !== interaction.user.id) {
            return buttonInteraction.reply({ content: 'You cannot use these buttons.', ephemeral: true });
        }
        if (buttonInteraction.customId === nextButtonId) currentPage++;
        else if (buttonInteraction.customId === prevButtonId) currentPage--;
        await buttonInteraction.update({ embeds: [pages[currentPage]], components: [createButtons()] });
    });

    collector.on('end', async () => {
        const finalEmbed = pages[currentPage];
        const disabledButtons = createButtons();
        disabledButtons.components.forEach(button => button.setDisabled(true));
        await response.edit({ embeds: [finalEmbed], components: [disabledButtons] }).catch(() => {});
    });
};


module.exports = {
  data: new SlashCommandBuilder()
    .setName('check-live')
    .setDescription('Lists all currently live streamers, grouped by platform.'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
      const [rows] = await db.execute(` 
        SELECT s.platform, s.username, s.discord_user_id, s.platform_user_id 
        FROM streamers s  
        JOIN subscriptions sub ON s.streamer_id = sub.streamer_id 
        WHERE sub.guild_id = ?  
        ORDER BY s.platform, s.username`, [interaction.guild.id]);

      if (rows.length === 0) {
        return interaction.editReply({ content: 'No streamers are being tracked on this server.' });
      }
      
      await interaction.editReply({ content: `Checking ${rows.length} streamers for live status...` });

      const statusChecks = rows.map(async (streamer) => {
            let apiResult, liveData = null;
            if (streamer.platform === 'twitch') apiResult = await checkTwitch(streamer);
            else if (streamer.platform === 'youtube') apiResult = await checkYouTube(streamer.platform_user_id);
            else if (streamer.platform === 'kick') apiResult = await checkKick(streamer.username);
            else if (streamer.platform === 'tiktok') apiResult = await checkTikTok(streamer.username);
            else if (streamer.platform === 'trovo') apiResult = await checkTrovo(streamer.username);
            
            if (streamer.platform === 'twitch' && apiResult?.length > 0) {
                liveData = { url: `https://www.twitch.tv/${apiResult[0].user_login}`, game: apiResult[0].game_name };
            } else if (streamer.platform === 'youtube' && apiResult?.is_live) {
                liveData = { url: apiResult.url, game: 'N/A' };
            } else if (streamer.platform === 'kick' && apiResult?.livestream) {
                liveData = { url: `https://kick.com/${apiResult.user.username}`, game: apiResult.livestream.categories[0]?.name || 'Not specified' };
            } else if (streamer.platform === 'tiktok' && apiResult?.is_live) {
                liveData = { url: `https://www.tiktok.com/@${streamer.username}/live`, game: 'N/A' };
            } else if (streamer.platform === 'trovo' && apiResult?.is_live) {
                liveData = { url: apiResult.channel_url, game: apiResult.category_name };
            }
            
            return { ...streamer, isLive: !!liveData, liveData };
        });

      const results = await Promise.allSettled(statusChecks);
      const liveStreamers = results
            .filter(res => res.status === 'fulfilled' && res.value && res.value.isLive)
            .map(res => res.value);

      if (liveStreamers.length === 0) {
        const embed = new EmbedBuilder().setColor('#FF0000').setTitle('No One is Live').setDescription('None of the tracked streamers are currently live.');
        return interaction.editReply({ content: '', embeds: [embed] });
      }

      const platformGroups = liveStreamers.reduce((acc, streamer) => {
        if (!acc[streamer.platform]) acc[streamer.platform] = [];
        acc[streamer.platform].push(streamer);
        return acc;
      }, {});


      const platformConfigs = [
        { name: 'Twitch', color: '#9146FF', data: platformGroups.twitch || [], emoji: '🟣' },
        { name: 'YouTube', color: '#FF0000', data: platformGroups.youtube || [], emoji: '🔴' },
        { name: 'Kick', color: '#52E252', data: platformGroups.kick || [], emoji: '🟢' },
        { name: 'Trovo', color: '#21d464', data: platformGroups.trovo || [], emoji: '🟢' },
        { name: 'TikTok', color: '#00f2ea', data: platformGroups.tiktok || [], emoji: '⚫' }
      ].sort((a,b) => platformPriority.indexOf(a.name.toLowerCase()) - platformPriority.indexOf(b.name.toLowerCase()));


      let isFirstReply = true;
      const initialContent = `**Live check complete. Found ${liveStreamers.length} live streamer(s).**`;

      for (const platform of platformConfigs) {
        if (platform.data.length === 0) continue;

        const platformPages = [];
        for (let i = 0; i < platform.data.length; i += 10) {
          const chunk = platform.data.slice(i, i + 10);
          
          const description = chunk.map(s => {
              const userLink = s.discord_user_id ? `(<@${s.discord_user_id}>)` : '';
              return `${platform.emoji} **[${escapeMarkdown(s.username)}](${s.liveData.url})** is playing **${s.liveData.game || 'N/A'}** ${userLink}`;
          }).join('\n\n');

          const embed = new EmbedBuilder().setColor(platform.color).setTitle(`Live ${platform.name} Streamers`).setDescription(description).setTimestamp().setFooter({ text: `Page ${Math.floor(i / 10) + 1} of ${Math.ceil(platform.data.length / 10)}` });
          platformPages.push(embed);
        }

        if (platformPages.length > 0) {
          await sendPaginatedEmbeds(interaction, platformPages, isFirstReply, isFirstReply ? initialContent : null);
          isFirstReply = false;
        }
      }

    } catch (e) {
      console.error('--- Critical Error in /check-live ---', e);
      await interaction.editReply({ content: 'A critical error occurred. Please try again later.' });
    }
  },
};
