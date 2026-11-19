import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { logMemberNicknameUpdate, logMemberRoleUpdate, sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { assignAutoroles } from '../core/greeting-manager.js';
import { onRolesAdded as checkAutoroleRequirement } from '../core/autoroles.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import { snapshotMember as snapshotStickyRoles } from '../core/sticky-roles-manager.js';
import { noteRoleChange as noteProtectionRoles } from '../core/protection-exempt.js';
import { onMemberUpdate as checkNameFilters } from '../core/name-filters.js';
import { onMemberUpdate as checkAvatarProtection } from '../core/avatar-protection.js';
import { onMemberUpdate as stopVerificationClock } from '../core/verification.js';
import { onMemberUpdate as stopAutoPruneClock } from '../core/auto-prune.js';
import { syncMuteRole } from '../core/mute-role.js';
import {
  getConfig as getTempAccessConfig, startTrial, markExempt, hasPendingTrial, postLog as postTempAccessLog,
} from '../core/temp-access-manager.js';

/**
 * Roles are the whole state machine for temporary access:
 *
 *   + the temp role            -> start a trial (this is the "give someone the
 *                                 role by hand" path, equivalent to the invite)
 *   + any role we didn't grant -> somebody adopted them; the trial is over and
 *                                 they keep their access
 *
 * The access roles this system hands out (e.g. the guild's @Verified gate) are
 * excluded from the second rule for an obvious reason: granting them is the
 * first thing `startTrial` does, and counting our own grant as adoption would
 * cancel every trial the instant it began.
 */
async function handleTempAccessRoles(oldMember, newMember) {
  try {
    if (newMember.user?.bot) return;

    const added = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id));
    if (!added.size) return;

    const cfg = await getTempAccessConfig(newMember.guild.id);
    if (!cfg?.enabled) return;

    if (cfg.temp_role_id && added.has(cfg.temp_role_id)) {
      await startTrial(newMember, { source: 'role', cfg });
      return;
    }

    if (!hasPendingTrial(newMember.guild.id, newMember.id)) return;

    const ours = new Set([cfg.temp_role_id, ...cfg.accessRoleIds].filter(Boolean));
    const adopted = added.find(r => !ours.has(r.id));
    if (!adopted) return;

    await markExempt(newMember.guild.id, newMember.id, `received role: ${adopted.name}`);
    await postTempAccessLog(newMember.guild, cfg, 'exempt', newMember.id, `was given ${adopted.name}`);
  } catch (error) {
    logger.error('[GuildMemberUpdate] Temporary-access role handling failed', {
      error: error.message, guildId: newMember.guild?.id, userId: newMember.id
    });
  }
}

export default {
  name: Events.GuildMemberUpdate,
  async execute(oldMember, newMember) {
    try {
      // Only the default bot should ignore guilds with custom bots
      if (newMember.client.isDefaultBot && await shouldIgnoreGuild(newMember.guild.id)) return;

      // Sticky roles: keep a snapshot of the member's roles so a departure the cache missed can
      // still be restored. Role changes only, sticky-enabled guilds only; never throws.
      snapshotStickyRoles(newMember, oldMember);

      // Protection allowlist: someone losing an allowlisted role is recorded first, so they keep
      // their exemption (the "once held an allowlisted role" rule). Never throws.
      void noteProtectionRoles(oldMember, newMember);

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
        await assignAutoroles(newMember, { source: 'screening' });
      }

      // Mute role (Moderation page): given while the member is timed out, by anyone, and taken away
      // when the timeout is lifted early; a timeout that runs out ends its temp_roles timer
      // (core/mute-role.js). Never throws; does nothing unless the timeout changed and a role is set.
      await syncMuteRole(oldMember, newMember);

      // Name filters: a new server nickname is checked against the server's filters, and staff
      // role or name changes keep Auto-Pilot's protected names current (core/name-filters.js).
      // Never throws; does nothing in servers without name checks.
      await checkNameFilters(oldMember, newMember);

      // Avatar protection: a new server avatar is checked against the protected images and the scam
      // avatars, and staff changes keep Auto-Pilot's protected avatars current (core/avatar-protection.js).
      // Never throws; does nothing in servers without avatar protection.
      await checkAvatarProtection(oldMember, newMember);

      // Temporary access is decided entirely by which roles a member holds, so
      // this runs before the logging calls below — a role change is the event
      // that both starts a trial and ends one.
      await handleTempAccessRoles(oldMember, newMember);

      // Autoroles with required roles: someone who has just been given one now qualifies for the
      // join roles (core/autoroles.js). Never throws; one cached config read when roles were added.
      await checkAutoroleRequirement(oldMember, newMember);

      // Deadline queue: a real role takes a member off the auto-prune clock, the Verified role off the
      // CAPTCHA clock. Memory-only checks for everyone not on a clock; never throw.
      await stopAutoPruneClock(oldMember, newMember);
      await stopVerificationClock(oldMember, newMember);

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

          await sendLogEmbed(newMember.guild, 'memberTimeout', embed, 'memberTimeout.applied');

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

          await sendLogEmbed(newMember.guild, 'memberTimeout', embed, 'memberTimeout.removed');

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

        await sendLogEmbed(newMember.guild, 'memberUpdate', embed, 'memberUpdate.avatar');

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
