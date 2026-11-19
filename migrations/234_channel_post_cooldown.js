/*
 * One post per member per N hours, enforced by us rather than by Discord.
 *
 * Discord's own slow mode cannot express this. It stops at six hours (21600s), and
 * anyone holding Manage Messages ignores it entirely — so the two things a self-promo
 * channel actually wants ("everyone gets one a day" and "staff are exempt") are both
 * out of reach natively.
 *
 * `last_post_at` is written only when a post has PASSED every other rule. A message
 * deleted for missing its image must not start the author's clock — otherwise the
 * first thing a new member learns is that getting it wrong costs them a day.
 */

export async function up(db) {
    const [cols] = await db.execute(
        `SELECT COLUMN_NAME FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'channel_post_rules'
            AND COLUMN_NAME = 'cooldown_hours'`
    );
    if (!cols.length) {
        await db.execute(
            `ALTER TABLE channel_post_rules
               ADD COLUMN cooldown_hours INT(11) NOT NULL DEFAULT 0 AFTER min_member_days`
        );
    }

    await db.execute(`
        CREATE TABLE IF NOT EXISTS channel_post_cooldowns (
            guild_id VARCHAR(20) NOT NULL,
            channel_id VARCHAR(20) NOT NULL,
            user_id VARCHAR(20) NOT NULL,
            last_post_at DATETIME NOT NULL,
            post_count INT(11) NOT NULL DEFAULT 1,
            PRIMARY KEY (guild_id, channel_id, user_id),
            KEY idx_last (last_post_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS channel_post_cooldowns');
    await db.execute('ALTER TABLE channel_post_rules DROP COLUMN cooldown_hours');
}
