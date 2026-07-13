/**
 * Migration 095: Self-promo separate announcement channel
 *
 * Adds the columns the dashboard form has been writing for some time but
 * which were never created in the schema:
 *   - announcement_channel_id VARCHAR(20) NULL  -- where go-live notifications post
 *   - same_channel TINYINT(1) NOT NULL DEFAULT 1 -- if 1, announce in signup channel
 *
 * Default same_channel=1 preserves the historical behavior (announcements in
 * the signup channel) for every existing guild.
 *
 * Also seeds guild 1475096615940521994, whose admin had configured a separate
 * announcement channel via the dashboard but the value never persisted because
 * the columns didn't exist. Backfills its already-created subscriptions and
 * removes any live_announcements rows still pinned to the old (signup) channel
 * so the next live tick doesn't try to edit messages there.
 */

const TARGET_GUILD = '1475096615940521994';
const SIGNUP_CHANNEL = '1498793717467975760';
const LIVE_NOTIFIER_CHANNEL = '1475247936974618665';

async function hasColumn(db, column) {
    const allowed = new Set(['announcement_channel_id', 'same_channel']);
    if (!allowed.has(column)) {
        throw new Error(`Refusing to inspect unknown column: ${column}`);
    }
    const [cols] = await db.execute(
        `SHOW COLUMNS FROM self_promo_config LIKE '${column}'`
    );
    return cols.length > 0;
}

export async function up(db) {
    if (!(await hasColumn(db, 'announcement_channel_id'))) {
        await db.execute(`
            ALTER TABLE self_promo_config
            ADD COLUMN announcement_channel_id VARCHAR(20) NULL
            COMMENT 'Where go-live announcements post. NULL = use signup channel_id'
        `);
    }
    if (!(await hasColumn(db, 'same_channel'))) {
        await db.execute(`
            ALTER TABLE self_promo_config
            ADD COLUMN same_channel TINYINT(1) NOT NULL DEFAULT 1
            COMMENT 'If 1, announce in signup channel; if 0, use announcement_channel_id'
        `);
    }

    const [seedResult] = await db.execute(
        `UPDATE self_promo_config
            SET same_channel = 0, announcement_channel_id = ?
          WHERE guild_id = ?`,
        [LIVE_NOTIFIER_CHANNEL, TARGET_GUILD]
    );

    const [subResult] = await db.execute(
        `UPDATE subscriptions
            SET announcement_channel_id = ?
          WHERE guild_id = ?
            AND announcement_channel_id = ?
            AND team_subscription_id IS NULL`,
        [LIVE_NOTIFIER_CHANNEL, TARGET_GUILD, SIGNUP_CHANNEL]
    );

    const [liveResult] = await db.execute(
        `DELETE FROM live_announcements
          WHERE guild_id = ?
            AND channel_id = ?`,
        [TARGET_GUILD, SIGNUP_CHANNEL]
    );

    console.log(
        `[Migration 095] Self-promo announcement channel columns added. ` +
        `Seeded guild ${TARGET_GUILD}: config rows updated=${seedResult.affectedRows}, ` +
        `subscriptions backfilled=${subResult.affectedRows}, ` +
        `stale live_announcements cleared=${liveResult.affectedRows}`
    );
}

export async function down(db) {
    if (await hasColumn(db, 'same_channel')) {
        await db.execute(`ALTER TABLE self_promo_config DROP COLUMN same_channel`);
    }
    if (await hasColumn(db, 'announcement_channel_id')) {
        await db.execute(`ALTER TABLE self_promo_config DROP COLUMN announcement_channel_id`);
    }
    console.log('[Migration 095] Rolled back - self-promo announcement channel columns dropped');
}
