import { Events, EmbedBuilder } from 'discord.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import logger from '../utils/logger.js';
import { sendLogEmbed } from '../core/log-manager.js';

export default {
  name: Events.MessageReactionRemove,
  async execute(reaction, user) {
    try {
      // Ignore bot reactions
      if (user.bot) return;

      // Handle starboard reaction removal
      if (reaction.client.starboardManager) {
        await reaction.client.starboardManager.handleReactionRemove(reaction, user);
      }

      // Handle reaction role removal
      if (reaction.client.reactionRoleManager) {
        await reaction.client.reactionRoleManager.handleReactionRemove(reaction, user);
      }

      // Log reaction removal (only if message is from a guild)
      if (reaction.message.guild) {
        // Fetch partial data if needed
        if (reaction.partial) {
          try {
            await reaction.fetch();
          } catch (fetchError) {
            logger.debug('[MessageReactionRemove] Could not fetch partial reaction');
            return;
          }
        }

        const emoji = reaction.emoji.id ? `<:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name;
        const messageContent = reaction.message.content ? reaction.message.content.substring(0, 100) : '[No content]';
        const messageAuthor = reaction.message.author ? `${reaction.message.author.tag}` : 'Unknown';

        const embed = new EmbedBuilder()
          .setColor(0xED4245) // Red
          .setTitle('➖ Reaction Removed')
          .setDescription(`${user} removed ${emoji} from a message in ${reaction.message.channel}`)
          .addFields(
            { name: 'User', value: `${user.tag} (${user.id})`, inline: true },
            { name: 'Channel', value: `${reaction.message.channel.name}`, inline: true },
            { name: 'Emoji', value: emoji, inline: true },
            { name: 'Message Author', value: messageAuthor, inline: true },
            { name: 'Message', value: messageContent, inline: false }
          )
          .setTimestamp();

        await sendLogEmbed(reaction.message.guild, 'reactionRemove', embed);
      }
    } catch (error) {
      logger.error('[MessageReactionRemove] Error handling reaction removal', {
        error: error.message,
        stack: error.stack,
        messageId: reaction.message.id,
        userId: user.id
      });
    }
  }
};
