/**
 * Chat giveaways: viewers type !<keyword> to enter the channel's active
 * giveaway. Cached active-giveaway lookup (60s TTL, dashboard-busted) so the
 * per-message check is cheap. Entry insert is INSERT IGNORE — the bot replies
 * only on a user's FIRST entry to avoid spam.
 */
import realPool from '../../utils/db.js';

const CACHE_TTL_MS = 60_000;

export function makeGiveaways({ pool, ttlMs = CACHE_TTL_MS }) {
    const cache = new Map(); // channelPk -> { giveaway|null, expiresAt }

    async function getActive(channelPk) {
        const key = Number(channelPk);
        const cached = cache.get(key);
        if (cached && cached.expiresAt > Date.now()) return cached.giveaway;
        const [[row]] = await pool.execute(
            "SELECT id, keyword, title FROM tokes_giveaways WHERE channel_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
            [key]
        );
        const giveaway = row || null;
        cache.set(key, { giveaway, expiresAt: Date.now() + ttlMs });
        return giveaway;
    }

    /** Try to enter; returns 'entered' | 'already' | null (no active giveaway / keyword mismatch). */
    async function tryEnter(channelPk, commandName, userId, username) {
        const g = await getActive(channelPk);
        if (!g || String(g.keyword).toLowerCase() !== String(commandName).toLowerCase()) return null;
        const [r] = await pool.execute(
            'INSERT IGNORE INTO tokes_giveaway_entries (giveaway_id, platform_user_id, username) VALUES (?, ?, ?)',
            [g.id, String(userId), String(username || '').slice(0, 100)]
        );
        return r.affectedRows ? 'entered' : 'already';
    }

    function clear(channelPk) { if (channelPk != null) cache.delete(Number(channelPk)); }

    return { getActive, tryEnter, clear };
}

const live = makeGiveaways({ pool: realPool });
export const getActiveGiveaway = live.getActive;
export const tryEnterGiveaway = live.tryEnter;
export const clearGiveawayCache = live.clear;
