/**
 * !elevated / !thoughts / !stoned
 * Display a random stoned thought
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

/**
 * Get a random approved thought
 */
async function getRandomThought() {
    const [rows] = await pool.execute(
        `SELECT * FROM tokes_thoughts
         WHERE is_approved = 1
         ORDER BY times_shown ASC, RAND()
         LIMIT 1`
    );
    return rows[0] || null;
}

export async function elevatedCommand(ctx) {
    const { username, reply, args } = ctx;

    try {
        // Check if user is submitting a thought
        if (args[0]?.toLowerCase() === 'submit' && args.length > 1) {
            const thought = args.slice(1).join(' ').trim();

            if (thought.length < 10) {
                reply(`${username}, thought too short! Must be at least 10 characters.`);
                return;
            }

            if (thought.length > 500) {
                reply(`${username}, thought too long! Max 500 characters.`);
                return;
            }

            // Submit thought (pending approval)
            await pool.execute(
                `INSERT INTO tokes_thoughts (thought, submitted_by, is_approved)
                 VALUES (?, ?, 0)`,
                [thought, username]
            );

            reply(`${username}, your thought has been submitted for review!`);
            return;
        }

        // Get random thought
        const thought = await getRandomThought();

        if (!thought) {
            // Fallback thoughts if none in database
            const fallbacks = [
                "If you think about it, every pizza is a personal pizza if you believe in yourself.",
                "What if dogs think we're immortal because we age so slowly compared to them?",
                "The word 'bed' actually looks like a bed.",
                "We're all just houseplants with more complicated emotions.",
                "Lasagna is just spaghetti flavored cake.",
                "Your future self is watching you through memories.",
                "The ocean is just a big soup.",
                "What if oxygen is actually poisonous and takes 75-100 years to kill us?",
                "Every time you clean something, you make something else dirty.",
                "Technically, we're all time travelers moving at the rate of 1 second per second."
            ];

            const randomFallback = fallbacks[Math.floor(Math.random() * fallbacks.length)];
            reply(`Elevated Thought: "${randomFallback}"`);
            return;
        }

        // Update times shown
        await pool.execute(
            `UPDATE tokes_thoughts SET times_shown = times_shown + 1 WHERE id = ?`,
            [thought.id]
        );

        // Build response
        let response = `Elevated Thought: "${thought.thought}"`;
        if (thought.submitted_by) {
            response += ` - ${thought.submitted_by}`;
        }

        reply(response);

    } catch (error) {
        logger.error('[ElevatedCommand] Error', { error: error.message });
        reply(`${username}, couldn't fetch a thought right now.`);
    }
}
