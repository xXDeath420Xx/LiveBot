import { createCanvas, loadImage, registerFont } from 'canvas';
import path from 'path';
import logger from './logger.js';

/**
 * Load background based on customization type
 */
async function loadBackground(ctx, width, height, c) {
  switch (c.background_type) {
    case 'solid': {
      ctx.fillStyle = c.background_value || '#1a1a2e';
      ctx.fillRect(0, 0, width, height);
      break;
    }
    case 'image': {
      try {
        const imgPath = path.resolve(`./data/rank-backgrounds/${c.guild_id}/${c.user_id}.png`);
        const bg = await loadImage(imgPath);
        ctx.drawImage(bg, 0, 0, width, height);
      } catch (err) {
        logger.warn('[RankCard] Failed to load custom background image, falling back to gradient', { error: err.message });
        // Fall back to default gradient
        const fallback = ctx.createLinearGradient(0, 0, width, height);
        fallback.addColorStop(0, '#1a1a2e');
        fallback.addColorStop(0.5, '#16213e');
        fallback.addColorStop(1, '#0f3460');
        ctx.fillStyle = fallback;
        ctx.fillRect(0, 0, width, height);
      }
      break;
    }
    case 'preset': {
      try {
        const presetPath = path.resolve(`./assets/rank-presets/${c.background_value}.png`);
        const bg = await loadImage(presetPath);
        ctx.drawImage(bg, 0, 0, width, height);
      } catch (err) {
        logger.warn('[RankCard] Failed to load preset background, falling back to gradient', { error: err.message, preset: c.background_value });
        const fallback = ctx.createLinearGradient(0, 0, width, height);
        fallback.addColorStop(0, '#1a1a2e');
        fallback.addColorStop(0.5, '#16213e');
        fallback.addColorStop(1, '#0f3460');
        ctx.fillStyle = fallback;
        ctx.fillRect(0, 0, width, height);
      }
      break;
    }
    case 'gradient':
    default: {
      let startColor = '#1a1a2e';
      let midColor = '#16213e';
      let endColor = '#0f3460';

      if (c.background_value) {
        try {
          const parsed = JSON.parse(c.background_value);
          startColor = parsed.start || startColor;
          midColor = parsed.mid || midColor;
          endColor = parsed.end || endColor;
        } catch {
          // Invalid JSON, use defaults
        }
      }

      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, startColor);
      gradient.addColorStop(0.5, midColor);
      gradient.addColorStop(1, endColor);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);

      // Add subtle pattern overlay for gradient backgrounds
      ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
      for (let i = 0; i < width; i += 20) {
        ctx.fillRect(i, 0, 1, height);
      }
      for (let i = 0; i < height; i += 20) {
        ctx.fillRect(0, i, width, 1);
      }
      break;
    }
  }
}

/**
 * Generate a rank card image for a user
 * @param {Object} user - Discord user object
 * @param {Object} rankData - User rank data (xp, level, rank, etc.)
 * @param {Object} member - Discord guild member object (optional, for role color)
 * @returns {Buffer} PNG image buffer
 */
export async function generateRankCard(user, rankData, member = null, customization = null) {
  try {
    // Canvas dimensions
    const width = 934;
    const height = 282;

    const defaults = {
      background_type: 'gradient',
      background_value: null,
      overlay_opacity: 0.6,
      progress_bar_color_start: '#667eea',
      progress_bar_color_end: '#764ba2',
      username_color: '#ffffff',
      xp_text_color: '#b9bbbe',
      level_color: '#ffffff',
      rank_color: '#ffd700',
      avatar_border_color: '#3498db',
      avatar_border_enabled: 1
    };
    const c = { ...defaults, ...(customization || {}) };

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Background
    await loadBackground(ctx, width, height, c);

    // Overlay
    ctx.fillStyle = `rgba(0, 0, 0, ${c.overlay_opacity})`;
    ctx.fillRect(0, 0, width, height);

    // Card border (only on non-image backgrounds for clean look)
    if (c.background_type !== 'image' && c.background_type !== 'preset') {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 4;
      ctx.strokeRect(0, 0, width, height);
    }

    // Avatar circle background
    ctx.beginPath();
    ctx.arc(141, 141, 110, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = '#2c3e50';
    ctx.fill();
    if (c.avatar_border_enabled) {
      ctx.strokeStyle = c.avatar_border_color;
      ctx.lineWidth = 8;
      ctx.stroke();
    }

    // Load and draw avatar
    try {
      const avatarURL = user.displayAvatarURL({ extension: 'png', size: 256 });
      const avatar = await loadImage(avatarURL);

      ctx.save();
      ctx.beginPath();
      ctx.arc(141, 141, 100, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(avatar, 41, 41, 200, 200);
      ctx.restore();
    } catch (error) {
      logger.error('[RankCard] Failed to load avatar', { error: error.message });
      // Draw placeholder circle
      ctx.fillStyle = '#7289da';
      ctx.beginPath();
      ctx.arc(141, 141, 100, 0, Math.PI * 2);
      ctx.fill();
    }

    // Username
    ctx.font = 'bold 42px Arial';
    ctx.fillStyle = c.username_color;
    ctx.textAlign = 'left';

    const username = user.username.length > 20 ? user.username.substring(0, 17) + '...' : user.username;
    ctx.fillText(username, 280, 90);

    // Discriminator (if exists)
    if (user.discriminator && user.discriminator !== '0') {
      ctx.font = '32px Arial';
      ctx.fillStyle = c.xp_text_color;
      const usernameWidth = ctx.measureText(username).width;
      ctx.fillText(`#${user.discriminator}`, 290 + usernameWidth, 90);
    }

    // Rank badge
    ctx.font = 'bold 28px Arial';
    ctx.fillStyle = c.rank_color;
    ctx.textAlign = 'right';
    ctx.fillText(`RANK #${rankData.rank}`, width - 40, 60);

    // Level badge
    ctx.fillStyle = c.level_color;
    ctx.fillText(`LEVEL ${rankData.level}`, width - 40, 100);

    // XP Progress text
    ctx.font = '24px Arial';
    ctx.fillStyle = c.xp_text_color;
    ctx.textAlign = 'left';
    ctx.fillText(`${rankData.xp} / ${rankData.xpForNextLevel} XP`, 280, 140);

    // Progress bar background
    const barX = 280;
    const barY = 160;
    const barWidth = width - barX - 40;
    const barHeight = 40;
    const barRadius = 20;

    // Draw rounded rectangle for background
    ctx.fillStyle = '#2c2f33';
    roundRect(ctx, barX, barY, barWidth, barHeight, barRadius);

    // Progress bar fill
    const progress = Math.min(rankData.xp / rankData.xpForNextLevel, 1);
    const fillWidth = barWidth * progress;

    if (fillWidth > 0) {
      const progressGradient = ctx.createLinearGradient(barX, barY, barX + fillWidth, barY);
      progressGradient.addColorStop(0, c.progress_bar_color_start);
      progressGradient.addColorStop(1, c.progress_bar_color_end);

      ctx.fillStyle = progressGradient;
      roundRect(ctx, barX, barY, fillWidth, barHeight, barRadius);
    }

    // Progress percentage
    ctx.font = 'bold 22px Arial';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    const percentage = Math.floor(progress * 100);
    ctx.fillText(`${percentage}%`, barX + barWidth / 2, barY + barHeight / 2 + 8);

    // Stats section
    const statsY = 230;
    ctx.font = '20px Arial';
    ctx.fillStyle = c.xp_text_color;
    ctx.textAlign = 'left';

    // Total XP
    ctx.fillText(`Total XP: ${rankData.totalXP}`, 280, statsY);

    // Voice stats
    if (rankData.totalVoiceMinutes > 0) {
      const voiceText = `Voice: ${formatVoiceTime(rankData.totalVoiceMinutes)} (${rankData.voiceXP} XP)`;
      const totalXPWidth = ctx.measureText(`Total XP: ${rankData.totalXP}`).width;
      ctx.fillText(voiceText, 280 + totalXPWidth + 40, statsY);
    }

    // Role color accent (if member provided)
    if (member && member.displayHexColor && member.displayHexColor !== '#000000') {
      ctx.fillStyle = member.displayHexColor;
      ctx.fillRect(0, 0, 8, height);
    }

    return canvas.toBuffer('image/png');
  } catch (error) {
    logger.error('[RankCard] Failed to generate rank card', { error: error.message, stack: error.stack });
    throw error;
  }
}

/**
 * Helper function to draw rounded rectangles
 */
function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fill();
}

/**
 * Format voice time for display
 */
function formatVoiceTime(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${days}d ${remainingHours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }

  return `${mins}m`;
}

/**
 * Alternative simple rank card generator (fallback if canvas fails)
 */
export async function generateSimpleRankCard(user, rankData) {
  const width = 800;
  const height = 250;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Simple background
  ctx.fillStyle = '#2c2f33';
  ctx.fillRect(0, 0, width, height);

  // Border
  ctx.strokeStyle = '#7289da';
  ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, width, height);

  // Text
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 36px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(user.username, width / 2, 60);

  ctx.font = '28px Arial';
  ctx.fillText(`Level ${rankData.level} | Rank #${rankData.rank}`, width / 2, 110);

  ctx.font = '24px Arial';
  ctx.fillText(`${rankData.xp} / ${rankData.xpForNextLevel} XP`, width / 2, 150);

  // Progress bar
  const barWidth = width - 100;
  const barHeight = 30;
  const barX = 50;
  const barY = 180;

  ctx.fillStyle = '#40444b';
  ctx.fillRect(barX, barY, barWidth, barHeight);

  const progress = Math.min(rankData.xp / rankData.xpForNextLevel, 1);
  ctx.fillStyle = '#7289da';
  ctx.fillRect(barX, barY, barWidth * progress, barHeight);

  return canvas.toBuffer('image/png');
}

export default { generateRankCard, generateSimpleRankCard };
