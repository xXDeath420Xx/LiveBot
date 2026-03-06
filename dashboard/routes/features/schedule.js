import express from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const router = express.Router();

// ==================== EVENT ROUTES ====================

// Get all events for a guild
router.get('/manage/:guildId/schedule/events', async (req, res) => {
  try {
    const { guildId } = req.params;

    const [events] = await pool.execute(
      `SELECT * FROM schedule_events WHERE guild_id = ? ORDER BY created_at DESC`,
      [guildId]
    );

    res.json({ events });
  } catch (error) {
    logger.error('[Dashboard] Error fetching schedule events', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// Create event
router.post('/manage/:guildId/schedule/events', async (req, res) => {
  try {
    const { guildId } = req.params;
    const { name, slug, description, twitchChannel } = req.body;

    if (!name || !slug) {
      return res.status(400).json({ error: 'Name and slug are required' });
    }

    const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    // Check for duplicate slug
    const [[existing]] = await pool.execute(
      'SELECT id FROM schedule_events WHERE guild_id = ? AND slug = ?',
      [guildId, cleanSlug]
    );

    if (existing) {
      return res.status(400).json({ error: 'An event with this slug already exists' });
    }

    const [result] = await pool.execute(
      `INSERT INTO schedule_events (guild_id, slug, name, description, twitch_channel, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [guildId, cleanSlug, name, description || null, twitchChannel || null, req.user?.id || 'dashboard']
    );

    res.json({ success: true, eventId: result.insertId });
  } catch (error) {
    logger.error('[Dashboard] Error creating event', { error: error.message });
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// Update event
router.put('/manage/:guildId/schedule/events/:eventId', async (req, res) => {
  try {
    const { guildId, eventId } = req.params;
    const { name, description, twitchChannel, isActive } = req.body;

    const updates = [];
    const values = [];

    if (name !== undefined) { updates.push('name = ?'); values.push(name); }
    if (description !== undefined) { updates.push('description = ?'); values.push(description); }
    if (twitchChannel !== undefined) { updates.push('twitch_channel = ?'); values.push(twitchChannel); }
    if (isActive !== undefined) { updates.push('is_active = ?'); values.push(isActive); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    values.push(eventId, guildId);

    await pool.execute(
      `UPDATE schedule_events SET ${updates.join(', ')} WHERE id = ? AND guild_id = ?`,
      values
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('[Dashboard] Error updating event', { error: error.message });
    res.status(500).json({ error: 'Failed to update event' });
  }
});

// Delete event
router.delete('/manage/:guildId/schedule/events/:eventId', async (req, res) => {
  try {
    const { guildId, eventId } = req.params;

    await pool.execute(
      'DELETE FROM schedule_events WHERE id = ? AND guild_id = ?',
      [eventId, guildId]
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('[Dashboard] Error deleting event', { error: error.message });
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

// ==================== SCHEDULE ROUTES ====================

// Get schedules for an event
router.get('/manage/:guildId/schedule/events/:eventId/schedules', async (req, res) => {
  try {
    const { guildId, eventId } = req.params;

    // Verify event belongs to guild
    const [[event]] = await pool.execute(
      'SELECT id FROM schedule_events WHERE id = ? AND guild_id = ?',
      [eventId, guildId]
    );

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const [schedules] = await pool.execute(
      'SELECT * FROM schedule_schedules WHERE event_id = ? ORDER BY start_time, id',
      [eventId]
    );

    res.json({ schedules });
  } catch (error) {
    logger.error('[Dashboard] Error fetching schedules', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch schedules' });
  }
});

// Create schedule
router.post('/manage/:guildId/schedule/events/:eventId/schedules', async (req, res) => {
  try {
    const { guildId, eventId } = req.params;
    const { name, slug, description, startTime } = req.body;

    if (!name || !slug) {
      return res.status(400).json({ error: 'Name and slug are required' });
    }

    // Verify event belongs to guild
    const [[event]] = await pool.execute(
      'SELECT id FROM schedule_events WHERE id = ? AND guild_id = ?',
      [eventId, guildId]
    );

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    const [result] = await pool.execute(
      `INSERT INTO schedule_schedules (event_id, slug, name, description, start_time)
       VALUES (?, ?, ?, ?, ?)`,
      [eventId, cleanSlug, name, description || null, startTime || null]
    );

    res.json({ success: true, scheduleId: result.insertId });
  } catch (error) {
    logger.error('[Dashboard] Error creating schedule', { error: error.message });
    res.status(500).json({ error: 'Failed to create schedule' });
  }
});

// Delete schedule
router.delete('/manage/:guildId/schedule/schedules/:scheduleId', async (req, res) => {
  try {
    const { guildId, scheduleId } = req.params;

    // Verify schedule belongs to guild via event
    const [[schedule]] = await pool.execute(
      `SELECT s.id FROM schedule_schedules s
       JOIN schedule_events e ON s.event_id = e.id
       WHERE s.id = ? AND e.guild_id = ?`,
      [scheduleId, guildId]
    );

    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    await pool.execute('DELETE FROM schedule_schedules WHERE id = ?', [scheduleId]);

    res.json({ success: true });
  } catch (error) {
    logger.error('[Dashboard] Error deleting schedule', { error: error.message });
    res.status(500).json({ error: 'Failed to delete schedule' });
  }
});

// ==================== ITEM (RUN) ROUTES ====================

// Get items for a schedule
router.get('/manage/:guildId/schedule/schedules/:scheduleId/items', async (req, res) => {
  try {
    const { guildId, scheduleId } = req.params;

    // Verify schedule belongs to guild
    const [[schedule]] = await pool.execute(
      `SELECT s.id, s.name, e.name as event_name FROM schedule_schedules s
       JOIN schedule_events e ON s.event_id = e.id
       WHERE s.id = ? AND e.guild_id = ?`,
      [scheduleId, guildId]
    );

    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    const [items] = await pool.execute(
      'SELECT * FROM schedule_items WHERE schedule_id = ? ORDER BY position',
      [scheduleId]
    );

    res.json({ schedule, items });
  } catch (error) {
    logger.error('[Dashboard] Error fetching items', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch items' });
  }
});

// Add item
router.post('/manage/:guildId/schedule/schedules/:scheduleId/items', async (req, res) => {
  try {
    const { guildId, scheduleId } = req.params;
    const { gameName, category, runners, estimateSeconds, setupSeconds, notes } = req.body;

    if (!gameName) {
      return res.status(400).json({ error: 'Game name is required' });
    }

    // Verify schedule belongs to guild
    const [[schedule]] = await pool.execute(
      `SELECT s.id FROM schedule_schedules s
       JOIN schedule_events e ON s.event_id = e.id
       WHERE s.id = ? AND e.guild_id = ?`,
      [scheduleId, guildId]
    );

    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    // Get next position
    const [[{ maxPos }]] = await pool.execute(
      'SELECT COALESCE(MAX(position), 0) as maxPos FROM schedule_items WHERE schedule_id = ?',
      [scheduleId]
    );

    const [result] = await pool.execute(
      `INSERT INTO schedule_items (schedule_id, position, game_name, category, runners, estimate_seconds, setup_seconds, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [scheduleId, maxPos + 1, gameName, category || null, runners || null,
       estimateSeconds || 0, setupSeconds || 0, notes || null]
    );

    res.json({ success: true, itemId: result.insertId });
  } catch (error) {
    logger.error('[Dashboard] Error adding item', { error: error.message });
    res.status(500).json({ error: 'Failed to add item' });
  }
});

// Update item
router.put('/manage/:guildId/schedule/items/:itemId', async (req, res) => {
  try {
    const { guildId, itemId } = req.params;
    const { gameName, category, runners, estimateSeconds, setupSeconds, status, notes } = req.body;

    // Verify item belongs to guild
    const [[item]] = await pool.execute(
      `SELECT i.id FROM schedule_items i
       JOIN schedule_schedules s ON i.schedule_id = s.id
       JOIN schedule_events e ON s.event_id = e.id
       WHERE i.id = ? AND e.guild_id = ?`,
      [itemId, guildId]
    );

    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const updates = [];
    const values = [];

    if (gameName !== undefined) { updates.push('game_name = ?'); values.push(gameName); }
    if (category !== undefined) { updates.push('category = ?'); values.push(category); }
    if (runners !== undefined) { updates.push('runners = ?'); values.push(runners); }
    if (estimateSeconds !== undefined) { updates.push('estimate_seconds = ?'); values.push(estimateSeconds); }
    if (setupSeconds !== undefined) { updates.push('setup_seconds = ?'); values.push(setupSeconds); }
    if (status !== undefined) { updates.push('status = ?'); values.push(status); }
    if (notes !== undefined) { updates.push('notes = ?'); values.push(notes); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    values.push(itemId);

    await pool.execute(
      `UPDATE schedule_items SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('[Dashboard] Error updating item', { error: error.message });
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// Delete item
router.delete('/manage/:guildId/schedule/items/:itemId', async (req, res) => {
  try {
    const { guildId, itemId } = req.params;

    // Verify item belongs to guild and get position
    const [[item]] = await pool.execute(
      `SELECT i.id, i.schedule_id, i.position FROM schedule_items i
       JOIN schedule_schedules s ON i.schedule_id = s.id
       JOIN schedule_events e ON s.event_id = e.id
       WHERE i.id = ? AND e.guild_id = ?`,
      [itemId, guildId]
    );

    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    await pool.execute('DELETE FROM schedule_items WHERE id = ?', [itemId]);

    // Reorder remaining items
    await pool.execute(
      'UPDATE schedule_items SET position = position - 1 WHERE schedule_id = ? AND position > ?',
      [item.schedule_id, item.position]
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('[Dashboard] Error deleting item', { error: error.message });
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

// Reorder items
router.post('/manage/:guildId/schedule/schedules/:scheduleId/reorder', async (req, res) => {
  try {
    const { guildId, scheduleId } = req.params;
    const { itemIds } = req.body;

    if (!Array.isArray(itemIds)) {
      return res.status(400).json({ error: 'itemIds must be an array' });
    }

    // Verify schedule belongs to guild
    const [[schedule]] = await pool.execute(
      `SELECT s.id FROM schedule_schedules s
       JOIN schedule_events e ON s.event_id = e.id
       WHERE s.id = ? AND e.guild_id = ?`,
      [scheduleId, guildId]
    );

    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    // Update positions
    for (let i = 0; i < itemIds.length; i++) {
      await pool.execute(
        'UPDATE schedule_items SET position = ? WHERE id = ? AND schedule_id = ?',
        [i + 1, itemIds[i], scheduleId]
      );
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('[Dashboard] Error reordering items', { error: error.message });
    res.status(500).json({ error: 'Failed to reorder items' });
  }
});

// Start/complete item
router.post('/manage/:guildId/schedule/items/:itemId/status', async (req, res) => {
  try {
    const { guildId, itemId } = req.params;
    const { status } = req.body;

    if (!['pending', 'running', 'completed', 'skipped'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // Verify item belongs to guild
    const [[item]] = await pool.execute(
      `SELECT i.id FROM schedule_items i
       JOIN schedule_schedules s ON i.schedule_id = s.id
       JOIN schedule_events e ON s.event_id = e.id
       WHERE i.id = ? AND e.guild_id = ?`,
      [itemId, guildId]
    );

    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const updates = ['status = ?'];
    const values = [status];

    if (status === 'running') {
      updates.push('actual_start = NOW()');
    } else if (status === 'completed') {
      updates.push('actual_end = NOW()');
    }

    values.push(itemId);

    await pool.execute(
      `UPDATE schedule_items SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('[Dashboard] Error updating item status', { error: error.message });
    res.status(500).json({ error: 'Failed to update status' });
  }
});

export default router;
