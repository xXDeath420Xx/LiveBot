import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import logger from './logger.js';

dotenv.config();

// Database connection state
let isConnected = false;
let connectionAttempts = 0;
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_DELAY_BASE = 1000; // Base delay in ms (exponential backoff)

// Transient error codes that should trigger retry
const TRANSIENT_ERROR_CODES = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'PROTOCOL_CONNECTION_LOST',
  'ER_CON_COUNT_ERROR',
  'ENOTFOUND',
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT'
];

// Create database connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 50,
  queueLimit: 100,
  connectTimeout: 10000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  timezone: '+00:00'
});

/**
 * Test database connection with retry logic
 */
async function testConnection(maxAttempts = MAX_RETRY_ATTEMPTS) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const connection = await pool.getConnection();
      await connection.ping(); // Actually test the connection
      connection.release();
      isConnected = true;
      connectionAttempts = 0;
      logger.info('[Database] Successfully connected to the database', {
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        attempt
      });
      return true;
    } catch (err) {
      connectionAttempts = attempt;
      const delay = RETRY_DELAY_BASE * Math.pow(2, attempt - 1); // Exponential backoff

      logger.error(`[Database] Connection attempt ${attempt}/${maxAttempts} failed`, {
        error: err.message,
        code: err.code,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        nextRetryIn: attempt < maxAttempts ? `${delay}ms` : 'N/A'
      });

      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  isConnected = false;
  logger.error('[Database] FATAL: All connection attempts exhausted', {
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    totalAttempts: maxAttempts
  });
  return false;
}

// Initialize connection on startup
testConnection().then(connected => {
  if (!connected) {
    logger.error('[Database] Starting in degraded mode - database unavailable');
  }
});

// Health check function for external monitoring
export function isDatabaseConnected() {
  return isConnected;
}

/**
 * Check if error is transient and should be retried
 */
function isTransientError(error) {
  return TRANSIENT_ERROR_CODES.includes(error.code) ||
         error.message?.includes('Connection lost') ||
         error.message?.includes('connect ETIMEDOUT');
}

/**
 * Sleep helper for retry delays
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute query with automatic retry for transient failures
 */
export async function queryWithRetry(sql, params = [], maxRetries = 3) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const [results] = await pool.execute(sql, params);

      // Reset connection state on success if it was marked as failed
      if (!isConnected) {
        isConnected = true;
        logger.info('[Database] Connection restored');
      }

      return results;
    } catch (error) {
      lastError = error;

      if (isTransientError(error) && attempt < maxRetries) {
        const delay = RETRY_DELAY_BASE * Math.pow(2, attempt - 1);
        logger.warn(`[Database] Transient error, retrying (${attempt}/${maxRetries})`, {
          sql: sql.substring(0, 100),
          error: error.message,
          code: error.code,
          retryIn: `${delay}ms`
        });

        // Mark as disconnected on connection errors
        if (error.code === 'PROTOCOL_CONNECTION_LOST' || error.code === 'ECONNRESET') {
          isConnected = false;
        }

        await sleep(delay);
        continue;
      }

      // Non-transient error or max retries exceeded
      break;
    }
  }

  logger.error('[Database] Query failed after retries', {
    sql: sql.substring(0, 200),
    error: lastError.message,
    code: lastError.code
  });
  throw lastError;
}

/**
 * Helper function to execute queries with error handling (backwards compatible)
 */
export async function query(sql, params = []) {
  return queryWithRetry(sql, params, 1); // Single attempt for backwards compatibility
}

// Helper function to get a connection for transactions
export async function getConnection() {
  return await pool.getConnection();
}

/**
 * Helper function for transactions with automatic retry for deadlocks
 */
export async function transaction(callback, maxRetries = 3) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await callback(connection);
      await connection.commit();
      return result;
    } catch (error) {
      lastError = error;
      await connection.rollback().catch(() => {}); // Ignore rollback errors

      // Retry on deadlock or lock timeout
      if ((error.code === 'ER_LOCK_DEADLOCK' || error.code === 'ER_LOCK_WAIT_TIMEOUT') && attempt < maxRetries) {
        const delay = RETRY_DELAY_BASE * Math.pow(2, attempt - 1);
        logger.warn(`[Database] Transaction deadlock, retrying (${attempt}/${maxRetries})`, {
          error: error.message,
          code: error.code,
          retryIn: `${delay}ms`
        });
        await sleep(delay);
        continue;
      }

      logger.error('[Database] Transaction failed', { error: error.message, code: error.code });
      throw error;
    } finally {
      connection.release();
    }
  }

  throw lastError;
}

/**
 * Execute transaction with retry (alias for transaction with default retries)
 */
export async function transactionWithRetry(callback, maxRetries = 3) {
  return transaction(callback, maxRetries);
}

export { pool, isTransientError };
export default pool;
