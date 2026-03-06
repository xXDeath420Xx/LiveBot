/**
 * Migration 045: Add alert_channel_id to ticket_panels
 *
 * Separates ticket alerts (new ticket opened → staff notification)
 * from ticket logs (close transcript/summary).
 *
 * - alert_channel_id: where "new ticket opened" embeds go
 * - log_channel_id: where close/transcript logs go (already exists)
 */
export async function up(pool) {
    await pool.execute(`
        ALTER TABLE ticket_panels
        ADD COLUMN alert_channel_id VARCHAR(20) DEFAULT NULL
        AFTER log_channel_id
    `);
}

export async function down(pool) {
    await pool.execute(`
        ALTER TABLE ticket_panels
        DROP COLUMN alert_channel_id
    `);
}
