const mysql = require('mysql2/promise');
require('dotenv-flow').config();

const dbConfig = {
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 15,
    queueLimit: 100,
    connectTimeout: 10000,
    timezone: 'Z',
    multipleStatements: true // Allow multiple statements for the dump.sql execution
};

const pool = mysql.createPool(dbConfig);

// Non-fatal connection test on startup
(async () => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        await connection.ping();
        console.log('[DB] Database connection test successful.');
        await connection.end();
    } catch (error) {
        console.error('[DB] WARNING: Could not connect to the database on startup.');
        console.error(`[DB] Reason: ${error.message}`);
    }
})();

pool.on('error', (err) => {
    console.error('[DB Pool Error]', err);
});

module.exports = pool;
