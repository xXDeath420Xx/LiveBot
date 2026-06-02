import express from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { DEFAULT_CATEGORIES } from '../../../migrations/117_event_schedules.js';

const router = express.Router();

/**
 * Best-effort resolution of Discord display names for a set of user IDs in a
 * guild, mirroring the membership-resolution pattern used by achievements.js.
 * Returns Map<userId, username>. Unresolved IDs are simply absent (callers fall
 * back to the raw user_id).
 */
async function resolveUsernames(guildId, userIds) {
  const info = new Map();
  const unique = [...new Set(userIds)].filter(Boolean);
  if (!unique.length) return info;

  const botClient = global.botManager?.getClientForGuild?.(guildId);
  const guild = botClient?.guilds?.cache?.get(guildId);
  if (!guild) return info;

  const misses = [];
  const record = (id, m) => {
    info.set(id, m.displayName || m.user?.username || null);
  };

  for (const id of unique) {
    const m = guild.members.cache.get(id);
    if (m) record(id, m); else misses.push(id);
  }

  if (misses.length) {
    try {
      const fetched = await guild.members.fetch({ user: misses, time: 10000 });
      for (const [id, m] of fetched) record(id, m);
    } catch {
      // Membership unknown — leave them unresolved (callers fall back to ID).
    }
  }

  return info;
}

// Get event-schedule config, categories and events for a guild
router.get('/manage/:guildId/event-schedule', async (req, res) => {
  try {
    const { guildId } = req.params;

    const [[config]] = await pool.execute(
      'SELECT * FROM event_schedule_config WHERE guild_id = ?',
      [guildId]
    );

    const [categories] = await pool.execute(
      'SELECT * FROM event_schedule_categories WHERE guild_id = ? ORDER BY sort_order ASC, id ASC',
      [guildId]
    );

    const [events] = await pool.execute(
      `SELECT e.*, c.name AS category_name, c.emoji AS category_emoji, c.color AS category_color
       FROM event_schedule_events e
       LEFT JOIN event_schedule_categories c ON e.category_id = c.id
       WHERE e.guild_id = ?
       ORDER BY e.id ASC`,
      [guildId]
    );

    // Resolve owner display names best-effort; fall back to raw user_id.
    const names = await resolveUsernames(guildId, events.map(e => e.user_id));
    const decorated = events.map(e => ({ ...e, username: names.get(e.user_id) || null }));

    res.json({
      config: config || null,
      categories,
      events: decorated
    });
  } catch (error) {
    logger.error('[Dashboard] Error fetching event-schedule', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch event schedule' });
  }
});

// Save event-schedule configuration (and seed default categories on first enable)
router.post('/manage/:guildId/event-schedule/config', async (req, res) => {
  try {
    const { guildId } = req.params;
    const { is_enabled, mode, channel_id, title, custom_message } = req.body;

    const safeMode = mode === 'per_user' ? 'per_user' : 'combined';

    await pool.execute(
      `INSERT INTO event_schedule_config
         (guild_id, is_enabled, mode, channel_id, title, custom_message)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         is_enabled = VALUES(is_enabled),
         mode = VALUES(mode),
         channel_id = VALUES(channel_id),
         title = VALUES(title),
         custom_message = VALUES(custom_message)`,
      [
        guildId,
        is_enabled ? 1 : 0,
        safeMode,
        channel_id || null,
        title || 'Event Calendar',
        custom_message || null
      ]
    );

    // Seed default category set when the guild has none yet.
    const [[{ cnt }]] = await pool.execute(
      'SELECT COUNT(*) AS cnt FROM event_schedule_categories WHERE guild_id = ?',
      [guildId]
    );
    if (cnt === 0) {
      for (const cat of DEFAULT_CATEGORIES) {
        await pool.execute(
          'INSERT INTO event_schedule_categories (guild_id, name, emoji, color, sort_order) VALUES (?, ?, ?, ?, ?)',
          [guildId, cat.name, cat.emoji || null, cat.color || '#3498DB', cat.sort_order || 0]
        );
      }
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('[Dashboard] Error saving event-schedule config', { error: error.message });
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

// Add a custom category
router.post('/manage/:guildId/event-schedule/category', async (req, res) => {
  try {
    const { guildId } = req.params;
    const { name, emoji, color } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Category name is required' });
    }

    const [[{ maxOrder }]] = await pool.execute(
      'SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM event_schedule_categories WHERE guild_id = ?',
      [guildId]
    );

    await pool.execute(
      'INSERT INTO event_schedule_categories (guild_id, name, emoji, color, sort_order) VALUES (?, ?, ?, ?, ?)',
      [guildId, String(name).trim().slice(0, 60), emoji || null, color || '#3498DB', maxOrder + 1]
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('[Dashboard] Error adding event-schedule category', { error: error.message });
    res.status(500).json({ error: 'Failed to add category' });
  }
});

// Delete a category
router.delete('/manage/:guildId/event-schedule/category/:id', async (req, res) => {
  try {
    const { guildId, id } = req.params;

    await pool.execute(
      'DELETE FROM event_schedule_categories WHERE guild_id = ? AND id = ?',
      [guildId, id]
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('[Dashboard] Error deleting event-schedule category', { error: error.message });
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

export default router;
