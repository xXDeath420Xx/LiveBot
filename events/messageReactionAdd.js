import { Events, EmbedBuilder } from 'discord.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import logger from '../utils/logger.js';
import { sendLogEmbed } from '../core/log-manager.js';

export default {
  name: Events.MessageReactionAdd,
  async execute(reaction, user) {
    try {
      // Ignore bot reactions
      if (user.bot) return;

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
          .setColor(0x57F287) // Green
          .setTitle('➕ Reaction Added')
          .setDescription(`${user} added ${emoji} to a message in ${reaction.message.channel}`)
          .addFields(
            { name: 'User', value: `${user.tag} (${user.id})`, inline: true },
            { name: 'Channel', value: `${reaction.message.channel.name}`, inline: true },
            { name: 'Emoji', value: emoji, inline: true },
            { name: 'Message Author', value: messageAuthor, inline: true },
            { name: 'Message', value: messageContent, inline: false }
          )
          .setTimestamp();

        await sendLogEmbed(reaction.message.guild, 'reactionAdd', embed);
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
