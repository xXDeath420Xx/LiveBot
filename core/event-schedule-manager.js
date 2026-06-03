import { AttachmentBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { weekStartFor, materializeWeek, groupByCategory, scheduleHash, formatTimeLabel } from './event-schedule-helpers.js';
import renderEventSchedule from '../utils/event-schedule-renderer.js';

const COOLDOWN_MS = 10 * 60 * 1000; // mirror the twitch manager's 10-min settle window

class EventScheduleManager {
  constructor(client) { this.client = client; logger.info('[EventSchedule] Manager initialized'); }

  async getConfig(guildId) {
    const [rows] = await pool.execute('SELECT * FROM event_schedule_config WHERE guild_id = ?', [guildId]);
    return rows[0] || null;
  }

  /** Build the renderer model for a set of events + the guild's categories. */
  async buildModel(config, events, categories) {
    const now = new Date();
    const ws = weekStartFor(now);
    const segs = materializeWeek(events, ws);
    if (!segs.length) return { model: null, hash: scheduleHash([]) };
    const sections = groupByCategory(segs, categories).map(sec => ({
      name: sec.name, emoji: sec.emoji, color: sec.color,
      items: sec.items.map(it => {
        const startCol = Math.max(0, Math.min(6, Math.floor((it.start - ws.getTime()) / (24 * 60 * 60 * 1000))));
        const endCol = Math.max(startCol, Math.min(6, Math.floor((it.end - 1 - ws.getTime()) / (24 * 60 * 60 * 1000))));
        return { startCol, span: endCol - startCol + 1, title: it.title, emoji: it.emoji, source: it.source, timeLabel: it.allDay ? 'Time TBD' : formatTimeLabel(it.start, it.end) };
      }),
    }));
    const weekDays = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(ws.getTime() + i * 24 * 60 * 60 * 1000);
      const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const isToday = d.toDateString() === now.toDateString();
      return { label: labels[i], date: `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`, isToday };
    });
    const model = {
      title: config.title || 'Event Calendar',
      timestampLabel: `${now.toISOString().slice(0, 19).replace('T', ' ')} UTC`,
      weekDays, sections, footer: 'Actual event times are subject to change.',
    };
    return { model, hash: scheduleHash(segs) };
  }

  /** Render + post/edit a single board (combined: userId=null; per_user: a specific user). */
  async syncBoard(config, userId) {
    const guildId = config.guild_id;
    const [cats] = await pool.execute('SELECT * FROM event_schedule_categories WHERE guild_id = ? ORDER BY sort_order', [guildId]);
    const eventsSql = userId
      ? 'SELECT * FROM event_schedule_events WHERE guild_id=? AND user_id=?'
      : 'SELECT * FROM event_schedule_events WHERE guild_id=?';
    const [events] = await pool.execute(eventsSql, userId ? [guildId, userId] : [guildId]);

    const { model, hash } = await this.buildModel(config, events, cats);

    const [postRows] = await pool.execute(
      'SELECT * FROM event_schedule_posts WHERE guild_id=? AND user_id <=> ?', [guildId, userId]
    );
    const post = postRows[0];

    // Unchanged content → skip, UNLESS an admin forced a refresh (e.g. to repost
    // a board whose Discord message was deleted while the schedule didn't change).
    if (post && post.schedule_hash === hash && !config.force_refresh) return;

    if (post && post.schedule_hash && post.change_detected_at) {
      const elapsed = Date.now() - new Date(post.change_detected_at).getTime();
      if (elapsed < COOLDOWN_MS && !config.force_refresh) return;
    } else if (post && post.schedule_hash) {
      await pool.execute('UPDATE event_schedule_posts SET change_detected_at=NOW() WHERE id=?', [post.id]);
      if (!config.force_refresh) return;
    }

    const client = global.botManager?.getClientForGuild?.(guildId) || this.client;
    const channel = await client.channels.fetch(config.channel_id).catch(() => null);
    if (!channel?.isTextBased?.()) { logger.warn(`[EventSchedule] No channel for guild ${guildId}`); return; }

    let messageId = post?.last_message_id || null;
    const buffer = model ? await renderEventSchedule(model) : null;
    const content = config.custom_message || (userId ? `<@${userId}>'s event schedule` : null);
    const payload = buffer
      ? { content: content || undefined, files: [new AttachmentBuilder(buffer, { name: 'schedule.png' })] }
      : { content: content || 'No upcoming events.' };

    try {
      if (messageId) {
        const msg = await channel.messages.fetch(messageId).catch(() => null);
        if (msg) await msg.edit(payload); else messageId = (await channel.send(payload)).id;
      } else {
        messageId = (await channel.send(payload)).id;
      }
    } catch (e) { logger.error(`[EventSchedule] post/edit failed for guild ${guildId}: ${e.message}`); return; }

    await pool.execute(
      `INSERT INTO event_schedule_posts (guild_id,user_id,channel_id,last_message_id,schedule_hash,change_detected_at,last_synced)
       VALUES (?,?,?,?,?,NULL,NOW())
       ON DUPLICATE KEY UPDATE channel_id=VALUES(channel_id), last_message_id=VALUES(last_message_id), schedule_hash=VALUES(schedule_hash), change_detected_at=NULL, last_synced=NOW()`,
      [guildId, userId, config.channel_id, messageId, hash]
    );
  }

  async syncGuild(guildId) {
    const config = await this.getConfig(guildId);
    if (!config || !config.is_enabled || !config.channel_id) return;
    if (config.mode === 'per_user') {
      const [owners] = await pool.execute('SELECT DISTINCT user_id FROM event_schedule_events WHERE guild_id=?', [guildId]);
      for (const { user_id } of owners) await this.syncBoard(config, user_id).catch(e => logger.error(`[EventSchedule] user board ${user_id}: ${e.message}`));
    } else {
      await this.syncBoard(config, null);
    }
    if (config.force_refresh) await pool.execute('UPDATE event_schedule_config SET force_refresh=0 WHERE guild_id=?', [guildId]);
  }

  async processAll() {
    const [guilds] = await pool.execute('SELECT guild_id FROM event_schedule_config WHERE is_enabled=1 AND channel_id IS NOT NULL');
    for (const { guild_id } of guilds) await this.syncGuild(guild_id).catch(e => logger.error(`[EventSchedule] guild ${guild_id}: ${e.message}`));
  }
}

export default EventScheduleManager;
