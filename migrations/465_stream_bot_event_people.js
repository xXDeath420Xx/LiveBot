/**
 * Migration 465: who a stored stream bot event names besides its actor (H-783), for /privacy and /privacy/viewer.
 *
 *   stream_bot_event_people   one row per person named in an event: a chat reply's parent (and thread starter), a
 *                             chat mention, a Kick gift sub recipient, a Twitch raid's target. platform_user_id when
 *                             the platform gave one, else the login (a Kick "@name"). Indexed by (platform,
 *                             platform_user_id) and (platform, login) so export and delete never scan `raw`. Rows go
 *                             with their event (FK ON DELETE CASCADE), so event retention covers them.
 *                             core/stream-bot/named.js writes them from store.insertEvent and reads them.
 *   music name indexes        song requests name a moderator only by display name (music_requests.decided_by,
 *                             music_bans.created_by, music_playlist_items.added_by): indexed for the same lookups.
 *
 * Backfill: the existing chat, gift_sub and raid events, in id order, 500 at a time.
 * Column names avoid core/privacy-tables.js USER_ID_COLUMNS (these are platform ids, not Discord ids).
 * Idempotent. `eventPeopleDdl(prefix)` builds the table under a test prefix.
 * Apply: npm run migrate -- 465_stream_bot_event_people.js
 */
import { namedPeople } from '../core/stream-bot/named.js';

const TAIL = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

export function eventPeopleDdl(prefix = 'stream_bot_') {
    const t = (n) => `\`${prefix}${n}\``;
    return [
        `CREATE TABLE IF NOT EXISTS ${t('event_people')} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            event_id BIGINT UNSIGNED NOT NULL,
            profile_id BIGINT UNSIGNED NOT NULL,
            platform VARCHAR(16) NOT NULL,
            platform_user_id VARCHAR(64) DEFAULT NULL,
            login VARCHAR(100) DEFAULT NULL,
            role VARCHAR(16) NOT NULL,
            PRIMARY KEY (id),
            KEY idx_person (platform, platform_user_id),
            KEY idx_login (platform, login),
            KEY idx_event (event_id),
            CONSTRAINT ${prefix}fk_event_people_event FOREIGN KEY (event_id) REFERENCES ${t('events')} (id) ON DELETE CASCADE
        ) ${TAIL}`,
    ];
}

export const MUSIC_NAME_INDEXES = Object.freeze([
    ['music_requests', 'idx_decided_by', 'decided_by'],
    ['music_bans', 'idx_created_by', 'created_by'],
    ['music_playlist_items', 'idx_added_by', 'added_by'],
]);

export async function musicNameIndexes(db, prefix = 'stream_bot_') {
    for (const [table, index, column] of MUSIC_NAME_INDEXES) {
        const name = `${prefix}${table}`;
        const [have] = await db.query('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [name]);
        if (!have.length) continue;   // migration 457 not applied here
        const [idx] = await db.query('SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1', [name, index]);
        if (!idx.length) await db.query(`ALTER TABLE \`${name}\` ADD KEY ${index} (${column})`);
    }
}

/** Index the events stored before this migration. Returns how many people rows were written. */
export async function backfill(db, prefix = 'stream_bot_', batch = 500) {
    let after = 0;
    let written = 0;
    for (;;) {
        const [rows] = await db.query(`SELECT e.id, e.profile_id, e.platform, e.type, e.actor_id, e.message, e.metadata, e.raw
            FROM \`${prefix}events\` e
            WHERE e.id > ? AND e.type IN ('chat', 'gift_sub', 'raid')
              AND NOT EXISTS (SELECT 1 FROM \`${prefix}event_people\` p WHERE p.event_id = e.id)
            ORDER BY e.id LIMIT ${Number(batch)}`, [after]);
        if (!rows.length) break;
        for (const r of rows) {
            after = Number(r.id);
            const people = namedPeople({ platform: r.platform, type: r.type, actor_id: r.actor_id, message: r.message, metadata: r.metadata, raw: r.raw });
            if (!people.length) continue;
            await db.query(`INSERT INTO \`${prefix}event_people\` (event_id, profile_id, platform, platform_user_id, login, role) VALUES ?`,
                [people.map((p) => [Number(r.id), Number(r.profile_id), p.platform, p.userId, p.login, p.role])]);
            written += people.length;
        }
    }
    return written;
}

export async function up(db) {
    for (const sql of eventPeopleDdl('stream_bot_')) await db.query(sql);
    await musicNameIndexes(db, 'stream_bot_');
    const n = await backfill(db, 'stream_bot_');
    console.log(`465: indexed ${n} named people in existing events`);
}

export async function down(db) {
    await db.query('DROP TABLE IF EXISTS `stream_bot_event_people`');
    for (const [table, index] of MUSIC_NAME_INDEXES) {
        const [idx] = await db.query('SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1', [`stream_bot_${table}`, index]);
        if (idx.length) await db.query(`ALTER TABLE \`stream_bot_${table}\` DROP KEY ${index}`);
    }
}

export default { up, down };
