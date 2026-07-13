export async function up(db) {
    await db.execute(`
        ALTER TABLE custom_bots
        ADD COLUMN self_service TINYINT(1) NOT NULL DEFAULT 0 AFTER approved
    `);
    console.log('[Migration 061] Added self_service flag to custom_bots');
}

export async function down(db) {
    await db.execute(`
        ALTER TABLE custom_bots
        DROP COLUMN self_service
    `);
    console.log('[Migration 061] Removed self_service flag from custom_bots');
}
