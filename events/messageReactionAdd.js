import { Events, EmbedBuilder } from 'discord.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import logger from '../utils/logger.js';
import { sendLogEmbed } from '../core/log-manager.js';
import { handleTimeReaction } from '../core/timezone-manager.js';
import { updateChallengeProgress } from '../core/daily-challenges-manager.js';

export default {
  name: Events.MessageReactionAdd,
  // Discord passes `details` as a third arg since mid-2024, carrying `burst`
  // (true when the reaction was a Nitro super-reaction) + `burstColors[]`.
  async execute(reaction, user, details) {
    try {
      // Ignore bot reactions
      if (user.bot) return;

      // Was this a Nitro super-reaction? discord.js surfaces it via a third
      // arg on this event. Fall back to inspecting the reaction's own counts
      // when details isn't available (older gateway envelopes).
      const isBurst = !!details?.burst || (typeof reaction.countDetails?.burst === 'number' && reaction.countDetails.burst > 0 && reaction.countDetails.normal === 0);

      // 🕰️ on a time we detected — DM the clicker their conversion. Returning here also
      // keeps a bot-provided UI affordance out of the reaction log.
      if (await handleTimeReaction(reaction, user)) return;

      // Daily challenges: reactions given in a server
      if (reaction.message.guildId) {
        updateChallengeProgress(reaction.message.guildId, user.id, 'reactions', 1)
          .catch(err => logger.warn('[DailyChallenges] reactions progress failed', { error: err.message }));
      }

      // Handle starboard reactions
      if (reaction.client.starboardManager) {
        await reaction.client.starboardManager.handleReactionAdd(reaction, user);
      }

      // Handle reaction roles
      if (reaction.client.reactionRoleManager) {
        await reaction.client.reactionRoleManager.handleReactionAdd(reaction, user);
      }

      // Log reaction (only if message is from a guild)
      if (reaction.message.guild) {
        // Fetch partial data if needed
        if (reaction.partial) {
          try {
            await reaction.fetch();
          } catch (fetchError) {
            logger.debug('[MessageReactionAdd] Could not fetch partial reaction');
            return;
          }
        }

        const emoji = reaction.emoji.id ? `<:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name;
        const messageContent = reaction.message.content ? reaction.message.content.substring(0, 100) : '[No content]';
        const messageAuthor = reaction.message.author ? `${reaction.message.author.tag}` : 'Unknown';

        const embed = new EmbedBuilder()
          .setColor(isBurst ? 0xFFC83D : 0x57F287) // gold for burst, green for normal
          .setTitle(isBurst ? '✨ Super Reaction Added' : '➕ Reaction Added')
          .setDescription(`${user} added ${emoji}${isBurst ? ' *(super reaction)*' : ''} to a message in ${reaction.message.channel}`)
          .addFields(
            { name: 'User', value: `${user.tag} (${user.id})`, inline: true },
            { name: 'Channel', value: `${reaction.message.channel.name}`, inline: true },
            { name: 'Emoji', value: emoji, inline: true },
            { name: 'Message Author', value: messageAuthor, inline: true },
            { name: 'Type', value: isBurst ? 'Super (Nitro burst)' : 'Standard', inline: true },
            { name: 'Message', value: messageContent, inline: false }
          )
          .setTimestamp();

        await sendLogEmbed(reaction.message.guild, 'reactionAdd', embed, isBurst ? 'reactionAdd.burst' : 'reactionAdd.standard',
          { channel: reaction.message.channel, user, userId: user?.id });
      }
    } catch (error) {
      logger.error('[MessageReactionAdd] Error handling reaction', {
        error: error.message,
        stack: error.stack,
        messageId: reaction.message.id,
        userId: user.id
      });
    }
  }
};
