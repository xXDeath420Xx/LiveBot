import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { themeColor } from '../../core/guild-theme.js';
import { replyRetired } from '../../core/retired-commands.js';

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
              option.setName('threshold').setDescription('Minimum number of stars required, 1 to 100 (default: 3)').setMinValue(1).setMaxValue(100)
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
          // Removed (H-650): auto-memes came from Reddit. Discord shows it until the next command deploy.
          return await replyRetired(interaction, 'community automeme');
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
        .setColor(themeColor(interaction.guildId, 'warning'))
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
      .setColor(themeColor(interaction.guildId, 'warning'))
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
    const emoji = config ? starboardManager.displayEmoji(config) : '⭐';

    const embed = new EmbedBuilder()
      .setColor(themeColor(interaction.guildId, 'warning'))
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
