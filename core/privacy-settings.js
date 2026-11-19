/*
 * A member's privacy choices (`user_privacy_settings`, one row per Discord user, bot-wide) and
 * the fast check the message path needs.
 *
 * Written by /privacy opt-out|opt-in (core/privacy-manager.js). Read on every message by
 * utils/message-cache.js and on every delete/edit log by core/log-manager.js, so the set of
 * opted-out users is held in memory and refreshed every few minutes rather than queried per
 * message. A change made through setPrivacySettings() applies immediately in this process.
 *
 * Only two switches are enforced and offered: opt_out_message_logging and opt_out_leaderboards.
 * The table's activity/voice tracking columns are not enforced anywhere yet, so /privacy does
 * not offer them — a switch that does nothing is worse than no switch.
 */

import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const REFRESH_MS = 5 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 30 * 1000;

let messageOptOuts = new Set();
let loadedAt = 0;
let loading = null;

async function refresh() {
    try {
        const [rows] = await pool.execute('SELECT user_id FROM user_privacy_settings WHERE opt_out_message_logging = 1');
        messageOptOuts = new Set(rows.map(r => String(r.user_id)));
        loadedAt = Date.now();
    } catch (error) {
        // Keep the last known set; try again soon rather than on every message.
        loadedAt = Date.now() - REFRESH_MS + RETRY_AFTER_FAILURE_MS;
        logger.error('[Privacy] Failed to load message-logging opt-outs', { error: error.message });
    }
}

/**
 * Has this user asked the bot not to store their messages?
 * The first call waits for the initial load; later refreshes happen in the background.
 */
export async function isMessageLoggingOptedOut(userId) {
    if (!userId) return false;
    if (Date.now() - loadedAt > REFRESH_MS) {
        if (!loading) loading = refresh().finally(() => { loading = null; });
        if (loadedAt === 0) await loading;
    }
    return messageOptOuts.has(String(userId));
}

const DEFAULTS = Object.freeze({ opt_out_message_logging: 0, opt_out_leaderboards: 0 });

/** The user's settings with defaults filled in. */
export async function getPrivacySettings(userId) {
    const [rows] = await pool.execute(
        'SELECT opt_out_message_logging, opt_out_leaderboards, created_at, updated_at FROM user_privacy_settings WHERE user_id = ?',
        [userId]
    );
    if (!rows.length) return { ...DEFAULTS, exists: false };
    return {
        opt_out_message_logging: Number(rows[0].opt_out_message_logging) ? 1 : 0,
        opt_out_leaderboards: Number(rows[0].opt_out_leaderboards) ? 1 : 0,
        created_at: rows[0].created_at,
        updated_at: rows[0].updated_at,
        exists: true,
    };
}

/**
 * Upsert the two enforced switches. Unknown keys are ignored.
 * @param {string} userId
 * @param {{ opt_out_message_logging?: boolean, opt_out_leaderboards?: boolean }} patch
 */
export async function setPrivacySettings(userId, patch) {
    const cols = [];
    const vals = [];
    for (const key of Object.keys(DEFAULTS)) {
        if (key in patch) {
            cols.push(key);
            vals.push(patch[key] ? 1 : 0);
        }
    }
    if (!cols.length) return getPrivacySettings(userId);

    await pool.execute(
        `INSERT INTO user_privacy_settings (user_id, ${cols.join(', ')})
         VALUES (?, ${cols.map(() => '?').join(', ')})
         ON DUPLICATE KEY UPDATE ${cols.map(c => `${c} = VALUES(${c})`).join(', ')}`,
        [userId, ...vals]
    );

    if ('opt_out_message_logging' in patch) {
        if (patch.opt_out_message_logging) messageOptOuts.add(String(userId));
        else messageOptOuts.delete(String(userId));
    }
    return getPrivacySettings(userId);
}

/**
 * SQL fragment for leaderboard queries: excludes members who opted out. `column` must be a
 * trusted identifier (a literal in the caller), never user input.
 */
export function leaderboardOptOutClause(column = 'user_id') {
    return `${column} NOT IN (SELECT user_id FROM user_privacy_settings WHERE opt_out_leaderboards = 1)`;
}

export default { isMessageLoggingOptedOut, getPrivacySettings, setPrivacySettings, leaderboardOptOutClause };
