/**
 * Migration 444 — one ticket number sequence per server, stored on the ticket (register H-661).
 *
 * An opened ticket showed the server's ticket count + 1 ("Ticket #N", and {number} in the channel name),
 * while the close log and transcript showed the global database id, and a count repeats once rows are
 * deleted. Now:
 *   - tickets.ticket_number holds the number people see (core/ticket-number.js)
 *   - ticket_counters holds each server's last number; it only goes up, so numbers are never reused
 *
 * Existing tickets are numbered per server in the order they were opened (id order), which is the number
 * they showed when opened unless tickets had been deleted before them. Tickets still unnumbered (opened by
 * the old code before the restart) continue after the server's highest number or counter, and the counter
 * is raised to match, so a re-run never hands out a number twice.
 *
 * Idempotent: table, column and index are added only when missing; numbered tickets are left alone.
 */
async function hasColumn(db, table, column) {
    const [rows] = await db.query(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, column]);
    return rows.length > 0;
}
async function hasIndex(db, table, index) {
    const [rows] = await db.query(
        'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1', [table, index]);
    return rows.length > 0;
}

export async function up(db) {
    await db.query(`
        CREATE TABLE IF NOT EXISTS ticket_counters (
            guild_id     VARCHAR(255) NOT NULL PRIMARY KEY,
            last_number  INT NOT NULL DEFAULT 0,
            updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    if (!(await hasColumn(db, 'tickets', 'ticket_number'))) {
        await db.query('ALTER TABLE tickets ADD COLUMN ticket_number INT NULL AFTER guild_id');
        console.log('[migrate 444] tickets.ticket_number added');
    }
    if (!(await hasIndex(db, 'tickets', 'uniq_guild_ticket_number'))) {
        await db.query('ALTER TABLE tickets ADD UNIQUE KEY uniq_guild_ticket_number (guild_id, ticket_number)');
    }

    const [res] = await db.query(`
        UPDATE tickets t
          JOIN (SELECT id, ROW_NUMBER() OVER (PARTITION BY guild_id ORDER BY id) AS rn
                  FROM tickets WHERE ticket_number IS NULL) n ON n.id = t.id
          JOIN (SELECT g.guild_id, GREATEST(COALESCE(MAX(g.ticket_number), 0), COALESCE(MAX(c.last_number), 0)) AS base
                  FROM tickets g LEFT JOIN ticket_counters c ON c.guild_id = g.guild_id
                 GROUP BY g.guild_id) b ON b.guild_id = t.guild_id
           SET t.ticket_number = b.base + n.rn`);
    console.log(`[migrate 444] ${res.affectedRows} ticket(s) numbered`);

    await db.query(`
        INSERT INTO ticket_counters (guild_id, last_number)
        SELECT guild_id, MAX(ticket_number) FROM tickets WHERE ticket_number IS NOT NULL GROUP BY guild_id
        ON DUPLICATE KEY UPDATE last_number = GREATEST(last_number, VALUES(last_number))`);
}

export async function down(db) {
    if (await hasIndex(db, 'tickets', 'uniq_guild_ticket_number')) await db.query('ALTER TABLE tickets DROP KEY uniq_guild_ticket_number');
    if (await hasColumn(db, 'tickets', 'ticket_number')) await db.query('ALTER TABLE tickets DROP COLUMN ticket_number');
    await db.query('DROP TABLE IF EXISTS ticket_counters');
}
