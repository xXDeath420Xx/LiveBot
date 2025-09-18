import mysql, { Pool, PoolOptions } from 'mysql2/promise';
import 'dotenv/config'; // Use 'dotenv/config' for direct loading

const dbConfig: PoolOptions = {
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 15,
    // Set a sensible, finite queueLimit to prevent unbounded request growth if the DB is slow/down.
    // A value of 0 means unlimited queue in mysql2, which can lead to memory issues.
    queueLimit: 100, 
    // Add a connection timeout
    connectTimeout: 10000,
    // Best practice: Explicitly set timezone for consistent date/time handling
    timezone: 'Z'
};

const pool: Pool = mysql.createPool(dbConfig);

// Test the connection on startup
(async () => {
    try {
        const connection = await pool.getConnection();
        console.log('[DB] Database connection successful.');
        connection.release();
    } catch (error: any) {
        console.error('[DB] FATAL: Could not connect to the database.');
        console.error(`[DB] Reason: ${error.message}`);
        // Exit the process if the database connection fails, as the bot cannot function.
        process.exit(1); 
    }
})();

pool.on('error', (err: Error) => {
    console.error('[DB Pool Error]', err);
});

export default pool;
