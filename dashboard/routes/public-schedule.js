import express from 'express';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

const router = express.Router();

// Public calendar page - shows events in a calendar view like Horaro
router.get('/schedule', async (req, res) => {
    try {
        // Get year and month from query params, default to current
        const now = new Date();
        const year = parseInt(req.query.year) || now.getFullYear();
        const month = parseInt(req.query.month) || (now.getMonth() + 1);

        // Get all active events with their earliest schedule start time
        const [events] = await pool.execute(
            `SELECT e.*,
                    (SELECT MIN(start_time) FROM schedule_schedules WHERE event_id = e.id) as start_date,
                    (SELECT MAX(start_time) FROM schedule_schedules WHERE event_id = e.id) as end_date,
                    (SELECT COUNT(*) FROM schedule_schedules WHERE event_id = e.id) as schedule_count,
                    (SELECT COUNT(*) FROM schedule_items i
                     JOIN schedule_schedules s ON i.schedule_id = s.id
                     WHERE s.event_id = e.id) as run_count
             FROM schedule_events e
             WHERE e.is_active = 1
             ORDER BY start_date ASC, e.name ASC`
        );

        // Build calendar data
        const firstDay = new Date(year, month - 1, 1);
        const lastDay = new Date(year, month, 0);
        const daysInMonth = lastDay.getDate();
        const startDayOfWeek = (firstDay.getDay() + 6) % 7; // Monday = 0

        // Create calendar grid
        const calendar = [];
        let week = [];

        // Add empty cells for days before the 1st
        for (let i = 0; i < startDayOfWeek; i++) {
            week.push({ day: null, events: [] });
        }

        // Add days of the month
        for (let day = 1; day <= daysInMonth; day++) {
            const date = new Date(year, month - 1, day);
            const dayEvents = events.filter(e => {
                if (!e.start_date) return false;
                const start = new Date(e.start_date);
                const end = e.end_date ? new Date(e.end_date) : start;
                // Check if this day falls within the event's date range
                const dayStart = new Date(year, month - 1, day);
                const dayEnd = new Date(year, month - 1, day, 23, 59, 59);
                return start <= dayEnd && end >= dayStart;
            });

            week.push({ day, date, events: dayEvents });

            if (week.length === 7) {
                calendar.push(week);
                week = [];
            }
        }

        // Add empty cells for remaining days
        if (week.length > 0) {
            while (week.length < 7) {
                week.push({ day: null, events: [] });
            }
            calendar.push(week);
        }

        // Get events for the listing below calendar
        const monthEvents = events.filter(e => {
            if (!e.start_date) return true; // Show events without dates
            const start = new Date(e.start_date);
            return start.getFullYear() === year && (start.getMonth() + 1) === month;
        });

        res.render('public-schedule-list', {
            events,
            monthEvents,
            calendar,
            year,
            month,
            monthName: new Date(year, month - 1).toLocaleString('en-US', { month: 'long' }),
            twitchUser: req.session?.twitchUser || null
        });
    } catch (error) {
        logger.error('[Public Schedule] Error loading schedule list', { error: error.message });
        res.status(500).render('public-schedule-list', {
            events: [],
            monthEvents: [],
            calendar: [],
            year: new Date().getFullYear(),
            month: new Date().getMonth() + 1,
            monthName: new Date().toLocaleString('en-US', { month: 'long' }),
            error: 'Failed to load events',
            twitchUser: req.session?.twitchUser || null
        });
    }
});

// Public schedule page - no auth required
router.get('/schedule/:eventSlug', async (req, res) => {
    try {
        const { eventSlug } = req.params;
        const { schedule: scheduleSlug } = req.query;

        // Fetch event by slug
        const [[event]] = await pool.execute(
            `SELECT * FROM schedule_events WHERE slug = ? AND is_active = 1`,
            [eventSlug]
        );

        if (!event) {
            return res.status(404).render('public-schedule', {
                error: 'Event not found or not active',
                event: null,
                schedules: [],
                currentSchedule: null,
                items: [],
                twitchUser: req.session?.twitchUser || null
            });
        }

        // Fetch all schedules for this event
        const [schedules] = await pool.execute(
            `SELECT * FROM schedule_schedules WHERE event_id = ? ORDER BY start_time, id`,
            [event.id]
        );

        // Determine which schedule to show
        let currentSchedule = null;
        if (scheduleSlug) {
            currentSchedule = schedules.find(s => s.slug === scheduleSlug);
        }
        if (!currentSchedule && schedules.length > 0) {
            currentSchedule = schedules[0];
        }

        // Fetch items for current schedule
        let items = [];
        if (currentSchedule) {
            const [rawItems] = await pool.execute(
                `SELECT * FROM schedule_items WHERE schedule_id = ? ORDER BY position`,
                [currentSchedule.id]
            );

            // Calculate estimated start times
            let cumulativeTime = currentSchedule.start_time
                ? new Date(currentSchedule.start_time).getTime()
                : null;

            items = rawItems.map((item, index) => {
                const estimatedStart = cumulativeTime ? new Date(cumulativeTime) : null;

                if (cumulativeTime) {
                    // Add estimate + setup for next run's start time
                    cumulativeTime += ((item.estimate_seconds || 0) + (item.setup_seconds || 0)) * 1000;
                }

                return {
                    ...item,
                    estimated_start: estimatedStart,
                    position: index + 1
                };
            });
        }

        res.render('public-schedule', {
            error: null,
            event,
            schedules,
            currentSchedule,
            items,
            twitchUser: req.session?.twitchUser || null
        });
    } catch (error) {
        logger.error('[Public Schedule] Error loading schedule', { error: error.message });
        res.status(500).render('public-schedule', {
            error: 'Failed to load schedule',
            event: null,
            schedules: [],
            currentSchedule: null,
            items: [],
            twitchUser: req.session?.twitchUser || null
        });
    }
});

// API endpoint for live ticker data (for auto-refresh)
router.get('/api/schedule/:eventSlug/ticker', async (req, res) => {
    try {
        const { eventSlug } = req.params;
        const { schedule: scheduleSlug } = req.query;

        // Fetch event
        const [[event]] = await pool.execute(
            `SELECT id, name, slug, twitch_channel FROM schedule_events WHERE slug = ? AND is_active = 1`,
            [eventSlug]
        );

        if (!event) {
            return res.status(404).json({ error: 'Event not found' });
        }

        // Fetch schedules
        const [schedules] = await pool.execute(
            `SELECT id, slug, name, start_time FROM schedule_schedules WHERE event_id = ? ORDER BY start_time, id`,
            [event.id]
        );

        // Get current schedule
        let currentSchedule = scheduleSlug
            ? schedules.find(s => s.slug === scheduleSlug)
            : schedules[0];

        if (!currentSchedule) {
            return res.json({ event, schedules: [], items: [], ticker: null });
        }

        // Fetch items
        const [rawItems] = await pool.execute(
            `SELECT * FROM schedule_items WHERE schedule_id = ? ORDER BY position`,
            [currentSchedule.id]
        );

        // Calculate times and find current/next
        let cumulativeTime = currentSchedule.start_time
            ? new Date(currentSchedule.start_time).getTime()
            : null;

        let currentRun = null;
        let nextRun = null;
        let previousRun = null;

        const items = rawItems.map((item, index) => {
            const estimatedStart = cumulativeTime ? new Date(cumulativeTime) : null;

            if (cumulativeTime) {
                cumulativeTime += ((item.estimate_seconds || 0) + (item.setup_seconds || 0)) * 1000;
            }

            const processed = {
                id: item.id,
                position: index + 1,
                game_name: item.game_name,
                category: item.category,
                runners: item.runners,
                estimate_seconds: item.estimate_seconds,
                setup_seconds: item.setup_seconds,
                status: item.status,
                estimated_start: estimatedStart?.toISOString(),
                actual_start: item.actual_start,
                actual_end: item.actual_end
            };

            // Track current/next/previous
            if (item.status === 'running') {
                currentRun = processed;
            } else if (item.status === 'completed') {
                previousRun = processed;
            } else if (!currentRun && !nextRun && item.status === 'pending') {
                nextRun = processed;
            }

            return processed;
        });

        // If no running item, current is the next pending
        if (!currentRun && nextRun) {
            currentRun = nextRun;
            nextRun = items.find(i => i.status === 'pending' && i.position > currentRun.position) || null;
        }

        res.json({
            event: {
                name: event.name,
                slug: event.slug,
                twitch_channel: event.twitch_channel
            },
            schedule: {
                name: currentSchedule.name,
                slug: currentSchedule.slug,
                start_time: currentSchedule.start_time
            },
            schedules: schedules.map(s => ({ slug: s.slug, name: s.name })),
            items,
            ticker: {
                previous: previousRun,
                current: currentRun,
                next: nextRun,
                total_runs: items.length,
                completed_runs: items.filter(i => i.status === 'completed').length
            },
            updated_at: new Date().toISOString()
        });
    } catch (error) {
        logger.error('[Public Schedule] Error fetching ticker data', { error: error.message });
        res.status(500).json({ error: 'Failed to fetch ticker data' });
    }
});

// API endpoint for full schedule data (JSON export)
router.get('/api/schedule/:eventSlug/export', async (req, res) => {
    try {
        const { eventSlug } = req.params;

        const [[event]] = await pool.execute(
            `SELECT * FROM schedule_events WHERE slug = ?`,
            [eventSlug]
        );

        if (!event) {
            return res.status(404).json({ error: 'Event not found' });
        }

        const [schedules] = await pool.execute(
            `SELECT * FROM schedule_schedules WHERE event_id = ? ORDER BY start_time, id`,
            [event.id]
        );

        const fullSchedules = await Promise.all(schedules.map(async (schedule) => {
            const [items] = await pool.execute(
                `SELECT * FROM schedule_items WHERE schedule_id = ? ORDER BY position`,
                [schedule.id]
            );
            return { ...schedule, items };
        }));

        res.json({
            event: {
                name: event.name,
                slug: event.slug,
                description: event.description,
                twitch_channel: event.twitch_channel
            },
            schedules: fullSchedules,
            exported_at: new Date().toISOString()
        });
    } catch (error) {
        logger.error('[Public Schedule] Error exporting schedule', { error: error.message });
        res.status(500).json({ error: 'Failed to export schedule' });
    }
});

export default router;
