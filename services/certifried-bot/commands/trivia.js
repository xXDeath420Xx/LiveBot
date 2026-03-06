/**
 * Trivia Commands
 * !cannatrivia / !ct - Start trivia
 * !a/!b/!c/!d - Answer trivia
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const TRIVIA_DURATION = 30000; // 30 seconds to answer
const TRIVIA_COOLDOWN = 60000; // 1 minute between trivia

// Track active trivia per channel
const triviaTimers = new Map();
const triviaCooldowns = new Map();

/**
 * Shuffle array
 */
function shuffle(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

/**
 * Get a random trivia question
 */
async function getRandomQuestion() {
    const [rows] = await pool.execute(
        `SELECT * FROM tokes_trivia_questions
         WHERE is_active = 1
         ORDER BY times_asked ASC, RAND()
         LIMIT 1`
    );
    return rows[0] || null;
}

/**
 * !cannatrivia / !ct - Start trivia
 */
export async function triviaCommand(ctx) {
    const { channel, username, reply } = ctx;

    try {
        // Check cooldown
        const lastTrivia = triviaCooldowns.get(channel.id);
        if (lastTrivia && Date.now() - lastTrivia < TRIVIA_COOLDOWN) {
            const remaining = Math.ceil((TRIVIA_COOLDOWN - (Date.now() - lastTrivia)) / 1000);
            reply(`Trivia cooldown! Try again in ${remaining}s`);
            return;
        }

        // Check for existing active trivia
        const [existing] = await pool.execute(
            `SELECT * FROM tokes_trivia_active WHERE channel_id = ?`,
            [channel.id]
        );

        if (existing.length > 0) {
            reply(`Trivia already active! Answer with !a, !b, !c, or !d`);
            return;
        }

        // Get a question
        const question = await getRandomQuestion();
        if (!question) {
            reply(`No trivia questions available!`);
            return;
        }

        // Shuffle answers
        const answers = shuffle([
            { text: question.correct_answer, isCorrect: true },
            { text: question.wrong_answer_1, isCorrect: false },
            { text: question.wrong_answer_2, isCorrect: false },
            { text: question.wrong_answer_3, isCorrect: false }
        ].filter(a => a.text));

        // Assign letters
        const answerMap = {};
        const letters = ['A', 'B', 'C', 'D'];
        let correctLetter = '';

        answers.forEach((answer, i) => {
            answerMap[letters[i]] = answer.text;
            if (answer.isCorrect) {
                correctLetter = letters[i];
            }
        });

        // Store active trivia
        const expiresAt = new Date(Date.now() + TRIVIA_DURATION);

        await pool.execute(
            `INSERT INTO tokes_trivia_active
             (channel_id, question, answer_key, option_a, option_b, option_c, option_d, expires_at, asked_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                channel.id,
                question.question,
                correctLetter,
                answerMap['A'] || null,
                answerMap['B'] || null,
                answerMap['C'] || null,
                answerMap['D'] || null,
                expiresAt,
                username
            ]
        );

        // Update question stats
        await pool.execute(
            `UPDATE tokes_trivia_questions SET times_asked = times_asked + 1 WHERE id = ?`,
            [question.id]
        );

        // Set timeout to expire trivia
        const timerId = setTimeout(async () => {
            await expireTrivia(channel.id, correctLetter, answerMap[correctLetter], reply);
        }, TRIVIA_DURATION);

        triviaTimers.set(channel.id, timerId);
        triviaCooldowns.set(channel.id, Date.now());

        // Build response
        let response = `TRIVIA (${question.difficulty || 'medium'}): ${question.question} | `;
        response += Object.entries(answerMap)
            .filter(([_, text]) => text)
            .map(([letter, text]) => `${letter}) ${text}`)
            .join(' | ');
        response += ` | 30 seconds to answer!`;

        reply(response);

    } catch (error) {
        logger.error('[TriviaCommand] Error', { error: error.message });
        reply(`${username}, couldn't start trivia. Try again!`);
    }
}

/**
 * Expire trivia (time ran out)
 */
async function expireTrivia(channelId, correctLetter, correctAnswer, reply) {
    try {
        const [rows] = await pool.execute(
            `SELECT * FROM tokes_trivia_active WHERE channel_id = ?`,
            [channelId]
        );

        if (rows.length === 0) return;

        await pool.execute(
            `DELETE FROM tokes_trivia_active WHERE channel_id = ?`,
            [channelId]
        );

        reply(`Time's up! The answer was ${correctLetter}) ${correctAnswer}`);

    } catch (error) {
        logger.error('[TriviaExpire] Error', { error: error.message });
    }
}

/**
 * !a/!b/!c/!d - Answer trivia
 */
export async function answerCommand(ctx) {
    const { channel, username, userId, reply, commandName, profile, channelStats } = ctx;

    try {
        // Get active trivia
        const [rows] = await pool.execute(
            `SELECT * FROM tokes_trivia_active WHERE channel_id = ?`,
            [channel.id]
        );

        if (rows.length === 0) {
            // No active trivia, ignore silently
            return;
        }

        const trivia = rows[0];
        const userAnswer = commandName.toUpperCase();
        const correctAnswer = trivia.answer_key;

        // Clear the timer
        const timerId = triviaTimers.get(channel.id);
        if (timerId) {
            clearTimeout(timerId);
            triviaTimers.delete(channel.id);
        }

        // Delete active trivia
        await pool.execute(
            `DELETE FROM tokes_trivia_active WHERE channel_id = ?`,
            [channel.id]
        );

        // Check answer
        if (userAnswer === correctAnswer) {
            // Correct!
            const xpReward = trivia.reward_xp || 50;

            // Update profile XP
            await pool.execute(
                `UPDATE tokes_profiles SET xp = xp + ? WHERE id = ?`,
                [xpReward, profile.id]
            );

            // Update channel stats
            await pool.execute(
                `UPDATE tokes_channel_stats SET trivia_wins = trivia_wins + 1 WHERE id = ?`,
                [channelStats.id]
            );

            const answerText = trivia[`option_${correctAnswer.toLowerCase()}`];
            reply(`${username} got it! The answer was ${correctAnswer}) ${answerText}. +${xpReward} XP!`);

        } else {
            // Wrong answer
            const answerText = trivia[`option_${correctAnswer.toLowerCase()}`];
            reply(`${username} wrong! The answer was ${correctAnswer}) ${answerText}`);
        }

    } catch (error) {
        logger.error('[AnswerCommand] Error', { error: error.message });
    }
}
