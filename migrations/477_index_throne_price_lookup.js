/*
 * Index for the Throne "latest price per item" lookup (infra DB tuning, 2026-11-21).
 *
 * core/throne-manager.js runs, about once a minute:
 *   SELECT item_id, price_raw FROM throne_price_history
 *    WHERE throne_username = ? AND (item_id, recorded_at) IN
 *          (SELECT item_id, MAX(recorded_at) FROM throne_price_history WHERE throne_username = ? GROUP BY item_id)
 * With only (throne_username, item_id) indexed, the outer query was a full scan of 4.3M rows:
 * slow log 2026-11-21, 35 runs in 25 min, 3.8 s each, 5.8M rows examined per run.
 *
 * (throne_username, item_id, recorded_at) serves the GROUP BY/MAX as a loose index scan and the
 * outer (item_id, recorded_at) match as a ref lookup. It makes idx_item (its prefix) redundant.
 * idx_time duplicates idx_retention_recorded_at (both (recorded_at)); the retention sweeper keeps
 * using idx_retention_recorded_at.
 *
 * Online DDL (INPLACE, LOCK=NONE): reads and inserts keep working while the index builds.
 * Idempotent: each step checks information_schema first.
 */
async function hasIndex(db, name) {
    const [rows] = await db.query(
        `SELECT 1 FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = 'throne_price_history' AND index_name = ? LIMIT 1`,
        [name]
    );
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasIndex(db, 'idx_user_item_time'))) {
        await db.query(`ALTER TABLE throne_price_history
            ADD INDEX idx_user_item_time (throne_username, item_id, recorded_at),
            ALGORITHM=INPLACE, LOCK=NONE`);
    }
    if (await hasIndex(db, 'idx_item')) {
        await db.query('ALTER TABLE throne_price_history DROP INDEX idx_item, ALGORITHM=INPLACE, LOCK=NONE');
    }
    if ((await hasIndex(db, 'idx_time')) && (await hasIndex(db, 'idx_retention_recorded_at'))) {
        await db.query('ALTER TABLE throne_price_history DROP INDEX idx_time, ALGORITHM=INPLACE, LOCK=NONE');
    }
}

export async function down(db) {
    if (!(await hasIndex(db, 'idx_item'))) {
        await db.query('ALTER TABLE throne_price_history ADD INDEX idx_item (throne_username, item_id), ALGORITHM=INPLACE, LOCK=NONE');
    }
    if (!(await hasIndex(db, 'idx_time'))) {
        await db.query('ALTER TABLE throne_price_history ADD INDEX idx_time (recorded_at), ALGORITHM=INPLACE, LOCK=NONE');
    }
    if (await hasIndex(db, 'idx_user_item_time')) {
        await db.query('ALTER TABLE throne_price_history DROP INDEX idx_user_item_time, ALGORITHM=INPLACE, LOCK=NONE');
    }
}
