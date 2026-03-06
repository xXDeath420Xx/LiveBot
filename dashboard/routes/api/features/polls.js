/**
 * Polls API
 * Handles poll management
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';

const router = express.Router({ mergeParams: true });

/**
 * GET /api/guilds/:guildId/polls
 * Get all polls
 */
router.get('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { status = 'all' } = req.query;

        let query = 'SELECT * FROM polls WHERE guild_id = ?';
        const params = [guildId];

        if (status === 'active') {
            query += ' AND (ends_at IS NULL OR ends_at > NOW())';
        } else if (status === 'ended') {
            query += ' AND ends_at IS NOT NULL AND ends_at <= NOW()';
        }

        query += ' ORDER BY created_at DESC';

        const [polls] = await pool.execute(query, params);

        // Parse options JSON for each poll
        polls.forEach(poll => {
            if (poll.options && typeof poll.options === 'string') {
                try {
                    poll.options = JSON.parse(poll.options);
                } catch (e) {
                    poll.options = [];
                }
            }
        });

        res.json({ success: true, polls });
    } catch (error) {
        logger.error('[API Polls GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch polls' });
    }
});

/**
 * POST /api/guilds/:guildId/polls
 * Create a poll
 */
router.post('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const {
            channel_id,
            question,
            options,
            duration_seconds,
            multiple_choice,
            anonymous
        } = req.body;

        if (!channel_id || !question || !options || options.length < 2) {
            return res.status(400).json({ error: 'Channel, question, and at least 2 options are required' });
        }

        const ends_at = duration_seconds
            ? new Date(Date.now() + duration_seconds * 1000)
            : null;

        const [result] = await pool.execute(`
            INSERT INTO polls
                (guild_id, channel_id, question, options, ends_at, multiple_choice, anonymous, creator_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            guildId,
            channel_id,
            question,
            JSON.stringify(options),
            ends_at,
            multiple_choice ? 1 : 0,
            anonymous ? 1 : 0,
            req.user.id
        ]);

        res.json({
            success: true,
            message: 'Poll created',
            pollId: result.insertId
        });
    } catch (error) {
        logger.error('[API Polls POST] Error:', error);
        res.status(500).json({ error: 'Failed to create poll' });
    }
});

/**
 * GET /api/guilds/:guildId/polls/:pollId
 * Get poll details with results
 */
router.get('/:pollId', async (req, res) => {
    try {
        const { guildId, pollId } = req.params;

        const [polls] = await pool.execute(
            'SELECT * FROM polls WHERE id = ? AND guild_id = ?',
            [pollId, guildId]
        );

        if (polls.length === 0) {
            return res.status(404).json({ error: 'Poll not found' });
        }

        const poll = polls[0];
        if (poll.options && typeof poll.options === 'string') {
            poll.options = JSON.parse(poll.options);
        }

        // Get vote counts
        const [votes] = await pool.execute(`
            SELECT option_index, COUNT(*) as count
            FROM poll_votes
            WHERE poll_id = ?
            GROUP BY option_index
        `, [pollId]);

        poll.results = votes.reduce((acc, v) => {
            acc[v.option_index] = v.count;
            return acc;
        }, {});

        res.json({ success: true, poll });
    } catch (error) {
        logger.error('[API Polls GET/:id] Error:', error);
        res.status(500).json({ error: 'Failed to fetch poll' });
    }
});

/**
 * DELETE /api/guilds/:guildId/polls/:pollId
 * Delete a poll
 */
router.delete('/:pollId', async (req, res) => {
    try {
        const { guildId, pollId } = req.params;

        // Delete votes first
        await pool.execute(
            'DELETE FROM poll_votes WHERE poll_id = ?',
            [pollId]
        );

        // Delete poll
        await pool.execute(
            'DELETE FROM polls WHERE id = ? AND guild_id = ?',
            [pollId, guildId]
        );

        res.json({ success: true, message: 'Poll deleted' });
    } catch (error) {
        logger.error('[API Polls DELETE] Error:', error);
        res.status(500).json({ error: 'Failed to delete poll' });
    }
});

/**
 * POST /api/guilds/:guildId/polls/:pollId/end
 * End a poll early
 */
router.post('/:pollId/end', async (req, res) => {
    try {
        const { guildId, pollId } = req.params;

        await pool.execute(
            'UPDATE polls SET ends_at = NOW() WHERE id = ? AND guild_id = ?',
            [pollId, guildId]
        );

        res.json({ success: true, message: 'Poll ended' });
    } catch (error) {
        logger.error('[API Polls End POST] Error:', error);
        res.status(500).json({ error: 'Failed to end poll' });
    }
});

export default router;
