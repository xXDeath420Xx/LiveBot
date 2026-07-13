/*
 * Compatibility shim for upstream OwO Bot's mysqlHandler.js API. Exposes
 * `query(sql, params?)` that proxies to our mysql2 pool's `.execute()`.
 *
 * Used only by translated battle-module files (core/owo/battle/**). All
 * other code in CertiFried should import pool from utils/db.js directly.
 */

import pool from './db.js';
import logger from './logger.js';

/**
 * Upstream's mysql.query(sql) returned raw rows (Array of row objects).
 * mysql2's pool.execute returns [rows, fields]. We unwrap to match upstream.
 */
export async function query(sql, params = []) {
    const [rows] = await pool.execute(sql, params);
    return rows;
}

/**
 * Upstream also exposed `mysql.con` as a raw mysql connection with a
 * callback-style .query(sql, cb). A few files use it for startup state
 * seeds. We provide a compat wrapper that forwards to our pool + calls
 * the callback with the (err, rows) shape.
 */
export const con = {
    query(sql, params, callback) {
        // Signature variants: (sql, cb) or (sql, params, cb)
        if (typeof params === 'function') {
            callback = params;
            params = [];
        }
        pool.execute(sql, params || [])
            .then(([rows]) => { try { callback?.(null, rows); } catch (e) { logger.warn('[owo-compat] mysql.con.query callback threw', { err: e.message }); } })
            .catch((err) => { try { callback?.(err); } catch { /* ignore */ } });
    },
};

export default { query, con };
