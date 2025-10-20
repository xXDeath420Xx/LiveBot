
const db = require('../utils/db');
const logger = require('../utils/logger');

// This function is a critical path. It must not throw unhandled exceptions.
async function getSongId(songIdentifier, guildId) {
    if (!songIdentifier || !guildId) {
        logger.warn('[Music Metrics] getSongId called with invalid identifier or guildId.');
        return null;
    }
    try {
        const [rows] = await db.query('SELECT song_id FROM music_song_metrics WHERE song_identifier = ? AND guild_id = ?', [songIdentifier, guildId]);
        if (rows.length > 0) {
            return rows[0].song_id;
        } else {
            const [result] = await db.query('INSERT INTO music_song_metrics (song_identifier, guild_id) VALUES (?, ?)', [songIdentifier, guildId]);
            return result.insertId;
        }
    } catch (error) {
        logger.error('[Music Metrics] Critical error in getSongId:', {
            message: error.message,
            songIdentifier,
            guildId
        });
        return null; // Return null on failure instead of throwing
    }
}

async function incrementPlayCount(songIdentifier, guildId, userId) {
    const songId = await getSongId(songIdentifier, guildId);
    if (!songId) {
        logger.warn('[Music Metrics] Could not increment play count because getSongId failed.');
        return;
    }

    try {
        await db.query('UPDATE music_song_metrics SET total_plays = total_plays + 1 WHERE song_id = ?', [songId]);
        await db.query('INSERT INTO music_user_metrics (user_id, guild_id, song_id, play_count) VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE play_count = play_count + 1', [userId, guildId, songId]);
    } catch (error) {
        logger.error('[Music Metrics] Failed to increment play count:', { error: error.message, stack: error.stack });
    }
}

async function incrementSkipCount(songIdentifier, guildId, userId) {
    const songId = await getSongId(songIdentifier, guildId);
    if (!songId) {
        logger.warn('[Music Metrics] Could not increment skip count because getSongId failed.');
        return;
    }

    try {
        await db.query('UPDATE music_song_metrics SET total_skips = total_skips + 1 WHERE song_id = ?', [songId]);
        await db.query('INSERT INTO music_user_metrics (user_id, guild_id, song_id, skip_count) VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE skip_count = skip_count + 1', [userId, guildId, songId]);
    } catch (error) {
        logger.error('[Music Metrics] Failed to increment skip count:', { error: error.message, stack: error.stack });
    }
}

async function incrementSkipButtonPresses(guildId, userId) {
    try {
        await db.query('INSERT INTO music_user_skip_stats (user_id, guild_id, skip_button_presses) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE skip_button_presses = skip_button_presses + 1', [userId, guildId]);
    } catch (error) {
        logger.error('[Music Metrics] Failed to increment skip button presses:', { error: error.message, stack: error.stack });
    }
}

async function getMusicMetrics(songIdentifier, guildId, userId) {
    try {
        const songId = await getSongId(songIdentifier, guildId);
        
        let songMetrics = null;
        let userMetrics = null;
        let userSkipStats = null;

        if (songId) {
            const [songRows] = await db.query('SELECT total_plays, total_skips FROM music_song_metrics WHERE song_id = ?', [songId]);
            songMetrics = songRows[0] || null;

            const [userRows] = await db.query('SELECT play_count, skip_count FROM music_user_metrics WHERE user_id = ? AND guild_id = ? AND song_id = ?', [userId, guildId, songId]);
            userMetrics = userRows[0] || null;
        }

        const [skipRows] = await db.query('SELECT skip_button_presses FROM music_user_skip_stats WHERE user_id = ? AND guild_id = ?', [userId, guildId]);
        userSkipStats = skipRows[0] || null;

        return {
            total_plays: songMetrics ? songMetrics.total_plays : 0,
            total_skips: songMetrics ? songMetrics.total_skips : 0,
            user_play_count: userMetrics ? userMetrics.play_count : 0,
            user_skip_count: userMetrics ? userMetrics.skip_count : 0,
            user_skip_button_presses: userSkipStats ? userSkipStats.skip_button_presses : 0
        };
    } catch (error) {
        logger.error('[Music Metrics] Failed to get music metrics:', { error: error.message, stack: error.stack });
        return {
            total_plays: 0,
            total_skips: 0,
            user_play_count: 0,
            user_skip_count: 0,
            user_skip_button_presses: 0
        };
    }
}

module.exports = {
    incrementPlayCount,
    incrementSkipCount,
    incrementSkipButtonPresses,
    getMusicMetrics
};
