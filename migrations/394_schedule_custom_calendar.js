/**
 * Wave 394 — a schedule can come from a calendar the owner fills in on the dashboard, from Twitch,
 * or from Twitch with per-day changes, and can be drawn as a month poster with the owner's art.
 */
export async function up(pool) {
    const [cols] = await pool.query('SHOW COLUMNS FROM twitch_schedule_sync_config');
    const have = new Set(cols.map((c) => c.Field));
    const add = [
        ['schedule_source', "VARCHAR(10) NOT NULL DEFAULT 'twitch'"],
        ['side_art_url', 'VARCHAR(500) NULL'],
        ['card_disclaimer', 'VARCHAR(600) NULL'],
    ].filter(([name]) => !have.has(name));
    for (const [name, type] of add) {
        await pool.query(`ALTER TABLE twitch_schedule_sync_config ADD COLUMN ${name} ${type}`);
    }
    await pool.query(`
        CREATE TABLE IF NOT EXISTS twitch_schedule_custom_days (
            id INT AUTO_INCREMENT PRIMARY KEY,
            sync_id INT NOT NULL,
            day DATE NOT NULL,
            kind VARCHAR(10) NOT NULL DEFAULT 'stream',
            title VARCHAR(120) NULL,
            title_color CHAR(7) NULL,
            title_color2 CHAR(7) NULL,
            start_time TIME NULL,
            end_time TIME NULL,
            note VARCHAR(160) NULL,
            note_color CHAR(7) NULL,
            updated_by VARCHAR(32) NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_sync_day (sync_id, day)
        )`);
}

export async function down(pool) {
    await pool.query('DROP TABLE IF EXISTS twitch_schedule_custom_days');
    for (const name of ['schedule_source', 'side_art_url', 'card_disclaimer']) {
        await pool.query(`ALTER TABLE twitch_schedule_sync_config DROP COLUMN ${name}`);
    }
}
