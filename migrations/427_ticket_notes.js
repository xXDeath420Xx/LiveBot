/**
 * Tickets: staff notes written from the dashboard's ticket details dialog (H-109).
 *
 *   ticket_notes  one row per note; never shown to the member who opened the ticket
 *
 * Written and read by dashboard/routes/api/features/tickets.js (POST/GET
 * /api/guilds/:guildId/tickets/:ticketId/notes, and the details payload). The route answers
 * 503 "needs migration" on note writes and returns an empty list on reads until this runs.
 * Notes are removed with their ticket (FK cascade).
 * Apply directly: import { up } and call up(pool).
 */
async function hasTable(pool, table) {
    const [rows] = await pool.query(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
    return rows.length > 0;
}

export async function up(pool) {
    if (!(await hasTable(pool, 'ticket_notes'))) {
        await pool.query(`
            CREATE TABLE \`ticket_notes\` (
                \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
                \`ticket_id\` INT(11) NOT NULL,
                \`guild_id\` VARCHAR(20) NOT NULL,
                \`author_id\` VARCHAR(20) NOT NULL,
                \`note\` TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
                \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (\`id\`),
                KEY \`idx_ticket\` (\`ticket_id\`, \`created_at\`),
                KEY \`idx_guild\` (\`guild_id\`),
                CONSTRAINT \`ticket_notes_ticket_fk\` FOREIGN KEY (\`ticket_id\`) REFERENCES \`tickets\` (\`id\`) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }
}

export async function down(pool) {
    if (await hasTable(pool, 'ticket_notes')) {
        await pool.query('DROP TABLE `ticket_notes`');
    }
}
