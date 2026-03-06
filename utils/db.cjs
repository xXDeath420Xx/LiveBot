"use strict";
/**
 * CommonJS wrapper for database connection pool
 * Uses console logging to avoid circular dependencies with logger
 */

const mysql = require('mysql2/promise');
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
  queueLimit: 0,
  connectTimeout: 10000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  // CRITICAL: Force UTC timezone to prevent 8-hour offset between MySQL (PST) and Node.js (UTC)
  timezone: '+00:00'
});

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

module.exports = pool;
module.exports.default = pool;
module.exports.pool = pool;
module.exports.query = query;
module.exports.getConnection = getConnection;
module.exports.transaction = transaction;
