import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { displayNameFor } from '../utils/display-name.js';
import { EmbedBuilder } from 'discord.js';
import { themeColor } from './guild-theme.js';
import { logFeatureEvent, userLabel } from './feature-log.js';

class GiveawayManager {
  constructor(client) {
    this.client = client;
    logger.info('[GiveawayManager] Giveaway manager initialized');
  }

  async checkGiveaways() {
    try {
      // Cleanup stale giveaways that no bot could end (e.g., bot left guild)
      await pool.execute(
        'UPDATE giveaways SET is_active = 0 WHERE is_active = 1 AND ends_at <= DATE_SUB(NOW(), INTERVAL 7 DAY)'
      );

      const [activeGiveaways] = await pool.execute(
        'SELECT * FROM giveaways WHERE is_active = 1 AND ends_at <= NOW()'
      );

      if (activeGiveaways.length === 0) return;

      logger.info(`[GiveawayManager] Found ${activeGiveaways.length} giveaways to end.`);

      for (const giveaway of activeGiveaways) {
        await this.endGiveaway(giveaway, false);
      }
    } catch (error) {
      logger.error('[GiveawayManager] Error checking for giveaways to end.', {
        error: error.stack
      });
    }
  }

  /**
   * @param {Object|null} [actor=null] who ended/rerolled it (User/GuildMember/id) — null = the scheduler ('Automatic')
   */
  async endGiveaway(giveaway, isReroll, actor = null) {
    const guildId = giveaway.guild_id;

    try {
      const guild = this.client.guilds.cache.get(guildId);

      if (!guild) {
        logger.debug(`[GiveawayManager] Guild ${guildId} not in cache for bot — skipping giveaway ${giveaway.id}`);
        return; // Don't mark inactive — another bot may handle this guild
      }

      const channel = await guild.channels.fetch(giveaway.channel_id).catch(() => null);

      if (!channel) {
        logger.debug(`[GiveawayManager] Channel not found for giveaway ${giveaway.id} in guild ${guildId} — skipping`);
        return; // Don't mark inactive — channel may be accessible to another bot
      }

      const message = await channel.messages.fetch(giveaway.message_id).catch(() => null);

      if (!message) {
        logger.debug(`[GiveawayManager] Message not found for giveaway ${giveaway.id} in guild ${guildId} — skipping`);
        return; // Don't mark inactive — message may be accessible to another bot
      }

      const reaction = message.reactions.cache.get('🎉');

      if (!reaction) {
        await channel.send(`The giveaway for **${giveaway.prize}** ended with no entries.`);
        await pool.execute('UPDATE giveaways SET is_active = 0 WHERE id = ?', [giveaway.id]);
        logger.info(`[GiveawayManager] Giveaway ${giveaway.id} ended with no reactions.`, {
          guildId
        });
        void logFeatureEvent(() => (guild), 'giveaway.noEntries', () => ({
          title: '🎉 Giveaway Ended (No Entries)',
          fields: [['Prize', giveaway.prize], ['Channel', `<#${channel.id}>`], [isReroll ? 'Rerolled By' : 'Ended By', userLabel(actor)]],
          url: message.url,
          avoidChannelIds: [channel.id],
        }));
        return;
      }

      const users = await reaction.users.fetch();
      const entrants = users.filter(user => !user.bot);

      if (entrants.size === 0) {
        await channel.send(`The giveaway for **${giveaway.prize}** ended with no entries.`);
        await pool.execute('UPDATE giveaways SET is_active = 0 WHERE id = ?', [giveaway.id]);
        logger.info(`[GiveawayManager] Giveaway ${giveaway.id} ended with no valid entries.`, {
          guildId
        });
        void logFeatureEvent(() => (guild), 'giveaway.noEntries', () => ({
          title: '🎉 Giveaway Ended (No Entries)',
          fields: [['Prize', giveaway.prize], ['Channel', `<#${channel.id}>`], [isReroll ? 'Rerolled By' : 'Ended By', userLabel(actor)]],
          url: message.url,
          avoidChannelIds: [channel.id],
        }));
        return;
      }

      const winners = entrants.random(giveaway.winner_count);
      const winnersArray = Array.isArray(winners) ? winners : [winners];
      const winnerMentions = winnersArray.map(u => u.toString()).join(', ');

      const resultMessage = isReroll
        ? `A new winner has been drawn! Congratulations ${winnerMentions}!`
        : `Congratulations ${winnerMentions}! You won the **${giveaway.prize}**!`;

      await channel.send({
        content: resultMessage,
        reply: { messageReference: message }
      });

      // Update the original giveaway embed
      const endedEmbed = EmbedBuilder.from(message.embeds[0])
        .setColor('#95A5A6')
        .setDescription(`Giveaway has ended.\n\n**Winner(s):** ${winnerMentions}`)
        .setFields([]); // Clear old fields

      await message.edit({ embeds: [endedEmbed], components: [] });

      // Update the database
      await pool.execute(
        'UPDATE giveaways SET is_active = 0, winners = ? WHERE id = ?',
        [JSON.stringify(winnersArray.map(u => u.id)), giveaway.id]
      );

      logger.info(`[GiveawayManager] ${isReroll ? 'Rerolled' : 'Ended'} giveaway ${giveaway.id}. Winners: ${winnersArray.map(u => u.tag).join(', ')}`, {
        guildId
      });

      void logFeatureEvent(() => (guild), () => (isReroll ? 'giveaway.rerolled' : 'giveaway.ended'), () => ({
        title: isReroll ? '🔄 Giveaway Rerolled' : '🏆 Giveaway Ended',
        fields: [
          ['Prize', giveaway.prize], [winnersArray.length === 1 ? 'Winner' : 'Winners', winnerMentions],
          ['Entries', entrants.size], ['Channel', `<#${channel.id}>`], [isReroll ? 'Rerolled By' : 'Ended By', userLabel(actor)],
        ],
        url: message.url,
        avoidChannelIds: [channel.id],
      }));

    } catch (error) {
      logger.error(`[GiveawayManager] Error ending giveaway ${giveaway.id}.`, {
        guildId,
        error: error.stack
      });
    }
  }

  /**
   * options.description: optional details shown in a "Details" field above "Ends" (up to 1000
   * characters; the field stays on the post when the giveaway ends).
   */
  async createGiveaway(guildId, channelId, hostId, prize, winnerCount, duration, options = {}) {
    try {
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) throw new Error('Guild not found');

      const channel = guild.channels.cache.get(channelId);
      if (!channel) throw new Error('Channel not found');

      const endsAt = new Date(Date.now() + duration * 1000);
      const host = await guild.members.fetch(hostId);

      const embed = new EmbedBuilder()
        .setColor(themeColor(guildId, 'primary'))
        .setTitle('🎉 GIVEAWAY 🎉')
        .setDescription(`Prize: **${prize}**\nWinners: **${winnerCount}**\nReact with 🎉 to enter!`)
        .addFields({ name: 'Ends', value: `<t:${Math.floor(endsAt.getTime() / 1000)}:R>` })
        .setFooter({ text: `Hosted by ${displayNameFor(host)}`, iconURL: host.user.displayAvatarURL() })
        .setTimestamp();
      const details = typeof options?.description === 'string' ? options.description.trim().slice(0, 1000) : '';
      if (details) embed.spliceFields(0, 0, { name: 'Details', value: details });

      const message = await channel.send({ embeds: [embed] });
      await message.react('🎉');

      const [result] = await pool.execute(
        'INSERT INTO giveaways (guild_id, channel_id, message_id, prize, winner_count, ends_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [guildId, channelId, message.id, prize, winnerCount, endsAt, hostId]
      );

      logger.info(`[GiveawayManager] Created giveaway "${prize}" in guild ${guildId}`, {
        guildId,
        giveawayId: result.insertId
      });

      void logFeatureEvent(() => (guild), 'giveaway.started', () => ({
        title: '🎉 Giveaway Started',
        fields: [
          ['Prize', prize], ['Winners', winnerCount], ['Host', userLabel(host)],
          ['Channel', `<#${channel.id}>`], ['Ends', `<t:${Math.floor(endsAt.getTime() / 1000)}:R>`],
        ],
        url: message.url,
        avoidChannelIds: [channel.id],
      }));

      return { giveawayId: result.insertId, messageId: message.id };
    } catch (error) {
      logger.error(`[GiveawayManager] Failed to create giveaway: ${error.message}`);
      throw error;
    }
  }

  async getActiveGiveaways(guildId) {
    try {
      const [giveaways] = await pool.execute(
        'SELECT * FROM giveaways WHERE guild_id = ? AND is_active = 1 ORDER BY ends_at ASC',
        [guildId]
      );
      return giveaways;
    } catch (error) {
      logger.error(`[GiveawayManager] Failed to get active giveaways: ${error.message}`);
      return [];
    }
  }

  async getGiveawayByMessageId(messageId) {
    try {
      const [[giveaway]] = await pool.execute(
        'SELECT * FROM giveaways WHERE message_id = ?',
        [messageId]
      );
      return giveaway || null;
    } catch (error) {
      logger.error(`[GiveawayManager] Failed to get giveaway: ${error.message}`);
      return null;
    }
  }

  /**
   * @param {Object|null} [actor=null] who cancelled it (User/GuildMember/id); null = 'Automatic'
   */
  async cancelGiveaway(giveawayId, actor = null) {
    try {
      const [[giveaway]] = await pool.execute(
        'SELECT * FROM giveaways WHERE id = ? AND is_active = 1',
        [giveawayId]
      );

      if (!giveaway) return false;

      await pool.execute('UPDATE giveaways SET is_active = 0 WHERE id = ?', [giveawayId]);

      const guild = this.client.guilds.cache.get(giveaway.guild_id);
      if (guild) {
        const channel = await guild.channels.fetch(giveaway.channel_id).catch(() => null);
        if (channel) {
          const message = await channel.messages.fetch(giveaway.message_id).catch(() => null);
          if (message) {
            const cancelledEmbed = EmbedBuilder.from(message.embeds[0])
              .setColor(themeColor(message.guild?.id, 'danger'))
              .setDescription(`**Giveaway Cancelled**\nThis giveaway has been cancelled by a moderator.`);
            await message.edit({ embeds: [cancelledEmbed], components: [] });
          }
        }
      }

      logger.info(`[GiveawayManager] Cancelled giveaway ${giveawayId}`);
      void logFeatureEvent(() => (guild), 'giveaway.cancelled', () => ({
        title: '🚫 Giveaway Cancelled',
        fields: [['Prize', giveaway.prize], ['Channel', `<#${giveaway.channel_id}>`], ['Cancelled By', userLabel(actor)]],
        url: `https://discord.com/channels/${giveaway.guild_id}/${giveaway.channel_id}/${giveaway.message_id}`,
        avoidChannelIds: [giveaway.channel_id],
      }));
      return true;
    } catch (error) {
      logger.error(`[GiveawayManager] Failed to cancel giveaway: ${error.message}`);
      return false;
    }
  }
}

export default GiveawayManager;
