const mysql = require("mysql2/promise");
require("dotenv").config();

const dbConfig = {
  host: process.env.DB_HOST || "127.0.0.1",
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 15,
  queueLimit: 100,
  connectTimeout: 10000,
  timezone: "Z"
};

const pool = mysql.createPool(dbConfig);

// New function to test the database connection
async function testConnection() {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.ping();
    console.log("[DB] Database connection successful.");
  } catch (error) {
    console.error("[DB] FATAL: Could not connect to the database.");
    console.error(`[DB] Reason: ${error.message}`);
    // Re-throw the error to let the main application handle it
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

pool.on("error", (err) => {
  // This will catch errors that occur on the pool after the initial connection
  console.error("[DB Pool Error]", err);
});

// Export both the pool and the test function
module.exports = {
    pool,
    testConnection,
    // Expose the end method for graceful shutdown
    end: () => pool.end()
};
