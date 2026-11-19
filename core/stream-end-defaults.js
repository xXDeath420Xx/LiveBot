/**
 * Guild-global defaults for stream-end behaviour.
 *
 * `subscriptions.edit_on_end` / `subscriptions.delete_on_end` are per-streamer
 * and are what the announcement cleanup actually reads. This module supplies the
 * value to stamp onto a subscription at CREATE time, so a guild only has to make
 * the decision once instead of re-toggling every streamer that any of the ~15
 * subscription-creating code paths adds later.
 *
 * Precedence, mirroring core/stream-manager.js (edit is checked before delete):
 *   edit_on_end = 1                    -> announcement is edited to "stream ended"
 *   edit_on_end = 0, delete_on_end = 1 -> announcement is deleted
 *   edit_on_end = 0, delete_on_end = 0 -> announcement is kept as-is
 *
 * Callers that carry an explicit per-streamer choice (the edit-streamer modal,
 * `/systems stream-ended set`, auto-track configs, `/alerts shoutout`) must NOT use this
 * — a stored decision always beats the guild default.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

// Matches the DB column defaults, so a missing guild row behaves exactly like a
// guild that never touched the setting.
const FALLBACK = Object.freeze({ edit_on_end: 0, delete_on_end: 1 });

const CACHE_TTL_MS = 60_000;
const cache = new Map(); // guildId -> { value, expires }

/**
 * @param {string} guildId
 * @returns {Promise<{edit_on_end: 0|1, delete_on_end: 0|1}>}
 */
export async function getStreamEndDefaults(guildId) {
    if (!guildId) return { ...FALLBACK };

    const hit = cache.get(guildId);
    if (hit && hit.expires > Date.now()) return { ...hit.value };

    let value = { ...FALLBACK };
    try {
        const [rows] = await pool.execute(
            'SELECT default_edit_on_end, default_delete_on_end FROM guilds WHERE guild_id = ?',
            [guildId],
        );
        if (rows.length) {
            value = {
                edit_on_end: rows[0].default_edit_on_end ? 1 : 0,
                delete_on_end: rows[0].default_delete_on_end ? 1 : 0,
            };
        }
    } catch (error) {
        // A guild that can't be read must not block adding a streamer — fall back
        // to the historical behaviour (delete on end) rather than throwing.
        logger.warn('[StreamEndDefaults] Falling back to delete-on-end', {
            guildId, error: error.message, category: 'streams',
        });
    }

    cache.set(guildId, { value, expires: Date.now() + CACHE_TTL_MS });
    return { ...value };
}

/**
 * Persist the guild defaults. Returns the stored values.
 * Writes the pair together so the two toggles can never disagree with what the
 * UI showed.
 */
export async function setStreamEndDefaults(guildId, { edit_on_end, delete_on_end }) {
    const value = {
        edit_on_end: edit_on_end ? 1 : 0,
        delete_on_end: delete_on_end ? 1 : 0,
    };

    // SELECT-then-write: on MariaDB an INSERT ... ON DUPLICATE KEY UPDATE reports
    // affectedRows = 1 for both branches, so it can't tell us whether the guild
    // row existed, and `guilds` has NOT NULL columns we'd have to invent values for.
    const [existing] = await pool.execute('SELECT guild_id FROM guilds WHERE guild_id = ?', [guildId]);

    if (existing.length) {
        await pool.execute(
            'UPDATE guilds SET default_edit_on_end = ?, default_delete_on_end = ? WHERE guild_id = ?',
            [value.edit_on_end, value.delete_on_end, guildId],
        );
    } else {
        await pool.execute(
            'INSERT INTO guilds (guild_id, default_edit_on_end, default_delete_on_end) VALUES (?, ?, ?)',
            [guildId, value.edit_on_end, value.delete_on_end],
        );
    }

    cache.set(guildId, { value, expires: Date.now() + CACHE_TTL_MS });
    return { ...value };
}

/**
 * Push the guild defaults down onto every existing subscription in the guild.
 * This is the "apply to all streamers" button — an explicit, one-shot action,
 * never something that runs on its own, because it overwrites per-streamer
 * choices someone may have made on purpose.
 *
 * @returns {Promise<number>} subscriptions updated
 */
export async function applyStreamEndDefaultsToExisting(guildId) {
    const value = await getStreamEndDefaults(guildId);
    const [result] = await pool.execute(
        'UPDATE subscriptions SET edit_on_end = ?, delete_on_end = ? WHERE guild_id = ?',
        [value.edit_on_end, value.delete_on_end, guildId],
    );
    return result.affectedRows || 0;
}

/** Drop the cached copy for a guild (used after an out-of-band write). */
export function invalidateStreamEndDefaults(guildId) {
    if (guildId) cache.delete(guildId);
    else cache.clear();
}

export { FALLBACK as STREAM_END_FALLBACK };
