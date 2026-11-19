/**
 * Per-guild moderation reason aliases.
 *
 * Lets admins register short tokens (e.g. `gh`) that commands expand to a full reason string
 * (`guideline hopper (repeat offender)`) before persisting an audit-log entry. Alias names are
 * stored lower-case and matched case-insensitively, so an admin typing `GH` or `gh` both hit
 * the same row.
 *
 * Public API (consumed by `/ban`, every `/admin mod` command that takes a reason (warn, mute, kick, ban,
 * unban, unmute, clearinfractions, slowmode, lock, temprole, also reached as !warn, !kick...), and `/modreason`):
 *   - list(guildId)                                → [{ alias, full_reason, uses, last_used_at }]
 *   - add(guildId, alias, fullReason, createdBy)   → { ok, row? } | { ok:false, error }
 *   - remove(guildId, alias)                       → { ok, removed:bool }
 *   - expand(guildId, text)                        → { reason, aliasMatched:string|null }
 *   - expandReason(guildId, text)                  → the full reason, or text unchanged (never throws)
 *   - reasonOption(interaction)                    → the `reason` option, expanded (the shared reason path)
 *
 * `expand()` is the hot path. It:
 *   1. Trims the input.
 *   2. If the entire string (case-insensitive) matches a stored alias, returns the full_reason
 *      and increments uses + last_used_at (fire-and-forget).
 *   3. Otherwise returns the input unchanged.
 *
 * Does NOT do substring expansion mid-sentence — that would be surprising and could corrupt
 * reasons that legitimately contain the alias text ("gh" in "ugh they did it again"). Only
 * whole-input matches expand.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const LOG = '[ModReasonAliases]';

const MAX_ALIAS_LEN = 32;
const MAX_REASON_LEN = 900;      // Discord's audit-log reason cap is 512 bytes but Node string
                                 // length is characters; keep ample headroom.

function normaliseAlias(s) {
    return String(s ?? '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, MAX_ALIAS_LEN);
}

/** List all aliases for a guild, newest-first. Returns [] on any error. */
export async function list(guildId) {
    try {
        const [rows] = await pool.execute(
            `SELECT alias, full_reason, uses, last_used_at, created_at, created_by
               FROM moderation_reason_aliases WHERE guild_id = ?
               ORDER BY uses DESC, alias ASC`,
            [String(guildId)]);
        return rows;
    } catch (err) {
        logger.warn(`${LOG} list failed`, { guildId, err: err.message });
        return [];
    }
}

/** Add a new alias. Returns { ok:true, row } or { ok:false, error }. */
export async function add(guildId, alias, fullReason, createdBy = null) {
    const a = normaliseAlias(alias);
    const r = String(fullReason ?? '').trim();
    if (!a) return { ok: false, error: 'Alias cannot be empty.' };
    if (a.length > MAX_ALIAS_LEN) return { ok: false, error: `Alias is capped at ${MAX_ALIAS_LEN} characters.` };
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(a)) return { ok: false, error: 'Alias may only contain letters, numbers, dot, dash, underscore.' };
    if (!r) return { ok: false, error: 'The full reason cannot be empty.' };
    if (r.length > MAX_REASON_LEN) return { ok: false, error: `Full reason is capped at ${MAX_REASON_LEN} characters.` };
    try {
        await pool.execute(
            `INSERT INTO moderation_reason_aliases (guild_id, alias, full_reason, created_by)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE full_reason = VALUES(full_reason), created_by = VALUES(created_by)`,
            [String(guildId), a, r, createdBy ? String(createdBy) : null]);
        return { ok: true, row: { alias: a, full_reason: r } };
    } catch (err) {
        logger.warn(`${LOG} add failed`, { guildId, alias: a, err: err.message });
        return { ok: false, error: 'Database error; try again.' };
    }
}

/** Remove an alias. Returns { ok:true, removed:bool }. */
export async function remove(guildId, alias) {
    const a = normaliseAlias(alias);
    if (!a) return { ok: true, removed: false };
    try {
        const [r] = await pool.execute(
            `DELETE FROM moderation_reason_aliases WHERE guild_id = ? AND alias = ?`,
            [String(guildId), a]);
        return { ok: true, removed: r.affectedRows > 0 };
    } catch (err) {
        logger.warn(`${LOG} remove failed`, { guildId, alias: a, err: err.message });
        return { ok: false, removed: false };
    }
}

/**
 * Expand an input to its full reason if (and only if) the entire input matches a stored
 * alias. Returns { reason, aliasMatched }.
 *
 * Hot path — called from ban/kick/warn/timeout before persisting. Keep cheap; log usage
 * fire-and-forget so a DB blip never blocks the moderation action.
 */
export async function expand(guildId, text, { db = pool } = {}) {
    const original = String(text ?? '').trim();
    if (!original || original.length > MAX_ALIAS_LEN) {
        return { reason: original, aliasMatched: null };
    }
    const a = normaliseAlias(original);
    if (!a) return { reason: original, aliasMatched: null };
    try {
        const [rows] = await db.execute(
            `SELECT full_reason FROM moderation_reason_aliases WHERE guild_id = ? AND alias = ? LIMIT 1`,
            [String(guildId), a]);
        if (!rows.length) return { reason: original, aliasMatched: null };
        Promise.resolve(db.execute(
            `UPDATE moderation_reason_aliases SET uses = uses + 1, last_used_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND alias = ?`,
            [String(guildId), a])).catch(() => {});
        return { reason: rows[0].full_reason, aliasMatched: a };
    } catch (err) {
        logger.warn(`${LOG} expand failed`, { guildId, err: err.message });
        return { reason: original, aliasMatched: null };
    }
}

/**
 * A moderation reason with a stored alias expanded (only when the whole reason is an alias). Anything
 * else, an empty reason, or a failed lookup comes back exactly as given, so a DB blip never blocks or
 * changes a moderation action.
 */
export async function expandReason(guildId, text, opts = {}) {
    if (text == null || !String(text).trim() || !guildId) return text;
    try {
        const out = await expand(guildId, text, opts);
        return out.aliasMatched ? out.reason : text;
    } catch {
        return text;
    }
}

/**
 * The shared reason path for the moderation commands: the `reason` option as typed, expanded through
 * the server's /modreason aliases (H-713). Works for slash interactions and the chat adapter alike.
 */
export async function reasonOption(interaction, opts = {}) {
    const raw = interaction?.options?.getString?.('reason') ?? null;
    return expandReason(interaction?.guildId ?? interaction?.guild?.id, raw, opts);
}

export default { list, add, remove, expand, expandReason, reasonOption };
