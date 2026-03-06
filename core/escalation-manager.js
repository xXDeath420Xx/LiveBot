import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { EmbedBuilder } from 'discord.js';

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

    // Check each rule (highest count first)
    for (const rule of rules) {
      const sinceDate = new Date(Date.now() - rule.time_period_hours * 60 * 60 * 1000);

      // Count infractions in the time period
      const [rows] = await pool.execute(
        'SELECT COUNT(*) as count FROM infractions WHERE guild_id = ? AND user_id = ? AND created_at >= ?',
        [guild.id, user.id, sinceDate]
      );

      const infractionCount = rows[0].count;

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
  const reason = `Automatic action: ${rule.infraction_count} infractions in ${rule.time_period_hours} hours.`;

  try {
    // Get bot client from guild
    const botUser = guild.client.user;

    // Log the automated infraction
    const expiresAt = rule.action_duration_minutes
      ? new Date(Date.now() + rule.action_duration_minutes * 60000)
      : null;

    const [result] = await pool.execute(
      'INSERT INTO infractions (guild_id, user_id, moderator_id, type, reason, duration_minutes, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        guild.id,
        user.id,
        botUser.id,
        rule.action.charAt(0).toUpperCase() + rule.action.slice(1), // Capitalize action type
        reason,
        rule.action_duration_minutes,
        expiresAt
      ]
    );

    const infractionId = result.insertId;

    // Try to DM the user
    try {
      const dmEmbed = new EmbedBuilder()
        .setColor('#E74C3C')
        .setTitle(`Automatic Action Taken in ${guild.name}`)
        .setDescription('Due to accumulating too many infractions recently, an automatic action has been taken.')
        .addFields(
          { name: 'Action', value: rule.action.toUpperCase() },
          { name: 'Reason', value: reason }
        )
        .setTimestamp();

      if (rule.action_duration_minutes) {
        dmEmbed.addFields({ name: 'Duration', value: `${rule.action_duration_minutes} minutes` });
      }

      await user.send({ embeds: [dmEmbed] });
    } catch (dmError) {
      logger.warn('[EscalationManager] Could not DM user about automated action', {
        userId: user.id,
        userTag: user.tag
      });
    }

    // Apply the action
    switch (rule.action.toLowerCase()) {
      case 'mute':
        await member.timeout(rule.action_duration_minutes * 60 * 1000, reason);
        logger.info('[EscalationManager] User muted (escalation)', {
          userId: user.id,
          duration: rule.action_duration_minutes
        });
        break;

      case 'kick':
        await member.kick(reason);
        logger.info('[EscalationManager] User kicked (escalation)', { userId: user.id });
        break;

      case 'ban':
        await member.ban({ reason });
        logger.info('[EscalationManager] User banned (escalation)', { userId: user.id });
        break;

      default:
        logger.warn('[EscalationManager] Unknown escalation action', { action: rule.action });
    }

    // Post to mod log
    const [configRows] = await pool.execute(
      'SELECT mod_log_channel_id FROM moderation_config WHERE guild_id = ?',
      [guild.id]
    );

    const config = configRows[0];
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
      .setColor('#C0392B')
      .setAuthor({ name: 'Automated Moderation' })
      .setTitle('Escalation Rule Triggered')
      .addFields(
        { name: 'User', value: `${user.tag} (${user.id})` },
        {
          name: 'Action Taken',
          value: `${rule.action.toUpperCase()}${rule.action_duration_minutes ? ` (${rule.action_duration_minutes}m)` : ''}`
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
