/*
 * Who may link a YouTube channel while Google is still reviewing CertiFried's OAuth verification (2026-11-21).
 *
 * Until Google approves the app, every grant of an unverified sensitive scope counts toward Google's 100-user cap and is
 * "production traffic on an unverified app". So the YouTube link flows (stream bot "Link YouTube", the multicast YouTube
 * connect and their callbacks) are open only to the owner and to reviewer accounts the owner lists; everyone else is told
 * IN_REVIEW_TEXT. One switch, "Open YouTube linking to everyone", on the owner console page /super-admin/youtube-review,
 * turns the gate off once Google approves. The /privacy/viewer YouTube sign-in is not gated: it has no CertiFried account to
 * check, reads one channel id with youtube.readonly and revokes the token at once.
 *
 *   createYouTubeGate({ db, table?, ownerIds?, now?, cacheMs?, logger? })
 *     state()                       { open, reviewers: [{ id, note, addedAt }], updatedAt, updatedBy, stored }
 *     allows(discordId)             open, the owner, or a listed reviewer. Fails closed (owner only) when the table is missing
 *                                   or cannot be read.
 *     setOpen(open, by) / addReviewer(id, note, by) / removeReviewer(id, by)
 *   IN_REVIEW_TEXT, GATE_TABLE, OWNER_DISCORD_ID, gateDdl(table)
 *
 * Storage: one row in stream_bot_youtube_gate (migration 480). Tested in tests/youtube-no-rewards.test.js.
 */

export const OWNER_DISCORD_ID = '365905620060340224';
export const GATE_TABLE = 'stream_bot_youtube_gate';
export const IN_REVIEW_TEXT = 'YouTube linking is in review with Google, back soon.';
export const MAX_REVIEWERS = 20;
const SNOWFLAKE = /^\d{15,25}$/;

export function gateDdl(table = GATE_TABLE) {
    return `CREATE TABLE IF NOT EXISTS \`${table}\` (
        id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
        is_open TINYINT(1) NOT NULL DEFAULT 0,
        reviewers TEXT NULL,
        updated_by VARCHAR(32) DEFAULT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
}

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function parseReviewers(text) {
    let list = [];
    try { list = JSON.parse(text || '[]'); } catch { list = []; }
    return (Array.isArray(list) ? list : []).filter((r) => r && SNOWFLAKE.test(String(r.id)))
        .map((r) => ({ id: String(r.id), note: clean(r.note, 100), addedAt: r.addedAt || null })).slice(0, MAX_REVIEWERS);
}

export function createYouTubeGate({ db, table = GATE_TABLE, ownerIds = [OWNER_DISCORD_ID, process.env.BOT_OWNER_ID], now = () => Date.now(), cacheMs = 15_000, logger = null } = {}) {
    if (!/^[A-Za-z0-9_]+$/.test(table)) throw new Error('bad table name');
    const owners = new Set(ownerIds.filter(Boolean).map(String));
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[YouTubeGate] ${msg}`, meta); } catch { /* ignore */ } };
    let cache = null;
    const closed = () => ({ open: false, reviewers: [], updatedAt: null, updatedBy: null, stored: false });

    async function state() {
        if (cache && now() - cache.at < cacheMs) return cache.value;
        let value;
        try {
            const [rows] = await db.query(`SELECT is_open, reviewers, updated_by, updated_at FROM \`${table}\` WHERE id = 1`);
            const r = rows[0];
            value = r ? { open: !!Number(r.is_open), reviewers: parseReviewers(r.reviewers), updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null, updatedBy: r.updated_by || null, stored: true }
                : closed();
        } catch (err) {
            log('warn', 'could not read the gate; only the owner may link YouTube', { error: err?.code || err?.message });
            value = closed();
        }
        cache = { at: now(), value };
        return value;
    }

    async function allows(discordId) {
        const id = String(discordId || '');
        if (!id) return false;
        if (owners.has(id)) return true;
        const s = await state();
        return s.open || s.reviewers.some((r) => r.id === id);
    }

    async function save(next, by) {
        await db.query(`INSERT INTO \`${table}\` (id, is_open, reviewers, updated_by) VALUES (1, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE is_open = VALUES(is_open), reviewers = VALUES(reviewers), updated_by = VALUES(updated_by)`,
        [next.open ? 1 : 0, JSON.stringify(next.reviewers), clean(by, 32) || null]);
        cache = null;
        return state();
    }

    return {
        state,
        allows,
        async setOpen(open, by) {
            const s = await state();
            return save({ ...s, open: !!open }, by);
        },
        async addReviewer(id, note, by) {
            const rid = String(id || '').trim();
            if (!SNOWFLAKE.test(rid)) return { ok: false, error: 'bad_id' };
            const s = await state();
            if (s.reviewers.some((r) => r.id === rid)) return { ok: false, error: 'exists' };
            if (s.reviewers.length >= MAX_REVIEWERS) return { ok: false, error: 'full' };
            const st = await save({ ...s, reviewers: [...s.reviewers, { id: rid, note: clean(note, 100), addedAt: new Date(now()).toISOString() }] }, by);
            return { ok: true, state: st };
        },
        async removeReviewer(id, by) {
            const s = await state();
            const left = s.reviewers.filter((r) => r.id !== String(id));
            if (left.length === s.reviewers.length) return { ok: false, error: 'not_listed' };
            return { ok: true, state: await save({ ...s, reviewers: left }, by) };
        },
        isOwner: (id) => owners.has(String(id || '')),
        _clearCache() { cache = null; },
    };
}

let shared = null;
/** The gate on the app's database pool (one per process). */
export async function youtubeGate() {
    if (shared) return shared;
    const { default: pool } = await import('../../../utils/db.js');
    const { default: logger } = await import('../../../utils/logger.js');
    shared = createYouTubeGate({ db: pool, logger });
    return shared;
}

export default { createYouTubeGate, youtubeGate, gateDdl, IN_REVIEW_TEXT, GATE_TABLE, OWNER_DISCORD_ID, MAX_REVIEWERS };
