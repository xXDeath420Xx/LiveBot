/*
 * Storage behind the custom-command {db:…} / {sdb:…} tokens (core/custom-command-vars.js, register H-648).
 *
 * Table custom_commands_kv (migration 352): one row per guild × owner × key, value as TEXT.
 *   owner = the Discord id of whoever ran the command, or DB_SERVER_USER ('server') for {sdb:…} rows.
 * Keys arrive validated and lower-cased by the parser; limits (keys per owner) are passed in by runDbOp.
 *
 * incr is atomic: INSERT … ON DUPLICATE KEY UPDATE adds to the stored number inside a transaction that
 * holds the row lock until the new value has been read back, so concurrent runs never lose an increment
 * and each sees its own result. A value that is not a whole number (or has more than 15 digits) counts
 * as 0, and totals are clamped to ±999,999,999,999,999.
 *
 * Retention: updated_at is the "last touched" time. Writes set it; a read refreshes it at most once a
 * day. jobs/retention-sweeper.js deletes rows untouched for 400 days (data_retention_policy row from
 * migration 439). /privacy export finds the rows by user_id; /privacy delete removes them
 * (core/privacy-tables.js DELETE_PLAN). Server rows (user_id 'server') belong to no member.
 *
 * The SQL store takes its pool as an argument so this module has no DB import; tests use the memory
 * store, and the dashboard Test button uses the preview store (reads real values, saves nothing).
 */

export const NUMBER_MAX = 999_999_999_999_999;
const NUMERIC = /^[+-]?\d{1,15}$/;

/** The stored text as a number, exactly as the SQL store reads it: not a whole number → 0. */
export function storedNumber(value) {
    const s = String(value ?? '').trim();
    return NUMERIC.test(s) ? Number(s) : 0;
}

const clampNumber = (n) => Math.max(-NUMBER_MAX, Math.min(NUMBER_MAX, n));

const TABLE = 'custom_commands_kv';
// SQL twin of storedNumber(): MariaDB REGEXP is PCRE; NULL falls through to 0.
const SQL_NUMBER = "CASE WHEN TRIM(value_text) REGEXP '^[+-]?[0-9]{1,15}$' THEN CAST(TRIM(value_text) AS SIGNED) ELSE 0 END";
const DEADLOCK = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

/**
 * @param {object} db  a mysql2/promise pool (query, execute, getConnection)
 */
export function createSqlStore(db) {
    /** May this owner write `key`? Yes if the key exists or the owner is under maxKeys. A soft cap: two
     * concurrent new keys can overshoot by one each, which is fine for a storage quota. */
    async function hasRoom(guildId, owner, key, maxKeys) {
        const [[row]] = await db.query(
            `SELECT COUNT(*) AS n, COALESCE(SUM(key_name = ?), 0) AS has FROM ${TABLE} WHERE guild_id = ? AND user_id = ?`,
            [key, guildId, owner]);
        return Number(row.has) > 0 || Number(row.n) < maxKeys;
    }

    return {
        async get(guildId, owner, key) {
            const [rows] = await db.execute(
                `SELECT value_text, updated_at < NOW() - INTERVAL 1 DAY AS stale FROM ${TABLE} WHERE guild_id = ? AND user_id = ? AND key_name = ?`,
                [guildId, owner, key]);
            if (!rows.length) return null;
            if (Number(rows[0].stale)) {
                // Reading counts as use for retention; refreshed at most daily so a busy key is not a write per run.
                db.execute(`UPDATE ${TABLE} SET updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND user_id = ? AND key_name = ?`,
                    [guildId, owner, key]).catch(() => {});
            }
            return rows[0].value_text ?? '';
        },

        async set(guildId, owner, key, value, maxKeys) {
            if (!(await hasRoom(guildId, owner, key, maxKeys))) return { full: true };
            await db.execute(
                `INSERT INTO ${TABLE} (guild_id, user_id, key_name, value_text) VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE value_text = VALUES(value_text), updated_at = CURRENT_TIMESTAMP`,
                [guildId, owner, key, String(value)]);
            return { ok: true };
        },

        async incr(guildId, owner, key, by, maxKeys) {
            if (!(await hasRoom(guildId, owner, key, maxKeys))) return { full: true };
            const step = Math.trunc(Number(by) || 0);
            for (let attempt = 1; ; attempt++) {
                const conn = await db.getConnection();
                try {
                    await conn.beginTransaction();
                    await conn.execute(
                        `INSERT INTO ${TABLE} (guild_id, user_id, key_name, value_text) VALUES (?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE
                           value_text = CAST(LEAST(GREATEST(${SQL_NUMBER} + CAST(? AS SIGNED), -${NUMBER_MAX}), ${NUMBER_MAX}) AS CHAR),
                           updated_at = CURRENT_TIMESTAMP`,
                        [guildId, owner, key, String(clampNumber(step)), String(step)]);
                    const [[row]] = await conn.execute(
                        `SELECT value_text FROM ${TABLE} WHERE guild_id = ? AND user_id = ? AND key_name = ? FOR UPDATE`,
                        [guildId, owner, key]);
                    await conn.commit();
                    return { value: Number(row.value_text) };
                } catch (err) {
                    await conn.rollback().catch(() => {});
                    if (attempt < 3 && DEADLOCK.has(err.code)) continue;   // rolled back, so retrying cannot double-count
                    throw err;
                } finally {
                    conn.release();
                }
            }
        },

        async del(guildId, owner, key) {
            const [r] = await db.execute(`DELETE FROM ${TABLE} WHERE guild_id = ? AND user_id = ? AND key_name = ?`, [guildId, owner, key]);
            return { deleted: r.affectedRows > 0 };
        },
    };
}

/** In-memory store with the SQL store's semantics (tests). */
export function createMemoryStore() {
    const owners = new Map();   // `${guildId}|${owner}` -> Map(key -> value)
    const bucket = (g, u) => {
        const k = `${g}|${u}`;
        if (!owners.has(k)) owners.set(k, new Map());
        return owners.get(k);
    };
    return {
        owners,
        async get(g, u, key) { return bucket(g, u).get(key) ?? null; },
        async set(g, u, key, value, maxKeys) {
            const b = bucket(g, u);
            if (!b.has(key) && b.size >= maxKeys) return { full: true };
            b.set(key, String(value));
            return { ok: true };
        },
        async incr(g, u, key, by, maxKeys) {
            const b = bucket(g, u);
            if (!b.has(key) && b.size >= maxKeys) return { full: true };
            const value = b.has(key) ? clampNumber(storedNumber(b.get(key)) + by) : clampNumber(by);
            b.set(key, String(value));
            return { value };
        },
        async del(g, u, key) { return { deleted: bucket(g, u).delete(key) }; },
    };
}

/**
 * Dashboard Test: reads go to `base` (the admin sees their real values), writes stay in memory and
 * are dropped with this object, so testing a command never changes anyone's storage.
 */
export function createPreviewStore(base) {
    const written = new Map();   // `${g}|${u}|${key}` -> value, or null when deleted
    const id = (g, u, key) => `${g}|${u}|${key}`;
    const read = async (g, u, key) => (written.has(id(g, u, key)) ? written.get(id(g, u, key)) : base.get(g, u, key));
    return {
        get: read,
        async set(g, u, key, value) { written.set(id(g, u, key), String(value)); return { ok: true }; },
        async incr(g, u, key, by) {
            const cur = await read(g, u, key);
            const value = cur == null ? clampNumber(by) : clampNumber(storedNumber(cur) + by);
            written.set(id(g, u, key), String(value));
            return { value };
        },
        async del(g, u, key) { written.set(id(g, u, key), null); return { deleted: true }; },
    };
}

export default { createSqlStore, createMemoryStore, createPreviewStore, storedNumber, NUMBER_MAX };
