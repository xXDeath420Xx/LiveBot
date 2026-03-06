/**
 * Migration 048: Add 'csv_import' to source ENUM + 'username' column
 */

export async function up(db) {
    await db.execute(`
        ALTER TABLE global_ban_entries
        MODIFY COLUMN source ENUM('auto_aggregate','manual_report','system','csv_import') NOT NULL DEFAULT 'manual_report'
    `);

    // Add username column for display purposes
    try {
        await db.execute(`
            ALTER TABLE global_ban_entries
            ADD COLUMN username VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL AFTER user_id
        `);
    } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
}

export async function down(db) {
    await db.execute(`
        ALTER TABLE global_ban_entries
        MODIFY COLUMN source ENUM('auto_aggregate','manual_report','system') NOT NULL DEFAULT 'manual_report'
    `);
    await db.execute('ALTER TABLE global_ban_entries DROP COLUMN username');
}
