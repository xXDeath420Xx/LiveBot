const mysql = require('mysql2/promise');
require('dotenv').config();

const dbConfig = {
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 15,
    queueLimit: 0,
    // Add a connection timeout
    connectTimeout: 10000 
};

const pool = mysql.createPool(dbConfig);

// Test the connection on startup
(async () => {
    try {
        const connection = await pool.getConnection();
        console.log('[DB] Database connection successful.');
        connection.release();
    } catch (error) {
        console.error('[DB] FATAL: Could not connect to the database.');
        console.error(`[DB] Reason: ${error.message}`);
        // Exit the process if the database connection fails, as the bot cannot function.
        process.exit(1); 
    }
})();

pool.on('error', (err) => {
    console.error('[DB Pool Error]', err);
});

module.exports = pool;