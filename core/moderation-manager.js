import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { EmbedBuilder } from 'discord.js';

/**
 * Log a moderation action (infraction) to the database and mod log channel
 * @param {CommandInteraction} interaction - The interaction that triggered the moderation action
 * @param {User} user - The user being moderated
 * @param {string} type - Type of infraction (Ban, Kick, Mute, Warn, etc.)
 * @param {string} reason - Reason for the action
 * @param {number|null} durationMinutes - Duration in minutes (for mutes)
 */
export async function logInfraction(interaction, user, type, reason, durationMinutes = null) {
  try {
    const expiresAt = durationMinutes ? new Date(Date.now() + durationMinutes * 60000) : null;

    // Insert infraction into database
    await pool.execute(
      'INSERT INTO infractions (guild_id, user_id, moderator_id, type, reason, duration_minutes, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [interaction.guild.id, user.id, interaction.user.id, type, reason, durationMinutes, expiresAt]
    );

    // Get mod log channel
    const [rows] = await pool.execute(
      'SELECT mod_log_channel_id FROM moderation_config WHERE guild_id = ?',
      [interaction.guild.id]
    );

    const config = rows[0];
    if (!config || !config.mod_log_channel_id) {
      logger.debug('[ModerationManager] No mod log channel configured for guild', {
        guildId: interaction.guild.id
      });
      return;
    }

    // Fetch the log channel
    const logChannel = await interaction.guild.channels.fetch(config.mod_log_channel_id).catch(() => null);
    if (!logChannel || !logChannel.isTextBased()) {
      logger.warn('[ModerationManager] Mod log channel not found or not text-based', {
        channelId: config.mod_log_channel_id
      });
      return;
    }

    // Color coding based on action type
    let color = '#E67E22'; // Default orange for warnings
    if (type === 'Mute') color = '#F1C40F'; // Yellow
    if (type === 'Kick') color = '#E74C3C'; // Red
    if (type === 'Ban') color = '#C0392B'; // Dark red
    if (type === 'Unmute' || type === 'Unban') color = '#2ECC71'; // Green for reversals
    if (type === 'ClearInfractions') color = '#95A5A6'; // Grey for neutral

    // Create log embed
    const logEmbed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: 'Moderation Log' })
      .setTitle(`${type.charAt(0).toUpperCase() + type.slice(1)} Issued`)
      .addFields(
        { name: 'User', value: `${user.tag} (${user.id})`, inline: false },
        { name: 'Moderator', value: `${interaction.user.tag} (${interaction.user.id})`, inline: false },
        { name: 'Reason', value: reason || 'No reason provided' }
      )
      .setTimestamp();

    if (durationMinutes) {
      logEmbed.addFields({ name: 'Duration', value: `${durationMinutes} minutes` });
    }

    // Send to log channel
    await logChannel.send({ embeds: [logEmbed] });

    // Check for escalations (don't escalate on reversal actions)
    if (type !== 'Unmute' && type !== 'Unban' && type !== 'ClearInfractions') {
      // Import escalation checker dynamically to avoid circular dependency
      const { checkEscalations } = await import('./escalation-manager.js');
      await checkEscalations(interaction.guild, user);

      // Record cross-guild action for global ban auto-aggregation
      if (interaction.client.globalBanManager && (type === 'Ban' || type === 'Kick' || type === 'Mute')) {
        try {
          await interaction.client.globalBanManager.recordCrossGuildAction(
            user.id, interaction.guild.id, type.toLowerCase(), reason, interaction.user.id
          );
        } catch (gbError) {
          logger.error('[ModerationManager] Failed to record global ban aggregate', { error: gbError.message });
        }
      }
    }

    logger.info('[ModerationManager] Infraction logged', {
      guildId: interaction.guild.id,
      userId: user.id,
      type,
      moderator: interaction.user.id
    });

  } catch (error) {
    logger.error('[ModerationManager] Failed to log infraction', {
      error: error.message,
      stack: error.stack
    });
  }
}
