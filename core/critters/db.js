/*
 * Critters DB access. The pool is loaded lazily from utils/db.js so pure modules and tests never open a
 * connection; tests and the migration smoke run can inject a pool and a table prefix.
 */

let poolRef = null;
let prefix = '';

export async function getPool() {
    if (!poolRef) poolRef = (await import('../../utils/db.js')).default;
    return poolRef;
}

/** Use another pool (tests, scripts). */
export function setCrittersPool(pool) {
    poolRef = pool;
}

/** Prefix every critter_* table name (tests and dry runs only). Letters, digits and underscores. */
export function setCrittersTablePrefix(p = '') {
    if (!/^[A-Za-z0-9_]*$/.test(p)) throw new Error('bad table prefix');
    prefix = p;
}

/** Quoted table name for an internal critter table: T('wallet') -> `critter_wallet`. */
export function T(name) {
    return `\`${prefix}critter_${name}\``;
}

/** Run a query on the pool or on a transaction connection; returns rows (or the OkPacket). */
export async function q(sql, params = [], conn = null) {
    const c = conn || await getPool();
    const [rows] = await c.query(sql, params);
    return rows;
}

const RETRY_CODES = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

/** Run fn(conn) in a transaction; retries deadlocks and lock waits up to 3 attempts with a short backoff. */
export async function withTx(fn, { attempts = 3 } = {}) {
    const pool = await getPool();
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const out = await fn(conn);
            await conn.commit();
            return out;
        } catch (err) {
            lastErr = err;
            try { await conn.rollback(); } catch { /* ignore */ }
            if (RETRY_CODES.has(err?.code) && attempt < attempts) {
                await new Promise(r => setTimeout(r, 20 * attempt + Math.floor(Math.random() * 30)));
                continue;
            }
            throw err;
        } finally {
            conn.release();
        }
    }
    throw lastErr;
}

/**
 * A refusal the member should see. `code` is stable (surfaces switch on it); `message` is ready-to-show text;
 * `data` carries numbers for custom wording.
 */
export class CritterError extends Error {
    constructor(code, message, data = {}) {
        super(message);
        this.name = 'CritterError';
        this.code = code;
        this.data = data;
    }
}

export const isCritterError = (e) => e instanceof CritterError || e?.name === 'CritterError';
