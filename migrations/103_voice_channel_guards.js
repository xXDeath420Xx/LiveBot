/**
 * Migration 103: Voice channel guards
 *
 * Stores "only this user can be in this voice channel" rules. The
 * voiceStateUpdate event handler reads this table and auto-disconnects any
 * member joining a guarded channel whose user_id doesn't match
 * `allowed_user_id` — even members whose role/Administrator bits bypass the
 * channel's CONNECT deny.
 *
 * Schema:
 *   guild_id         VARCHAR(20) NOT NULL
 *   channel_id       VARCHAR(20) NOT NULL
 *   allowed_user_id  VARCHAR(20) NOT NULL
 *   created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
 *   PRIMARY KEY (guild_id, channel_id)
 *
 * Idempotent (whitelist-based hasTable).
 */

async function tableExists(db, table) {
    const allowed = new Set(['voice_channel_guards']);
    if (!allowed.has(table)) throw new Error(`Refusing to inspect unknown table: ${table}`);
    const [rows] = await db.execute(
        `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${table}'`
    );
    return rows[0].n > 0;
}

export async function up(db) {
    if (!(await tableExists(db, 'voice_channel_guards'))) {
        await db.execute(`
            CREATE TABLE voice_channel_guards (
                guild_id        VARCHAR(20) NOT NULL,
                channel_id      VARCHAR(20) NOT NULL,
                allowed_user_id VARCHAR(20) NOT NULL,
                created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (guild_id, channel_id),
                INDEX idx_channel (channel_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
    }
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS voice_channel_guards');
}
