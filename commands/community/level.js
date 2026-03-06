import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';
import { generateRankCard } from '../../utils/rank-card-generator.js';
import pool from '../../utils/db.js';

export default {
  data: new SlashCommandBuilder()
    .setName('level')
    .setDescription('Level and XP system commands')
    .addSubcommand(subcommand =>
      subcommand
        .setName('rank')
        .setDescription('View your or another user\'s rank card')
        .addUserOption(option =>
          option
            .setName('user')
            .setDescription('The user to check (defaults to you)')
            .setRequired(false)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('leaderboard')
        .setDescription('View the server XP leaderboard')
        .addIntegerOption(option =>
          option
            .setName('page')
            .setDescription('Page number')
            .setRequired(false)
            .setMinValue(1)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('setup')
        .setDescription('Configure the leveling system (Admin)')
        .addBooleanOption(option =>
          option
            .setName('enabled')
            .setDescription('Enable or disable the leveling system')
            .setRequired(false)
        )
        .addIntegerOption(option =>
          option
            .setName('xp_per_message')
            .setDescription('Base XP per message')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(100)
        )
        .addIntegerOption(option =>
          option
            .setName('cooldown')
            .setDescription('Cooldown in seconds between XP gains')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(300)
        )
        .addChannelOption(option =>
          option
            .setName('level_up_channel')
            .setDescription('Channel for level up announcements (leave empty for current channel)')
            .setRequired(false)
        )
        .addStringOption(option =>
          option
            .setName('level_up_message')
            .setDescription('Custom level up message. Use {user}, {level}, {username}')
            .setRequired(false)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('set-xp')
        .setDescription('Set a user\'s total XP (Admin)')
        .addUserOption(option =>
          option
            .setName('user')
            .setDescription('The user')
            .setRequired(true)
        )
        .addIntegerOption(option =>
          option
            .setName('amount')
            .setDescription('Total XP amount')
            .setRequired(true)
            .setMinValue(0)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('add-xp')
        .setDescription('Add XP to a user (Admin)')
        .addUserOption(option =>
          option
            .setName('user')
            .setDescription('The user')
            .setRequired(true)
        )
        .addIntegerOption(option =>
          option
            .setName('amount')
            .setDescription('XP amount to add')
            .setRequired(true)
            .setMinValue(1)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('remove-xp')
        .setDescription('Remove XP from a user (Admin)')
        .addUserOption(option =>
          option
            .setName('user')
            .setDescription('The user')
            .setRequired(true)
        )
        .addIntegerOption(option =>
          option
            .setName('amount')
            .setDescription('XP amount to remove')
            .setRequired(true)
            .setMinValue(1)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('reset')
        .setDescription('Reset levels (Admin)')
        .addUserOption(option =>
          option
            .setName('user')
            .setDescription('User to reset (leave empty to reset entire server)')
            .setRequired(false)
        )
    )
    .addSubcommandGroup(group =>
      group
        .setName('role-reward')
        .setDescription('Manage role rewards for levels')
        .addSubcommand(subcommand =>
          subcommand
            .setName('add')
            .setDescription('Add a role reward for reaching a level (Admin)')
            .addIntegerOption(option =>
              option
                .setName('level')
                .setDescription('The level to grant the role at')
                .setRequired(true)
                .setMinValue(1)
            )
            .addRoleOption(option =>
              option
                .setName('role')
                .setDescription('The role to grant')
                .setRequired(true)
            )
        )
        .addSubcommand(subcommand =>
          subcommand
            .setName('remove')
            .setDescription('Remove a role reward (Admin)')
            .addIntegerOption(option =>
              option
                .setName('level')
                .setDescription('The level to remove the reward from')
                .setRequired(true)
                .setMinValue(1)
            )
        )
        .addSubcommand(subcommand =>
          subcommand
            .setName('list')
            .setDescription('List all role rewards')
        )
    ),

  async execute(interaction) {
    const levelingManager = interaction.client.levelingManager;

    if (!levelingManager) {
      return interaction.reply({
        content: 'The leveling system is not available.',
        ephemeral: true
      });
    }

    const subcommandGroup = interaction.options.getSubcommandGroup();
    const subcommand = interaction.options.getSubcommand();

    try {
      // Handle role-reward subcommand group
      if (subcommandGroup === 'role-reward') {
        return await this.handleRoleReward(interaction, levelingManager, subcommand);
      }

      // Handle other subcommands
      switch (subcommand) {
        case 'rank':
          await this.handleRank(interaction, levelingManager);
          break;
        case 'leaderboard':
          await this.handleLeaderboard(interaction, levelingManager);
          break;
        case 'setup':
          await this.handleSetup(interaction, levelingManager);
          break;
        case 'set-xp':
          await this.handleSetXP(interaction, levelingManager);
          break;
        case 'add-xp':
          await this.handleAddXP(interaction, levelingManager);
          break;
        case 'remove-xp':
          await this.handleRemoveXP(interaction, levelingManager);
          break;
        case 'reset':
          await this.handleReset(interaction, levelingManager);
          break;
        default:
          await interaction.reply({
            content: 'Unknown subcommand.',
            ephemeral: true
          });
      }
    } catch (error) {
      console.error('[Level Command Error]', error);
      const replyMethod = interaction.deferred || interaction.replied ? 'editReply' : 'reply';
      await interaction[replyMethod]({
        content: 'An error occurred while processing this command.',
        ephemeral: true
      }).catch(() => {});
    }
  },

  async handleRank(interaction, levelingManager) {
    const user = interaction.options.getUser('user') || interaction.user;
    await interaction.deferReply();

    const rankData = await levelingManager.getUserRank(interaction.guild.id, user.id);

    if (!rankData) {
      return interaction.editReply({
        content: 'Failed to retrieve rank data.',
        ephemeral: true
      });
    }

    try {
      // Generate rank card
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);

      // Fetch rank card customization
      const [customRows] = await pool.execute(
        'SELECT * FROM rank_card_settings WHERE guild_id = ? AND user_id = ?',
        [interaction.guild.id, user.id]
      );
      const customization = customRows.length > 0 ? customRows[0] : null;

      const rankCard = await generateRankCard(user, rankData, member, customization);

      const attachment = new AttachmentBuilder(rankCard, { name: 'rank-card.png' });

      await interaction.editReply({ files: [attachment] });
    } catch (error) {
      console.error('[Rank Card Error]', error);
      // Fallback to text-based rank display
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`${user.username}'s Rank`)
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'Level', value: `${rankData.level}`, inline: true },
          { name: 'Rank', value: `#${rankData.rank}`, inline: true },
          { name: 'XP', value: `${rankData.xp}/${rankData.xpForNextLevel}`, inline: true },
          { name: 'Total XP', value: `${rankData.totalXP}`, inline: true },
          { name: 'Voice Time', value: levelingManager.formatVoiceTime(rankData.totalVoiceMinutes), inline: true },
          { name: 'Voice XP', value: `${rankData.voiceXP}`, inline: true }
        )
        .setFooter({ text: `${Math.floor((rankData.xp / rankData.xpForNextLevel) * 100)}% to next level` });

      await interaction.editReply({ embeds: [embed] });
    }
  },

  async handleLeaderboard(interaction, levelingManager) {
    const page = interaction.options.getInteger('page') || 1;
    await interaction.deferReply();

    const leaderboard = await levelingManager.getLeaderboard(interaction.guild.id, page, 10);

    if (!leaderboard || leaderboard.users.length === 0) {
      return interaction.editReply({
        content: 'No users found on the leaderboard.',
        ephemeral: true
      });
    }

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle(`${interaction.guild.name} - XP Leaderboard`)
      .setDescription(`Showing page ${page} of ${leaderboard.totalPages}`)
      .setFooter({ text: `Total users: ${leaderboard.totalUsers}` });

    let description = '';
    const startRank = (page - 1) * 10;

    for (let i = 0; i < leaderboard.users.length; i++) {
      const userData = leaderboard.users[i];
      const rank = startRank + i + 1;
      const medal = rank === 1 ? ':first_place:' : rank === 2 ? ':second_place:' : rank === 3 ? ':third_place:' : `${rank}.`;

      try {
        const user = await interaction.client.users.fetch(userData.user_id).catch(() => null);
        const username = user ? user.username : `Unknown User (${userData.user_id})`;
        const totalXP = levelingManager.getTotalXP(userData.level, userData.xp);

        description += `${medal} **${username}** - Level ${userData.level} (${totalXP} total XP)\n`;
      } catch (error) {
        description += `${medal} Unknown User - Level ${userData.level}\n`;
      }
    }

    embed.setDescription(description);

    const dashboardUrl = process.env.DASHBOARD_URL?.replace(/\/$/, '') || 'https://certifriedmultitool.com';
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('View Full Leaderboard')
        .setStyle(ButtonStyle.Link)
        .setURL(`${dashboardUrl}/lb/${interaction.guild.id}`)
    );

    await interaction.editReply({ embeds: [embed], components: [row] });
  },

  async handleSetup(interaction, levelingManager) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: 'You need the **Manage Server** permission to use this command.',
        ephemeral: true
      });
    }

    const enabled = interaction.options.getBoolean('enabled');
    const xpPerMessage = interaction.options.getInteger('xp_per_message');
    const cooldown = interaction.options.getInteger('cooldown');
    const levelUpChannel = interaction.options.getChannel('level_up_channel');
    const levelUpMessage = interaction.options.getString('level_up_message');

    if (enabled === null && !xpPerMessage && !cooldown && !levelUpChannel && !levelUpMessage) {
      // Show current config
      const config = await levelingManager.getConfig(interaction.guild.id);

      const embed = new EmbedBuilder()
        .setColor(config.enabled ? '#00FF00' : '#FF0000')
        .setTitle('Leveling System Configuration')
        .setDescription(config.enabled ? '✅ **Status:** Enabled' : '❌ **Status:** Disabled')
        .addFields(
          { name: 'XP per Message', value: `${config.xp_per_message}`, inline: true },
          { name: 'Cooldown', value: `${config.xp_cooldown_seconds}s`, inline: true },
          { name: 'Voice XP Enabled', value: config.voice_xp_enabled ? 'Yes' : 'No', inline: true },
          { name: 'Level Up Channel', value: config.level_up_channel_id ? `<#${config.level_up_channel_id}>` : 'Current channel', inline: true },
          { name: 'Weekend Multiplier', value: `${config.xp_multiplier_weekends}x`, inline: true },
          { name: 'Level Up Message', value: config.level_up_message, inline: false }
        )
        .setFooter({ text: 'Use /level setup enabled:true to enable the leveling system' });

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const currentConfig = await levelingManager.getConfig(interaction.guild.id);
    const newConfig = {
      enabled: enabled !== null ? enabled : currentConfig.enabled,
      xp_per_message: xpPerMessage || currentConfig.xp_per_message,
      xp_cooldown_seconds: cooldown || currentConfig.xp_cooldown_seconds,
      level_up_channel_id: levelUpChannel ? levelUpChannel.id : currentConfig.level_up_channel_id,
      level_up_message: levelUpMessage || currentConfig.level_up_message,
      xp_per_voice_minute: currentConfig.xp_per_voice_minute,
      voice_xp_enabled: currentConfig.voice_xp_enabled,
      xp_multiplier_weekends: currentConfig.xp_multiplier_weekends,
      xp_multiplier_events: currentConfig.xp_multiplier_events
    };

    const success = await levelingManager.updateConfig(interaction.guild.id, newConfig);

    if (success) {
      const embed = new EmbedBuilder()
        .setColor(enabled === false ? '#FF0000' : '#00FF00')
        .setTitle(enabled === false ? '❌ Leveling System Disabled' : '✅ Configuration Updated')
        .setDescription(
          enabled === false
            ? 'The leveling system has been disabled. Users will no longer gain XP or levels.'
            : enabled === true
            ? 'The leveling system has been enabled! Users will now gain XP from messages.'
            : 'The leveling system configuration has been updated successfully.'
        );

      if (enabled !== null) {
        embed.addFields({ name: 'Status', value: enabled ? '✅ Enabled' : '❌ Disabled', inline: true });
      }
      if (xpPerMessage) {
        embed.addFields({ name: 'XP per Message', value: `${xpPerMessage}`, inline: true });
      }
      if (cooldown) {
        embed.addFields({ name: 'Cooldown', value: `${cooldown}s`, inline: true });
      }
      if (levelUpChannel) {
        embed.addFields({ name: 'Level Up Channel', value: `<#${levelUpChannel.id}>`, inline: true });
      }
      if (levelUpMessage) {
        embed.addFields({ name: 'Level Up Message', value: levelUpMessage, inline: false });
      }

      await interaction.editReply({ embeds: [embed] });
    } else {
      await interaction.editReply({
        content: 'Failed to update configuration. Please try again later.'
      });
    }
  },

  async handleSetXP(interaction, levelingManager) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: 'You need the **Manage Server** permission to use this command.',
        ephemeral: true
      });
    }

    const user = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');

    await interaction.deferReply({ ephemeral: true });

    const result = await levelingManager.setXP(interaction.guild.id, user.id, amount);

    if (result) {
      await interaction.editReply({
        content: `Successfully set ${user.username}'s XP to ${amount} (Level ${result.level}, ${result.xp} XP).`
      });
    } else {
      await interaction.editReply({
        content: 'Failed to set XP. Please try again later.'
      });
    }
  },

  async handleAddXP(interaction, levelingManager) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: 'You need the **Manage Server** permission to use this command.',
        ephemeral: true
      });
    }

    const user = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');

    await interaction.deferReply({ ephemeral: true });

    const oldLevel = await levelingManager.addXP(interaction.guild.id, user.id, amount);
    const rankData = await levelingManager.getUserRank(interaction.guild.id, user.id);

    if (rankData) {
      await interaction.editReply({
        content: `Successfully added ${amount} XP to ${user.username}. They are now Level ${rankData.level} with ${rankData.xp} XP.`
      });
    } else {
      await interaction.editReply({
        content: 'Failed to add XP. Please try again later.'
      });
    }
  },

  async handleRemoveXP(interaction, levelingManager) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: 'You need the **Manage Server** permission to use this command.',
        ephemeral: true
      });
    }

    const user = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');

    await interaction.deferReply({ ephemeral: true });

    const result = await levelingManager.removeXP(interaction.guild.id, user.id, amount);

    if (result) {
      await interaction.editReply({
        content: `Successfully removed ${amount} XP from ${user.username}. They are now Level ${result.level} with ${result.xp} XP.`
      });
    } else {
      await interaction.editReply({
        content: 'Failed to remove XP or user not found.'
      });
    }
  },

  async handleReset(interaction, levelingManager) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({
        content: 'You need the **Administrator** permission to use this command.',
        ephemeral: true
      });
    }

    const user = interaction.options.getUser('user');

    await interaction.deferReply({ ephemeral: true });

    if (user) {
      const success = await levelingManager.resetUser(interaction.guild.id, user.id);
      if (success) {
        await interaction.editReply({
          content: `Successfully reset ${user.username}'s level and XP.`
        });
      } else {
        await interaction.editReply({
          content: 'Failed to reset user levels.'
        });
      }
    } else {
      // Confirm before resetting entire server
      await interaction.editReply({
        content: 'Are you sure you want to reset ALL levels in this server? This action cannot be undone! Use this command again with a specific user to confirm, or contact a developer to perform a full reset.'
      });
    }
  },

  async handleRoleReward(interaction, levelingManager, subcommand) {
    if (subcommand === 'list') {
      await interaction.deferReply();

      const rewards = await levelingManager.getRoleRewards(interaction.guild.id);

      if (rewards.length === 0) {
        return interaction.editReply({
          content: 'No role rewards have been configured for this server.',
          ephemeral: true
        });
      }

      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('Level Role Rewards')
        .setDescription('Users will receive these roles when reaching the specified levels:');

      for (const reward of rewards) {
        const role = interaction.guild.roles.cache.get(reward.role_id);
        const roleName = role ? role.name : 'Unknown Role';
        embed.addFields({
          name: `Level ${reward.level}`,
          value: role ? `${role}` : roleName,
          inline: true
        });
      }

      return interaction.editReply({ embeds: [embed] });
    }

    // Check permissions for add/remove
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return interaction.reply({
        content: 'You need the **Manage Roles** permission to use this command.',
        ephemeral: true
      });
    }

    if (subcommand === 'add') {
      const level = interaction.options.getInteger('level');
      const role = interaction.options.getRole('role');

      await interaction.deferReply({ ephemeral: true });

      const success = await levelingManager.addRoleReward(interaction.guild.id, level, role.id);

      if (success) {
        await interaction.editReply({
          content: `Successfully added ${role} as a reward for reaching Level ${level}.`
        });
      } else {
        await interaction.editReply({
          content: 'Failed to add role reward. Please try again later.'
        });
      }
    } else if (subcommand === 'remove') {
      const level = interaction.options.getInteger('level');

      await interaction.deferReply({ ephemeral: true });

      const success = await levelingManager.removeRoleReward(interaction.guild.id, level);

      if (success) {
        await interaction.editReply({
          content: `Successfully removed the role reward for Level ${level}.`
        });
      } else {
        await interaction.editReply({
          content: 'Failed to remove role reward or no reward found for that level.'
        });
      }
    }
  },

  category: 'community'
};
