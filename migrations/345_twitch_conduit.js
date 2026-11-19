/**
 * Migration 345 — Twitch EventSub Conduits config storage.
 *
 * Conduits are Twitch's replacement for direct webhook subscriptions when the
 * subscription count scales past ~10K per app. Instead of creating one webhook
 * sub per (broadcaster, event), you create a conduit (a transport layer with
 * 1-20,000 shards), register webhook URLs on the shards, and point every
 * subscription at the conduit. The conduit caps at 20K subs, each with
 * near-free admin overhead.
 *
 * We only need one row — the conduit id Twitch issued us and metadata about
 * it. On first boot after this migration runs, the manager will create the
 * conduit, register its single shard with our webhook URL + secret, and insert
 * the row. Subsequent boots just read it.
 *
 * Idempotent.
 */
async function hasTable(db, table) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasTable(db, 'twitch_eventsub_conduit'))) {
        await db.execute(`
            CREATE TABLE twitch_eventsub_conduit (
                id          TINYINT UNSIGNED NOT NULL DEFAULT 1,
                conduit_id  VARCHAR(64)      NOT NULL,
                shard_count INT UNSIGNED     NOT NULL DEFAULT 1,
                created_at  TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at  TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                CONSTRAINT single_row CHECK (id = 1)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
        console.log('[migrate 345] created twitch_eventsub_conduit');
    } else {
        console.log('[migrate 345] twitch_eventsub_conduit already exists');
    }
}
