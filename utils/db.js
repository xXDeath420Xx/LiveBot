const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 15, // Increased limit for a multi-process app
    queueLimit: 0,
    connectTimeout: 10000 // 10 seconds
});

// Test the connection on startup
pool.getConnection()
    .then(connection => {
        console.log('[Database] Successfully connected to the database.');
        connection.release();
    })
    .catch(err => {
        console.error('[Database] FATAL: Could not connect to the database. Please check your configuration and ensure MySQL is running.', { error: err.message });
        // In a real-world scenario, you might want to exit the process
        // if the database is critical for the application's startup.
        // process.exit(1);
    });

module.exports = pool;