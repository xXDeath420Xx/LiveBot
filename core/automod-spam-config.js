/**
 * Switching on the Spam limits (automod_spam_config, the dashboard's ?page=automod-spam).
 *
 * The page shows the defaults in core/feature-config-spec.js ('automod-spam'), but the table's own
 * column defaults differ (5 s window, 10 emoji, 20 repeats, mute). Paths that switched the feature on
 * by inserting only (guild_id, enabled) - the setup wizard and the takeover catalogue - left a new
 * row on the column defaults, so the same feature had two sets of defaults. Both now go through
 * enableAutomodSpam(): a new row gets the page's defaults, an existing row is only switched on.
 */
import pool from '../utils/db.js';
import { defaultsFor } from './feature-config-spec.js';

export const AUTOMOD_SPAM_LIMIT_COLUMNS = Object.freeze(['max_messages', 'time_window', 'max_mentions', 'max_emojis', 'max_repeated_chars', 'action']);

/** The INSERT for enableAutomodSpam, as { sql, params }. Pure. */
export function enableAutomodSpamQuery(guildId) {
    const d = defaultsFor('automod-spam');
    const cols = AUTOMOD_SPAM_LIMIT_COLUMNS;
    return {
        sql: `INSERT INTO automod_spam_config (guild_id, enabled, ${cols.join(', ')})
             VALUES (?, 1, ${cols.map(() => '?').join(', ')})
             ON DUPLICATE KEY UPDATE enabled = 1`,
        params: [String(guildId), ...cols.map((c) => d[c])],
    };
}

/** Switch the Spam limits on for a server: the page's defaults for a new row, saved limits kept otherwise. */
export async function enableAutomodSpam(guildId, db = pool) {
    const { sql, params } = enableAutomodSpamQuery(guildId);
    return db.execute(sql, params);
}

export default { enableAutomodSpam, enableAutomodSpamQuery, AUTOMOD_SPAM_LIMIT_COLUMNS };
