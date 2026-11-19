// Greenhouse Tycoon (cfx v2): run a function in one transaction on one pooled connection.
// Deadlocks and lock-wait timeouts are retried (with jitter); everything else, including a GameError
// such as INSUFFICIENT_FUNDS, rolls back and is rethrown unchanged. Unlike utils/db.js transaction(), a
// business refusal is not logged as a database failure.

const RETRYABLE = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export async function withTx(db, fn, { retries = 4 } = {}) {
    for (let attempt = 1; ; attempt++) {
        const conn = await db.getConnection();
        try {
            await conn.beginTransaction();
            const result = await fn(conn);
            await conn.commit();
            return result;
        } catch (err) {
            try { await conn.rollback(); } catch { /* the original error matters more */ }
            if (RETRYABLE.has(err?.code) && attempt < retries) {
                await sleep(10 * attempt + Math.floor(Math.random() * 25));
                continue;
            }
            throw err;
        } finally {
            conn.release();
        }
    }
}
