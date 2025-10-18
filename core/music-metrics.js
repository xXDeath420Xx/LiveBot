
const db = require('../utils/db');
const logger = require('../utils/logger');

async function getSongId(songIdentifier, guildId) {
    const [rows] = await db.query('SELECT song_id FROM music_song_metrics WHERE song_identifier = ? AND guild_id = ?', [songIdentifier, guildId]);
    if (rows.length > 0) {
        return rows[0].song_id;
    } else {
        const [result] = await db.query('INSERT INTO music_song_metrics (song_identifier, guild_id) VALUES (?, ?)', [songIdentifier, guildId]);
        return result.insertId;
    }
}

async function incrementPlayCount(songIdentifier, guildId, userId) {
    try {
        const songId = await getSongId(songIdentifier, guildId);
        await db.query('UPDATE music_song_metrics SET total_plays = total_plays + 1 WHERE song_id = ?', [songId]);
        await db.query('INSERT INTO music_user_metrics (user_id, guild_id, song_id, play_count) VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE play_count = play_count + 1', [userId, guildId, songId]);
    } catch (error) {
        logger.error('[Music Metrics] Failed to increment play count:', { error: error.message, stack: error.stack });
    }
}

async function incrementSkipCount(songIdentifier, guildId, userId) {
    try {
        const songId = await getSongId(songIdentifier, guildId);
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
        const [songMetrics] = await db.query('SELECT total_plays, total_skips FROM music_song_metrics WHERE song_id = ?', [songId]);
        const [userMetrics] = await db.query('SELECT play_count, skip_count FROM music_user_metrics WHERE user_id = ? AND guild_id = ? AND song_id = ?', [userId, guildId, songId]);
        const [userSkipStats] = await db.query('SELECT skip_button_presses FROM music_user_skip_stats WHERE user_id = ? AND guild_id = ?', [userId, guildId]);

        return {
            total_plays: songMetrics.length > 0 ? songMetrics[0].total_plays : 0,
            total_skips: songMetrics.length > 0 ? songMetrics[0].total_skips : 0,
            user_play_count: userMetrics.length > 0 ? userMetrics[0].play_count : 0,
            user_skip_count: userMetrics.length > 0 ? userMetrics[0].skip_count : 0,
            user_skip_button_presses: userSkipStats.length > 0 ? userSkipStats[0].skip_button_presses : 0
        };
    } catch (error) {
        logger.error('[Music Metrics] Failed to get music metrics:', { error: error.message, stack: error.stack });
        return null;
    }
}

module.exports = {
    incrementPlayCount,
    incrementSkipCount,
    incrementSkipButtonPresses,
    getMusicMetrics
};
