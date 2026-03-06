import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { EmbedBuilder } from 'discord.js';

class GiveawayManager {
  constructor(client) {
    this.client = client;
    logger.info('[GiveawayManager] Giveaway manager initialized');
  }

  async checkGiveaways() {
    try {
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

  async endGiveaway(giveaway, isReroll) {
    const guildId = giveaway.guild_id;

    try {
      const guild = this.client.guilds.cache.get(guildId);

      if (!guild) {
        logger.warn(`[GiveawayManager] Guild not found for giveaway ${giveaway.id}. Marking as inactive.`, {
          guildId
        });
        await pool.execute('UPDATE giveaways SET is_active = 0 WHERE id = ?', [giveaway.id]);
        return;
      }

      const channel = await guild.channels.fetch(giveaway.channel_id).catch(() => null);

      if (!channel) {
        logger.warn(`[GiveawayManager] Channel not found for giveaway ${giveaway.id}. Marking as inactive.`, {
          guildId
        });
        await pool.execute('UPDATE giveaways SET is_active = 0 WHERE id = ?', [giveaway.id]);
        return;
      }

      const message = await channel.messages.fetch(giveaway.message_id).catch(() => null);

      if (!message) {
        logger.warn(`[GiveawayManager] Message not found for giveaway ${giveaway.id}. Marking as inactive.`, {
          guildId
        });
        await pool.execute('UPDATE giveaways SET is_active = 0 WHERE id = ?', [giveaway.id]);
        return;
      }

      const reaction = message.reactions.cache.get('🎉');

      if (!reaction) {
        await channel.send(`The giveaway for **${giveaway.prize}** ended with no entries.`);
        await pool.execute('UPDATE giveaways SET is_active = 0 WHERE id = ?', [giveaway.id]);
        logger.info(`[GiveawayManager] Giveaway ${giveaway.id} ended with no reactions.`, {
          guildId
        });
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

    } catch (error) {
      logger.error(`[GiveawayManager] Error ending giveaway ${giveaway.id}.`, {
        guildId,
        error: error.stack
      });
    }
  }

  async createGiveaway(guildId, channelId, hostId, prize, winnerCount, duration) {
    try {
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) throw new Error('Guild not found');

      const channel = guild.channels.cache.get(channelId);
      if (!channel) throw new Error('Channel not found');

      const endsAt = new Date(Date.now() + duration * 1000);
      const host = await guild.members.fetch(hostId);

      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🎉 GIVEAWAY 🎉')
        .setDescription(`Prize: **${prize}**\nWinners: **${winnerCount}**\nReact with 🎉 to enter!`)
        .addFields({ name: 'Ends', value: `<t:${Math.floor(endsAt.getTime() / 1000)}:R>` })
        .setFooter({ text: `Hosted by ${host.user.username}`, iconURL: host.user.displayAvatarURL() })
        .setTimestamp();

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

  async cancelGiveaway(giveawayId) {
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
              .setColor('#E74C3C')
              .setDescription(`**Giveaway Cancelled**\nThis giveaway has been cancelled by a moderator.`);
            await message.edit({ embeds: [cancelledEmbed], components: [] });
          }
        }
      }

      logger.info(`[GiveawayManager] Cancelled giveaway ${giveawayId}`);
      return true;
    } catch (error) {
      logger.error(`[GiveawayManager] Failed to cancel giveaway: ${error.message}`);
      return false;
    }
  }
}

export default GiveawayManager;
