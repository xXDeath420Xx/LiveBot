import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { logMemberJoin } from '../core/log-manager.js';
import { handleGuildMemberAdd } from '../core/greeting-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import { getConfig as getTempAccessConfig, attributeJoin, startTrial } from '../core/temp-access-manager.js';
import { checkJoin as joinGateCheck, isRemoval as joinGateRemoved } from '../core/join-gate.js';
import { recordJoin } from '../core/join-history.js';
import { markReturned as markStreamerReturned } from '../core/streamer-departure.js';
import { restoreOnJoin as restoreStickyRoles } from '../core/sticky-roles-manager.js';
import { noteMemberActivity as noteStatRoleActivity } from '../core/statrole-manager.js';
import { enforceJoin as enforceRaidLockdown } from '../core/raid-lockdown.js';
import { onMemberJoin as startVerification } from '../core/verification.js';
import { onMemberJoin as startAutoPrune } from '../core/auto-prune.js';
import pool from '../utils/db.js';
import { observeFlags } from '../core/user-flag-observations.js';
import { recordNetworkJoin, recordNetworkJoinSnapshot } from '../core/network-intel.js';

export default {
  name: Events.GuildMemberAdd,
  async execute(member) {
    // Flag observation — fire-and-forget; records this user's current public_flags so we can
    // later answer "when did Discord first flag this user?" with a real lower bound.
    observeFlags(member.user, member.guild?.id || null);

    // Log which bot is handling this event
    const botIdentifier = member.client.isDefaultBot ? 'DEFAULT BOT' : `CUSTOM BOT (${member.client.botId})`;
    logger.info(`[GuildMemberAdd] Event received by ${botIdentifier} for user ${member.user.tag} in guild ${member.guild.id}`);

    // Only the default bot should ignore guilds with custom bots
    if (member.client.isDefaultBot) {
      const shouldIgnore = await shouldIgnoreGuild(member.guild.id);
      logger.info(`[GuildMemberAdd] Default bot checking if should ignore guild ${member.guild.id}: ${shouldIgnore}`);
      if (shouldIgnore) {
        logger.info(`[GuildMemberAdd] Default bot ignoring guild ${member.guild.id} (has custom bot assigned)`);
        return;
      }
    }

    // Every arrival goes on the permanent join history the rejoin limit counts (core/join-history.js),
    // in every server whether or not the limit is on. Above the stale-event guard on purpose: a
    // replayed join is still a real join, and the row is keyed on the join time so it lands once.
    try {
      await recordJoin(member);
    } catch (err) {
      logger.warn(`[GuildMemberAdd] could not record join history for ${member.id}: ${err.message}`);
    }

    // Network Intel (core/network-intel.js): bump the cross-guild counters and freeze the join-time
    // snapshot onto the row recordJoin just inserted. Both fire-and-forget — a network graph miss
    // is cheap, a broken join pipeline is not.
    recordNetworkJoin(member).catch(() => {});
    recordNetworkJoinSnapshot(member).catch(() => {});

    // Raid lockdown (core/raid-lockdown.js): while one runs, every new join is kicked / banned / timed
    // out / quarantined / logged before anything else touches them. Above the stale-event guard on
    // purpose: a join replayed after a restart still happened during the lockdown (enforceJoin only
    // acts on members whose join time is after the lockdown began). Fails open.
    try {
      const lock = await enforceRaidLockdown(member);
      if (lock?.stop) return;
    } catch (err) {
      logger.error(`[GuildMemberAdd] raid lockdown check failed for ${member.id}: ${err.message}`);
    }

    // A supporter who donated before joining (or who left and came back) gets their role.
    // Best-effort: never let this block the join pipeline.
    try {
      const { syncMember } = await import('../core/kofi-manager.js');
      await syncMember(member);
    } catch (err) {
      logger.error(`[Kofi] member sync failed: ${err.message}`);
    }

    // They're back — un-pause the streamer subscriptions their departure paused.
    //
    // Deliberately ABOVE the stale-event guard below. A replayed join event still tells us the
    // truth (this person is in the guild right now), and a restart is precisely when a rejoin we
    // never saw live needs picking up. The alternative is waiting up to a day for the sweeper.
    //
    // markReturned only clears rows it owns, so a subscription paused by the monthly leveling
    // reset stays paused: leaving and rejoining is not a way around the level-3 gate.
    try {
      await markStreamerReturned(member.guild.id, member.id);
    } catch (err) {
      logger.warn(`[GuildMemberAdd] streamer departure restore failed for ${member.id}: ${err.message}`);
    }

    // Stale event guard - skip if member joined more than 30s ago (replayed event from restart)
    if (member.joinedAt) {
      const joinAge = Date.now() - member.joinedAt.getTime();
      if (joinAge > 30000) {
        logger.info(`[GuildMemberAdd] Ignoring stale event for ${member.user.tag} in ${member.guild.id} - joined ${Math.round(joinAge / 1000)}s ago`);
        return;
      }
    }

    // Raid Detection - track join for raid detection, the auto-lockdown trigger and same-name floods.
    // 'stop' = it removed, timed out or quarantined them: no welcome, no roles, no trial.
    if (member.client.raidDetectionManager) {
      try {
        const verdict = await member.client.raidDetectionManager.trackJoin(member);
        if (verdict === 'stop') return;
      } catch (error) {
        logger.error('[GuildMemberAdd] Error tracking join for raid detection', {
          error: error.message,
          guildId: member.guild?.id,
          userId: member.id
        });
      }
    }

    // Global Ban check - enforce shared ban list on join
    if (member.client.globalBanManager) {
      try {
        await member.client.globalBanManager.checkMember(member);
      } catch (error) {
        logger.error('[GuildMemberAdd] Error checking global ban', {
          error: error.message,
          guildId: member.guild?.id,
          userId: member.id
        });
      }
    }

    // Account-age gate. Runs after the global ban list and BEFORE anything that hands out roles,
    // welcomes them or counts them as a member: a join that is about to be reversed must not
    // trigger a greeting, restore a role set, or start a trial. If it removed them, stop here.
    try {
      const verdict = await joinGateCheck(member);
      if (joinGateRemoved(verdict)) return;
    } catch (error) {
      // A broken gate must not break joining. Fail open, loudly.
      logger.error('[GuildMemberAdd] join gate errored — letting the join through', {
        error: error.message, guildId: member.guild?.id, userId: member.id,
      });
    }

    // Sticky roles — a member who left and came back within the server's retention window gets the
    // roles they had back (guilds.sticky_roles_enabled; core/sticky-roles-manager.js). After the join
    // gate on purpose: a join that is about to be reversed must not be handed a role set first.
    // Never throws; posts a 'sticky-roles' log event itself.
    await restoreStickyRoles(member);
    // Stat roles: a returning member gets roles they already earned; account-age rules apply at once.
    noteStatRoleActivity(member, 'join');

    // Backup Restore — auto-reassign roles to returning members
    try {
      const [restoreRows] = await pool.execute(
        'SELECT backup_restore_data, backup_restore_expires FROM guild_settings WHERE guild_id = ? AND backup_restore_data IS NOT NULL',
        [member.guild.id]
      );
      if (restoreRows.length > 0 && restoreRows[0].backup_restore_data) {
        const expires = restoreRows[0].backup_restore_expires;
        if (expires && new Date(expires) > new Date()) {
          const pendingRestores = JSON.parse(restoreRows[0].backup_restore_data);
          const memberRestore = pendingRestores.find(m => m.userId === member.id);
          if (memberRestore && memberRestore.roles.length > 0) {
            const rolesToAdd = memberRestore.roles
              .map(rid => member.guild.roles.cache.get(rid))
              .filter(r => r && !r.managed);
            if (rolesToAdd.length > 0) {
              await member.roles.add(rolesToAdd, 'Backup restore — member rejoin');
              if (memberRestore.nickname) {
                await member.setNickname(memberRestore.nickname, 'Backup restore').catch(() => {});
              }
              logger.info(`[Backup Restore] Auto-restored ${rolesToAdd.length} roles for ${member.user.username} in ${member.guild.name} (rejoin within restore window)`);
            }
          }
        } else if (expires && new Date(expires) <= new Date()) {
          // Expired — clean up
          await pool.execute(
            'UPDATE guild_settings SET backup_restore_data = NULL, backup_restore_expires = NULL WHERE guild_id = ?',
            [member.guild.id]
          );
        }
      }
    } catch (error) {
      logger.error('[GuildMemberAdd] Error checking backup restore', { error: error.message, guildId: member.guild?.id, userId: member.id });
    }

    // Verification gate (core/verification.js): the unverified role, so the member only sees the gate
    // channel until they verify, and — in CAPTCHA mode with a time limit — the start of their clock.
    // Never throws.
    await startVerification(member);

    // Temporary access — a join through a tracked invite starts a trial that ends
    // in removal unless the member shows any sign of life. Attribution has to
    // happen here and now: it works by noticing which invite's use count went up,
    // and that signal is gone the moment anything else fetches invites.
    try {
      const tempCfg = await getTempAccessConfig(member.guild.id);
      if (tempCfg?.enabled && !member.user.bot) {
        const inviteCode = await attributeJoin(member.guild);
        if (inviteCode) {
          await startTrial(member, { source: 'invite', inviteCode, cfg: tempCfg });
        }
      }
    } catch (error) {
      logger.error('[GuildMemberAdd] Error starting temporary-access trial', {
        error: error.message, guildId: member.guild?.id, userId: member.id
      });
    }

    // Auto-prune (core/auto-prune.js): on the clock until they get a real role. After everything that
    // hands out roles above, so a restored or trial role already counts. Never throws.
    await startAutoPrune(member);

    try {
      await logMemberJoin(member);
    } catch (error) {
      logger.error('[GuildMemberAdd] Error logging member join', {
        error: error.message,
        stack: error.stack,
        guildId: member.guild?.id,
        userId: member.id
      });
    }

    try {
      logger.info(`[GuildMemberAdd] ${botIdentifier} calling handleGuildMemberAdd for ${member.user.tag}`);
      await handleGuildMemberAdd(member);
    } catch (error) {
      logger.error('[GuildMemberAdd] Error handling welcome message', {
        error: error.message,
        stack: error.stack,
        guildId: member.guild?.id,
        userId: member.id
      });
    }

    // Track server statistics
    if (member.client.serverStatsManager) {
      try {
        await member.client.serverStatsManager.trackMemberJoin(member.guild.id);
      } catch (error) {
        logger.error('[GuildMemberAdd] Error tracking member join stats', {
          error: error.message,
          guildId: member.guild?.id,
          userId: member.id
        });
      }
    }

    // Track achievements
    if (member.client.achievementManager) {
      try {
        // Early adopter achievement - first 10 members to join
        const memberCount = member.guild.memberCount;
        if (memberCount <= 10) {
          await member.client.achievementManager.trackAchievement(
            member.id,
            member.guild.id,
            'early_adopter',
            1,
            { completed: true }
          );
        }

        // Trailblazer achievement - first 100 members
        if (memberCount <= 100) {
          await member.client.achievementManager.trackAchievement(
            member.id,
            member.guild.id,
            'trailblazer',
            1,
            { completed: true }
          );
        }
      } catch (error) {
        logger.error('[GuildMemberAdd] Error tracking achievements', {
          error: error.message,
          guildId: member.guild?.id,
          userId: member.id
        });
      }
    }
  }
};
