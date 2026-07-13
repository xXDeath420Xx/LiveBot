import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { safeJsonArray } from '../utils/safeJson.js';

// Discord-style random quirky join phrases. {user} is replaced with the member mention.
const QUIRKY_JOINS = [
  "{user} just showed up!",
  "Everyone welcome {user}!",
  "A wild {user} appeared!",
  "{user} just slid into the server.",
  "Look who it is — {user}!",
  "{user} hopped in. Say hi!",
  "Roll out the carpet, {user} has arrived.",
  "{user} just joined the party. 🎉",
  "Glad you could make it, {user}.",
  "Welcome aboard, {user}.",
  "{user} landed. Brace for awesome.",
  "{user} has entered the chat.",
  "It's dangerous to go alone — take {user}!",
  "{user} just logged on.",
  "{user}, welcome to the pack.",
  "A new friend joined: {user}.",
  "{user} just materialized out of thin air.",
  "{user} rolled a 20 on initiative and joined.",
  "Please give a warm welcome to {user}.",
  "{user} is here. The server is now cooler.",
];

function pickQuirky() {
  return QUIRKY_JOINS[Math.floor(Math.random() * QUIRKY_JOINS.length)];
}

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
  if (member.user?.bot) return;

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

    // Pre-compute a random quirky phrase once per join so it stays consistent across
    // message body, embed title, and card title if all three reference it.
    const quirkyPhrase = pickQuirky()
      .replace(/{user}/g, `<@${member.id}>`);
    const quirkyPlain = QUIRKY_JOINS[Math.floor(Math.random() * QUIRKY_JOINS.length)]
      .replace(/{user}/g, member.user.username);

    // Use default message if none configured
    let messageContent = (config.message || `Welcome ${member}!`)
      .replace(/{mention}/g, `<@${member.id}>`)
      .replace(/{username}/g, member.user.username)
      .replace(/{user}/g, member.user.tag)
      .replace(/{server}/g, member.guild.name)
      .replace(/{memberCount}/g, member.guild.memberCount.toString())
      .replace(/{member_count}/g, member.guild.memberCount.toString())
      .replace(/{count}/g, member.guild.memberCount.toString())
      .replace(/{quirky}/g, quirkyPhrase)
      .replace(/{quirky_plain}/g, quirkyPlain);

    if (config.banner_enabled && Canvas) {
      const width = 1100;
      const height = 400;
      const padding = 40;
      const canvas = Canvas.createCanvas(width, height);
      const ctx = canvas.getContext('2d');

      // Background — custom image or black card with rounded corners
      const backgroundUrl = config.card_background_url || config.banner_background_url;
      const radius = 30;

      // Draw rounded rectangle helper
      const drawRoundedRect = (x, y, w, h, r) => {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
      };

      if (backgroundUrl) {
        try {
          const background = await Canvas.loadImage(backgroundUrl);
          drawRoundedRect(0, 0, width, height, radius);
          ctx.clip();
          ctx.drawImage(background, 0, 0, width, height);
          ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
          ctx.fillRect(0, 0, width, height);
        } catch (e) {
          logger.error('Failed to load welcome card background.', {
            guildId, category: 'greeting', error: e.message
          });
          ctx.fillStyle = '#000000';
          drawRoundedRect(0, 0, width, height, radius);
          ctx.fill();
        }
      } else {
        ctx.fillStyle = '#000000';
        drawRoundedRect(0, 0, width, height, radius);
        ctx.fill();
      }

      // Circular avatar with white border — centered in upper portion
      const avatarSize = 180;
      const avatarCenterX = width / 2;
      const avatarCenterY = padding + avatarSize / 2 + 10;

      try {
        const avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 256 });
        const avatar = await Canvas.loadImage(avatarUrl);

        ctx.save();
        ctx.beginPath();
        ctx.arc(avatarCenterX, avatarCenterY, avatarSize / 2, 0, Math.PI * 2, true);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(avatar, avatarCenterX - avatarSize / 2, avatarCenterY - avatarSize / 2, avatarSize, avatarSize);
        ctx.restore();

        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(avatarCenterX, avatarCenterY, avatarSize / 2 + 2, 0, Math.PI * 2, true);
        ctx.closePath();
        ctx.stroke();
      } catch (err) {
        logger.error(`Failed to load avatar for ${member.user.tag}:`, {
          error: err.message, category: 'greeting'
        });
      }

      // Title text — "{username} just joined the server"
      const textY = avatarCenterY + avatarSize / 2 + 45;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#FFFFFF';
      const titleText = (config.card_title_text || '{user} just joined the server')
        .replace(/{user}/g, member.user.username)
        .replace(/{server}/g, member.guild.name);
      ctx.font = '42px Arial';
      ctx.fillText(titleText, width / 2, textY);

      // Subtitle — "Member #N"
      ctx.fillStyle = '#DCDDDE';
      const memberCount = member.guild.memberCount;
      const subtitleText = (config.card_subtitle_text || 'Member #{memberCount}')
        .replace(/{user}/g, member.user.username)
        .replace(/{server}/g, member.guild.name)
        .replace(/{memberCount}/g, memberCount.toString());
      ctx.font = '24px Arial';
      ctx.fillText(subtitleText, width / 2, textY + 35);

      const attachment = new AttachmentBuilder(canvas.toBuffer(), { name: 'welcome-image.png' });
      logger.info(`[GreetingManager] ${botIdentifier} SENDING enhanced welcome banner for ${member.user.tag} to channel ${config.channel_id}`);

      // Wrap the card in an embed so it renders with a colored side-bar + footer member count.
      const embed = new EmbedBuilder()
        .setColor(0xCDC3FF)
        .setTitle(`👋 ${quirkyPlain}`)
        .setDescription(messageContent)
        .setImage('attachment://welcome-image.png')
        .setFooter({ text: `${member.guild.name} • Member #${member.guild.memberCount}` })
        .setTimestamp();

      await channel.send({ content: `<@${member.id}>`, embeds: [embed], files: [attachment] });
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
  if (member.user?.bot) return;

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

    const memberCount = member.guild.memberCount;
    let messageContent = (config.goodbye_message || '')
      .replace(/{mention}/g, `<@${member.id}>`)
      .replace(/{username}/g, member.user.username)
      .replace(/{user}/g, member.user.tag)
      .replace(/{server}/g, member.guild.name)
      .replace(/{memberCount}/g, memberCount.toString())
      .replace(/{member_count}/g, memberCount.toString())
      .replace(/{count}/g, memberCount.toString());

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
