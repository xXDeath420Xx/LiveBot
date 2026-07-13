import { EmbedBuilder, AttachmentBuilder } from 'discord.js';
import crypto from 'crypto';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { getStreamSchedule, getTwitchUser } from '../utils/platforms/twitch-api.js';
import {
  getGuildTimezone,
  formatTimeInZone,
  getZoneAbbreviation,
  getLocalDateParts
} from '../utils/guild-timezone.js';

const CHANGE_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes — wait for streamer to finish editing

// Canvas is optional. If not installed, image generation is skipped and we fall back
// to the text embed.
let Canvas = null;
try { Canvas = await import('canvas'); } catch { /* silent; image gen disabled */ }

// Stable warm palette — categories hash here so the same game always lands on the
// same colour across renders. Shared by the monthly and weekly views.
const PALETTE = ['#F9C9D0', '#FDE5A3', '#C8E6B5', '#FBCBA4', '#D8CCE8', '#BEDCED', '#F2BFAE', '#E8DBB5'];
const strToColor = (s) => {
  if (!s) return '#EEE1C5';
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
};

/**
 * Manages Twitch schedule syncing to Discord
 */
export default class TwitchScheduleManager {
  constructor(client) {
    this.client = client;
  }

  /**
   * Get all enabled schedule syncs for this bot's guilds
   * @returns {Promise<Array>}
   */
  async getEnabledSyncs() {
    try {
      let query = `
        SELECT
          tss.id,
          tss.guild_id,
          tss.streamer_id,
          tss.discord_channel_id,
          tss.mention_role_id,
          tss.custom_message,
          tss.last_synced,
          tss.schedule_hash,
          tss.last_message_id,
          tss.change_detected_at,
          tss.sync_interval_minutes,
          tss.weekly_refresh,
          tss.last_weekly_refresh,
          tss.view_mode,
          tss.force_refresh,
          s.platform_user_id,
          s.username,
          s.profile_image_url
        FROM twitch_schedule_sync_config tss
        JOIN streamers s ON tss.streamer_id = s.streamer_id
        WHERE tss.is_enabled = 1 AND s.platform = 'twitch'
      `;

      const params = [];

      // Filter by this bot's assigned guilds
      if (!this.client.isDefaultBot && this.client.assignedGuilds) {
        query += ` AND tss.guild_id IN (${this.client.assignedGuilds.map(() => '?').join(',')})`;
        params.push(...this.client.assignedGuilds);
      } else if (this.client.isDefaultBot) {
        // Default bot should only process guilds without custom bots
        const [customGuilds] = await pool.execute('SELECT DISTINCT guild_id FROM guild_bot_mapping');
        if (customGuilds.length > 0) {
          const customGuildIds = customGuilds.map(r => r.guild_id);
          query += ` AND tss.guild_id NOT IN (${customGuildIds.map(() => '?').join(',')})`;
          params.push(...customGuildIds);
        }
      }

      const [syncs] = await pool.execute(query, params);
      return syncs;
    } catch (error) {
      logger.error('[TwitchScheduleManager] Error getting enabled syncs:', {
        error: error.message,
        botId: this.client.botId || 'default'
      });
      return [];
    }
  }

  /**
   * Get the Twitch user ID for a streamer
   * @param {Object} syncConfig - The sync configuration
   * @returns {Promise<string|null>}
   */
  async getTwitchUserId(syncConfig) {
    // If platform_user_id is temporary, fetch the real one
    if (syncConfig.platform_user_id && syncConfig.platform_user_id.startsWith('temp_')) {
      try {
        const userData = await getTwitchUser(syncConfig.username);
        if (userData && userData.id) {
          // Update the database with the real user ID
          await pool.execute(
            'UPDATE streamers SET platform_user_id = ? WHERE streamer_id = ?',
            [userData.id, syncConfig.streamer_id]
          );
          return userData.id;
        }
      } catch (error) {
        logger.warn(`[TwitchScheduleManager] Failed to fetch Twitch user ID for ${syncConfig.username}:`, error.message);
      }
    }

    // Return existing user ID if not temporary
    if (syncConfig.platform_user_id && !syncConfig.platform_user_id.startsWith('temp_')) {
      return syncConfig.platform_user_id;
    }

    return null;
  }

  /**
   * Hash schedule segments to detect changes
   */
  hashSchedule(segments) {
    const data = segments.map(s => `${s.start_time}|${s.end_time}|${s.title}|${s.category?.id}`).join('\n');
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
  }

  /**
   * Sync a single schedule configuration
   * Only posts/edits when the schedule actually changes.
   * Waits 10 minutes after detecting a change before posting (so streamers can finish editing).
   */
  async syncSchedule(syncConfig, { skipCooldown = false } = {}) {
    try {
      const twitchUserId = await this.getTwitchUserId(syncConfig);

      if (!twitchUserId) {
        logger.warn(`[TwitchScheduleManager] No valid Twitch user ID for streamer ${syncConfig.username}`);
        if (syncConfig.force_refresh) {
          await pool.execute('UPDATE twitch_schedule_sync_config SET force_refresh = 0 WHERE id = ?', [syncConfig.id]);
        }
        return;
      }

      // Fetch schedule from Twitch API
      const scheduleResponse = await getStreamSchedule(twitchUserId);

      if (!scheduleResponse || !scheduleResponse.data) {
        logger.debug(`[TwitchScheduleManager] No schedule data available for ${syncConfig.username}`);
        if (syncConfig.force_refresh) {
          await pool.execute('UPDATE twitch_schedule_sync_config SET force_refresh = 0 WHERE id = ?', [syncConfig.id]);
        }
        return;
      }

      const scheduleData = scheduleResponse.data.data;

      if (!scheduleData || !scheduleData.segments || scheduleData.segments.length === 0) {
        logger.debug(`[TwitchScheduleManager] No scheduled streams for ${syncConfig.username}`);
        if (syncConfig.force_refresh) {
          await pool.execute('UPDATE twitch_schedule_sync_config SET force_refresh = 0 WHERE id = ?', [syncConfig.id]);
        }
        return;
      }

      // Hash the schedule to detect changes
      const newHash = this.hashSchedule(scheduleData.segments);
      const oldHash = syncConfig.schedule_hash;

      // Weekly refresh — if enabled and 7+ days have passed, always proceed even if hash is unchanged
      const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
      const weeklyDue = !!syncConfig.weekly_refresh && (
        !syncConfig.last_weekly_refresh ||
        (Date.now() - new Date(syncConfig.last_weekly_refresh).getTime()) >= WEEK_MS
      );

      // Skip only if hash matches, message exists, no change is pending, and no weekly refresh due.
      // skipCooldown=true (dashboard force-sync, force_refresh flag) overrides this — a re-render
      // is wanted even when Twitch's data is identical to what's already posted.
      if (!skipCooldown && newHash === oldHash && syncConfig.last_message_id && !syncConfig.change_detected_at && !weeklyDue) {
        logger.debug(`[TwitchScheduleManager] Schedule unchanged for ${syncConfig.username}`);
        return;
      }

      // Cooldown handling
      if (!skipCooldown) {
        if (syncConfig.change_detected_at) {
          // A change was previously detected — we're in the cooldown window
          if (newHash !== oldHash) {
            // Schedule changed AGAIN during cooldown — reset the timer with the new hash
            await pool.execute(
              'UPDATE twitch_schedule_sync_config SET change_detected_at = NOW(), schedule_hash = ? WHERE id = ?',
              [newHash, syncConfig.id]
            );
            logger.info(`[TwitchScheduleManager] Schedule changed again for ${syncConfig.username} — resetting 10 min timer`);
            return;
          }
          // Hash stable since detection — check if cooldown elapsed
          const elapsed = Date.now() - new Date(syncConfig.change_detected_at).getTime();
          if (elapsed < CHANGE_COOLDOWN_MS) {
            logger.debug(`[TwitchScheduleManager] Schedule for ${syncConfig.username} still in cooldown (${Math.floor(elapsed / 1000)}s elapsed)`);
            return;
          }
          // Cooldown elapsed — fall through to post
          logger.info(`[TwitchScheduleManager] Cooldown elapsed for ${syncConfig.username} — posting now`);
        } else if (newHash !== oldHash) {
          // First detection of a change (or first-ever sync where oldHash is NULL)
          await pool.execute(
            'UPDATE twitch_schedule_sync_config SET change_detected_at = NOW(), schedule_hash = ? WHERE id = ?',
            [newHash, syncConfig.id]
          );
          logger.info(`[TwitchScheduleManager] Schedule change detected for ${syncConfig.username} — waiting 10 min before posting`);
          return;
        }
      }

      // Ready to post/edit — cooldown passed or first-time post
      const channel = await this.client.channels.fetch(syncConfig.discord_channel_id).catch(() => null);
      if (!channel) {
        logger.warn(`[TwitchScheduleManager] Channel ${syncConfig.discord_channel_id} not found for guild ${syncConfig.guild_id}`);
        return;
      }

      // Diff-based cancellation detection: segments that were present in the previous
      // sync but are now absent from the Twitch API response — and whose start time
      // hasn't passed yet — count as canceled.
      let previousSegments = [];
      try { previousSegments = syncConfig.previous_segments_json ? JSON.parse(syncConfig.previous_segments_json) : []; } catch {}
      const nowMs = Date.now();
      const currentIds = new Set(scheduleData.segments.map(s => s.id));
      const canceledSegments = previousSegments
        .filter(p => p?.id && !currentIds.has(p.id) && p.start_time && new Date(p.start_time).getTime() > nowMs);

      const embed = await this.buildScheduleEmbed(syncConfig, scheduleData);
      const scheduleImage = await this.buildScheduleImage(syncConfig, scheduleData, canceledSegments).catch(err => {
        logger.warn(`[TwitchScheduleManager] image render failed for ${syncConfig.username}: ${err.message}`);
        return null;
      });
      const webUrl = `https://certifriedmultitool.com/schedule/${encodeURIComponent(syncConfig.username)}`;
      let messageContent = syncConfig.custom_message || `📅 **${syncConfig.username}**'s ꜱᴛʀᴇᴀᴍɪɴɢ ꜱᴄʜᴇᴅᴜʟᴇ\n${webUrl}`;
      if (syncConfig.mention_role_id) {
        // If mention_role_id equals guild_id, it's the @everyone role — use plain text
        if (syncConfig.mention_role_id === syncConfig.guild_id) {
          messageContent = `@everyone ${messageContent}`;
        } else {
          messageContent = `<@&${syncConfig.mention_role_id}> ${messageContent}`;
        }
      }

      const messagePayload = { content: messageContent, embeds: [embed] };
      if (scheduleImage) {
        messagePayload.files = [new AttachmentBuilder(scheduleImage, { name: `${syncConfig.username}-schedule.png` })];
        embed.setImage(`attachment://${syncConfig.username}-schedule.png`);
      }
      let messageId = syncConfig.last_message_id;

      // Weekly refresh already computed above as `weeklyDue`.
      // When due AND we have a prior message, delete it and force a fresh send below.
      if (weeklyDue && messageId) {
        try {
          const oldMsg = await channel.messages.fetch(messageId).catch(() => null);
          if (oldMsg) {
            await oldMsg.delete().catch(err => {
              logger.warn(`[TwitchScheduleManager] Weekly refresh: failed to delete old message ${messageId} for ${syncConfig.username}: ${err.message}`);
            });
            logger.info(`[TwitchScheduleManager] Weekly refresh: deleted old schedule message for ${syncConfig.username} in guild ${syncConfig.guild_id}`);
          }
        } catch (err) {
          logger.warn(`[TwitchScheduleManager] Weekly refresh cleanup error for ${syncConfig.username}: ${err.message}`);
        }
        messageId = null; // force a fresh send
      }

      // Try to edit existing message first (unless weekly refresh cleared it)
      if (messageId) {
        try {
          const existingMsg = await channel.messages.fetch(messageId);
          await existingMsg.edit(messagePayload);
          logger.info(`[TwitchScheduleManager] Edited schedule for ${syncConfig.username} in guild ${syncConfig.guild_id}`);
        } catch (err) {
          logger.warn(`[TwitchScheduleManager] Failed to edit existing schedule message ${messageId} for ${syncConfig.username} in guild ${syncConfig.guild_id} (${err.message}) — sending new message`);
          messageId = null;
        }
      }

      // Send new message if no existing message to edit
      if (!messageId) {
        const newMsg = await channel.send(messagePayload);
        messageId = newMsg.id;
        logger.info(`[TwitchScheduleManager] Posted new schedule for ${syncConfig.username} in guild ${syncConfig.guild_id}`);
      }

      // Snapshot current segments so the next sync can diff for cancellations.
      const segmentsSnapshot = JSON.stringify(scheduleData.segments.map(s => ({
        id: s.id, title: s.title, start_time: s.start_time, end_time: s.end_time,
        category: s.category ? { id: s.category.id, name: s.category.name } : null,
      })));

      // Update DB: hash, message ID, timestamps, clear change timer, snapshot segments.
      // When weekly refresh fired, also update last_weekly_refresh.
      if (weeklyDue) {
        await pool.execute(
          'UPDATE twitch_schedule_sync_config SET schedule_hash = ?, last_message_id = ?, last_synced = NOW(), last_weekly_refresh = NOW(), change_detected_at = NULL, previous_segments_json = ?, force_refresh = 0 WHERE id = ?',
          [newHash, messageId, segmentsSnapshot, syncConfig.id]
        ).catch(async (e) => {
          if (!/Unknown column/i.test(e.message)) throw e;
          await pool.execute('UPDATE twitch_schedule_sync_config SET schedule_hash = ?, last_message_id = ?, last_synced = NOW(), last_weekly_refresh = NOW(), change_detected_at = NULL, force_refresh = 0 WHERE id = ?', [newHash, messageId, syncConfig.id]);
        });
      } else {
        await pool.execute(
          'UPDATE twitch_schedule_sync_config SET schedule_hash = ?, last_message_id = ?, last_synced = NOW(), change_detected_at = NULL, previous_segments_json = ?, force_refresh = 0 WHERE id = ?',
          [newHash, messageId, segmentsSnapshot, syncConfig.id]
        ).catch(async (e) => {
          if (!/Unknown column/i.test(e.message)) throw e;
          await pool.execute('UPDATE twitch_schedule_sync_config SET schedule_hash = ?, last_message_id = ?, last_synced = NOW(), change_detected_at = NULL, force_refresh = 0 WHERE id = ?', [newHash, messageId, syncConfig.id]);
        });
      }
    } catch (error) {
      logger.error(`[TwitchScheduleManager] Error syncing schedule for ${syncConfig.username}:`, {
        error: error.message,
        stack: error.stack,
        guildId: syncConfig.guild_id
      });
    }
  }

  /**
   * Build an embed with the schedule information
   * @param {Object} syncConfig - The sync configuration
   * @param {Object} scheduleData - The schedule data from Twitch
   * @returns {Promise<EmbedBuilder>}
   */
  async buildScheduleEmbed(syncConfig, scheduleData) {
    const embed = new EmbedBuilder()
      .setColor('#9146FF') // Twitch purple
      .setTitle(`📅 ${syncConfig.username}'s ꜱᴛʀᴇᴀᴍɪɴɢ ꜱᴄʜᴇᴅᴜʟᴇ`)
      .setURL(`https://twitch.tv/${syncConfig.username}`)
      .setTimestamp();

    if (syncConfig.profile_image_url) {
      embed.setThumbnail(syncConfig.profile_image_url);
    }

    // Add scheduled streams (limit to next 10)
    const segments = scheduleData.segments.slice(0, 10);

    for (const segment of segments) {
      const startTime = new Date(segment.start_time);
      const discordTimestamp = Math.floor(startTime.getTime() / 1000);

      let fieldValue = `<t:${discordTimestamp}:F> (<t:${discordTimestamp}:R>)`;

      if (segment.category && segment.category.name) {
        fieldValue += `\n🎮 ${segment.category.name}`;
      }

      embed.addFields({
        name: segment.title || 'Scheduled Stream',
        value: fieldValue,
        inline: false
      });
    }

    if (scheduleData.segments.length > 10) {
      embed.setFooter({
        text: `Showing 10 of ${scheduleData.segments.length} scheduled streams`
      });
    }

    return embed;
  }

  /**
   * Dispatcher — picks monthly or weekly renderer based on syncConfig.view_mode.
   * All times are rendered in the guild's configured timezone (or UTC if unset),
   * and segments are bucketed into the guild-local day so a stream that's "tonight"
   * locally never appears under tomorrow's date because of UTC rollover.
   */
  async buildScheduleImage(syncConfig, scheduleData, canceledSegments = []) {
    if (!Canvas) return null;
    const segments = scheduleData.segments || [];
    if (!segments.length && !canceledSegments.length) return null;

    const tz = await getGuildTimezone(syncConfig.guild_id);
    const referenceDate = new Date(
      (segments[0] || canceledSegments[0])?.start_time || Date.now()
    );
    const zoneAbbr = getZoneAbbreviation(tz, referenceDate);

    const mode = syncConfig.view_mode === 'weekly' ? 'weekly' : 'monthly';
    if (mode === 'weekly') {
      return this._buildWeeklyImage(syncConfig, segments, canceledSegments, tz, zoneAbbr);
    }
    return this._buildMonthlyImage(syncConfig, segments, canceledSegments, tz, zoneAbbr);
  }

  /**
   * Render a full-month calendar image of the Twitch schedule. Sun–Sat columns,
   * up to 6 rows of dates, color-coded blocks per stream category. Canceled
   * segments are rendered red with a strikethrough + "CANCELLED" badge.
   *
   * Design inspired by user-supplied reference (docs/April2026.jpg).
   */
  async _buildMonthlyImage(syncConfig, segments, canceledSegments, tz, zoneAbbr) {
    // Pivot to the earliest segment, but bucket by the guild-local calendar.
    const earliest = [...segments, ...canceledSegments]
      .map(s => new Date(s.start_time))
      .sort((a, b) => a - b)[0] || new Date();
    const earliestParts = getLocalDateParts(earliest, tz);
    const year = earliestParts.year;
    const month = earliestParts.month;       // 0-indexed
    const firstParts = getLocalDateParts(new Date(Date.UTC(year, month, 1, 12)), tz);
    const lastParts  = getLocalDateParts(new Date(Date.UTC(year, month + 1, 0, 12)), tz);
    const firstWeekday = firstParts.weekday; // 0 = Sun
    const daysInMonth  = lastParts.day;
    const numRows = Math.ceil((firstWeekday + daysInMonth) / 7);

    // Layout
    const width = 1650, headerHeight = 180, dowHeight = 48, cellHeight = 170, footerHeight = 60;
    const height = headerHeight + dowHeight + cellHeight * numRows + footerHeight;
    const canvas = Canvas.createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#FFF8E6';
    ctx.fillRect(0, 0, width, height);

    // Header banner
    ctx.fillStyle = '#5E3B1E';
    ctx.fillRect(0, 0, width, headerHeight);
    ctx.fillStyle = '#F5C26B';
    ctx.fillRect(0, headerHeight - 8, width, 8);

    // Title — month name from a date safely inside the local month
    const localMonthAnchor = new Date(Date.UTC(year, month, 15, 12));
    const monthName = formatTimeInZone(localMonthAnchor, tz, { month: 'long', year: 'numeric' });
    const streamerName = (syncConfig.username || 'Streamer');
    ctx.textAlign = 'center';
    ctx.fillStyle = '#F5C26B';
    ctx.font = 'bold italic 60px Arial';
    ctx.fillText(`${streamerName}'s ${monthName}`, width / 2, 80);
    ctx.fillStyle = '#FFEFCE';
    ctx.font = 'italic 36px Arial';
    ctx.fillText('Streaming Schedule', width / 2, 130);
    ctx.fillStyle = '#C7A679';
    ctx.font = '18px Arial';
    ctx.fillText('twitch.tv/' + streamerName, width / 2, 158);

    // Day-of-week header row
    this._drawDowHeader(ctx, headerHeight, dowHeight, width);

    // Index segments by guild-local date-of-month, dropping any that fall
    // outside the rendered month after the TZ shift.
    const byDate = {};
    const indexInto = (list, canceled) => {
      for (const s of list) {
        const p = getLocalDateParts(new Date(s.start_time), tz);
        if (p.year !== year || p.month !== month) continue;
        (byDate[p.day] ||= []).push({ ...s, canceled, _localHour: p.hour, _localMin: p.minute });
      }
    };
    indexInto(segments, false);
    indexInto(canceledSegments, true);

    const colW = width / 7;
    ctx.lineWidth = 1;
    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < 7; col++) {
        const idx = row * 7 + col;
        const dateNum = idx - firstWeekday + 1;
        const x = col * colW;
        const y = headerHeight + dowHeight + row * cellHeight;

        ctx.strokeStyle = '#C7A679';
        ctx.strokeRect(x, y, colW, cellHeight);

        if (dateNum < 1 || dateNum > daysInMonth) {
          ctx.fillStyle = '#F0E3C8';
          ctx.fillRect(x + 1, y + 1, colW - 2, cellHeight - 2);
          continue;
        }

        ctx.fillStyle = '#5E3B1E';
        ctx.font = 'bold 22px Arial';
        ctx.textAlign = 'left';
        ctx.fillText(String(dateNum), x + 10, y + 26);

        const segs = (byDate[dateNum] || []).sort((a, b) => a.start_time.localeCompare(b.start_time));
        if (segs.length === 0) {
          ctx.fillStyle = '#E6D6BA';
          ctx.fillRect(x + 6, y + 38, colW - 12, 36);
          ctx.fillStyle = '#7A6A5A';
          ctx.font = 'italic 22px Arial';
          ctx.textAlign = 'center';
          ctx.fillText('No Stream', x + colW / 2, y + 62);
          continue;
        }

        // Up to 2 segments per cell (monthly grid is space-constrained)
        const maxSegs = Math.min(segs.length, 2);
        const blockH = (cellHeight - 44) / maxSegs - 4;
        let sy = y + 38;
        for (let i = 0; i < maxSegs; i++) {
          this._drawSegmentBlock(ctx, segs[i], x + 6, sy, colW - 12, blockH, tz, zoneAbbr, {
            titleMax: 26, categoryMax: 22, titleFont: 'bold 17px Arial', timeFont: 'bold 16px Arial'
          });
          sy += blockH + 4;
        }
      }
    }

    this._drawFooter(ctx, width, height, footerHeight, tz, zoneAbbr);
    return canvas.toBuffer('image/png');
  }

  /**
   * Render a 7-day weekly view. Sun–Sat columns, single tall row, more vertical
   * space per cell so up to 4 segments per day fit without truncation. The week
   * anchor is the Sunday containing (or preceding) the first upcoming/in-progress
   * segment in the guild's local timezone.
   */
  async _buildWeeklyImage(syncConfig, segments, canceledSegments, tz, zoneAbbr) {
    const nowMs = Date.now();
    const upcoming = segments
      .map(s => ({ s, t: new Date(s.start_time).getTime() }))
      .sort((a, b) => a.t - b.t)
      .find(({ s, t }) => t + (60 * 60 * 1000) > nowMs);   // first stream not finished an hour ago
    const anchorInstant = upcoming ? new Date(upcoming.s.start_time) : new Date();
    const anchorParts = getLocalDateParts(anchorInstant, tz);

    // Walk back to the Sunday of the anchor's week (in tz).
    // Build a UTC midnight for the anchor day, then subtract `weekday` days. The
    // resulting instant lives somewhere in Sunday in `tz` regardless of offset.
    const anchorUtcNoon = new Date(Date.UTC(anchorParts.year, anchorParts.month, anchorParts.day, 12));
    const sundayInstant = new Date(anchorUtcNoon.getTime() - anchorParts.weekday * 86_400_000);

    const days = [];
    for (let i = 0; i < 7; i++) {
      const dayInstant = new Date(sundayInstant.getTime() + i * 86_400_000);
      const p = getLocalDateParts(dayInstant, tz);
      days.push({ ...p, segments: [] });
    }

    // Bucket segments by guild-local Y/M/D match against `days`.
    const indexInto = (list, canceled) => {
      for (const s of list) {
        const p = getLocalDateParts(new Date(s.start_time), tz);
        const slot = days.findIndex(d => d.year === p.year && d.month === p.month && d.day === p.day);
        if (slot === -1) continue;
        days[slot].segments.push({ ...s, canceled, _localHour: p.hour, _localMin: p.minute });
      }
    };
    indexInto(segments, false);
    indexInto(canceledSegments, true);

    // Layout — fewer cells but each is much taller so 4 segments + meta fit.
    const width = 1650, headerHeight = 180, dowHeight = 60, cellHeight = 480, footerHeight = 60;
    const height = headerHeight + dowHeight + cellHeight + footerHeight;
    const canvas = Canvas.createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#FFF8E6';
    ctx.fillRect(0, 0, width, height);

    // Header banner
    ctx.fillStyle = '#5E3B1E';
    ctx.fillRect(0, 0, width, headerHeight);
    ctx.fillStyle = '#F5C26B';
    ctx.fillRect(0, headerHeight - 8, width, 8);

    const streamerName = (syncConfig.username || 'Streamer');
    const weekStartLabel = formatTimeInZone(sundayInstant, tz, { month: 'long', day: 'numeric' });
    const weekEndInstant = new Date(sundayInstant.getTime() + 6 * 86_400_000);
    const weekEndLabel = formatTimeInZone(weekEndInstant, tz, { month: 'long', day: 'numeric', year: 'numeric' });
    ctx.textAlign = 'center';
    ctx.fillStyle = '#F5C26B';
    ctx.font = 'bold italic 56px Arial';
    ctx.fillText(`${streamerName}'s Week`, width / 2, 76);
    ctx.fillStyle = '#FFEFCE';
    ctx.font = 'italic 32px Arial';
    ctx.fillText(`${weekStartLabel} – ${weekEndLabel}`, width / 2, 124);
    ctx.fillStyle = '#C7A679';
    ctx.font = '18px Arial';
    ctx.fillText('twitch.tv/' + streamerName, width / 2, 158);

    // Day-of-week header row — show Sun/Mon/etc. + the local date number
    ctx.fillStyle = '#EEDBB6';
    ctx.fillRect(0, headerHeight, width, dowHeight);
    ctx.strokeStyle = '#C7A679';
    ctx.lineWidth = 1;
    const colW = width / 7;
    const dowLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (let i = 0; i < 7; i++) {
      ctx.strokeRect(i * colW, headerHeight, colW, dowHeight);
      ctx.fillStyle = '#5E3B1E';
      ctx.textAlign = 'center';
      ctx.font = 'bold 22px Arial';
      ctx.fillText(dowLabels[i], i * colW + colW / 2, headerHeight + 26);
      ctx.font = '18px Arial';
      ctx.fillText(String(days[i].day), i * colW + colW / 2, headerHeight + 50);
    }

    // Render each day cell
    const cellY = headerHeight + dowHeight;
    for (let i = 0; i < 7; i++) {
      const x = i * colW;
      ctx.strokeStyle = '#C7A679';
      ctx.strokeRect(x, cellY, colW, cellHeight);

      const segs = days[i].segments.sort((a, b) => a.start_time.localeCompare(b.start_time));
      if (segs.length === 0) {
        ctx.fillStyle = '#E6D6BA';
        ctx.fillRect(x + 8, cellY + 16, colW - 16, 56);
        ctx.fillStyle = '#7A6A5A';
        ctx.font = 'italic 26px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('No Stream', x + colW / 2, cellY + 52);
        continue;
      }

      // Up to 4 segments — weekly cells are 2.8× taller than monthly so we
      // can show more streams per day without unreadable squish.
      const maxSegs = Math.min(segs.length, 4);
      const innerH = cellHeight - 16;
      const blockH = (innerH / maxSegs) - 8;
      let sy = cellY + 12;
      for (let j = 0; j < maxSegs; j++) {
        this._drawSegmentBlock(ctx, segs[j], x + 8, sy, colW - 16, blockH, tz, zoneAbbr, {
          titleMax: 28, categoryMax: 24, titleFont: 'bold 20px Arial', timeFont: 'bold 18px Arial', categoryFont: '16px Arial'
        });
        sy += blockH + 8;
      }
      if (segs.length > maxSegs) {
        ctx.fillStyle = '#7A6A5A';
        ctx.font = 'italic 14px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(`+${segs.length - maxSegs} more`, x + colW / 2, cellY + cellHeight - 8);
      }
    }

    this._drawFooter(ctx, width, height, footerHeight, tz, zoneAbbr);
    return canvas.toBuffer('image/png');
  }

  // ─── Shared rendering helpers ───────────────────────────────────────────────

  /** Sun–Sat header row for the monthly grid. */
  _drawDowHeader(ctx, headerHeight, dowHeight, width) {
    ctx.fillStyle = '#EEDBB6';
    ctx.fillRect(0, headerHeight, width, dowHeight);
    ctx.strokeStyle = '#C7A679';
    ctx.lineWidth = 1;
    const colW = width / 7;
    const dowLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (let i = 0; i < 7; i++) {
      ctx.strokeRect(i * colW, headerHeight, colW, dowHeight);
      ctx.fillStyle = '#5E3B1E';
      ctx.font = 'bold 24px Arial';
      ctx.textAlign = 'center';
      ctx.fillText(dowLabels[i], i * colW + colW / 2, headerHeight + 32);
    }
  }

  /** Footer bar — always reflects the guild's TZ. */
  _drawFooter(ctx, width, height, footerHeight, tz, zoneAbbr) {
    ctx.fillStyle = '#5E3B1E';
    ctx.fillRect(0, height - footerHeight, width, footerHeight);
    ctx.fillStyle = '#FFEFCE';
    ctx.font = 'bold 18px Arial';
    ctx.textAlign = 'left';
    const tzNote = zoneAbbr === tz ? zoneAbbr : `${zoneAbbr} (${tz})`;
    ctx.fillText(`*** ALL TIMES ARE IN ${tzNote} UNLESS OTHERWISE NOTED ***`, 30, height - 24);
    ctx.textAlign = 'right';
    ctx.font = '16px Arial';
    const updated = formatTimeInZone(new Date(), tz, { dateStyle: 'medium', timeStyle: 'short' });
    ctx.fillText(`Updated ${updated} ${zoneAbbr}`, width - 30, height - 24);
  }

  /**
   * Draw a single stream block (rectangle + title + category + time).
   * Shared by the monthly and weekly renderers so they always agree on style.
   */
  _drawSegmentBlock(ctx, s, x, y, w, h, tz, zoneAbbr, opts = {}) {
    const {
      titleMax = 26, categoryMax = 22,
      titleFont = 'bold 17px Arial',
      timeFont = 'bold 16px Arial',
      categoryFont = '14px Arial'
    } = opts;

    const color = s.canceled ? '#E8ADAD' : strToColor(s.category?.name || s.title);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = s.canceled ? '#B33A3A' : '#BDA47A';
    ctx.strokeRect(x, y, w, h);

    const title = (s.title || 'Stream').slice(0, titleMax);
    const category = (s.category?.name || '').slice(0, categoryMax);
    const startLocal = formatTimeInZone(new Date(s.start_time), tz, {
      hour: 'numeric', minute: '2-digit'
    });

    ctx.textAlign = 'center';
    ctx.fillStyle = s.canceled ? '#8B2C2C' : '#3D2B1F';
    ctx.font = titleFont;
    const titleY = y + 24;
    const titleText = s.canceled ? 'CANCELLED' : title;
    ctx.fillText(titleText, x + w / 2, titleY);
    if (s.canceled) {
      const tw = ctx.measureText(titleText).width;
      ctx.strokeStyle = '#8B2C2C';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + w / 2 - tw / 2 - 3, titleY - 5);
      ctx.lineTo(x + w / 2 + tw / 2 + 3, titleY - 5);
      ctx.stroke();
    }
    if (!s.canceled && category) {
      ctx.fillStyle = '#5E3B1E';
      ctx.font = categoryFont;
      ctx.fillText(category, x + w / 2, titleY + 22);
    }
    ctx.fillStyle = s.canceled ? '#8B2C2C' : '#5E3B1E';
    ctx.font = timeFont;
    ctx.fillText(`${startLocal} ${zoneAbbr}`, x + w / 2, y + h - 10);
  }

  /**
   * Process all enabled schedule syncs.
   * Skips syncs whose sync_interval_minutes hasn't elapsed since last_synced
   * AND which are not due for a weekly refresh — avoids redundant Twitch API calls.
   */
  async processAllSyncs() {
    try {
      const syncs = await this.getEnabledSyncs();

      if (syncs.length === 0) {
        logger.debug(`[TwitchScheduleManager] No enabled schedule syncs for bot ${this.client.botId || 'default'}`);
        return;
      }

      const now = Date.now();
      const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

      const due = syncs.filter(sync => {
        // One-shot operator-triggered refresh — always due, bypasses cooldown
        // (handled by passing skipCooldown:true below).
        if (sync.force_refresh) return true;
        // Due for weekly refresh? Never skip even if interval hasn't elapsed.
        if (sync.weekly_refresh) {
          const lastWeekly = sync.last_weekly_refresh ? new Date(sync.last_weekly_refresh).getTime() : 0;
          if (now - lastWeekly >= WEEK_MS) return true;
        }
        // First sync ever — always due
        if (!sync.last_synced) return true;
        // Check per-sync interval
        const interval = Math.max(15, sync.sync_interval_minutes || 360);
        const lastSynced = new Date(sync.last_synced).getTime();
        return (now - lastSynced) >= interval * 60 * 1000;
      });

      if (due.length === 0) {
        logger.debug(`[TwitchScheduleManager] No syncs due right now (${syncs.length} total, all within their intervals) for bot ${this.client.botId || 'default'}`);
        return;
      }

      logger.info(`[TwitchScheduleManager] Processing ${due.length}/${syncs.length} due schedule sync(s) for bot ${this.client.botId || 'default'}`);

      for (const sync of due) {
        await this.syncSchedule(sync, { skipCooldown: !!sync.force_refresh });

        // Add a small delay between syncs to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      logger.error('[TwitchScheduleManager] Error processing syncs:', {
        error: error.message,
        stack: error.stack
      });
    }
  }
}
