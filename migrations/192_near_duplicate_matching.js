import pool from '../utils/db.js';

/**
 * Opt-in flag for near-duplicate cross-channel spam grouping.
 *
 * The old grouping keyed on an exact SHA-256 of the message, so it only ever caught byte-identical
 * copy-paste. Near-duplicate grouping (core/spam-similarity.js) also catches the lightly-edited
 * copies real spammers send — which means it fires MORE often, and 24 of the 40 guilds with
 * adaptive spam enabled run a cross-channel threshold of only 3.
 *
 * Turning that on everywhere at once would quietly increase enforcement in servers that never
 * asked for it, so it is off by default and enabled per guild.
 */
export async function up() {
    const [cols] = await pool.execute("SHOW COLUMNS FROM adaptive_spam_config LIKE 'near_duplicate_matching'");
    if (cols.length === 0) {
        await pool.execute(
            `ALTER TABLE adaptive_spam_config
             ADD COLUMN near_duplicate_matching TINYINT(1) NOT NULL DEFAULT 0`);
    }
    console.log('[Migration 192] adaptive_spam_config.near_duplicate_matching added (off by default)');
}

export async function down() {
    await pool.execute('ALTER TABLE adaptive_spam_config DROP COLUMN near_duplicate_matching').catch(() => {});
    console.log('[Migration 192] near_duplicate_matching dropped');
}
