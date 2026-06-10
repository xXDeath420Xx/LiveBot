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
