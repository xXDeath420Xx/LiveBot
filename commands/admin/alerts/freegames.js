import { EmbedBuilder } from 'discord.js';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { triggerManualCheck } from '../../../jobs/free-games-scheduler.js';
import { themeColor } from '../../../core/guild-theme.js';

export async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case 'subscribe':
      await freeGamesSubscribe(interaction);
      break;
    case 'unsubscribe':
      await freeGamesUnsubscribe(interaction);
      break;
    case 'list':
      await freeGamesList(interaction);
      break;
    case 'filters':
      await freeGamesFilters(interaction);
      break;
    case 'check':
      await freeGamesCheck(interaction);
      break;
    case 'current':
      await freeGamesCurrent(interaction);
      break;
  }
}

async function freeGamesSubscribe(interaction) {
  await interaction.deferReply();

  const channel = interaction.options.getChannel('channel');
  const mentionRole = interaction.options.getRole('mention-role');
  const customMessage = interaction.options.getString('custom-message');

  try {
    const [existing] = await pool.execute(
      'SELECT id FROM free_games_subscriptions WHERE guild_id = ? AND discord_channel_id = ?',
      [interaction.guild.id, channel.id]
    );

    if (existing.length > 0) {
      return interaction.editReply({
        content: `A subscription already exists for ${channel}.\n\nUse \`/alerts freegames filters\` to configure it or \`/alerts freegames unsubscribe\` to remove it.`
      });
    }

    await pool.execute(
      `INSERT INTO free_games_subscriptions (
        guild_id, discord_channel_id, mention_role_id, custom_message,
        notify_free, notify_weekend, notify_dlc,
        filter_steam, filter_epic, filter_gog, filter_prime,
        filter_windows, is_enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        interaction.guild.id,
        channel.id,
        mentionRole?.id || null,
        customMessage || null,
        true,  // notify_free
        false, // notify_weekend
        false, // notify_dlc
        true,  // filter_steam
        true,  // filter_epic
        true,  // filter_gog
        true,  // filter_prime
        true,  // filter_windows
        true   // is_enabled
      ]
    );

    const embed = new EmbedBuilder()
      .setColor(themeColor(interaction.guildId, 'success'))
      .setTitle('Free Game Notifications Enabled')
      .setDescription(`You'll now receive free game notifications in ${channel}`)
      .addFields(
        { name: 'Channel', value: `${channel}`, inline: true },
        { name: 'Mention Role', value: mentionRole ? `${mentionRole}` : 'None', inline: true },
        { name: 'Stores', value: 'Steam, Epic Games, GOG, Prime Gaming', inline: false },
        { name: 'Platforms', value: 'Windows', inline: true },
        { name: 'Types', value: 'Free to Keep Only', inline: true }
      )
      .setFooter({ text: 'Use /alerts freegames filters to customize your preferences' })
      .setTimestamp();

    if (customMessage) {
      embed.addFields({ name: 'Custom Message', value: customMessage, inline: false });
    }

    await interaction.editReply({ embeds: [embed] });
    logger.info(`[FreeGames] Subscription created for guild ${interaction.guild.id} in channel ${channel.id}`);

  } catch (error) {
    logger.error('[FreeGames Subscribe] Error:', { error: error.message, stack: error.stack, guildId: interaction.guild.id });
    await interaction.editReply({ content: 'An error occurred while creating the subscription. Please try again.' });
  }
}

async function freeGamesUnsubscribe(interaction) {
  await interaction.deferReply();

  const channel = interaction.options.getChannel('channel');

  try {
    const [result] = await pool.execute(
      'DELETE FROM free_games_subscriptions WHERE guild_id = ? AND discord_channel_id = ?',
      [interaction.guild.id, channel.id]
    );

    if (result.affectedRows === 0) {
      return interaction.editReply({ content: `No subscription found for ${channel}.` });
    }

    await interaction.editReply({ content: `Free game notifications have been disabled for ${channel}.` });
    logger.info(`[FreeGames] Subscription removed for guild ${interaction.guild.id} in channel ${channel.id}`);

  } catch (error) {
    logger.error('[FreeGames Unsubscribe] Error:', { error: error.message, stack: error.stack, guildId: interaction.guild.id });
    await interaction.editReply({ content: 'An error occurred while removing the subscription. Please try again.' });
  }
}

async function freeGamesList(interaction) {
  await interaction.deferReply();

  try {
    const [subscriptions] = await pool.execute(
      'SELECT * FROM free_games_subscriptions WHERE guild_id = ? ORDER BY created_at DESC',
      [interaction.guild.id]
    );

    if (subscriptions.length === 0) {
      return interaction.editReply({
        content: 'No free game subscriptions configured.\n\nUse `/alerts freegames subscribe` to set one up!'
      });
    }

    const embed = new EmbedBuilder()
      .setColor(themeColor(interaction.guildId, 'accent'))
      .setTitle('Free Game Subscriptions')
      .setDescription(`**${subscriptions.length}** subscription(s) configured`)
      .setTimestamp();

    for (const sub of subscriptions) {
      const channel = await interaction.guild.channels.fetch(sub.discord_channel_id).catch(() => null);
      const channelMention = channel ? `<#${sub.discord_channel_id}>` : 'Channel not found';

      // Only what a live scraper can emit. The GamerPower aggregator was the sole source of
      // Ubisoft, EA/Origin, itch.io, Humble, Battle.net, "other" and every console/mobile
      // platform; it was removed, so listing those toggles would report settings that cannot
      // affect a single notification.
      const stores = [
        ['filter_steam', 'Steam'], ['filter_epic', 'Epic'], ['filter_gog', 'GOG'],
        ['filter_prime', 'Prime Gaming'],
      ].filter(([col]) => sub[col]).map(([, label]) => label);

      const platforms = [
        ['filter_windows', 'Windows'], ['filter_mac', 'Mac'], ['filter_linux', 'Linux'],
      ].filter(([col]) => sub[col]).map(([, label]) => label);

      const types = [];
      if (sub.notify_free) types.push('Free to Keep');
      if (sub.notify_weekend) types.push('Free Weekend');
      if (sub.notify_dlc) types.push('DLC');

      let fieldValue = `**Channel:** ${channelMention}\n`;
      fieldValue += `**Status:** ${sub.is_enabled ? 'Enabled' : 'Disabled'}\n`;
      fieldValue += `**Stores:** ${stores.join(', ') || 'None'}\n`;
      fieldValue += `**Platforms:** ${platforms.join(', ') || 'None'}\n`;
      fieldValue += `**Types:** ${types.join(', ') || 'None'}`;

      embed.addFields({ name: `Subscription #${sub.id}`, value: fieldValue, inline: false });
    }

    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    logger.error('[FreeGames List] Error:', { error: error.message, stack: error.stack, guildId: interaction.guild.id });
    await interaction.editReply({ content: 'An error occurred while fetching subscriptions. Please try again.' });
  }
}

async function freeGamesFilters(interaction) {
  await interaction.deferReply();

  const channel = interaction.options.getChannel('channel');
  const storesStr = interaction.options.getString('stores');
  const platformsStr = interaction.options.getString('platforms');
  const freeToKeep = interaction.options.getBoolean('free-to-keep');
  const freeWeekend = interaction.options.getBoolean('free-weekend');
  const dlc = interaction.options.getBoolean('dlc');

  try {
    const [existing] = await pool.execute(
      'SELECT id FROM free_games_subscriptions WHERE guild_id = ? AND discord_channel_id = ?',
      [interaction.guild.id, channel.id]
    );

    if (existing.length === 0) {
      return interaction.editReply({
        content: `No subscription found for ${channel}.\n\nUse \`/alerts freegames subscribe\` to create one first.`
      });
    }

    const updates = [];
    const values = [];

    // A named store/platform sets its column to 1 and everything unnamed in the same group
    // to 0, so `stores:steam,epic` means exactly those two.
    //
    // These lists are the stores and platforms a live scraper can actually produce, NOT every
    // column the schema has. The GamerPower aggregator that fed the rest was removed, so
    // accepting `stores:itch` here would set a column nothing ever reads and report success.
    const STORE_COLUMNS = {
      steam: 'filter_steam', epic: 'filter_epic', gog: 'filter_gog',
      prime: 'filter_prime',
    };
    const PLATFORM_COLUMNS = {
      windows: 'filter_windows', mac: 'filter_mac', linux: 'filter_linux',
    };

    /** Apply a comma-separated selection to every column in its group. */
    function applyGroup(input, columnMap) {
      const chosen = new Set(input.toLowerCase().split(',').map(s => s.trim()).filter(Boolean));
      const unknown = [...chosen].filter(c => !columnMap[c]);
      // Every distinct column in the group, since aliases (ea/origin, ps/playstation) collide.
      for (const col of new Set(Object.values(columnMap))) {
        const on = [...chosen].some(c => columnMap[c] === col);
        updates.push(`${col} = ?`);
        values.push(on ? 1 : 0);
      }
      return unknown;
    }

    const unknownNames = [];
    if (storesStr !== null) unknownNames.push(...applyGroup(storesStr, STORE_COLUMNS));
    if (platformsStr !== null) unknownNames.push(...applyGroup(platformsStr, PLATFORM_COLUMNS));

    if (unknownNames.length) {
      return interaction.editReply({
        content: `I do not recognise: ${unknownNames.map(u => `\`${u}\``).join(', ')}\n\n` +
          `**Stores:** ${[...new Set(Object.keys(STORE_COLUMNS))].join(', ')}\n` +
          `**Platforms:** ${[...new Set(Object.keys(PLATFORM_COLUMNS))].join(', ')}\n\n` +
          'Nothing was changed.'
      });
    }

    if (freeToKeep !== null) {
      updates.push('notify_free = ?');
      values.push(freeToKeep ? 1 : 0);
    }

    if (freeWeekend !== null) {
      updates.push('notify_weekend = ?');
      values.push(freeWeekend ? 1 : 0);
    }

    if (dlc !== null) {
      updates.push('notify_dlc = ?');
      values.push(dlc ? 1 : 0);
    }

    if (updates.length === 0) {
      return interaction.editReply({ content: 'No filters provided. Please specify at least one filter option.' });
    }

    values.push(interaction.guild.id, channel.id);

    await pool.execute(
      `UPDATE free_games_subscriptions SET ${updates.join(', ')} WHERE guild_id = ? AND discord_channel_id = ?`,
      values
    );

    await interaction.editReply({
      content: `Filters updated for ${channel}!\n\nUse \`/alerts freegames list\` to see your current configuration.`
    });

    logger.info(`[FreeGames] Filters updated for guild ${interaction.guild.id} in channel ${channel.id}`);

  } catch (error) {
    logger.error('[FreeGames Filters] Error:', { error: error.message, stack: error.stack, guildId: interaction.guild.id });
    await interaction.editReply({ content: 'An error occurred while updating filters. Please try again.' });
  }
}

async function freeGamesCheck(interaction) {
  await interaction.deferReply();

  try {
    await interaction.editReply('Checking for new free games...');
    await triggerManualCheck();
    await interaction.editReply('Check complete! Any new free games will be announced shortly.');

  } catch (error) {
    logger.error('[FreeGames Check] Error:', { error: error.message, stack: error.stack });
    await interaction.editReply({ content: 'An error occurred while checking for free games. Please try again later.' });
  }
}

async function freeGamesCurrent(interaction) {
  await interaction.deferReply();

  try {
    const [products] = await pool.execute(
      `SELECT * FROM free_games_products
       WHERE is_active = 1
       AND (until_date IS NULL OR until_date > NOW())
       ORDER BY created_at DESC
       LIMIT 25`
    );

    if (products.length === 0) {
      return interaction.editReply({
        content: 'No currently available free games found.\n\nRun `/alerts freegames check` to search for new games.'
      });
    }

    const embed = new EmbedBuilder()
      .setColor(themeColor(interaction.guildId, 'success'))
      .setTitle('Currently Available Free Games')
      .setDescription(`**${products.length}** free game(s) available right now`)
      .setTimestamp();

    for (const product of products) {
      const platforms = [];
      if (product.platform_windows) platforms.push('Windows');
      if (product.platform_mac) platforms.push('Mac');
      if (product.platform_linux) platforms.push('Linux');

      let fieldValue = `**Store:** ${product.store.toUpperCase()}\n`;
      fieldValue += `**Platforms:** ${platforms.join(', ')}\n`;
      fieldValue += `**Link:** [Get it now](${product.url})`;

      if (product.until_date) {
        const until = Math.floor(new Date(product.until_date).getTime() / 1000);
        fieldValue += `\n**Until:** <t:${until}:R>`;
      }

      embed.addFields({ name: product.title, value: fieldValue, inline: false });
    }

    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    logger.error('[FreeGames Current] Error:', { error: error.message, stack: error.stack });
    await interaction.editReply({ content: 'An error occurred while fetching current free games. Please try again.' });
  }
}
