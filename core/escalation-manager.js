import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { EmbedBuilder } from 'discord.js';
import { isProtectedFromBanCommands } from '../utils/owner-protection.js';
import { themeColor } from './guild-theme.js';
import { logFeatureEvent, userLabel } from './feature-log.js';
import { protectionHold } from './protection-exempt.js';
import { sendModerationDm } from './moderation-manager.js';

/**
 * The infractions an escalation rule counts: warnings, timeouts, kicks and bans (H-658). Not reversals
 * (Unmute, Unban), not the ClearInfractions marker, and not the raid / self-bot / spam detector rows,
 * which record a detection rather than a moderation action.
 */
export const ESCALATION_COUNTED_TYPES = Object.freeze(['Warn', 'Mute', 'Kick', 'Ban']);

/** The reason every escalation-made infraction carries; those rows are the punishment, not an offence. */
const ESCALATION_REASON_PREFIX = 'Automatic action:';

/**
 * How many infractions count towards a rule: the counted types created at or after `sinceMs`, after the
 * member's last ClearInfractions row (/admin mod clearinfractions wipes the history, then writes that row),
 * leaving out the rows escalation itself recorded.
 * @param {Array<{ id:number, type:string, reason?:string|null, created_at:Date|string }>} rows  the member's rows
 * @param {number} sinceMs  start of the rule's window
 */
export function countTowardEscalation(rows, sinceMs) {
  const list = Array.isArray(rows) ? rows : [];
  const lastClear = list.reduce((max, r) => (r.type === 'ClearInfractions' && Number(r.id) > max ? Number(r.id) : max), 0);
  return list.filter((r) => ESCALATION_COUNTED_TYPES.includes(r.type)
    && Number(r.id) > lastClear
    && new Date(r.created_at).getTime() >= sinceMs
    && !String(r.reason || '').startsWith(ESCALATION_REASON_PREFIX)).length;
}

/**
 * escalation_rules.action → the infractions.type ENUM value it is recorded as.
 *
 * The type used to be built by capitalising the action, so a 'timeout' rule (what the dashboard's
 * "Timeout" option means) became 'Timeout', which the ENUM rejects — the INSERT threw before the
 * action ran and the rule never fired. A timeout IS a mute in Discord terms.
 */
const ACTION_INFRACTION_TYPE = {
  warn: 'Warn',
  mute: 'Mute',
  timeout: 'Mute',
  kick: 'Kick',
  ban: 'Ban'
};

/** infractions.type → the Moderation page's DM switch and wording (core/moderation-manager.js MOD_DM_ACTIONS). */
const ESCALATION_DM_ACTION = { Warn: 'warn', Mute: 'mute', Kick: 'kick', Ban: 'ban' };

/**
 * Length of an escalation mute/timeout whose rule has no action_duration_minutes. The dashboard form
 * never asked for one, so most mute rules have NULL — which timed the member out for 0 ms (no mute).
 */
export const DEFAULT_ESCALATION_MUTE_MINUTES = 60;

/** Discord refuses timeouts longer than 28 days. */
const MAX_TIMEOUT_MINUTES = 28 * 24 * 60;

/**
 * Check if a user has met escalation criteria and apply automatic actions
 * @param {Guild} guild - The guild where the escalation check is happening
 * @param {User} user - The user to check for escalations
 */
export async function checkEscalations(guild, user) {
  try {
    // Get all escalation rules for this guild, ordered by highest count first
    const [rules] = await pool.execute(
      'SELECT * FROM escalation_rules WHERE guild_id = ? ORDER BY infraction_count DESC',
      [guild.id]
    );

    if (rules.length === 0) {
      logger.debug('[EscalationManager] No escalation rules configured for guild', {
        guildId: guild.id
      });
      return;
    }

    // Fetch the member
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) {
      logger.debug('[EscalationManager] Member not found in guild', {
        userId: user.id,
        guildId: guild.id
      });
      return;
    }

    if (!member.moderatable) {
      logger.debug('[EscalationManager] Member not moderatable (higher role or owner)', {
        userId: user.id,
        guildId: guild.id
      });
      return;
    }

    // The member's record in this server, read once and counted per rule (countTowardEscalation).
    const [history] = await pool.execute(
      'SELECT id, type, reason, created_at FROM infractions WHERE guild_id = ? AND user_id = ?',
      [guild.id, user.id]
    );

    // Check each rule (highest count first)
    for (const rule of rules) {
      const sinceMs = Date.now() - rule.time_period_hours * 60 * 60 * 1000;
      const infractionCount = countTowardEscalation(history, sinceMs);

      if (infractionCount >= rule.infraction_count) {
        // Escalation triggered - apply action and stop checking
        logger.info('[EscalationManager] Escalation triggered', {
          guildId: guild.id,
          userId: user.id,
          infractionCount,
          requiredCount: rule.infraction_count,
          action: rule.action
        });

        await applyAction(guild, member, user, rule);
        return; // Stop after applying the first matching (highest) rule
      }
    }

  } catch (error) {
    logger.error('[EscalationManager] Error checking escalations', {
      error: error.message,
      stack: error.stack,
      userId: user.id,
      guildId: guild.id
    });
  }
}

/**
 * Apply an automatic escalation action
 * @param {Guild} guild - The guild
 * @param {GuildMember} member - The member to moderate
 * @param {User} user - The user
 * @param {Object} rule - The escalation rule
 */
async function applyAction(guild, member, user, rule) {
  if (isProtectedFromBanCommands(user?.id)) {
    logger.warn('[EscalationManager] Refusing to apply escalation to protected bot owner', {
      userId: user.id,
      guildId: guild.id,
      action: rule?.action
    });
    return;
  }

  const reason = `Automatic action: ${rule.infraction_count} infractions in ${rule.time_period_hours} hours.`;

  const action = String(rule.action || '').toLowerCase();
  const infractionType = ACTION_INFRACTION_TYPE[action];
  if (!infractionType) {
    logger.warn('[EscalationManager] Escalation rule has an unknown action — skipped', {
      guildId: guild.id,
      ruleId: rule.id,
      action: rule.action
    });
    return;
  }

  // Unified allowlist / global pause: no automatic escalation (core/protection-exempt.js logs the skip).
  const doing = { Mute: 'timeout', Kick: 'kick', Ban: 'ban', Warn: 'warn' }[infractionType];
  if (await protectionHold(member ?? { guild, id: user.id, user }, doing, 'Auto escalation')) return;

  // Only mutes have a length. Kick/ban rules carry 0 or NULL here, which is not a duration.
  let durationMinutes = null;
  if (infractionType === 'Mute') {
    durationMinutes = Number(rule.action_duration_minutes);
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      logger.warn('[EscalationManager] Mute/timeout rule has no duration — using the default', {
        guildId: guild.id,
        ruleId: rule.id,
        action: rule.action,
        defaultMinutes: DEFAULT_ESCALATION_MUTE_MINUTES
      });
      durationMinutes = DEFAULT_ESCALATION_MUTE_MINUTES;
    }
    durationMinutes = Math.min(Math.round(durationMinutes), MAX_TIMEOUT_MINUTES);
  }

  try {
    // Get bot client from guild
    const botUser = guild.client.user;

    // Log the automated infraction
    const expiresAt = durationMinutes
      ? new Date(Date.now() + durationMinutes * 60000)
      : null;

    const [result] = await pool.execute(
      'INSERT INTO infractions (guild_id, user_id, moderator_id, type, reason, duration_minutes, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        guild.id,
        user.id,
        botUser.id,
        infractionType,
        reason,
        durationMinutes,
        expiresAt
      ]
    );

    const infractionId = result.insertId;

    // DM the member through the Moderation page's messages: its on/off switch and wording for this
    // action (H-658 — this used to send its own DM whatever the switches said). Before a kick or ban,
    // while the bot still shares the server with them. sendModerationDm never throws.
    await sendModerationDm(guild, user, ESCALATION_DM_ACTION[infractionType], {
      reason,
      durationMinutes,
      expiresAtMs: durationMinutes ? Date.now() + durationMinutes * 60000 : undefined,
      permanent: infractionType === 'Ban',
      moderator: botUser,
    });

    // Apply the action
    switch (infractionType) {
      case 'Mute':
        await member.timeout(durationMinutes * 60 * 1000, reason);
        logger.info('[EscalationManager] User muted (escalation)', {
          userId: user.id,
          duration: durationMinutes
        });
        break;

      case 'Kick':
        await member.kick(reason);
        logger.info('[EscalationManager] User kicked (escalation)', { userId: user.id });
        break;

      case 'Ban':
        await member.ban({ reason });
        logger.info('[EscalationManager] User banned (escalation)', { userId: user.id });
        break;

      case 'Warn':
        // A warning is the recorded infraction plus the DM above; there is no Discord-side action.
        logger.info('[EscalationManager] User warned (escalation)', { userId: user.id });
        break;
    }

    // Post to mod log
    const [configRows] = await pool.execute(
      'SELECT mod_log_channel_id FROM moderation_config WHERE guild_id = ?',
      [guild.id]
    );

    const config = configRows[0];

    // Server log; the mod-log embed below goes to mod_log_channel_id, so it is not repeated there.
    void logFeatureEvent(() => (guild), 'moderation.escalation', () => ({
      title: '📈 Escalation Triggered',
      fields: [
        ['Member', userLabel(user)],
        ['Action', rule.action.toUpperCase()],
        ['Duration', durationMinutes ? `${durationMinutes} minutes` : null],
        ['Rule', `${rule.infraction_count} infractions in ${rule.time_period_hours} hours`],
        ['Case', `#${infractionId}`],
        ['Moderator', userLabel(botUser)],
        ['Reason', reason, false],
      ],
      avoidChannelIds: [config?.mod_log_channel_id],
    }));

    if (!config || !config.mod_log_channel_id) {
      logger.debug('[EscalationManager] No mod log channel configured');
      return;
    }

    const logChannel = await guild.channels.fetch(config.mod_log_channel_id).catch(() => null);
    if (!logChannel || !logChannel.isTextBased()) {
      logger.warn('[EscalationManager] Mod log channel not found or not text-based');
      return;
    }

    const logEmbed = new EmbedBuilder()
      .setColor(themeColor(member.guild?.id, 'danger'))
      .setAuthor({ name: 'Automated Moderation' })
      .setTitle('Escalation Rule Triggered')
      .addFields(
        { name: 'User', value: `${user.tag} (${user.id})` },
        {
          name: 'Action Taken',
          value: `${rule.action.toUpperCase()}${durationMinutes ? ` (${durationMinutes}m)` : ''}`
        },
        {
          name: 'Trigger',
          value: `Reached ${rule.infraction_count} infractions in ${rule.time_period_hours} hours.`
        },
        { name: 'Case ID', value: `#${infractionId}` }
      )
      .setTimestamp();

    await logChannel.send({ embeds: [logEmbed] });

  } catch (error) {
    logger.error('[EscalationManager] Failed to apply escalation action', {
      error: error.message,
      stack: error.stack,
      userId: user.id,
      action: rule.action
    });
  }
}
