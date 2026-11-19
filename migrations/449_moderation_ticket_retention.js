/**
 * Migration 449 — retention for moderation records, tickets and raid lockdowns (register H-673; the owner
 * left the periods to us). Until now these tables had no data_retention_policy row and were kept forever.
 * jobs/retention-sweeper.js deletes by the timestamp column below, in batches, every night.
 *
 *   infractions         created_at  730 days  Bans, kicks, mutes and the other moderation records. Two years keeps
 *                                             repeat offences visible for twice as long as the moderation log
 *                                             (audit_logs, 365 days). Warnings already go after one year
 *                                             (jobs/cleanup-scheduler.js). Escalation reads at most 30 days back.
 *   tickets             closed_at   365 days  Closed tickets, with their form answers; ticket_notes go with them
 *                                             (ON DELETE CASCADE). An open ticket has no closed_at and is never swept.
 *   ticket_transcripts  created_at  365 days  Encrypted ticket and modmail transcripts, written when the ticket
 *                                             closes, so they last as long as the closed ticket.
 *   raid_lockdowns      ended_at    180 days  Ended lockdowns and the members they blocked. An active lockdown has
 *                                             no ended_at and is never swept. 180 days matches invite tracking.
 *
 * The transcript HTML files in transcripts/ follow the tickets row: the sweeper deletes files older than its
 * retain_days (jobs/retention-sweeper.js pruneTranscriptFiles).
 *
 * The indexes keep the nightly DELETE ... WHERE <column> < ... off a full scan.
 * Idempotent: indexes are added only when missing, policy rows with INSERT IGNORE.
 */
const INDEXES = [
    ['infractions', 'idx_infractions_created', 'created_at'],
    ['tickets', 'idx_tickets_closed', 'closed_at'],
    ['raid_lockdowns', 'idx_raid_lockdowns_ended', 'ended_at'],
];

async function hasIndex(db, table, name) {
    const [rows] = await db.query(
        `SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`, [table, name]);
    return rows.length > 0;
}

export async function up(db) {
    for (const [table, name, column] of INDEXES) {
        if (!(await hasIndex(db, table, name))) await db.query(`ALTER TABLE \`${table}\` ADD KEY \`${name}\` (\`${column}\`)`);
    }
    await db.query(`
        INSERT IGNORE INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes) VALUES
            ('infractions', 'created_at', 730, 1, 'Moderation records (bans, kicks, mutes). Two years for repeat offences; warnings go after one year (cleanup-scheduler).'),
            ('tickets', 'closed_at', 365, 1, 'Closed tickets and their form answers; notes cascade. Open tickets (closed_at NULL) are never swept.'),
            ('ticket_transcripts', 'created_at', 365, 1, 'Encrypted ticket and modmail transcripts, as long as the closed ticket. The HTML files follow the tickets row.'),
            ('raid_lockdowns', 'ended_at', 180, 1, 'Ended raid lockdowns and who they blocked. Active ones (ended_at NULL) are never swept.')`);
}

export async function down(db) {
    await db.query(`DELETE FROM data_retention_policy
                     WHERE table_name IN ('infractions', 'tickets', 'ticket_transcripts', 'raid_lockdowns')`);
    for (const [table, name] of INDEXES) {
        if (await hasIndex(db, table, name)) await db.query(`ALTER TABLE \`${table}\` DROP KEY \`${name}\``);
    }
}
