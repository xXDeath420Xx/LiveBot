import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { logMemberNicknameUpdate, logMemberRoleUpdate, sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { assignAutoroles } from '../core/greeting-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
  name: Events.GuildMemberUpdate,
  async execute(oldMember, newMember) {
    try {
      // Only the default bot should ignore guilds with custom bots
      if (newMember.client.isDefaultBot && await shouldIgnoreGuild(newMember.guild.id)) return;

      // Handle partial members
      if (oldMember.partial) {
        try {
          await oldMember.fetch();
        } catch (error) {
          logger.debug('[GuildMemberUpdate] Failed to fetch partial old member', {
            userId: oldMember.id
          });
          return;
        }
      }

      if (newMember.partial) {
        try {
          await newMember.fetch();
        } catch (error) {
          logger.debug('[GuildMemberUpdate] Failed to fetch partial new member', {
            userId: newMember.id
          });
          return;
        }
      }

      // Check if member completed rules screening (pending -> not pending)
      if (oldMember.pending === true && newMember.pending === false) {
        logger.info(`Member ${newMember.user.tag} completed rules screening`, {
          guildId: newMember.guild.id,
          userId: newMember.id,
          category: 'greeting'
        });

        // Assign autoroles now that they've accepted the rules
        await assignAutoroles(newMember);
      }

      // Log nickname changes
      await logMemberNicknameUpdate(oldMember, newMember);

      // Log role changes
      await logMemberRoleUpdate(oldMember, newMember);

      // Log timeout changes
      if (oldMember.communicationDisabledUntilTimestamp !== newMember.communicationDisabledUntilTimestamp) {
        if (newMember.communicationDisabledUntilTimestamp) {
          // Member was timed out
          const timeoutUntil = Math.floor(newMember.communicationDisabledUntilTimestamp / 1000);

          const embed = new EmbedBuilder()
            .setColor(0xFEE75C) // Yellow
            .setTitle('⏱️ Member Timed Out')
            .setDescription(`${newMember} was timed out`)
            .addFields(
              { name: 'User', value: `${newMember.user.tag} (${newMember.id})`, inline: true },
              { name: 'Timeout Until', value: `<t:${timeoutUntil}:F> (<t:${timeoutUntil}:R>)`, inline: false }
            )
            .setTimestamp();

          await sendLogEmbed(newMember.guild, 'memberTimeout', embed);

          await saveAuditLog(
            newMember.guild.id,
            'MEMBER_TIMEOUT',
            null,
            newMember.id,
            null,
            null,
            'Member timed out',
            null,
            null,
            JSON.stringify({ timeoutUntil: newMember.communicationDisabledUntilTimestamp })
          );
        } else {
          // Timeout was removed
          const embed = new EmbedBuilder()
            .setColor(0x57F287) // Green
            .setTitle('✅ Timeout Removed')
            .setDescription(`${newMember}'s timeout was removed`)
            .addFields(
              { name: 'User', value: `${newMember.user.tag} (${newMember.id})`, inline: true }
            )
            .setTimestamp();

          await sendLogEmbed(newMember.guild, 'memberTimeout', embed);

          await saveAuditLog(
            newMember.guild.id,
            'MEMBER_TIMEOUT_REMOVE',
            null,
            newMember.id,
            null,
            null,
            'Timeout removed',
            null,
            null,
            null
          );
        }
      }

      // Log avatar changes (guild-specific avatars)
      if (oldMember.avatar !== newMember.avatar) {
        const oldAvatarUrl = oldMember.avatar ? oldMember.displayAvatarURL({ dynamic: true, size: 256 }) : 'None';
        const newAvatarUrl = newMember.avatar ? newMember.displayAvatarURL({ dynamic: true, size: 256 }) : 'None';

        const embed = new EmbedBuilder()
          .setColor(0x5865F2) // Blurple
          .setTitle('🖼️ Server Avatar Changed')
          .setDescription(`${newMember} changed their server avatar`)
          .addFields(
            { name: 'User', value: `${newMember.user.tag} (${newMember.id})`, inline: false }
          )
          .setTimestamp();

        if (newMember.avatar) {
          embed.setThumbnail(newAvatarUrl);
        }

        await sendLogEmbed(newMember.guild, 'memberUpdate', embed);

        await saveAuditLog(
          newMember.guild.id,
          'MEMBER_AVATAR_UPDATE',
          null,
          newMember.id,
          null,
          null,
          'Server avatar changed',
          null,
          oldAvatarUrl,
          newAvatarUrl
        );
      }
    } catch (error) {
      logger.error('[GuildMemberUpdate] Error logging member update', {
        error: error.message,
        stack: error.stack,
        guildId: newMember.guild?.id,
        userId: newMember.id
      });
    }
  }
};
