import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { EmbedBuilder } from 'discord.js';

class ScheduleManager {
  constructor(client) {
    this.client = client;
    this.tickerInterval = null;
    logger.info('[ScheduleManager] Schedule manager initialized');
  }

  // ==================== EVENT METHODS ====================

  async createEvent(guildId, data, createdBy) {
    const { slug, name, description, websiteUrl, twitchChannel, startDate, endDate, timezone } = data;

    const [result] = await pool.execute(
      `INSERT INTO schedule_events
       (guild_id, slug, name, description, website_url, twitch_channel, start_date, end_date, timezone, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [guildId, slug, name, description || null, websiteUrl || null, twitchChannel || null,
       startDate || null, endDate || null, timezone || 'UTC', createdBy]
    );

    logger.info('[ScheduleManager] Event created', { guildId, slug, eventId: result.insertId });
    return result.insertId;
  }

  async getEvent(guildId, slugOrId) {
    const isNumeric = !isNaN(slugOrId);
    const [rows] = await pool.execute(
      isNumeric
        ? 'SELECT * FROM schedule_events WHERE id = ? AND guild_id = ?'
        : 'SELECT * FROM schedule_events WHERE slug = ? AND guild_id = ?',
      [slugOrId, guildId]
    );
    return rows[0] || null;
  }

  async listEvents(guildId, activeOnly = true) {
    const query = activeOnly
      ? 'SELECT * FROM schedule_events WHERE guild_id = ? AND is_active = TRUE ORDER BY created_at DESC'
      : 'SELECT * FROM schedule_events WHERE guild_id = ? ORDER BY created_at DESC';
    const [rows] = await pool.execute(query, [guildId]);
    return rows;
  }

  async updateEvent(eventId, data) {
    const fields = [];
    const values = [];

    const allowedFields = ['name', 'description', 'website_url', 'twitch_channel',
                          'start_date', 'end_date', 'timezone', 'is_active'];

    for (const [key, value] of Object.entries(data)) {
      const dbField = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      if (allowedFields.includes(dbField)) {
        fields.push(`${dbField} = ?`);
        values.push(value);
      }
    }

    if (fields.length === 0) return false;

    values.push(eventId);
    await pool.execute(
      `UPDATE schedule_events SET ${fields.join(', ')} WHERE id = ?`,
      values
    );
    return true;
  }

  async deleteEvent(eventId) {
    await pool.execute('DELETE FROM schedule_events WHERE id = ?', [eventId]);
    logger.info('[ScheduleManager] Event deleted', { eventId });
  }

  // ==================== SCHEDULE METHODS ====================

  async createSchedule(eventId, data) {
    const { slug, name, description, startTime, setupTimeSeconds } = data;

    const [result] = await pool.execute(
      `INSERT INTO schedule_schedules
       (event_id, slug, name, description, start_time, setup_time_seconds)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [eventId, slug, name, description || null, startTime || null, setupTimeSeconds || 300]
    );

    logger.info('[ScheduleManager] Schedule created', { eventId, slug, scheduleId: result.insertId });
    return result.insertId;
  }

  async getSchedule(scheduleId) {
    const [rows] = await pool.execute(
      'SELECT s.*, e.guild_id, e.name as event_name, e.slug as event_slug FROM schedule_schedules s JOIN schedule_events e ON s.event_id = e.id WHERE s.id = ?',
      [scheduleId]
    );
    return rows[0] || null;
  }

  async listSchedules(eventId) {
    const [rows] = await pool.execute(
      'SELECT * FROM schedule_schedules WHERE event_id = ? AND hidden = FALSE ORDER BY start_time, id',
      [eventId]
    );
    return rows;
  }

  async updateSchedule(scheduleId, data) {
    const fields = [];
    const values = [];

    const allowedFields = ['name', 'description', 'start_time', 'setup_time_seconds', 'hidden'];

    for (const [key, value] of Object.entries(data)) {
      const dbField = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      if (allowedFields.includes(dbField)) {
        fields.push(`${dbField} = ?`);
        values.push(value);
      }
    }

    if (fields.length === 0) return false;

    values.push(scheduleId);
    await pool.execute(
      `UPDATE schedule_schedules SET ${fields.join(', ')} WHERE id = ?`,
      values
    );
    return true;
  }

  async deleteSchedule(scheduleId) {
    await pool.execute('DELETE FROM schedule_schedules WHERE id = ?', [scheduleId]);
    logger.info('[ScheduleManager] Schedule deleted', { scheduleId });
  }

  // ==================== ITEM (RUN) METHODS ====================

  async addItem(scheduleId, data) {
    const { gameName, category, runners, estimateSeconds, setupSeconds, scheduledStart, notes, customData } = data;

    // Get next position
    const [[{ maxPos }]] = await pool.execute(
      'SELECT COALESCE(MAX(position), 0) as maxPos FROM schedule_items WHERE schedule_id = ?',
      [scheduleId]
    );

    const [result] = await pool.execute(
      `INSERT INTO schedule_items
       (schedule_id, position, game_name, category, runners, estimate_seconds, setup_seconds, scheduled_start, notes, custom_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [scheduleId, maxPos + 1, gameName, category || null, runners || null,
       estimateSeconds || 0, setupSeconds || 0, scheduledStart || null, notes || null,
       customData ? JSON.stringify(customData) : null]
    );

    logger.info('[ScheduleManager] Item added', { scheduleId, itemId: result.insertId, gameName });
    return result.insertId;
  }

  async getItem(itemId) {
    const [rows] = await pool.execute(
      `SELECT i.*, s.name as schedule_name, s.event_id, e.guild_id, e.name as event_name
       FROM schedule_items i
       JOIN schedule_schedules s ON i.schedule_id = s.id
       JOIN schedule_events e ON s.event_id = e.id
       WHERE i.id = ?`,
      [itemId]
    );
    return rows[0] || null;
  }

  async listItems(scheduleId) {
    const [rows] = await pool.execute(
      'SELECT * FROM schedule_items WHERE schedule_id = ? ORDER BY position',
      [scheduleId]
    );
    return rows;
  }

  async updateItem(itemId, data) {
    const fields = [];
    const values = [];

    const allowedFields = ['game_name', 'category', 'runners', 'estimate_seconds',
                          'setup_seconds', 'scheduled_start', 'actual_start', 'actual_end',
                          'status', 'notes', 'custom_data'];

    for (const [key, value] of Object.entries(data)) {
      const dbField = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      if (allowedFields.includes(dbField)) {
        fields.push(`${dbField} = ?`);
        values.push(dbField === 'custom_data' && value ? JSON.stringify(value) : value);
      }
    }

    if (fields.length === 0) return false;

    values.push(itemId);
    await pool.execute(
      `UPDATE schedule_items SET ${fields.join(', ')} WHERE id = ?`,
      values
    );
    return true;
  }

  async deleteItem(itemId) {
    // Get schedule_id before deleting
    const [[item]] = await pool.execute('SELECT schedule_id, position FROM schedule_items WHERE id = ?', [itemId]);
    if (!item) return;

    await pool.execute('DELETE FROM schedule_items WHERE id = ?', [itemId]);

    // Reorder remaining items
    await pool.execute(
      'UPDATE schedule_items SET position = position - 1 WHERE schedule_id = ? AND position > ?',
      [item.schedule_id, item.position]
    );

    logger.info('[ScheduleManager] Item deleted', { itemId });
  }

  async reorderItems(scheduleId, itemIds) {
    for (let i = 0; i < itemIds.length; i++) {
      await pool.execute(
        'UPDATE schedule_items SET position = ? WHERE id = ? AND schedule_id = ?',
        [i + 1, itemIds[i], scheduleId]
      );
    }
  }

  async startItem(itemId) {
    await pool.execute(
      'UPDATE schedule_items SET status = ?, actual_start = NOW() WHERE id = ?',
      ['running', itemId]
    );
    logger.info('[ScheduleManager] Item started', { itemId });
  }

  async completeItem(itemId) {
    await pool.execute(
      'UPDATE schedule_items SET status = ?, actual_end = NOW() WHERE id = ?',
      ['completed', itemId]
    );
    logger.info('[ScheduleManager] Item completed', { itemId });
  }

  // ==================== TICKER METHODS ====================

  async getCurrentItem(scheduleId) {
    const [rows] = await pool.execute(
      `SELECT * FROM schedule_items WHERE schedule_id = ? AND status = 'running' LIMIT 1`,
      [scheduleId]
    );
    return rows[0] || null;
  }

  async getNextItem(scheduleId) {
    const [rows] = await pool.execute(
      `SELECT * FROM schedule_items WHERE schedule_id = ? AND status = 'pending' ORDER BY position LIMIT 1`,
      [scheduleId]
    );
    return rows[0] || null;
  }

  async getTicker(scheduleId) {
    const current = await this.getCurrentItem(scheduleId);
    const next = await this.getNextItem(scheduleId);

    // If no current, get the first pending as "up next"
    if (!current && next) {
      return { current: null, next, upNext: null };
    }

    // Get the one after next
    let upNext = null;
    if (next) {
      const [rows] = await pool.execute(
        `SELECT * FROM schedule_items WHERE schedule_id = ? AND position > ? AND status = 'pending' ORDER BY position LIMIT 1`,
        [scheduleId, next.position]
      );
      upNext = rows[0] || null;
    }

    return { current, next, upNext };
  }

  // ==================== LINKED CHANNEL METHODS ====================

  async linkChannel(guildId, channelId, eventId, scheduleId, options = {}) {
    const { updateType, updateInterval, announceBeforeMinutes, roleToPing } = options;

    await pool.execute(
      `INSERT INTO schedule_linked_channels
       (guild_id, channel_id, event_id, schedule_id, update_type, update_interval_seconds, announce_before_minutes, role_to_ping)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
       schedule_id = VALUES(schedule_id),
       update_type = VALUES(update_type),
       update_interval_seconds = VALUES(update_interval_seconds),
       announce_before_minutes = VALUES(announce_before_minutes),
       role_to_ping = VALUES(role_to_ping)`,
      [guildId, channelId, eventId, scheduleId || null,
       updateType || 'ticker', updateInterval || 60,
       announceBeforeMinutes || 5, roleToPing || null]
    );

    logger.info('[ScheduleManager] Channel linked', { guildId, channelId, eventId });
  }

  async unlinkChannel(channelId, eventId) {
    await pool.execute(
      'DELETE FROM schedule_linked_channels WHERE channel_id = ? AND event_id = ?',
      [channelId, eventId]
    );
    logger.info('[ScheduleManager] Channel unlinked', { channelId, eventId });
  }

  async getLinkedChannels(eventId) {
    const [rows] = await pool.execute(
      'SELECT * FROM schedule_linked_channels WHERE event_id = ?',
      [eventId]
    );
    return rows;
  }

  // ==================== TICKER UPDATE SYSTEM ====================

  startTickerUpdates(intervalMs = 60000) {
    if (this.tickerInterval) {
      clearInterval(this.tickerInterval);
    }

    this.tickerInterval = setInterval(() => this.updateAllTickers(), intervalMs);
    logger.info('[ScheduleManager] Ticker updates started', { intervalMs });
  }

  stopTickerUpdates() {
    if (this.tickerInterval) {
      clearInterval(this.tickerInterval);
      this.tickerInterval = null;
      logger.info('[ScheduleManager] Ticker updates stopped');
    }
  }

  async updateAllTickers() {
    try {
      const [linkedChannels] = await pool.execute(
        `SELECT lc.*, e.name as event_name, e.slug as event_slug
         FROM schedule_linked_channels lc
         JOIN schedule_events e ON lc.event_id = e.id
         WHERE e.is_active = TRUE`
      );

      for (const link of linkedChannels) {
        await this.updateTicker(link).catch(err => {
          logger.error('[ScheduleManager] Error updating ticker', {
            channelId: link.channel_id,
            error: err.message
          });
        });
      }
    } catch (error) {
      logger.error('[ScheduleManager] Error in updateAllTickers', { error: error.message });
    }
  }

  async updateTicker(link) {
    const guild = this.client.guilds.cache.get(link.guild_id);
    if (!guild) return;

    const channel = await guild.channels.fetch(link.channel_id).catch(() => null);
    if (!channel) return;

    // Get the schedule to use (specific or first active)
    let scheduleId = link.schedule_id;
    if (!scheduleId) {
      const schedules = await this.listSchedules(link.event_id);
      if (schedules.length > 0) scheduleId = schedules[0].id;
    }
    if (!scheduleId) return;

    const ticker = await this.getTicker(scheduleId);
    const embed = this.buildTickerEmbed(link.event_name, ticker);

    // Update or create message
    if (link.message_id) {
      try {
        const message = await channel.messages.fetch(link.message_id);
        await message.edit({ embeds: [embed] });
      } catch (e) {
        // Message deleted, create new one
        const newMsg = await channel.send({ embeds: [embed] });
        await pool.execute(
          'UPDATE schedule_linked_channels SET message_id = ?, last_updated = NOW() WHERE id = ?',
          [newMsg.id, link.id]
        );
      }
    } else {
      const newMsg = await channel.send({ embeds: [embed] });
      await pool.execute(
        'UPDATE schedule_linked_channels SET message_id = ?, last_updated = NOW() WHERE id = ?',
        [newMsg.id, link.id]
      );
    }
  }

  buildTickerEmbed(eventName, ticker) {
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(`Schedule: ${eventName}`)
      .setTimestamp();

    if (ticker.current) {
      embed.addFields({
        name: 'Now Playing',
        value: this.formatItem(ticker.current),
        inline: false
      });
    } else {
      embed.addFields({
        name: 'Now Playing',
        value: '*No run in progress*',
        inline: false
      });
    }

    if (ticker.next) {
      embed.addFields({
        name: 'Up Next',
        value: this.formatItem(ticker.next),
        inline: false
      });
    }

    if (ticker.upNext) {
      embed.addFields({
        name: 'Coming Up',
        value: this.formatItem(ticker.upNext),
        inline: false
      });
    }

    return embed;
  }

  formatItem(item) {
    let text = `**${item.game_name}**`;
    if (item.category) text += ` - ${item.category}`;
    if (item.runners) text += `\nRunner(s): ${item.runners}`;
    if (item.estimate_seconds > 0) {
      text += `\nEstimate: ${this.formatDuration(item.estimate_seconds)}`;
    }
    return text;
  }

  formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }

  parseDuration(str) {
    // Parse formats like "1:30:00", "45:00", "1h30m", "90m", etc.
    if (!str) return 0;

    // HH:MM:SS or MM:SS format
    const colonMatch = str.match(/^(\d+):(\d+)(?::(\d+))?$/);
    if (colonMatch) {
      if (colonMatch[3]) {
        // HH:MM:SS
        return parseInt(colonMatch[1]) * 3600 + parseInt(colonMatch[2]) * 60 + parseInt(colonMatch[3]);
      } else {
        // MM:SS
        return parseInt(colonMatch[1]) * 60 + parseInt(colonMatch[2]);
      }
    }

    // 1h30m format
    let total = 0;
    const hourMatch = str.match(/(\d+)h/i);
    const minMatch = str.match(/(\d+)m/i);
    const secMatch = str.match(/(\d+)s/i);

    if (hourMatch) total += parseInt(hourMatch[1]) * 3600;
    if (minMatch) total += parseInt(minMatch[1]) * 60;
    if (secMatch) total += parseInt(secMatch[1]);

    return total;
  }
}

export default ScheduleManager;
