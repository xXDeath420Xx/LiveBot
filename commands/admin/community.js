import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';

export default {
  category: 'admin',
  data: new SlashCommandBuilder()
    .setName('community')
    .setDescription('Community engagement and entertainment features')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommandGroup(group =>
      group
        .setName('starboard')
        .setDescription('Starboard system commands')
        .addSubcommand(sub =>
          sub
            .setName('setup')
            .setDescription('Configure the starboard')
            .addChannelOption(option =>
              option.setName('channel').setDescription('The channel for starboard messages').setRequired(true)
            )
            .addIntegerOption(option =>
              option.setName('threshold').setDescription('Minimum number of stars required (default: 3)').setMinValue(1).setMaxValue(50)
            )
            .addStringOption(option =>
              option.setName('emoji').setDescription('The star emoji to use (default: ⭐)')
            )
        )
        .addSubcommand(sub =>
          sub.setName('disable').setDescription('Disable the starboard')
        )
        .addSubcommand(sub =>
          sub.setName('stats').setDescription('View starboard statistics')
        )
        .addSubcommand(sub =>
          sub
            .setName('top')
            .setDescription('View most starred messages')
            .addIntegerOption(option =>
              option.setName('limit').setDescription('Number of messages to show (default: 10)').setMinValue(1).setMaxValue(25)
            )
        )
    )
    .addSubcommandGroup(group =>
      group
        .setName('automeme')
        .setDescription('Configure automated meme posting')
        .addSubcommand(sub =>
          sub
            .setName('setup')
            .setDescription('Enable and configure auto-meme posting')
            .addChannelOption(option =>
              option.setName('channel').setDescription('Channel to post memes in').setRequired(true)
            )
            .addStringOption(option =>
              option.setName('subreddit').setDescription('Subreddit to pull memes from')
                .addChoices(
                  { name: 'Memes (General)', value: 'memes' },
                  { name: 'Dank Memes', value: 'dankmemes' },
                  { name: 'Wholesome Memes', value: 'wholesomememes' },
                  { name: 'Gaming Memes', value: 'gaming' },
                  { name: 'Anime Memes', value: 'animemes' },
                  { name: 'Programming Memes', value: 'ProgrammerHumor' },
                  { name: 'Poker', value: 'poker' },
                  { name: 'Poker Memes', value: 'pokermemes' },
                  { name: 'Chip Porn (Poker Chips)', value: 'ChipPorn' }
                )
            )
            .addIntegerOption(option =>
              option.setName('interval').setDescription('How often to post (in hours)').setMinValue(1).setMaxValue(168)
            )
        )
        .addSubcommand(sub =>
          sub.setName('disable').setDescription('Disable auto-meme posting')
        )
        .addSubcommand(sub =>
          sub.setName('status').setDescription('View current auto-meme configuration')
        )
        .addSubcommand(sub =>
          sub.setName('test').setDescription('Post a test meme now')
        )
    )
    .addSubcommandGroup(group =>
      group
        .setName('pokermeme')
        .setDescription('Poker meme generation')
        .addSubcommand(sub =>
          sub
            .setName('test')
            .setDescription('Generate and post a poker meme now')
            .addChannelOption(option =>
              option.setName('channel').setDescription('Channel to post to (defaults to current)')
            )
        )
    ),

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup();
    const subcommand = interaction.options.getSubcommand();

    try {
      switch (group) {
        case 'starboard':
          return await this.handleStarboard(interaction, subcommand);
        case 'automeme':
          return await this.handleAutoMeme(interaction, subcommand);
        case 'pokermeme':
          return await this.handlePokerMeme(interaction, subcommand);
      }
    } catch (error) {
      console.error('[Community Command Error]', error);
      const method = interaction.deferred || interaction.replied ? 'editReply' : 'reply';
      await interaction[method]({
        content: 'An error occurred while processing this command.',
        ephemeral: true
      }).catch(() => {});
    }
  },

  // ==================== STARBOARD GROUP ====================
  async handleStarboard(interaction, subcommand) {
    const starboardManager = interaction.client.starboardManager;

    if (!starboardManager) {
      return interaction.reply({
        content: 'The starboard system is not available.',
        ephemeral: true
      });
    }

    switch (subcommand) {
      case 'setup':
        await this.starboardSetup(interaction, starboardManager);
        break;
      case 'disable':
        await this.starboardDisable(interaction, starboardManager);
        break;
      case 'stats':
        await this.starboardStats(interaction, starboardManager);
        break;
      case 'top':
        await this.starboardTop(interaction, starboardManager);
        break;
    }
  },

  async starboardSetup(interaction, starboardManager) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: 'You need the **Manage Server** permission to use this command.',
        ephemeral: true
      });
    }

    const channel = interaction.options.getChannel('channel');
    const threshold = interaction.options.getInteger('threshold') || 3;
    const emoji = interaction.options.getString('emoji') || '⭐';

    if (!channel.isTextBased()) {
      return interaction.reply({
        content: 'The starboard channel must be a text channel.',
        ephemeral: true
      });
    }

    await interaction.deferReply({ ephemeral: true });

    const success = await starboardManager.setConfig(
      interaction.guild.id,
      channel.id,
      threshold,
      emoji,
      true
    );

    if (success) {
      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('Starboard Configured')
        .setDescription('The starboard system has been set up successfully!')
        .addFields(
          { name: 'Channel', value: `<#${channel.id}>`, inline: true },
          { name: 'Threshold', value: `${threshold} stars`, inline: true },
          { name: 'Emoji', value: emoji, inline: true }
        )
        .setFooter({ text: 'Messages with enough stars will appear in the starboard!' });

      await interaction.editReply({ embeds: [embed] });
    } else {
      await interaction.editReply({
        content: 'Failed to configure starboard. Please try again later.'
      });
    }
  },

  async starboardDisable(interaction, starboardManager) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: 'You need the **Manage Server** permission to use this command.',
        ephemeral: true
      });
    }

    await interaction.deferReply({ ephemeral: true });

    const success = await starboardManager.disableStarboard(interaction.guild.id);

    if (success) {
      await interaction.editReply({ content: 'Starboard has been disabled.' });
    } else {
      await interaction.editReply({ content: 'Failed to disable starboard.' });
    }
  },

  async starboardStats(interaction, starboardManager) {
    await interaction.deferReply();

    const config = await starboardManager.getConfig(interaction.guild.id);

    if (!config) {
      return interaction.editReply({
        content: 'The starboard has not been configured yet. Use `/community starboard setup` to set it up.',
        ephemeral: true
      });
    }

    const stats = await starboardManager.getStats(interaction.guild.id);

    if (!stats || stats.total_starred === 0) {
      return interaction.editReply({
        content: 'No starboard statistics available yet.',
        ephemeral: true
      });
    }

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('Starboard Statistics')
      .addFields(
        { name: 'Total Starred Messages', value: `${stats.total_starred}`, inline: true },
        { name: 'Total Stars Given', value: `${stats.total_stars}`, inline: true },
        { name: 'Average Stars', value: `${Math.round(stats.avg_stars * 10) / 10}`, inline: true },
        { name: 'Most Stars on a Message', value: `${stats.max_stars}`, inline: true },
        { name: 'Star Threshold', value: `${config.star_threshold}`, inline: true },
        { name: 'Status', value: config.enabled ? 'Enabled' : 'Disabled', inline: true }
      )
      .setFooter({ text: `${interaction.guild.name} Starboard` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },

  async starboardTop(interaction, starboardManager) {
    const limit = interaction.options.getInteger('limit') || 10;

    await interaction.deferReply();

    const topMessages = await starboardManager.getTopMessages(interaction.guild.id, limit);

    if (topMessages.length === 0) {
      return interaction.editReply({
        content: 'No starred messages found.',
        ephemeral: true
      });
    }

    const config = await starboardManager.getConfig(interaction.guild.id);
    const emoji = config ? config.emoji : '⭐';

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle(`Top Starred Messages`)
      .setFooter({ text: `${interaction.guild.name} Starboard` })
      .setTimestamp();

    let description = '';

    for (let i = 0; i < topMessages.length; i++) {
      const msg = topMessages[i];
      const rank = i + 1;
      const medal = rank === 1 ? ':first_place:' : rank === 2 ? ':second_place:' : rank === 3 ? ':third_place:' : `${rank}.`;

      try {
        const channel = await interaction.guild.channels.fetch(msg.original_channel_id).catch(() => null);
        const channelMention = channel ? `<#${channel.id}>` : 'Unknown Channel';

        let messageLink = '';
        if (channel) {
          messageLink = `https://discord.com/channels/${interaction.guild.id}/${msg.original_channel_id}/${msg.original_message_id}`;
        }

        description += `${medal} ${emoji} **${msg.star_count}** - ${channelMention}`;
        if (messageLink) {
          description += ` [Jump to message](${messageLink})`;
        }
        description += '\n';
      } catch (error) {
        description += `${medal} ${emoji} **${msg.star_count}** - Unknown Channel\n`;
      }
    }

    embed.setDescription(description);

    await interaction.editReply({ embeds: [embed] });
  },

  // ==================== AUTOMEME GROUP ====================
  async handleAutoMeme(interaction, subcommand) {
    const autoMemeManager = interaction.client.autoMemeManager;

    if (!autoMemeManager) {
      return interaction.reply({
        content: '❌ Auto-meme system is not available.',
        ephemeral: true
      });
    }

    try {
      if (subcommand === 'setup') {
        const channel = interaction.options.getChannel('channel');
        const subreddit = interaction.options.getString('subreddit') || 'memes';
        const interval = interaction.options.getInteger('interval') || 24;

        if (!channel.isTextBased()) {
          return interaction.reply({
            content: '❌ Please select a text channel.',
            ephemeral: true
          });
        }

        await interaction.deferReply({ ephemeral: true });

        await autoMemeManager.configureGuild(
          interaction.guild.id,
          true,
          channel.id,
          subreddit,
          interval
        );

        const embed = new EmbedBuilder()
          .setColor('#00FF00')
          .setTitle('✅ Auto-Meme Posting Enabled')
          .setDescription(`Memes will be automatically posted to ${channel}`)
          .addFields(
            { name: 'Subreddit', value: `r/${subreddit}`, inline: true },
            { name: 'Interval', value: `Every ${interval} hour${interval > 1 ? 's' : ''}`, inline: true }
          )
          .setFooter({ text: 'Use /community automeme test to post a meme immediately' })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });

      } else if (subcommand === 'disable') {
        await interaction.deferReply({ ephemeral: true });

        await autoMemeManager.configureGuild(
          interaction.guild.id,
          false
        );

        return interaction.editReply({
          content: '✅ Auto-meme posting has been disabled.'
        });

      } else if (subcommand === 'status') {
        await interaction.deferReply({ ephemeral: true });

        const config = await autoMemeManager.getGuildConfig(interaction.guild.id);

        if (!config) {
          return interaction.editReply({
            content: '❌ Auto-meme posting is not configured for this server.\n\nUse `/community automeme setup` to get started!'
          });
        }

        const channel = interaction.guild.channels.cache.get(config.channel_id);
        const status = config.is_enabled ? '🟢 Enabled' : '🔴 Disabled';

        const embed = new EmbedBuilder()
          .setColor(config.is_enabled ? '#00FF00' : '#FF0000')
          .setTitle('Auto-Meme Configuration')
          .addFields(
            { name: 'Status', value: status, inline: true },
            { name: 'Channel', value: channel ? `${channel}` : 'Channel not found', inline: true },
            { name: 'Subreddit', value: `r/${config.subreddit}`, inline: true },
            { name: 'Interval', value: `Every ${config.post_interval_hours} hour${config.post_interval_hours > 1 ? 's' : ''}`, inline: true },
            { name: 'Last Posted', value: config.last_posted_at ? `<t:${Math.floor(new Date(config.last_posted_at).getTime() / 1000)}:R>` : 'Never', inline: true }
          )
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });

      } else if (subcommand === 'test') {
        const config = await autoMemeManager.getGuildConfig(interaction.guild.id);

        if (!config || !config.channel_id) {
          return interaction.reply({
            content: '❌ Auto-meme posting is not configured. Use `/community automeme setup` first.',
            ephemeral: true
          });
        }

        await interaction.deferReply({ ephemeral: true });

        try {
          await autoMemeManager.postManualMeme(
            interaction.guild.id,
            config.channel_id,
            config.subreddit
          );

          const channel = interaction.guild.channels.cache.get(config.channel_id);

          return interaction.editReply({
            content: `✅ Test meme posted to ${channel}!`
          });

        } catch (error) {
          console.error('[AutoMeme Test Error]', error);
          return interaction.editReply({
            content: '❌ Failed to post test meme. Please check the channel permissions and try again.'
          });
        }
      }

    } catch (error) {
      console.error('[AutoMeme Command Error]', error);

      const replyMethod = interaction.deferred ? 'editReply' : 'reply';
      return interaction[replyMethod]({
        content: '❌ An error occurred while processing your request.',
        ephemeral: true
      });
    }
  },

  // ==================== POKER MEME GROUP ====================
  async handlePokerMeme(interaction, subcommand) {
    const { getPokerMemeGenerator } = await import('../../jobs/poker-meme-scheduler.js');

    try {
      if (subcommand === 'test') {
        const channel = interaction.options.getChannel('channel') || interaction.channel;

        if (!channel.isTextBased()) {
          return interaction.reply({
            content: '❌ Please select a text channel.',
            ephemeral: true
          });
        }

        await interaction.deferReply({ ephemeral: true });

        // Get the generator for this bot
        let generator = getPokerMemeGenerator('default');

        // Check if this guild has a custom bot
        if (global.botManager) {
          const managingBotId = global.botManager.guildBotMapping.get(interaction.guild.id);
          if (managingBotId) {
            generator = getPokerMemeGenerator(managingBotId);
          }
        }

        if (!generator) {
          return interaction.editReply({
            content: '❌ Poker meme generator is not available.'
          });
        }

        try {
          const success = await generator.postPokerMeme(interaction.guild.id, channel.id);

          if (success) {
            return interaction.editReply({
              content: `✅ Poker meme posted to ${channel}!`
            });
          } else {
            return interaction.editReply({
              content: '❌ Failed to generate poker meme. Trying Reddit fallback...'
            });
          }
        } catch (error) {
          console.error('[PokerMeme Test Error]', error);
          return interaction.editReply({
            content: '❌ Failed to post poker meme. Please try again.'
          });
        }
      }

    } catch (error) {
      console.error('[PokerMeme Command Error]', error);

      const replyMethod = interaction.deferred ? 'editReply' : 'reply';
      return interaction[replyMethod]({
        content: '❌ An error occurred while processing your request.',
        ephemeral: true
      });
    }
  }
};
