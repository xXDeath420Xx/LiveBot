import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import pool from '../../utils/db.js';

export default {
    category: 'info',
  data: new SlashCommandBuilder()
    .setName('server')
    .setDescription('Server information and statistics')
    // Basic info subcommand
    .addSubcommand(subcommand =>
      subcommand
        .setName('info')
        .setDescription('Display detailed information about the current server')
    )
    // Lookup subcommand for fetching any guild by ID
    .addSubcommand(subcommand =>
      subcommand
        .setName('lookup')
        .setDescription('Look up information about any server by ID')
        .addStringOption(option =>
          option.setName('id')
            .setDescription('The server/guild ID to look up')
            .setRequired(true)
        )
    )
    // Stats subcommand group
    .addSubcommandGroup(group =>
      group
        .setName('stats')
        .setDescription('View server statistics and analytics')
        .addSubcommand(subcommand =>
          subcommand
            .setName('overview')
            .setDescription('View server overview and current stats')
        )
        .addSubcommand(subcommand =>
          subcommand
            .setName('growth')
            .setDescription('View server growth over time')
            .addIntegerOption(option =>
              option.setName('days')
                .setDescription('Number of days to show (default: 30)')
                .setRequired(false)
                .setMinValue(7)
                .setMaxValue(90)
            )
        )
        .addSubcommand(subcommand =>
          subcommand
            .setName('activity')
            .setDescription('View server activity statistics')
            .addIntegerOption(option =>
              option.setName('days')
                .setDescription('Number of days to show (default: 7)')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(30)
            )
        )
        .addSubcommand(subcommand =>
          subcommand
            .setName('topusers')
            .setDescription('View most active users')
            .addIntegerOption(option =>
              option.setName('days')
                .setDescription('Number of days to analyze (default: 7)')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(30)
            )
        )
        .addSubcommand(subcommand =>
          subcommand
            .setName('topchannels')
            .setDescription('View most active channels')
            .addIntegerOption(option =>
              option.setName('days')
                .setDescription('Number of days to analyze (default: 7)')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(30)
            )
        )
        .addSubcommand(subcommand =>
          subcommand
            .setName('peakhours')
            .setDescription('View peak activity times')
        )
    ),

  async execute(interaction) {
    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();

    try {
      // Handle basic server info (no group)
      if (!subcommandGroup && subcommand === 'info') {
        return await this.handleServerInfo(interaction);
      }

      // Handle server lookup by ID
      if (!subcommandGroup && subcommand === 'lookup') {
        return await this.handleServerLookup(interaction);
      }

      // Handle stats subcommand group
      if (subcommandGroup === 'stats') {
        // Check for ManageGuild permission for stats commands
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
          return interaction.reply({
            content: '❌ You need the **Manage Server** permission to view server statistics.',
            ephemeral: true
          });
        }

        const serverStatsManager = interaction.client.serverStatsManager;

        if (!serverStatsManager) {
          return interaction.reply({
            content: '❌ Server statistics system is not available.',
            ephemeral: true
          });
        }

        await interaction.deferReply();

        switch (subcommand) {
          case 'overview':
            return await this.handleStatsOverview(interaction);
          case 'growth':
            return await this.handleStatsGrowth(interaction, serverStatsManager);
          case 'activity':
            return await this.handleStatsActivity(interaction, serverStatsManager);
          case 'topusers':
            return await this.handleStatsTopUsers(interaction, serverStatsManager);
          case 'topchannels':
            return await this.handleStatsTopChannels(interaction, serverStatsManager);
          case 'peakhours':
            return await this.handleStatsPeakHours(interaction, serverStatsManager);
        }
      }
    } catch (error) {
      console.error('[Server Command Error]', error);
      const replyMethod = interaction.deferred ? 'editReply' : 'reply';
      return interaction[replyMethod]({
        content: '❌ An error occurred while processing the server command.',
        ephemeral: true
      });
    }
  },

  // Server info handler (from serverinfo.js)
  async handleServerInfo(interaction) {
    await interaction.deferReply();

    const guild = interaction.guild;
    const owner = await guild.fetchOwner();

    const textChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText).size;
    const voiceChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice).size;
    const categories = guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory).size;
    const totalMembers = guild.memberCount;
    const humanMembers = guild.members.cache.filter(member => !member.user.bot).size;
    const botMembers = totalMembers - humanMembers;
    const roleCount = guild.roles.cache.size;

    const verificationLevels = ['None', 'Low', 'Medium', 'High', 'Very High'];
    const explicitContentFilters = ['Disabled', 'Members without roles', 'All members'];

    const embed = new EmbedBuilder()
      .setColor('#3498DB')
      .setTitle(`Server Info: ${guild.name}`)
      .setThumbnail(guild.iconURL({ size: 256 }))
      .addFields(
        { name: 'Owner', value: `${owner.user.tag} (${owner.id})`, inline: false },
        { name: 'Server ID', value: guild.id, inline: false },
        { name: 'Created On', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:F>`, inline: false },
        { name: 'Members', value: `**Total:** ${totalMembers}\n**Humans:** ${humanMembers}\n**Bots:** ${botMembers}`, inline: true },
        { name: 'Channels', value: `**Text:** ${textChannels}\n**Voice:** ${voiceChannels}\n**Categories:** ${categories}`, inline: true },
        { name: 'Roles', value: `${roleCount}`, inline: true },
        { name: 'Verification Level', value: verificationLevels[guild.verificationLevel] || 'Unknown', inline: true },
        { name: 'Explicit Content Filter', value: explicitContentFilters[guild.explicitContentFilter] || 'Unknown', inline: true }
      )
      .setFooter({ text: `Requested by ${interaction.user.tag}` })
      .setTimestamp();

    // Add boost info if available
    if (guild.premiumTier > 0) {
      embed.addFields({
        name: '💎 Boost Info',
        value: `**Tier:** ${guild.premiumTier}\n**Boosts:** ${guild.premiumSubscriptionCount || 0}`,
        inline: true
      });
    }

    // Add banner if available
    if (guild.banner) {
      embed.setImage(guild.bannerURL({ size: 1024 }));
    }

    return interaction.editReply({ embeds: [embed] });
  },

  // Server lookup handler - fetch any guild by ID
  async handleServerLookup(interaction) {
    await interaction.deferReply();

    const guildId = interaction.options.getString('id');

    // Validate guild ID format (Discord snowflake)
    if (!/^\d{17,19}$/.test(guildId)) {
      return interaction.editReply({
        content: '❌ Invalid server ID format. Please provide a valid Discord server ID.'
      });
    }

    // Decode snowflake to get creation date
    const snowflake = BigInt(guildId);
    const timestamp = Number((snowflake >> 22n) + 1420070400000n);
    const createdAt = new Date(timestamp);

    // Check if it's a valid Discord timestamp (after Discord's epoch)
    if (timestamp < 1420070400000 || timestamp > Date.now()) {
      return interaction.editReply({
        content: '❌ Invalid server ID. The timestamp decoded from this ID is not valid.'
      });
    }

    // Helper function to get bot presence info across ALL instances
    const getBotPresenceInfo = async (guildId) => {
      const presenceInfo = {
        defaultBot: false,
        customBot: null,
        anyBotPresent: false,
        presentBots: []
      };

      // Check ALL bot instances for guild presence
      if (global.botManager) {
        for (const [botId, client] of global.botManager.clients.entries()) {
          if (client.isReady() && client.guilds.cache.has(guildId)) {
            presenceInfo.anyBotPresent = true;
            presenceInfo.presentBots.push({
              id: botId,
              name: client.user?.username || botId,
              isDefault: botId === 'default'
            });
            if (botId === 'default') {
              presenceInfo.defaultBot = true;
            }
          }
        }
      } else {
        // Fallback to checking just the executing client
        try {
          const guild = await interaction.client.guilds.fetch(guildId);
          if (guild) {
            presenceInfo.defaultBot = true;
            presenceInfo.anyBotPresent = true;
          }
        } catch (e) {
          // Default bot not in guild
        }
      }

      // Check for custom bot assignment in database
      try {
        const [mapping] = await pool.execute(
          `SELECT gbm.bot_id, cb.bot_name, cb.enabled
           FROM guild_bot_mapping gbm
           LEFT JOIN custom_bots cb ON gbm.bot_id = cb.bot_id
           WHERE gbm.guild_id = ?`,
          [guildId]
        );
        if (mapping.length > 0) {
          presenceInfo.customBot = {
            id: mapping[0].bot_id,
            name: mapping[0].bot_name || 'Unknown',
            enabled: mapping[0].enabled
          };
        }
      } catch (e) {
        // No custom bot or error
      }

      return presenceInfo;
    };

    // Format bot presence for embed
    const formatBotPresence = (presenceInfo) => {
      const lines = [];

      // Show all present bot instances
      if (presenceInfo.presentBots.length > 0) {
        lines.push(`✅ **Bot Instances Present:** ${presenceInfo.presentBots.length}`);
        presenceInfo.presentBots.forEach(bot => {
          const label = bot.isDefault ? '(Default)' : '(Custom)';
          lines.push(`   └ ${bot.name} ${label}`);
        });
      } else {
        lines.push('❌ **No bot instances** present in this server');
      }

      // Custom bot database assignment
      if (presenceInfo.customBot) {
        const status = presenceInfo.customBot.enabled ? '🟢 Enabled' : '🔴 Disabled';
        lines.push(`📋 **Assigned Custom Bot:** ${presenceInfo.customBot.name}`);
        lines.push(`   └ ID: \`${presenceInfo.customBot.id}\` - ${status}`);
      }

      return lines.join('\n');
    };

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setFooter({ text: `Requested by ${interaction.user.tag}` })
      .setTimestamp();

    // Get bot presence info early so we can include it in all responses
    const presenceInfo = await getBotPresenceInfo(guildId);

    // Try to fetch guild from ANY bot instance (unified lookup)
    try {
      // Use unified lookup across all bot instances
      let guild = null;
      if (global.botManager) {
        guild = global.botManager.getGuildFromAnyClient(guildId);
      }
      // Fallback to just the executing client if botManager not available
      if (!guild) {
        guild = await interaction.client.guilds.fetch(guildId).catch(() => null);
      }

      if (guild) {
        // A bot instance is in this guild - get full info
        const owner = await guild.fetchOwner().catch(() => null);
        const members = await guild.members.fetch().catch(() => guild.members.cache);

        const textChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText).size;
        const voiceChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice).size;
        const categories = guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory).size;
        const humanMembers = members.filter ? members.filter(m => !m.user.bot).size : 'Unknown';
        const botMembers = members.filter ? members.filter(m => m.user.bot).size : 'Unknown';

        embed
          .setTitle(`🔍 Server Lookup: ${guild.name}`)
          .setThumbnail(guild.iconURL({ size: 256 }))
          .addFields(
            { name: '📋 Server ID', value: guild.id, inline: false },
            { name: '👑 Owner', value: owner ? `${owner.user.tag} (${owner.id})` : 'Unable to fetch', inline: false },
            { name: '📅 Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:F>\n(<t:${Math.floor(guild.createdTimestamp / 1000)}:R>)`, inline: false },
            { name: '👥 Members', value: `**Total:** ${guild.memberCount}\n**Humans:** ${humanMembers}\n**Bots:** ${botMembers}`, inline: true },
            { name: '💬 Channels', value: `**Text:** ${textChannels}\n**Voice:** ${voiceChannels}\n**Categories:** ${categories}`, inline: true },
            { name: '🎭 Roles', value: `${guild.roles.cache.size}`, inline: true }
          )
          .setColor('#57F287');

        if (guild.premiumTier > 0) {
          embed.addFields({
            name: '💎 Boost Status',
            value: `**Tier:** ${guild.premiumTier}\n**Boosts:** ${guild.premiumSubscriptionCount || 0}`,
            inline: true
          });
        }

        if (guild.banner) {
          embed.setImage(guild.bannerURL({ size: 1024 }));
        }

        embed.addFields({
          name: '🤖 Bot Presence',
          value: formatBotPresence(presenceInfo),
          inline: false
        });

        // Update cache with fresh data
        try {
          await pool.execute(`
            INSERT INTO guilds (guild_id, guild_name, owner_id, icon_hash, member_count, last_seen)
            VALUES (?, ?, ?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE
              guild_name = VALUES(guild_name),
              owner_id = VALUES(owner_id),
              icon_hash = VALUES(icon_hash),
              member_count = VALUES(member_count),
              last_seen = NOW()
          `, [guild.id, guild.name, owner?.id || null, guild.icon, guild.memberCount]);
        } catch (cacheErr) {
          // Silently fail cache update
        }

        return interaction.editReply({ embeds: [embed] });
      }
    } catch (fetchError) {
      // Bot is not in the guild - try alternative methods
    }

    // Try guild preview (only works for discoverable guilds)
    try {
      const preview = await interaction.client.rest.get(`/guilds/${guildId}/preview`);

      if (preview) {
        embed
          .setTitle(`🔍 Server Preview: ${preview.name}`)
          .setThumbnail(preview.icon ? `https://cdn.discordapp.com/icons/${guildId}/${preview.icon}.png?size=256` : null)
          .setDescription(preview.description || 'No description')
          .addFields(
            { name: '📋 Server ID', value: guildId, inline: false },
            { name: '📅 Created', value: `<t:${Math.floor(createdAt.getTime() / 1000)}:F>\n(<t:${Math.floor(createdAt.getTime() / 1000)}:R>)`, inline: false },
            { name: '👥 Approximate Members', value: preview.approximate_member_count?.toLocaleString() || 'Unknown', inline: true },
            { name: '🟢 Online', value: preview.approximate_presence_count?.toLocaleString() || 'Unknown', inline: true },
            { name: '😀 Emojis', value: preview.emojis?.length?.toString() || '0', inline: true }
          )
          .setColor('#FEE75C');

        if (preview.features?.length > 0) {
          embed.addFields({
            name: '✨ Features',
            value: preview.features.slice(0, 10).map(f => `\`${f}\``).join(', '),
            inline: false
          });
        }

        embed.addFields({
          name: '🤖 Bot Presence',
          value: formatBotPresence(presenceInfo),
          inline: false
        });

        return interaction.editReply({ embeds: [embed] });
      }
    } catch (previewError) {
      // Preview not available
    }

    // Try widget (only works if widget is enabled)
    try {
      const response = await fetch(`https://discord.com/api/guilds/${guildId}/widget.json`);
      if (response.ok) {
        const widget = await response.json();

        embed
          .setTitle(`🔍 Server Widget: ${widget.name}`)
          .addFields(
            { name: '📋 Server ID', value: guildId, inline: false },
            { name: '📅 Created', value: `<t:${Math.floor(createdAt.getTime() / 1000)}:F>\n(<t:${Math.floor(createdAt.getTime() / 1000)}:R>)`, inline: false },
            { name: '🟢 Online Members', value: widget.presence_count?.toString() || 'Unknown', inline: true },
            { name: '🔊 Voice Channels', value: widget.channels?.length?.toString() || '0', inline: true }
          )
          .setColor('#FEE75C');

        embed.addFields({
          name: '🤖 Bot Presence',
          value: formatBotPresence(presenceInfo),
          inline: false
        });

        return interaction.editReply({ embeds: [embed] });
      }
    } catch (widgetError) {
      // Widget not available
    }

    // Try database cache (historical data from when bot was a member)
    try {
      if (pool) {
        const [rows] = await pool.execute(
          'SELECT guild_name, owner_id, icon_hash, member_count, last_seen FROM guilds WHERE guild_id = ?',
          [guildId]
        );

        if (rows.length > 0 && rows[0].guild_name) {
          const cached = rows[0];
          const owner = cached.owner_id ? await interaction.client.users.fetch(cached.owner_id).catch(() => null) : null;

          embed
            .setTitle(`🔍 Server Lookup: ${cached.guild_name}`)
            .setDescription('⚠️ **Cached data** - Default bot is no longer a member of this server')
            .setThumbnail(cached.icon_hash ? `https://cdn.discordapp.com/icons/${guildId}/${cached.icon_hash}.png?size=256` : null)
            .addFields(
              { name: '📋 Server ID', value: guildId, inline: false },
              { name: '👑 Owner', value: owner ? `${owner.tag} (${cached.owner_id})` : cached.owner_id || 'Unknown', inline: false },
              { name: '📅 Created', value: `<t:${Math.floor(createdAt.getTime() / 1000)}:F>\n(<t:${Math.floor(createdAt.getTime() / 1000)}:R>)`, inline: false },
              { name: '👥 Members (cached)', value: cached.member_count?.toLocaleString() || 'Unknown', inline: true },
              { name: '📆 Last Seen', value: cached.last_seen ? `<t:${Math.floor(new Date(cached.last_seen).getTime() / 1000)}:R>` : 'Unknown', inline: true }
            )
            .setColor('#FFA500');

          embed.addFields({
            name: '🤖 Bot Presence',
            value: formatBotPresence(presenceInfo) + '\n📦 Showing cached historical data',
            inline: false
          });

          return interaction.editReply({ embeds: [embed] });
        }
      }
    } catch (cacheError) {
      // Cache lookup failed, continue to snowflake-only response
    }

    // No data available - show only what we can derive from the snowflake
    embed
      .setTitle('🔍 Server Lookup')
      .setDescription('Limited information available - bot is not a member and server has no public data.')
      .addFields(
        { name: '📋 Server ID', value: guildId, inline: false },
        { name: '📅 Created', value: `<t:${Math.floor(createdAt.getTime() / 1000)}:F>\n(<t:${Math.floor(createdAt.getTime() / 1000)}:R>)`, inline: false },
        { name: '⏱️ Age', value: `${Math.floor((Date.now() - timestamp) / (1000 * 60 * 60 * 24))} days`, inline: true }
      )
      .setColor('#ED4245')
      .addFields({
        name: '🤖 Bot Presence',
        value: formatBotPresence(presenceInfo) + '\n\n❌ Server Discovery disabled\n❌ Server Widget disabled\n❌ No cached data available',
        inline: false
      });

    return interaction.editReply({ embeds: [embed] });
  },

  // Stats overview handler
  async handleStatsOverview(interaction) {
    const guild = interaction.guild;

    // Get current stats
    const members = await guild.members.fetch();
    const bots = members.filter(m => m.user.bot).size;
    const humans = members.size - bots;
    const online = members.filter(m => m.presence?.status && m.presence.status !== 'offline').size;

    const channels = guild.channels.cache;
    const textChannels = channels.filter(c => c.isTextBased()).size;
    const voiceChannels = channels.filter(c => c.isVoiceBased()).size;

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(`📊 ${guild.name} Statistics`)
      .setThumbnail(guild.iconURL())
      .addFields(
        { name: '👥 Total Members', value: members.size.toLocaleString(), inline: true },
        { name: '🤖 Bots', value: bots.toLocaleString(), inline: true },
        { name: '🟢 Online', value: online.toLocaleString(), inline: true },
        { name: '💬 Text Channels', value: textChannels.toString(), inline: true },
        { name: '🔊 Voice Channels', value: voiceChannels.toString(), inline: true },
        { name: '🎭 Roles', value: guild.roles.cache.size.toString(), inline: true },
        { name: '😀 Emojis', value: guild.emojis.cache.size.toString(), inline: true },
        { name: '🎨 Stickers', value: guild.stickers.cache.size.toString(), inline: true },
        { name: '💎 Boost Level', value: `Level ${guild.premiumTier}`, inline: true }
      )
      .setFooter({ text: `Server ID: ${guild.id}` })
      .setTimestamp();

    if (guild.premiumSubscriptionCount > 0) {
      embed.addFields({
        name: '⚡ Boosts',
        value: guild.premiumSubscriptionCount.toString(),
        inline: true
      });
    }

    return interaction.editReply({ embeds: [embed] });
  },

  // Stats growth handler
  async handleStatsGrowth(interaction, serverStatsManager) {
    const days = interaction.options.getInteger('days') || 30;
    const snapshots = await serverStatsManager.getGrowthStats(interaction.guild.id, days);

    if (snapshots.length === 0) {
      return interaction.editReply({
        content: 'No growth data available yet. Statistics are collected daily.'
      });
    }

    const earliest = snapshots[0];
    const latest = snapshots[snapshots.length - 1];
    const memberGrowth = latest.member_count - earliest.member_count;
    const growthPercent = ((memberGrowth / earliest.member_count) * 100).toFixed(1);

    const embed = new EmbedBuilder()
      .setColor('#57F287')
      .setTitle(`📈 Server Growth (Last ${days} Days)`)
      .addFields(
        { name: 'Current Members', value: latest.member_count.toLocaleString(), inline: true },
        { name: 'Net Growth', value: `${memberGrowth > 0 ? '+' : ''}${memberGrowth}`, inline: true },
        { name: 'Growth Rate', value: `${growthPercent}%`, inline: true },
        { name: '👥 Humans', value: latest.human_count.toLocaleString(), inline: true },
        { name: '🤖 Bots', value: latest.bot_count.toLocaleString(), inline: true },
        { name: '💬 Channels', value: latest.channel_count.toString(), inline: true }
      )
      .setTimestamp();

    // Show trend
    if (snapshots.length >= 7) {
      const recentSnapshots = snapshots.slice(-7);
      const trendText = recentSnapshots.map(s =>
        `${s.snapshot_date}: ${s.member_count} members`
      ).join('\n');

      embed.addFields({
        name: 'Recent Trend',
        value: trendText.length > 1024 ? trendText.substring(0, 1021) + '...' : trendText
      });
    }

    return interaction.editReply({ embeds: [embed] });
  },

  // Stats activity handler
  async handleStatsActivity(interaction, serverStatsManager) {
    const days = interaction.options.getInteger('days') || 7;
    const stats = await serverStatsManager.getActivityStats(interaction.guild.id, days);

    if (stats.length === 0) {
      return interaction.editReply({
        content: 'No activity data available yet.'
      });
    }

    const totalMessages = stats.reduce((sum, s) => sum + s.messages_sent, 0);
    const totalCommands = stats.reduce((sum, s) => sum + s.commands_used, 0);
    const totalJoins = stats.reduce((sum, s) => sum + s.members_joined, 0);
    const totalLeaves = stats.reduce((sum, s) => sum + s.members_left, 0);
    const avgMessagesPerDay = Math.floor(totalMessages / stats.length);

    const embed = new EmbedBuilder()
      .setColor('#FEE75C')
      .setTitle(`📊 Server Activity (Last ${days} Days)`)
      .addFields(
        { name: '💬 Total Messages', value: totalMessages.toLocaleString(), inline: true },
        { name: '⚙️ Commands Used', value: totalCommands.toLocaleString(), inline: true },
        { name: '📈 Avg/Day', value: avgMessagesPerDay.toLocaleString(), inline: true },
        { name: '➕ Members Joined', value: totalJoins.toString(), inline: true },
        { name: '➖ Members Left', value: totalLeaves.toString(), inline: true },
        { name: '📊 Net Change', value: `${totalJoins - totalLeaves > 0 ? '+' : ''}${totalJoins - totalLeaves}`, inline: true }
      )
      .setTimestamp();

    // Show daily breakdown
    if (stats.length <= 7) {
      const dailyText = stats.map(s =>
        `${s.stat_date}: ${s.messages_sent} messages, ${s.commands_used} commands`
      ).join('\n');

      embed.addFields({
        name: 'Daily Breakdown',
        value: dailyText.length > 1024 ? dailyText.substring(0, 1021) + '...' : dailyText
      });
    }

    return interaction.editReply({ embeds: [embed] });
  },

  // Stats top users handler
  async handleStatsTopUsers(interaction, serverStatsManager) {
    const days = interaction.options.getInteger('days') || 7;
    const topUsers = await serverStatsManager.getTopMessageUsers(interaction.guild.id, days, 10);

    if (topUsers.length === 0) {
      return interaction.editReply({
        content: 'No user activity data available yet.'
      });
    }

    const embed = new EmbedBuilder()
      .setColor('#EB459E')
      .setTitle(`👥 Most Active Users (Last ${days} Days)`)
      .setTimestamp();

    const userList = await Promise.all(
      topUsers.map(async (userData, index) => {
        const user = await interaction.client.users.fetch(userData.user_id).catch(() => null);
        const username = user ? user.username : 'Unknown User';
        const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `**${index + 1}.**`;

        return `${medal} **${username}**\n` +
               `└ ${userData.total_messages.toLocaleString()} messages | ${userData.total_words.toLocaleString()} words`;
      })
    );

    embed.setDescription(userList.join('\n\n'));

    return interaction.editReply({ embeds: [embed] });
  },

  // Stats top channels handler
  async handleStatsTopChannels(interaction, serverStatsManager) {
    const days = interaction.options.getInteger('days') || 7;
    const topChannels = await serverStatsManager.getTopChannels(interaction.guild.id, days, 10);

    if (topChannels.length === 0) {
      return interaction.editReply({
        content: 'No channel activity data available yet.'
      });
    }

    const embed = new EmbedBuilder()
      .setColor('#3BA55D')
      .setTitle(`💬 Most Active Channels (Last ${days} Days)`)
      .setTimestamp();

    const channelList = topChannels.map((channelData, index) => {
      const channel = interaction.guild.channels.cache.get(channelData.channel_id);
      const channelName = channel ? channel.name : 'Unknown Channel';
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `**${index + 1}.**`;

      return `${medal} ${channel ? `<#${channel.id}>` : channelName}\n` +
             `└ ${channelData.total_messages.toLocaleString()} messages`;
    }).join('\n\n');

    embed.setDescription(channelList);

    return interaction.editReply({ embeds: [embed] });
  },

  // Stats peak hours handler
  async handleStatsPeakHours(interaction, serverStatsManager) {
    const peakHours = await serverStatsManager.getPeakHours(interaction.guild.id);

    if (peakHours.length === 0) {
      return interaction.editReply({
        content: 'No peak activity data available yet.'
      });
    }

    const embed = new EmbedBuilder()
      .setColor('#ED4245')
      .setTitle('⏰ Peak Activity Times')
      .setDescription('Times when the server is most active')
      .setTimestamp();

    const peakList = peakHours.slice(0, 10).map((peak, index) => {
      const day = serverStatsManager.formatDayOfWeek(peak.day_of_week);
      const hour = serverStatsManager.formatHour(peak.hour_of_day);

      return `**${index + 1}.** ${day}s at ${hour}\n` +
             `└ ${peak.message_count.toLocaleString()} messages`;
    }).join('\n\n');

    embed.setDescription(peakList);

    return interaction.editReply({ embeds: [embed] });
  }
};
