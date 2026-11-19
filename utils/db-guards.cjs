'use strict';
/**
 * Guards for the mysql2 promise pools in utils/db.js and utils/db.cjs (one copy for both).
 *
 * 1. pool.pool must stay the mysql2 core pool (H-314). PromisePool.execute/query/getConnection all
 *    do `this.pool.<method>(…, callback)`. utils/db.cjs used to end with `module.exports = pool;`
 *    followed by `module.exports.pool = pool;`, which set pool.pool to the promise pool itself. From
 *    then on every `execute(sql, params)` called itself until the stack ran out: the innermost
 *    promise rejected with "RangeError: Maximum call stack size exceeded" (printed as "Exception in
 *    PromiseRejectCallback … mysql2/lib/promise/pool.js:64", six times on 2026-11-17/18) and the
 *    caller's promise never settled. The only user, the AI DJ (core/dj-manager.cjs), hung on its
 *    blocklist / favourites / voice lookups: no next playlist, no tracks after the first when a
 *    playlist was added. The same file also assigned helper functions over pool.query and
 *    pool.getConnection, and the getConnection helper called pool.getConnection, i.e. itself.
 *    The field is now locked (read-only), so the same mistake throws at load instead.
 *
 * 2. Idempotent release. mysql2 does not stop a connection being released twice: the second
 *    release pushes a duplicate into _freeConnections, and when the idle sweeper later destroys it
 *    only the first copy is spliced out, so `while (free > maxIdle)` spins forever and hangs the
 *    process.
 */

/**
 * @param {import('mysql2/promise').Pool} pool  promise pool from mysql2/promise createPool
 * @param {object} [opts]
 * @param {(msg: string, meta?: object) => void} [opts.warn]
 * @param {string} [opts.label]  which wrapper ('db.js' / 'db.cjs'), for the log line
 * @returns {{ doubleReleases: number }}
 */
function installPoolGuards(pool, { warn = (m, meta) => console.warn(m, meta || ''), label = 'db' } = {}) {
  if (pool.__cfGuards) return pool.__cfGuards;

  const corePool = pool.pool;
  if (!corePool || corePool === pool || typeof corePool.releaseConnection !== 'function'
      || typeof corePool.getConnection !== 'function') {
    throw new Error(`[Database] ${label}: pool.pool is not the mysql2 core pool; every query would recurse into itself`);
  }
  // Read-only from here: assigning it (e.g. `module.exports.pool = pool` on a module whose exports
  // object IS the pool) now throws in strict code instead of silently breaking every query.
  Object.defineProperty(pool, 'pool', { value: corePool, writable: false, configurable: false, enumerable: true });

  const stats = { doubleReleases: 0 };
  Object.defineProperty(pool, '__cfGuards', { value: stats, enumerable: false });

  const releaseConnection = corePool.releaseConnection.bind(corePool);
  corePool.releaseConnection = (connection) => {
    if (connection && connection._pool && corePool._freeConnections.toArray().includes(connection)) {
      stats.doubleReleases++;
      warn(`[Database] Ignored double release of a pooled connection (${label})`, { stack: new Error().stack });
      return;
    }
    releaseConnection(connection);
  };
  return stats;
}

module.exports = { installPoolGuards };
