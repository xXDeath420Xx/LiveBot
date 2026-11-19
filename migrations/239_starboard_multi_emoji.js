/*
 * She picked seven reaction emoji for the starboard, not one. The column held
 * varchar(64) — a single emoji — so the list silently didn't fit.
 */
export async function up(db) {
    await db.execute('ALTER TABLE starboard_config MODIFY COLUMN emoji TEXT NULL');
}
export async function down(db) {
    await db.execute("ALTER TABLE starboard_config MODIFY COLUMN emoji VARCHAR(64) NULL");
}
