/**
 * Wave 405 — twitch_teams live board: one message in a chosen channel listing which team members are
 * live right now, edited in place by core/team-live-board.js.
 *
 * live_board_channel_id  where the board lives (NULL = no board)
 * live_board_message_id  the board message, so it is edited rather than re-posted
 */
export async function up(pool) {
    const [cols] = await pool.query(`SHOW COLUMNS FROM twitch_teams LIKE 'live_board_%'`);
    const have = new Set(cols.map(c => c.Field));
    if (!have.has('live_board_channel_id')) {
        await pool.query(`ALTER TABLE twitch_teams ADD COLUMN live_board_channel_id VARCHAR(32) NULL DEFAULT NULL`);
    }
    if (!have.has('live_board_message_id')) {
        await pool.query(`ALTER TABLE twitch_teams ADD COLUMN live_board_message_id VARCHAR(32) NULL DEFAULT NULL`);
    }
}
