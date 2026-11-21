/**
 * Migration 480: Google OAuth verification fixes for YouTube (2026-11-21).
 *
 *   stream_bot_youtube_gate   one row: whether YouTube linking is open to everyone, and the reviewer accounts that may link
 *                             before Google approves the app (core/stream-bot/youtube/gate.js; owner page
 *                             /super-admin/youtube-review). No row means closed: only the owner may link.
 *   data_retention_policy     YouTube API data is kept 30 days at most (YouTube API Services Developer Policies III.E.4).
 *                             `<table>__youtube` rows sweep only that table's YouTube rows (jobs/retention-sweeper.js
 *                             SCOPED_GUARDS); the plain rows keep their windows for Twitch and Kick. stream_bot_youtube_live
 *                             (the current broadcast of a linked channel, refreshed every few minutes) gets 30 days too.
 *
 * Safe to run again (CREATE TABLE IF NOT EXISTS; the policy rows are upserted to 30 days). down() removes both.
 */
import { gateDdl, GATE_TABLE } from '../core/stream-bot/youtube/gate.js';

export const RETENTION_ROWS = Object.freeze([
    ['stream_bot_events__youtube', 'created_at', 30, 'YouTube rows of the stream bot event log: 30 days (YouTube API policy III.E.4)'],
    ['stream_bot_viewers__youtube', 'last_seen_at', 30, 'YouTube viewer records: 30 days after last seen (YouTube API policy III.E.4)'],
    ['stream_bot_viewer_history__youtube', 'created_at', 30, 'History rows of YouTube viewer records: 30 days (YouTube API policy III.E.4)'],
    ['stream_bot_store_redemptions__youtube', 'created_at', 30, 'YouTube store redemptions (none since 2026-11-21): 30 days'],
    ['stream_bot_media_requests__youtube', 'created_at', 30, 'YouTube media share requests (none since 2026-11-21): 30 days'],
    ['stream_bot_music_requests__youtube', 'created_at', 30, 'Song requests from YouTube chat: 30 days (YouTube API policy III.E.4)'],
    ['stream_bot_music_likes__youtube', 'created_at', 30, 'Song likes from YouTube chat: 30 days (YouTube API policy III.E.4)'],
    ['stream_bot_quotes__youtube', 'created_at', 30, 'Quotes added from YouTube chat: 30 days (YouTube API policy III.E.4)'],
    ['stream_bot_youtube_live', 'updated_at', 30, 'YouTube live state of a linked channel: 30 days after its last refresh (YouTube API policy III.E.4)'],
]);

async function tableExists(db, name) {
    const [rows] = await db.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [name]);
    return Number(rows[0].n) > 0;
}

export async function up(db) {
    await db.query(gateDdl(GATE_TABLE));
    if (await tableExists(db, 'data_retention_policy')) {
        for (const [table, column, days, notes] of RETENTION_ROWS) {
            await db.query(`INSERT INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes) VALUES (?, ?, ?, 1, ?)
                            ON DUPLICATE KEY UPDATE timestamp_column = VALUES(timestamp_column), retain_days = VALUES(retain_days), enabled = 1, notes = VALUES(notes)`,
            [table, column, days, notes]);
        }
    }
}

export async function down(db) {
    if (await tableExists(db, 'data_retention_policy')) {
        await db.query(`DELETE FROM data_retention_policy WHERE table_name IN (${RETENTION_ROWS.map(() => '?').join(', ')})`, RETENTION_ROWS.map((r) => r[0]));
    }
    await db.query(`DROP TABLE IF EXISTS \`${GATE_TABLE}\``);
}

export default { up, down, RETENTION_ROWS };
