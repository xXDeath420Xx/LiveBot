"use strict";
/**
 * Music metrics with isolated database connection
 * Completely bypasses the shared pool to avoid stack overflow
 */

const mysql = require('mysql2/promise');
require('dotenv').config();

// Create a separate small pool just for metrics
let metricsPool = null;

async function getPool() {
    if (!metricsPool) {
        metricsPool = mysql.createPool({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            waitForConnections: true,
            connectionLimit: 3,
            queueLimit: 0,
            connectTimeout: 5000
        });
    }
    return metricsPool;
}

async function getSongId(songIdentifier, guildId) {
    if (!songIdentifier || !guildId) return null;

    const identifier = String(songIdentifier).substring(0, 500);

    try {
        const pool = await getPool();
        const [rows] = await pool.execute(
            'SELECT song_id FROM music_song_metrics WHERE song_identifier = ? AND guild_id = ?',
            [identifier, guildId]
        );

        if (rows.length > 0) {
            return rows[0].song_id;
        }

        const [result] = await pool.execute(
            'INSERT INTO music_song_metrics (song_identifier, guild_id) VALUES (?, ?)',
            [identifier, guildId]
        );
        return result.insertId;
    } catch (error) {
        console.error('[Music Metrics] getSongId error:', error.message);
        return null;
    }
}

async function incrementPlayCount(songIdentifier, guildId, userId) {
    if (!songIdentifier || !guildId || !userId) return;

    try {
        const songId = await getSongId(songIdentifier, guildId);
        if (!songId) return;

        const pool = await getPool();
        await pool.execute(
            'UPDATE music_song_metrics SET total_plays = total_plays + 1 WHERE song_id = ?',
            [songId]
        );
        await pool.execute(
            'INSERT INTO music_user_metrics (user_id, guild_id, song_id, play_count) VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE play_count = play_count + 1',
            [userId, guildId, songId]
        );
    } catch (error) {
        console.error('[Music Metrics] incrementPlayCount error:', error.message);
    }
}

async function incrementSkipCount(songIdentifier, guildId, userId) {
    if (!songIdentifier || !guildId || !userId) return;

    try {
        const songId = await getSongId(songIdentifier, guildId);
        if (!songId) return;

        const pool = await getPool();
        await pool.execute(
            'UPDATE music_song_metrics SET total_skips = total_skips + 1 WHERE song_id = ?',
            [songId]
        );
        await pool.execute(
            'INSERT INTO music_user_metrics (user_id, guild_id, song_id, skip_count) VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE skip_count = skip_count + 1',
            [userId, guildId, songId]
        );
    } catch (error) {
        console.error('[Music Metrics] incrementSkipCount error:', error.message);
    }
}

async function incrementSkipButtonPresses(guildId, userId) {
    if (!guildId || !userId) return;

    try {
        const pool = await getPool();
        await pool.execute(
            'INSERT INTO music_user_skip_stats (user_id, guild_id, skip_button_presses) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE skip_button_presses = skip_button_presses + 1',
            [userId, guildId]
        );
    } catch (error) {
        console.error('[Music Metrics] incrementSkipButtonPresses error:', error.message);
    }
}

async function getMusicMetrics(songIdentifier, guildId, userId) {
    const defaults = {
        total_plays: 0,
        total_skips: 0,
        user_play_count: 0,
        user_skip_count: 0,
        user_skip_button_presses: 0
    };

    if (!songIdentifier || !guildId || !userId) return defaults;

    try {
        const pool = await getPool();
        const songId = await getSongId(songIdentifier, guildId);

        let songMetrics = null;
        let userMetrics = null;

        if (songId) {
            const [songRows] = await pool.execute(
                'SELECT total_plays, total_skips FROM music_song_metrics WHERE song_id = ?',
                [songId]
            );
            songMetrics = songRows[0] || null;

            const [userRows] = await pool.execute(
                'SELECT play_count, skip_count FROM music_user_metrics WHERE user_id = ? AND guild_id = ? AND song_id = ?',
                [userId, guildId, songId]
            );
            userMetrics = userRows[0] || null;
        }

        const [skipRows] = await pool.execute(
            'SELECT skip_button_presses FROM music_user_skip_stats WHERE user_id = ? AND guild_id = ?',
            [userId, guildId]
        );
        const userSkipStats = skipRows[0] || null;

        return {
            total_plays: songMetrics?.total_plays || 0,
            total_skips: songMetrics?.total_skips || 0,
            user_play_count: userMetrics?.play_count || 0,
            user_skip_count: userMetrics?.skip_count || 0,
            user_skip_button_presses: userSkipStats?.skip_button_presses || 0
        };
    } catch (error) {
        console.error('[Music Metrics] getMusicMetrics error:', error.message);
        return defaults;
    }
}

module.exports = {
    incrementPlayCount,
    incrementSkipCount,
    incrementSkipButtonPresses,
    getMusicMetrics
};
