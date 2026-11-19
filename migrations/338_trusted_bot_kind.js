/**
 * Migration 338 — extend protection_allowlist.kind to include 'bot'.
 *
 * Lets admins mark specific bot user IDs as pre-approved for their server. The join-time
 * audit-log handler at events/guildAuditLogEntryCreate.js reads this when a bot is added
 * (AuditLogEvent.BotAdd) and distinguishes trusted vs. unauthorized bot additions in the
 * log embed. Enforcement actions (kick/ban) will arrive in a later wave once the
 * dashboard-side management UI for trusted bots is built.
 *
 * Idempotent: safe to re-run — only alters the enum when 'bot' is not already a member.
 *
 * Apply directly: `import { up } and call up(pool)` (migrations/run.js is unreliable).
 */
async function columnEnumValues(db, table, column) {
    const [rows] = await db.execute(
        `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]);
    if (!rows.length) return null;
    const t = String(rows[0].COLUMN_TYPE);
    // "enum('a','b','c')"
    const match = t.match(/^enum\((.+)\)$/i);
    if (!match) return null;
    return match[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
}

export async function up(db) {
    const current = await columnEnumValues(db, 'protection_allowlist', 'kind');
    if (!current) throw new Error('protection_allowlist.kind column not found');
    if (current.includes('bot')) return;   // already extended
    const extended = [...current, 'bot'];
    const enumLiteral = extended.map(v => `'${v.replace(/'/g, "''")}'`).join(',');
    await db.execute(
        `ALTER TABLE protection_allowlist MODIFY COLUMN kind ENUM(${enumLiteral}) NOT NULL`,
    );
}

export async function down(db) {
    // Rollback the enum. Will fail if any rows have kind='bot' — that is correct; we don't
    // want to silently drop trusted-bot assignments.
    const current = await columnEnumValues(db, 'protection_allowlist', 'kind');
    if (!current || !current.includes('bot')) return;
    const reduced = current.filter(v => v !== 'bot');
    const enumLiteral = reduced.map(v => `'${v.replace(/'/g, "''")}'`).join(',');
    await db.execute(
        `ALTER TABLE protection_allowlist MODIFY COLUMN kind ENUM(${enumLiteral}) NOT NULL`,
    );
}
