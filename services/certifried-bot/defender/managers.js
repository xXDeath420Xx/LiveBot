/**
 * Network-Manager roster for the Kick Defender (dedicated, independent of
 * tokes_users.role). Cached: isManager runs on each manager-gated command.
 */
import pool from '../../../utils/db.js';

const CACHE_TTL_MS = 30_000;
let cache = null;

async function getSet() {
    if (cache && cache.expiresAt > Date.now()) return cache.set;
    const [rows] = await pool.execute('SELECT tokes_user_id FROM kbd_managers');
    const set = new Set(rows.map(r => Number(r.tokes_user_id)));
    cache = { set, expiresAt: Date.now() + CACHE_TTL_MS };
    return set;
}

export function invalidate() { cache = null; }

export async function isManager(tokesUserId) {
    if (tokesUserId == null) return false;
    return (await getSet()).has(Number(tokesUserId));
}

export async function addManager(tokesUserId, addedBy = null) {
    await pool.execute(
        'INSERT IGNORE INTO kbd_managers (tokes_user_id, added_by) VALUES (?, ?)',
        [tokesUserId, addedBy]
    );
    invalidate();
}

export async function removeManager(tokesUserId) {
    await pool.execute('DELETE FROM kbd_managers WHERE tokes_user_id = ?', [tokesUserId]);
    invalidate();
}

export async function managerCount() {
    const [[row]] = await pool.execute('SELECT COUNT(*) n FROM kbd_managers');
    return Number(row.n);
}

/**
 * List current managers with their display name + when they were added, so the
 * admin UI can show WHO the managers are (not just a count). Best-effort join to
 * tokes_users for the name; falls back to the raw id.
 */
export async function listManagers() {
    const [rows] = await pool.execute(`
        SELECT m.tokes_user_id, m.created_at, u.primary_name
        FROM kbd_managers m
        LEFT JOIN tokes_users u ON u.id = m.tokes_user_id
        ORDER BY m.created_at DESC
    `);
    return rows.map(r => ({
        userId: Number(r.tokes_user_id),
        name: r.primary_name || ('user #' + r.tokes_user_id),
        addedAt: r.created_at
    }));
}
