export async function up(pool) {
    await pool.execute(`
        ALTER TABLE global_ban_action_log
        MODIFY COLUMN action ENUM(
            'ban','kick','alert',
            'appeal_submitted','appeal_approved','appeal_denied',
            'report_created','report_approved','report_denied',
            'entry_created','entry_expired','entry_removed',
            'entry_updated'
        ) NOT NULL
    `);
}

export async function down(pool) {
    await pool.execute(`
        ALTER TABLE global_ban_action_log
        MODIFY COLUMN action ENUM(
            'ban','kick','alert',
            'appeal_submitted','appeal_approved','appeal_denied',
            'report_created','report_approved','report_denied',
            'entry_created','entry_expired','entry_removed'
        ) NOT NULL
    `);
}
