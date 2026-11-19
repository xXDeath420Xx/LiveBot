"use strict";
/**
 * CommonJS wrapper for database connection pool
 * Uses console logging to avoid circular dependencies with logger
 */

const mysql = require('mysql2/promise');
const { installPoolGuards } = require('./db-guards.cjs');
require('dotenv').config();

// Create database connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 200,   // was 0 (unbounded); matches utils/db.js
  maxIdle: 10,
  connectTimeout: 10000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  // CRITICAL: Force UTC timezone to prevent 8-hour offset between MySQL (PST) and Node.js (UTC)
  timezone: '+00:00'
});

// Same guards as utils/db.js (utils/db-guards.cjs): idempotent release, and pool.pool locked to
// the core pool (H-314, see the exports at the bottom).
installPoolGuards(pool, { label: 'db.cjs', warn: (msg, meta) => console.warn(msg, meta ? JSON.stringify(meta) : '') });

// Test the connection on startup
pool.getConnection()
  .then((connection) => {
    console.log('[Database] Successfully connected to the database');
    connection.release();
  })
  .catch((err) => {
    console.error('[Database] FATAL: Could not connect to the database:', err.message);
    // Don't exit - allow the app to start and retry connections
  });

// Helper function to execute queries with error handling
async function query(sql, params = []) {
  try {
    const [results] = await pool.execute(sql, params);
    return results;
  } catch (error) {
    console.error('[Database] Query error:', sql.substring(0, 200), error.message);
    throw error;
  }
}

// Helper function to get a connection for transactions
async function getConnection() {
  return await pool.getConnection();
}

// Helper function for transactions
async function transaction(callback) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    console.error('[Database] Transaction failed:', error.message);
    throw error;
  } finally {
    connection.release();
  }
}

// The exports object IS the promise pool, so nothing may be assigned over the pool's own members.
// This used to also set .pool, .query and .getConnection: `.pool = pool` made pool.pool point at
// the promise pool itself, so every execute(sql, params) recursed until the stack overflowed and
// never settled (H-314; the AI DJ, the only user, hung on every lookup), and the getConnection
// helper called pool.getConnection, i.e. itself. pool.query / pool.getConnection are mysql2's own.
module.exports = pool;
module.exports.default = pool;
module.exports.transaction = transaction;
module.exports.queryRows = query;
