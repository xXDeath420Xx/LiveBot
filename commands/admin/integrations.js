import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { getTwitchUser } from '../../utils/platforms/twitch-api.js';
import { getTwitchScheduleManager } from '../../jobs/twitch-schedule-scheduler.js';

export default {
  category: 'admin',
  data: new SlashCommandBuilder()
    .setName('integrations')
    .setDescription('Manage third-party platform integrations')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommandGroup(group =>
      group
        .setName('twitch')
        .setDescription('Manage Twitch integrations')
        .addSubcommand(sub =>
          sub
            .setName('add')
            .setDescription('Add a Twitch streamer schedule sync')
            .addStringOption(option =>
              option.setName('streamer').setDescription('Twitch username of the streamer').setRequired(true)
            )
            .addChannelOption(option =>
              option.setName('channel').setDescription('Discord channel to post schedules in').addChannelTypes(ChannelType.GuildText).setRequired(true)
            )
            .addRoleOption(option =>
              option.setName('mention-role').setDescription('Role to mention when posting schedules (optional)')
            )
            .addStringOption(option =>
              option.setName('custom-message').setDescription('Custom message to include with schedule posts (optional)')
            )
        )
        .addSubcommand(sub =>
          sub
            .setName('remove')
            .setDescription('Remove a Twitch streamer schedule sync')
            .addStringOption(option =>
              option.setName('streamer').setDescription('Twitch username of the streamer to remove').setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub.setName('list').setDescription('List all configured Twitch schedule syncs')
        )
        .addSubcommand(sub =>
          sub
            .setName('sync')
            .setDescription('Force immediate sync of a streamer schedule')
            .addStringOption(option =>
              option.setName('streamer').setDescription('Twitch username to sync (optional, syncs all if not provided)')
            )
        )
    ),

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup();
    const subcommand = interaction.options.getSubcommand();

    if (group === 'twitch') {
      switch (subcommand) {
        case 'add':
          await this.twitchAdd(interaction);
          break;
        case 'remove':
          await this.twitchRemove(interaction);
          break;
        case 'list':
          await this.twitchList(interaction);
          break;
        case 'sync':
          await this.twitchSync(interaction);
          break;
      }
    }
  },

  async twitchList(interaction) {
    await interaction.deferReply();

    try {
      const [syncs] = await pool.execute(`
        SELECT
          tss.id,
          tss.streamer_id,
          tss.discord_channel_id,
          tss.mention_role_id,
          tss.custom_message,
          tss.is_enabled,
          tss.last_synced,
          s.username,
          s.profile_image_url
        FROM twitch_schedule_sync_config tss
        JOIN streamers s ON tss.streamer_id = s.streamer_id
        WHERE tss.guild_id = ? AND s.platform = 'twitch'
        ORDER BY s.username
      `, [interaction.guild.id]);

      if (syncs.length === 0) {
        return interaction.editReply({
          content: '📅 No Twitch schedule syncs configured for this server.\n\nUse `/integrations twitch add` to set one up!'
        });
      }

      const embed = new EmbedBuilder()
        .setColor('#9146FF')
        .setTitle('📅 Twitch Schedule Syncs')
        .setDescription(`**${syncs.length}** schedule sync(s) configured`)
        .setTimestamp();

      for (const sync of syncs) {
        const channel = await interaction.guild.channels.fetch(sync.discord_channel_id).catch(() => null);
        const channelMention = channel ? `<#${sync.discord_channel_id}>` : `⚠️ Channel not found`;

        const role = sync.mention_role_id
          ? (await interaction.guild.roles.fetch(sync.mention_role_id).catch(() => null))
          : null;
        const roleMention = role ? `<@&${sync.mention_role_id}>` : 'None';

        const lastSynced = sync.last_synced
          ? `<t:${Math.floor(new Date(sync.last_synced).getTime() / 1000)}:R>`
          : 'Never';

        const status = sync.is_enabled ? '✅ Enabled' : '❌ Disabled';

        let fieldValue = `**Channel:** ${channelMention}\n`;
        fieldValue += `**Mention Role:** ${roleMention}\n`;
        fieldValue += `**Status:** ${status}\n`;
        fieldValue += `**Last Synced:** ${lastSynced}`;

        if (sync.custom_message) {
          fieldValue += `\n**Custom Message:** ${sync.custom_message}`;
        }

        embed.addFields({ name: `🎮 ${sync.username}`, value: fieldValue, inline: false });
      }

      embed.setFooter({ text: 'Schedules are automatically synced every 6 hours' });

      await interaction.editReply({ embeds: [embed] });

    } catch (error) {
      logger.error('[Twitch Schedule List] Error:', { error: error.message, stack: error.stack, guildId: interaction.guild.id });
      await interaction.editReply({ content: '❌ An error occurred while fetching schedule syncs. Please try again.' });
    }
  },

  async twitchAdd(interaction) {
    await interaction.deferReply();

    const streamerUsername = interaction.options.getString('streamer').toLowerCase().trim();
    const channel = interaction.options.getChannel('channel');
    const mentionRole = interaction.options.getRole('mention-role');
    const customMessage = interaction.options.getString('custom-message');

    try {
      await interaction.editReply('🔍 Validating Twitch username...');

      const twitchUser = await getTwitchUser(streamerUsername);

      if (!twitchUser || !twitchUser.id) {
        return interaction.editReply({
          content: `❌ Twitch user **${streamerUsername}** not found. Please check the username and try again.`
        });
      }

      await interaction.editReply('📝 Checking streamer database...');

      let [streamers] = await pool.execute(
        'SELECT streamer_id, platform_user_id FROM streamers WHERE LOWER(username) = ? AND platform = ?',
        [streamerUsername, 'twitch']
      );

      let streamerId;

      if (streamers.length === 0) {
        const [result] = await pool.execute(
          `INSERT INTO streamers (username, platform, platform_user_id, profile_image_url)
           VALUES (?, 'twitch', ?, ?)`,
          [twitchUser.login, twitchUser.id, twitchUser.profile_image_url]
        );
        streamerId = result.insertId;
        logger.info(`[Integrations Twitch] Created new streamer record for ${twitchUser.login} (ID: ${streamerId})`);
      } else {
        streamerId = streamers[0].streamer_id;

        if (streamers[0].platform_user_id && streamers[0].platform_user_id.startsWith('temp_')) {
          await pool.execute(
            'UPDATE streamers SET platform_user_id = ?, profile_image_url = ? WHERE streamer_id = ?',
            [twitchUser.id, twitchUser.profile_image_url, streamerId]
          );
          logger.info(`[Integrations Twitch] Updated platform_user_id for ${twitchUser.login}`);
        }
      }

      const [existingSyncs] = await pool.execute(
        'SELECT id FROM twitch_schedule_sync_config WHERE guild_id = ? AND streamer_id = ?',
        [interaction.guild.id, streamerId]
      );

      if (existingSyncs.length > 0) {
        return interaction.editReply({
          content: `❌ A schedule sync for **${twitchUser.login}** already exists in this server.\n\nUse \`/integrations twitch remove ${twitchUser.login}\` to remove it first, or use the dashboard to edit it.`
        });
      }

      await interaction.editReply('✨ Creating schedule sync...');

      await pool.execute(
        `INSERT INTO twitch_schedule_sync_config
         (guild_id, streamer_id, discord_channel_id, mention_role_id, custom_message, is_enabled)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [
          interaction.guild.id,
          streamerId,
          channel.id,
          mentionRole?.id || null,
          customMessage || null
        ]
      );

      logger.info(`[Integrations Twitch] Created sync for ${twitchUser.login} in guild ${interaction.guild.id}`);

      const successEmbed = new EmbedBuilder()
        .setColor('#9146FF')
        .setTitle('✅ Schedule Sync Added')
        .setThumbnail(twitchUser.profile_image_url)
        .addFields(
          { name: 'Streamer', value: `🎮 **${twitchUser.display_name}** (${twitchUser.login})`, inline: false },
          { name: 'Channel', value: `<#${channel.id}>`, inline: true },
          { name: 'Mention Role', value: mentionRole ? `<@&${mentionRole.id}>` : 'None', inline: true }
        )
        .setDescription('Schedule will be automatically synced every 6 hours.')
        .setTimestamp();

      if (customMessage) {
        successEmbed.addFields({ name: 'Custom Message', value: customMessage, inline: false });
      }

      successEmbed.setFooter({ text: 'Use /integrations twitch sync to force an immediate sync' });

      await interaction.editReply({ content: null, embeds: [successEmbed] });

    } catch (error) {
      logger.error('[Integrations Twitch Add] Error:', { error: error.message, stack: error.stack, guildId: interaction.guild.id, streamer: streamerUsername });
      await interaction.editReply({ content: '❌ An error occurred while adding the schedule sync. Please try again.' });
    }
  },

  async twitchRemove(interaction) {
    await interaction.deferReply();

    const streamerUsername = interaction.options.getString('streamer').toLowerCase().trim();

    try {
      const [syncs] = await pool.execute(`
        SELECT tss.id, s.username, s.streamer_id
        FROM twitch_schedule_sync_config tss
        JOIN streamers s ON tss.streamer_id = s.streamer_id
        WHERE tss.guild_id = ? AND LOWER(s.username) = ? AND s.platform = 'twitch'
      `, [interaction.guild.id, streamerUsername]);

      if (syncs.length === 0) {
        return interaction.editReply({
          content: `❌ No schedule sync found for **${streamerUsername}** in this server.\n\nUse \`/integrations twitch list\` to see configured syncs.`
        });
      }

      const sync = syncs[0];

      await pool.execute('DELETE FROM twitch_schedule_sync_config WHERE id = ?', [sync.id]);

      logger.info(`[Integrations Twitch Remove] Removed sync for ${sync.username} in guild ${interaction.guild.id}`);

      await interaction.editReply({ content: `✅ Schedule sync for **${sync.username}** has been removed.` });

    } catch (error) {
      logger.error('[Integrations Twitch Remove] Error:', { error: error.message, stack: error.stack, guildId: interaction.guild.id, streamer: streamerUsername });
      await interaction.editReply({ content: '❌ An error occurred while removing the schedule sync. Please try again.' });
    }
  },

  async twitchSync(interaction) {
    await interaction.deferReply();

    const streamerUsername = interaction.options.getString('streamer')?.toLowerCase().trim();

    try {
      const manager = getTwitchScheduleManager(interaction.guild.id);

      if (!manager) {
        return interaction.editReply({ content: '❌ Schedule manager not available. Please try again later.' });
      }

      if (streamerUsername) {
        const [syncs] = await pool.execute(`
          SELECT
            tss.id,
            tss.guild_id,
            tss.streamer_id,
            tss.discord_channel_id,
            tss.mention_role_id,
            tss.custom_message,
            tss.last_synced,
            s.platform_user_id,
            s.username,
            s.profile_image_url
          FROM twitch_schedule_sync_config tss
          JOIN streamers s ON tss.streamer_id = s.streamer_id
          WHERE tss.guild_id = ? AND LOWER(s.username) = ? AND s.platform = 'twitch' AND tss.is_enabled = 1
        `, [interaction.guild.id, streamerUsername]);

        if (syncs.length === 0) {
          return interaction.editReply({
            content: `❌ No enabled schedule sync found for **${streamerUsername}** in this server.\n\nUse \`/integrations twitch list\` to see configured syncs.`
          });
        }

        await interaction.editReply(`🔄 Syncing schedule for **${syncs[0].username}**...`);

        await manager.syncSchedule(syncs[0]);

        await interaction.editReply({ content: `✅ Successfully synced schedule for **${syncs[0].username}**!` });

        logger.info(`[Integrations Twitch Sync] Manual sync for ${syncs[0].username} in guild ${interaction.guild.id}`);

      } else {
        await interaction.editReply('🔄 Syncing all schedules...');

        const syncs = await manager.getEnabledSyncs();
        const guildSyncs = syncs.filter(s => s.guild_id === interaction.guild.id);

        if (guildSyncs.length === 0) {
          return interaction.editReply({
            content: '📅 No enabled schedule syncs found for this server.\n\nUse `/integrations twitch add` to set one up!'
          });
        }

        for (const sync of guildSyncs) {
          await manager.syncSchedule(sync);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        await interaction.editReply({ content: `✅ Successfully synced **${guildSyncs.length}** schedule(s)!` });

        logger.info(`[Integrations Twitch Sync] Manual sync of ${guildSyncs.length} schedules in guild ${interaction.guild.id}`);
      }

    } catch (error) {
      logger.error('[Integrations Twitch Sync] Error:', { error: error.message, stack: error.stack, guildId: interaction.guild.id, streamer: streamerUsername });
      await interaction.editReply({ content: '❌ An error occurred while syncing schedules. Please check the logs or try again later.' });
    }
  }
};
