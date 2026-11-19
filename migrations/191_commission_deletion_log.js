import pool from '../utils/db.js';

/**
 * Make every commission-filter deletion recoverable, and give a false positive a way to be undone
 * permanently.
 *
 * Before this, a phrase or pattern deletion left nothing behind but `deleted_count + 1`. The
 * message content was gone, so a member saying "the bot ate my post" could not be checked, let
 * alone reversed. Only the soft-sell tier wrote a row, and only because it needed one for review.
 *
 * commission_spam_decisions becomes the log for ALL tiers, and commission_spam_exemptions is the
 * durable "never catch this again" list a moderator builds by ruling on false positives.
 */
export async function up() {
    const [cols] = await pool.execute('SHOW COLUMNS FROM commission_spam_decisions');
    const have = new Set(cols.map(c => c.Field));
    const add = async (name, ddl) => {
        if (!have.has(name)) await pool.execute(`ALTER TABLE commission_spam_decisions ADD COLUMN ${ddl}`);
    };

    // Which tier fired and what it keyed on, so a false positive can be traced to the exact
    // phrase / rule / signal set that caused it and that trigger can be turned off.
    await add('via', "via VARCHAR(16) NOT NULL DEFAULT 'soft-sell'");
    await add('rule', 'rule VARCHAR(64) NULL DEFAULT NULL');
    await add('matched', 'matched VARCHAR(255) NULL DEFAULT NULL');
    // Whether the message was actually removed, and whether a moderator has since undone it.
    await add('deleted', 'deleted TINYINT(1) NOT NULL DEFAULT 0');
    await add('restored_at', 'restored_at DATETIME NULL DEFAULT NULL');
    await add('restored_by', 'restored_by VARCHAR(20) NULL DEFAULT NULL');
    await add('attachments', 'attachments MEDIUMTEXT NULL DEFAULT NULL');
    await add('log_message_id', 'log_message_id VARCHAR(20) NULL DEFAULT NULL');

    // 'allowed' already existed for review rulings; false positives on an auto-deletion need their
    // own verdict so the two are distinguishable in the log.
    await pool.execute(
        `ALTER TABLE commission_spam_decisions
         MODIFY COLUMN verdict ENUM('pending','confirmed','allowed','false_positive')
         NOT NULL DEFAULT 'pending'`);

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS commission_spam_exemptions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            -- 'content': this exact message text is fine here (normalised + hashed)
            -- 'trigger': this phrase / pattern rule / soft-sell signal set stops firing in this guild
            -- 'user':    this member is exempt from the filter entirely
            kind ENUM('content','trigger','user') NOT NULL,
            value VARCHAR(255) NOT NULL,
            note VARCHAR(255) NULL,
            created_by VARCHAR(20) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_exemption (guild_id, kind, value),
            INDEX idx_guild_kind (guild_id, kind)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    console.log('[Migration 191] commission deletion log + exemptions ready');
}

export async function down() {
    await pool.execute('DROP TABLE IF EXISTS commission_spam_exemptions');
    for (const col of ['via', 'rule', 'matched', 'deleted', 'restored_at', 'restored_by', 'attachments', 'log_message_id']) {
        await pool.execute(`ALTER TABLE commission_spam_decisions DROP COLUMN \`${col}\``).catch(() => {});
    }
    console.log('[Migration 191] commission deletion log schema dropped');
}
