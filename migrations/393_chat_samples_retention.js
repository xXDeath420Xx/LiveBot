/**
 * Wave 393 — sampled chat messages are kept for 90 days (the longest analytics range) instead of a
 * 10,000-message ring buffer per channel, so a busy channel's audit window isn't cut short.
 */
export async function up(pool) {
    await pool.query(`
        INSERT INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes)
        VALUES ('twitch_chat_message_samples', 'occurred_at', 90, 1,
                'Opt-in chat text (chat sampling). 90d matches the longest analytics range.')
        ON DUPLICATE KEY UPDATE timestamp_column = VALUES(timestamp_column), retain_days = VALUES(retain_days),
                                enabled = VALUES(enabled), notes = VALUES(notes)`);
}

export async function down(pool) {
    await pool.query(`DELETE FROM data_retention_policy WHERE table_name = 'twitch_chat_message_samples'`);
}
