/**
 * Migration 092: fix owo_quest.claimed default.
 *
 * MariaDB auto-applies DEFAULT CURRENT_TIMESTAMP to timestamp columns when
 * no explicit default is given, which poisoned the quest system — every
 * newly-inserted quest immediately showed as claimed. Force DEFAULT NULL.
 */
export async function up(db) {
    const [cols] = await db.execute("SHOW COLUMNS FROM owo_quest WHERE Field = 'claimed'");
    if (cols[0] && (cols[0].Default !== null || cols[0].Null !== 'YES')) {
        await db.execute('ALTER TABLE owo_quest MODIFY claimed TIMESTAMP NULL DEFAULT NULL');
    }
}

export async function down(db) {
    // No meaningful reverse — the previous auto-default was never intentional.
}
