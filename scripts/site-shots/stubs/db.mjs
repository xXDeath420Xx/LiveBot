/*
 * Stand-in for utils/db.js during the screenshot run. Queries are answered by the handler the run
 * installs (globalThis.__siteShotsDb(sql, params) -> rows); anything it does not know gets no rows.
 * No connection is ever opened.
 */
const answer = async (sql, params = []) => {
    const h = globalThis.__siteShotsDb;
    const rows = typeof h === 'function' ? (await h(String(sql), params)) : null;
    return [Array.isArray(rows) ? rows : [], []];
};
const conn = { execute: answer, query: answer, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} };
export const pool = { execute: answer, query: answer, getConnection: async () => conn, end: async () => {}, on: () => {} };
export function isDatabaseConnected() { return false; }
export async function queryWithRetry(sql, params = []) { return answer(sql, params); }
export async function query(sql, params = []) { return (await answer(sql, params))[0]; }
export async function getConnection() { return conn; }
export async function transaction(cb) { return cb(conn); }
export async function transactionWithRetry(cb) { return cb(conn); }
export function isTransientError() { return false; }
export default pool;
