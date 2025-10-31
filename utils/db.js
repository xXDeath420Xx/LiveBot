"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = exports.db = void 0;
const promise_1 = __importDefault(require("mysql2/promise"));
// Use require for dotenv to avoid TypeScript compilation issues
const dotenv = require('dotenv');
dotenv.config();
const pool = promise_1.default.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 15, // Increased limit for a multi-process app
    queueLimit: 0,
    connectTimeout: 10000 // 10 seconds
});
exports.pool = pool;
// Test the connection on startup
pool.getConnection()
    .then((connection) => {
    console.log('[Database] Successfully connected to the database.');
    connection.release();
})
    .catch((err) => {
    console.error('[Database] FATAL: Could not connect to the database. Please check your configuration and ensure MySQL is running.', { error: err.message });
    // In a real-world scenario, you might want to exit the process
    // if the database is critical for the application's startup.
    // process.exit(1);
});
exports.db = pool;
exports.default = pool;
