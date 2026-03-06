import express from 'express';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { requireTwitchAuth } from './auth-twitch.js';

const router = express.Router();

// My Schedules Dashboard
router.get('/my-schedules', requireTwitchAuth, async (req, res) => {
    try {
        const userId = req.session.twitchUser.id;

        // Get user's events
        const [events] = await pool.execute(
            `SELECT e.*,
                    (SELECT COUNT(*) FROM schedule_schedules WHERE event_id = e.id) as schedule_count,
                    (SELECT COUNT(*) FROM schedule_items i
                     JOIN schedule_schedules s ON i.schedule_id = s.id
                     WHERE s.event_id = e.id) as run_count
             FROM schedule_events e
             WHERE e.user_id = ?
             ORDER BY e.created_at DESC`,
            [userId]
        );

        res.render('my-schedules', {
            user: req.session.twitchUser,
            events
        });
    } catch (error) {
        logger.error('[My Schedules] Error', { error: error.message });
        res.status(500).render('my-schedules', {
            user: req.session.twitchUser,
            events: [],
            error: 'Failed to load schedules'
        });
    }
});

// Event Editor Page
router.get('/my-schedules/:eventId', requireTwitchAuth, async (req, res) => {
    try {
        const userId = req.session.twitchUser.id;
        const { eventId } = req.params;

        // Get event with ownership check
        const [[event]] = await pool.execute(
            'SELECT * FROM schedule_events WHERE id = ? AND user_id = ?',
            [eventId, userId]
        );

        if (!event) {
            return res.redirect('/my-schedules');
        }

        // Get schedules with item counts
        const [schedules] = await pool.execute(
            `SELECT s.*,
                    (SELECT COUNT(*) FROM schedule_items WHERE schedule_id = s.id) as item_count
             FROM schedule_schedules s
             WHERE s.event_id = ?
             ORDER BY s.start_time, s.id`,
            [eventId]
        );

        // Get items for each schedule
        for (const schedule of schedules) {
            const [items] = await pool.execute(
                'SELECT * FROM schedule_items WHERE schedule_id = ? ORDER BY position',
                [schedule.id]
            );
            schedule.items = items;
        }

        res.render('my-schedules-event', {
            user: req.session.twitchUser,
            event,
            schedules
        });
    } catch (error) {
        logger.error('[My Schedules] Error loading event', { error: error.message });
        res.redirect('/my-schedules');
    }
});

// ==================== EVENT ROUTES ====================

// Get all events for user
router.get('/api/my-schedules/events', requireTwitchAuth, async (req, res) => {
    try {
        const userId = req.session.twitchUser.id;

        const [events] = await pool.execute(
            `SELECT e.*,
                    (SELECT COUNT(*) FROM schedule_schedules WHERE event_id = e.id) as schedule_count,
                    (SELECT COUNT(*) FROM schedule_items i
                     JOIN schedule_schedules s ON i.schedule_id = s.id
                     WHERE s.event_id = e.id) as run_count
             FROM schedule_events e
             WHERE e.user_id = ?
             ORDER BY e.created_at DESC`,
            [userId]
        );

        res.json({ events });
    } catch (error) {
        logger.error('[User Schedule] Error fetching events', { error: error.message });
        res.status(500).json({ error: 'Failed to fetch events' });
    }
});

// Create event
router.post('/api/my-schedules/events', requireTwitchAuth, async (req, res) => {
    logger.debug('[User Schedule] Create event request', { body: req.body });
    try {
        const userId = req.session.twitchUser.id;
        logger.debug('[User Schedule] User ID', { userId });
        const { name, slug, description, website, twitchChannel, twitter, startDate, endDate, theme, secret } = req.body;

        if (!name || !slug) {
            return res.status(400).json({ error: 'Name and slug are required' });
        }

        const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');

        // Check for duplicate slug (globally unique)
        const [[existing]] = await pool.execute(
            'SELECT id FROM schedule_events WHERE slug = ?',
            [cleanSlug]
        );

        if (existing) {
            return res.status(400).json({ error: 'An event with this slug already exists' });
        }

        const [result] = await pool.execute(
            `INSERT INTO schedule_events (user_id, slug, name, description, website_url, twitch_channel, twitter, start_date, end_date, theme, secret, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                userId,
                cleanSlug,
                name,
                description || null,
                website || null,
                twitchChannel || req.session.twitchUser.login,
                twitter || null,
                startDate || null,
                endDate || null,
                theme || 'default',
                secret || null,
                'twitch:' + req.session.twitchUser.login
            ]
        );

        logger.info('[User Schedule] Event created', { eventId: result.insertId });
        res.json({ success: true, eventId: result.insertId });
    } catch (error) {
        logger.error('[User Schedule] Error creating event', { error: error.message });
        res.status(500).json({ error: 'Failed to create event' });
    }
});

// Update event
router.put('/api/my-schedules/events/:eventId', requireTwitchAuth, async (req, res) => {
    try {
        const userId = req.session.twitchUser.id;
        const { eventId } = req.params;
        const { name, description, twitchChannel, isActive } = req.body;

        // Verify ownership
        const [[event]] = await pool.execute(
            'SELECT id FROM schedule_events WHERE id = ? AND user_id = ?',
            [eventId, userId]
        );

        if (!event) {
            return res.status(404).json({ error: 'Event not found' });
        }

        const updates = [];
        const values = [];

        if (name !== undefined) { updates.push('name = ?'); values.push(name); }
        if (description !== undefined) { updates.push('description = ?'); values.push(description); }
        if (twitchChannel !== undefined) { updates.push('twitch_channel = ?'); values.push(twitchChannel); }
        if (isActive !== undefined) { updates.push('is_active = ?'); values.push(isActive); }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No updates provided' });
        }

        values.push(eventId);

        await pool.execute(
            `UPDATE schedule_events SET ${updates.join(', ')} WHERE id = ?`,
            values
        );

        res.json({ success: true });
    } catch (error) {
        logger.error('[User Schedule] Error updating event', { error: error.message });
        res.status(500).json({ error: 'Failed to update event' });
    }
});

// Delete event
router.delete('/api/my-schedules/events/:eventId', requireTwitchAuth, async (req, res) => {
    try {
        const userId = req.session.twitchUser.id;
        const { eventId } = req.params;

        // Verify ownership
        const [[event]] = await pool.execute(
            'SELECT id FROM schedule_events WHERE id = ? AND user_id = ?',
            [eventId, userId]
        );

        if (!event) {
            return res.status(404).json({ error: 'Event not found' });
        }

        await pool.execute('DELETE FROM schedule_events WHERE id = ?', [eventId]);

        res.json({ success: true });
    } catch (error) {
        logger.error('[User Schedule] Error deleting event', { error: error.message });
        res.status(500).json({ error: 'Failed to delete event' });
    }
});

// ==================== SCHEDULE ROUTES ====================

// Get schedules for an event
router.get('/api/my-schedules/events/:eventId/schedules', requireTwitchAuth, async (req, res) => {
    try {
        const userId = req.session.twitchUser.id;
        const { eventId } = req.params;

        // Verify ownership
        const [[event]] = await pool.execute(
            'SELECT id FROM schedule_events WHERE id = ? AND user_id = ?',
            [eventId, userId]
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
        logger.error('[User Schedule] Error fetching schedules', { error: error.message });
        res.status(500).json({ error: 'Failed to fetch schedules' });
    }
});

// Create schedule
router.post('/api/my-schedules/events/:eventId/schedules', requireTwitchAuth, async (req, res) => {
    try {
        const userId = req.session.twitchUser.id;
        const { eventId } = req.params;
        const { name, slug, website, twitchChannel, twitter, timezone, startTime, setupTime, theme, secret, hiddenSecret } = req.body;

        if (!name || !slug) {
            return res.status(400).json({ error: 'Name and slug are required' });
        }

        // Verify ownership
        const [[event]] = await pool.execute(
            'SELECT id FROM schedule_events WHERE id = ? AND user_id = ?',
            [eventId, userId]
        );

        if (!event) {
            return res.status(404).json({ error: 'Event not found' });
        }

        const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');

        // Parse setup time (e.g., "5m" or "5m 30s" to seconds)
        let setupSeconds = 300; // default 5 minutes
        if (setupTime) {
            setupSeconds = 0;
            const matches = setupTime.match(/(\d+)\s*(h|m|s|min|sec)?/gi);
            if (matches) {
                matches.forEach(match => {
                    const [, num, unit] = match.match(/(\d+)\s*(h|m|s|min|sec)?/i) || [];
                    if (num) {
                        const n = parseInt(num);
                        if (!unit || unit.toLowerCase().startsWith('s')) setupSeconds += n;
                        else if (unit.toLowerCase().startsWith('m')) setupSeconds += n * 60;
                        else if (unit.toLowerCase().startsWith('h')) setupSeconds += n * 3600;
                    }
                });
            }
        }

        const [result] = await pool.execute(
            `INSERT INTO schedule_schedules (event_id, slug, name, website_url, twitch_channel, twitter, timezone, start_time, setup_time_seconds, theme, secret, hidden_secret)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                eventId,
                cleanSlug,
                name,
                website || null,
                twitchChannel || null,
                twitter || null,
                timezone || 'UTC',
                startTime || null,
                setupSeconds,
                theme || 'default',
                secret || null,
                hiddenSecret || null
            ]
        );

        res.json({ success: true, scheduleId: result.insertId });
    } catch (error) {
        logger.error('[User Schedule] Error creating schedule', { error: error.message });
        res.status(500).json({ error: 'Failed to create schedule' });
    }
});

// Delete schedule
router.delete('/api/my-schedules/schedules/:scheduleId', requireTwitchAuth, async (req, res) => {
    try {
        const userId = req.session.twitchUser.id;
        const { scheduleId } = req.params;

        // Verify ownership via event
        const [[schedule]] = await pool.execute(
            `SELECT s.id FROM schedule_schedules s
             JOIN schedule_events e ON s.event_id = e.id
             WHERE s.id = ? AND e.user_id = ?`,
            [scheduleId, userId]
        );

        if (!schedule) {
            return res.status(404).json({ error: 'Schedule not found' });
        }

        await pool.execute('DELETE FROM schedule_schedules WHERE id = ?', [scheduleId]);

        res.json({ success: true });
    } catch (error) {
        logger.error('[User Schedule] Error deleting schedule', { error: error.message });
        res.status(500).json({ error: 'Failed to delete schedule' });
    }
});

// ==================== ITEM (RUN) ROUTES ====================

// Get items for a schedule
router.get('/api/my-schedules/schedules/:scheduleId/items', requireTwitchAuth, async (req, res) => {
    try {
        const userId = req.session.twitchUser.id;
        const { scheduleId } = req.params;

        // Verify ownership
        const [[schedule]] = await pool.execute(
            `SELECT s.id, s.name, e.name as event_name FROM schedule_schedules s
             JOIN schedule_events e ON s.event_id = e.id
             WHERE s.id = ? AND e.user_id = ?`,
            [scheduleId, userId]
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
        logger.error('[User Schedule] Error fetching items', { error: error.message });
        res.status(500).json({ error: 'Failed to fetch items' });
    }
});

// Add item
router.post('/api/my-schedules/schedules/:scheduleId/items', requireTwitchAuth, async (req, res) => {
    try {
        const userId = req.session.twitchUser.id;
        const { scheduleId } = req.params;
        const { gameName, category, runners, estimateSeconds, setupSeconds, notes } = req.body;

        if (!gameName) {
            return res.status(400).json({ error: 'Game name is required' });
        }

        // Verify ownership
        const [[schedule]] = await pool.execute(
            `SELECT s.id FROM schedule_schedules s
             JOIN schedule_events e ON s.event_id = e.id
             WHERE s.id = ? AND e.user_id = ?`,
            [scheduleId, userId]
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
        logger.error('[User Schedule] Error adding item', { error: error.message });
        res.status(500).json({ error: 'Failed to add item' });
    }
});

// Update item
router.put('/api/my-schedules/items/:itemId', requireTwitchAuth, async (req, res) => {
    try {
        const userId = req.session.twitchUser.id;
        const { itemId } = req.params;
        const { gameName, category, runners, estimateSeconds, setupSeconds, status, notes } = req.body;

        // Verify ownership
        const [[item]] = await pool.execute(
            `SELECT i.id FROM schedule_items i
             JOIN schedule_schedules s ON i.schedule_id = s.id
             JOIN schedule_events e ON s.event_id = e.id
             WHERE i.id = ? AND e.user_id = ?`,
            [itemId, userId]
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
        logger.error('[User Schedule] Error updating item', { error: error.message });
        res.status(500).json({ error: 'Failed to update item' });
    }
});

// Delete item
router.delete('/api/my-schedules/items/:itemId', requireTwitchAuth, async (req, res) => {
    try {
        const userId = req.session.twitchUser.id;
        const { itemId } = req.params;

        // Verify ownership and get position
        const [[item]] = await pool.execute(
            `SELECT i.id, i.schedule_id, i.position FROM schedule_items i
             JOIN schedule_schedules s ON i.schedule_id = s.id
             JOIN schedule_events e ON s.event_id = e.id
             WHERE i.id = ? AND e.user_id = ?`,
            [itemId, userId]
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
        logger.error('[User Schedule] Error deleting item', { error: error.message });
        res.status(500).json({ error: 'Failed to delete item' });
    }
});

// Update item status
router.post('/api/my-schedules/items/:itemId/status', requireTwitchAuth, async (req, res) => {
    try {
        const userId = req.session.twitchUser.id;
        const { itemId } = req.params;
        const { status } = req.body;

        if (!['pending', 'running', 'completed', 'skipped'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        // Verify ownership
        const [[item]] = await pool.execute(
            `SELECT i.id FROM schedule_items i
             JOIN schedule_schedules s ON i.schedule_id = s.id
             JOIN schedule_events e ON s.event_id = e.id
             WHERE i.id = ? AND e.user_id = ?`,
            [itemId, userId]
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
        logger.error('[User Schedule] Error updating status', { error: error.message });
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// Reorder items
router.post('/api/my-schedules/schedules/:scheduleId/reorder', requireTwitchAuth, async (req, res) => {
    try {
        const userId = req.session.twitchUser.id;
        const { scheduleId } = req.params;
        const { itemIds } = req.body;

        if (!Array.isArray(itemIds)) {
            return res.status(400).json({ error: 'itemIds must be an array' });
        }

        // Verify ownership
        const [[schedule]] = await pool.execute(
            `SELECT s.id FROM schedule_schedules s
             JOIN schedule_events e ON s.event_id = e.id
             WHERE s.id = ? AND e.user_id = ?`,
            [scheduleId, userId]
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
        logger.error('[User Schedule] Error reordering items', { error: error.message });
        res.status(500).json({ error: 'Failed to reorder items' });
    }
});

export default router;
