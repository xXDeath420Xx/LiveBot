import { AttachmentBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { safeJsonArray } from '../utils/safeJson.js';

let Canvas;
try {
  Canvas = await import('canvas');
} catch (e) {
  logger.warn('Canvas module not available. Banner generation will be disabled.', { category: 'greeting' });
}

import { enforceSizeLimit } from '../utils/cacheUtils.js';

// Deduplication cache to prevent duplicate welcome messages
// Key: `${guildId}-${memberId}`, Value: timestamp
const recentWelcomes = new Map();
const WELCOME_DEDUP_WINDOW = 10000; // 10 seconds
const MAX_WELCOME_CACHE = 5000; // Prevent unbounded growth

// Clean up old entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of recentWelcomes) {
    if (now - timestamp > WELCOME_DEDUP_WINDOW) {
      recentWelcomes.delete(key);
    }
  }
  // Enforce max size to prevent memory leaks
  enforceSizeLimit(recentWelcomes, MAX_WELCOME_CACHE, 'recentWelcomes');
}, 60000);

/**
 * Handle when a member joins a guild
 * @param {import('discord.js').GuildMember} member - The member who joined
 */
export async function handleGuildMemberAdd(member) {
  const guildId = member.guild.id;
  const memberId = member.id;
  const botIdentifier = member.client.isDefaultBot ? 'DEFAULT BOT' : `CUSTOM BOT (${member.client.botId})`;

  logger.info(`[GreetingManager] ${botIdentifier} handleGuildMemberAdd called for ${member.user.tag} in guild ${guildId}`);

  // Stale join check - if member joined more than 30 seconds ago, this is likely
  // a replayed event from a bot restart, not a real join
  if (member.joinedAt) {
    const joinAge = Date.now() - member.joinedAt.getTime();
    if (joinAge > 30000) {
      logger.info(`[GreetingManager] Skipping welcome for ${member.user.tag} in ${guildId} - member joined ${Math.round(joinAge / 1000)}s ago (stale event)`, { guildId, memberId, botIdentifier, category: 'greeting' });
      return;
    }
  }

  // Deduplication check - prevent duplicate welcome messages within 10 seconds
  // Uses atomic check-and-set pattern to prevent race conditions
  const dedupKey = `${guildId}-${memberId}`;
  const now = Date.now();
  const lastWelcome = recentWelcomes.get(dedupKey);

  // Atomically check and set to prevent race condition
  if (lastWelcome && now - lastWelcome < WELCOME_DEDUP_WINDOW) {
    logger.warn(`[GreetingManager] Duplicate welcome prevented for ${member.user.tag} in guild ${guildId} (${now - lastWelcome}ms since last)`, {
      guildId,
      memberId,
      botIdentifier,
      category: 'greeting'
    });
    return;
  }

  // Set immediately before any async operations to prevent race condition
  recentWelcomes.set(dedupKey, now);

  try {
    const [rows] = await pool.execute(
      'SELECT channel_id, message, banner_enabled, card_background_url, banner_background_url FROM welcome_settings WHERE guild_id = ?',
      [guildId]
    );

    if (rows.length === 0 || !rows[0].channel_id) {
      logger.debug(`[GreetingManager] No welcome settings or channel for guild ${guildId}`);
      return;
    }

    const config = rows[0];
    const channel = member.guild.channels.cache.get(config.channel_id);
    if (!channel) {
      logger.warn(`[GreetingManager] Welcome channel ${config.channel_id} not found in guild ${guildId}`);
      return;
    }

    logger.info(`[GreetingManager] ${botIdentifier} preparing to send welcome message to channel ${config.channel_id}`);

    // Use default message if none configured
    let messageContent = (config.message || `Welcome ${member}!`)
      .replace(/{mention}/g, `<@${member.id}>`)
      .replace(/{user}/g, member.user.tag)
      .replace(/{server}/g, member.guild.name)
      .replace(/{memberCount}/g, member.guild.memberCount.toString());

    if (config.banner_enabled && Canvas) {
      // Enhanced banner design with better quality
      const width = 1024;
      const height = 450;
      const canvas = Canvas.createCanvas(width, height);
      const ctx = canvas.getContext('2d');

      // Background
      try {
        // Check both card_background_url (new column) and banner_background_url (legacy)
        const backgroundUrl = config.card_background_url || config.banner_background_url;
        if (backgroundUrl) {
          const background = await Canvas.loadImage(backgroundUrl);
          // Draw background, scale to cover entire canvas
          ctx.drawImage(background, 0, 0, width, height);
          // Add semi-transparent overlay for better text visibility
          ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
          ctx.fillRect(0, 0, width, height);
        } else {
          // Default gradient background
          const gradient = ctx.createLinearGradient(0, 0, width, height);
          gradient.addColorStop(0, '#5865F2');
          gradient.addColorStop(1, '#7289DA');
          ctx.fillStyle = gradient;
          ctx.fillRect(0, 0, width, height);
        }
      } catch (e) {
        logger.error('Failed to load welcome card background.', {
          guildId,
          category: 'greeting',
          backgroundUrl: backgroundUrl,
          error: e.message,
          stack: e.stack
        });
        // Fallback to gradient
        const gradient = ctx.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, '#5865F2');
        gradient.addColorStop(1, '#7289DA');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);

        // Log a warning to the channel if it's a format issue
        if (e.message.includes('Unsupported') || e.message.includes('type')) {
          logger.warn('Background image format not supported. Please use JPG or PNG format.', {
            guildId,
            category: 'greeting',
            url: backgroundUrl
          });
        }
      }

      // Load and draw circular avatar with border
      const avatarSize = 200;
      const avatarX = width / 2 - avatarSize / 2;
      const avatarY = 80;

      try {
        const avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 256 });
        const avatar = await Canvas.loadImage(avatarUrl);

        // Draw circular avatar
        ctx.save();
        ctx.beginPath();
        ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2, true);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
        ctx.restore();

        // Draw avatar border
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2, true);
        ctx.closePath();
        ctx.stroke();
      } catch (err) {
        logger.error(`Failed to load avatar for ${member.user.tag}:`, {
          error: err.message,
          category: 'greeting'
        });
      }

      // Text setup
      ctx.textAlign = 'center';
      ctx.fillStyle = '#FFFFFF';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 4;

      // Welcome text
      ctx.font = 'bold 56px Arial';
      ctx.strokeText('WELCOME', width / 2, 320);
      ctx.fillText('WELCOME', width / 2, 320);

      // Username
      ctx.font = 'bold 42px Arial';
      const username = member.user.username;
      const truncatedUsername = username.length > 20 ? username.substring(0, 20) + '...' : username;
      ctx.strokeText(truncatedUsername, width / 2, 380);
      ctx.fillText(truncatedUsername, width / 2, 380);

      // Member count
      ctx.font = '32px Arial';
      const memberCount = member.guild.memberCount;
      const memberText = `Member #${memberCount}`;
      ctx.strokeText(memberText, width / 2, 420);
      ctx.fillText(memberText, width / 2, 420);

      const attachment = new AttachmentBuilder(canvas.toBuffer(), { name: 'welcome-image.png' });
      logger.info(`[GreetingManager] ${botIdentifier} SENDING enhanced welcome banner for ${member.user.tag} to channel ${config.channel_id}`);
      await channel.send({ content: messageContent, files: [attachment] });
      logger.info(`[GreetingManager] ${botIdentifier} SENT enhanced welcome banner for ${member.user.tag}.`, {
        guildId,
        category: 'greeting'
      });

    } else {
      logger.info(`[GreetingManager] ${botIdentifier} SENDING welcome message for ${member.user.tag} to channel ${config.channel_id}`);
      await channel.send(messageContent);
      logger.info(`[GreetingManager] ${botIdentifier} SENT welcome message for ${member.user.tag}.`, {
        guildId,
        category: 'greeting'
      });
    }

    // Handle autorole if configured (with rules screening check)
    await assignAutoroles(member);
  } catch (error) {
    logger.error('Error handling guild member add.', {
      guildId,
      category: 'greeting',
      error: error.stack
    });
  }
}

/**
 * Handle when a member leaves a guild
 * @param {import('discord.js').GuildMember} member - The member who left
 */
export async function handleGuildMemberRemove(member) {
  const guildId = member.guild.id;
  try {
    const [rows] = await pool.execute(
      'SELECT goodbye_enabled, goodbye_channel_id, goodbye_message FROM welcome_settings WHERE guild_id = ?',
      [guildId]
    );

    if (rows.length === 0 || !rows[0].goodbye_enabled || !rows[0].goodbye_channel_id) return;

    const config = rows[0];
    const channel = member.guild.channels.cache.get(config.goodbye_channel_id);
    if (!channel) return;

    let messageContent = (config.goodbye_message || '')
      .replace(/{mention}/g, `<@${member.id}>`)
      .replace(/{user}/g, member.user.tag)
      .replace(/{server}/g, member.guild.name);

    await channel.send(messageContent);
    logger.info(`Sent goodbye message for ${member.user.tag}.`, {
      guildId,
      category: 'greeting'
    });
  } catch (error) {
    logger.error('Error handling guild member remove.', {
      guildId,
      category: 'greeting',
      error: error.stack
    });
  }
}

/**
 * Assign autoroles to a member (respects rules screening)
 * @param {import('discord.js').GuildMember} member - The member to assign roles to
 */
export async function assignAutoroles(member) {
  const guildId = member.guild.id;

  try {
    // Check if member has completed rules screening (if enabled)
    // If member.pending is true, they haven't accepted rules yet
    if (member.pending) {
      logger.info(`Skipping autorole for ${member.user.tag} - rules screening not completed (pending: true)`, {
        guildId,
        userId: member.id,
        category: 'greeting'
      });
      return;
    }

    // Load autoroles configuration from new table (supports multiple roles)
    const [autorolesConfig] = await pool.execute(
      'SELECT roles_to_assign FROM autoroles_config WHERE guild_id = ? AND is_enabled = 1',
      [guildId]
    );

    let rolesToAssign = [];

    if (autorolesConfig.length > 0 && autorolesConfig[0].roles_to_assign) {
      // Parse roles from JSON
      try {
        const parsedRoles = safeJsonArray(autorolesConfig[0].roles_to_assign, 'autoroles roles_to_assign');
        if (Array.isArray(parsedRoles) && parsedRoles.length > 0) {
          rolesToAssign = parsedRoles;
        }
      } catch (e) {
        logger.error('Failed to parse autoroles JSON', {
          guildId,
          category: 'greeting',
          error: e.message
        });
      }
    }

    // Fallback to old system (single role from welcome_settings)
    if (rolesToAssign.length === 0) {
      const [welcomeSettings] = await pool.execute(
        'SELECT auto_role_id FROM welcome_settings WHERE guild_id = ? AND auto_role_id IS NOT NULL',
        [guildId]
      );

      if (welcomeSettings.length > 0 && welcomeSettings[0].auto_role_id) {
        rolesToAssign.push(welcomeSettings[0].auto_role_id);
      }
    }

    // Assign all configured roles
    if (rolesToAssign.length > 0) {
      const assignedRoles = [];
      const failedRoles = [];

      for (const roleId of rolesToAssign) {
        try {
          const role = member.guild.roles.cache.get(roleId);
          if (role) {
            // Check if member already has the role
            if (!member.roles.cache.has(roleId)) {
              await member.roles.add(role);
              assignedRoles.push(role.name);
            }
          } else {
            failedRoles.push(roleId);
            logger.warn(`Autorole not found: ${roleId}`, {
              guildId,
              category: 'greeting'
            });
          }
        } catch (error) {
          failedRoles.push(roleId);
          logger.error(`Failed to assign autorole ${roleId}`, {
            guildId,
            userId: member.id,
            category: 'greeting',
            error: error.message
          });
        }
      }

      if (assignedRoles.length > 0) {
        logger.info(`Assigned autoroles to ${member.user.tag}: ${assignedRoles.join(', ')}`, {
          guildId,
          userId: member.id,
          category: 'greeting'
        });
      }
    }
  } catch (error) {
    logger.error('Error assigning autoroles', {
      guildId,
      userId: member.id,
      category: 'greeting',
      error: error.message,
      stack: error.stack
    });
  }
}
