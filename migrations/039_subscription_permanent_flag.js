/**
 * Add permanent flag to subscriptions table
 * Permanent subscriptions are never removed by automatic cleanup
 */
export async function up(db) {
    await db.execute(`
        ALTER TABLE subscriptions
        ADD COLUMN permanent TINYINT(1) NOT NULL DEFAULT 0
    `);
}

export async function down(db) {
    await db.execute(`
        ALTER TABLE subscriptions
        DROP COLUMN permanent
    `);
}
