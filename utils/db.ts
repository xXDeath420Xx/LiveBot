import mysql from 'mysql2/promise';
import { Pool } from 'mysql2/promise';
// Use require for dotenv to avoid TypeScript compilation issues
const dotenv = require('dotenv');

dotenv.config();

const pool: Pool = mysql.createPool({
    host: process.env.DB_HOST as string,
    user: process.env.DB_USER as string,
    password: process.env.DB_PASSWORD as string,
    database: process.env.DB_NAME as string,
    waitForConnections: true,
    connectionLimit: 15, // Increased limit for a multi-process app
    queueLimit: 0,
    connectTimeout: 10000 // 10 seconds
});

// Test the connection on startup
pool.getConnection()
    .then((connection) => {
        console.log('[Database] Successfully connected to the database.');
        connection.release();
    })
    .catch((err: Error) => {
        console.error('[Database] FATAL: Could not connect to the database. Please check your configuration and ensure MySQL is running.', { error: err.message });
        // In a real-world scenario, you might want to exit the process
        // if the database is critical for the application's startup.
        // process.exit(1);
    });

export const db = pool;
export { pool };
export default pool;
