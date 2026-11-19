import 'dotenv/config';
import mysql from 'mysql2/promise';
import { up } from '../migrations/234_channel_post_cooldown.js';

// One-off scripts use a direct connection: the shared pool hangs outside the bot process.
const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306
});

try {
    await up(db);
    console.log('migration 234 applied');
} catch (err) {
    // A SQL error inside a top-level-await ESM script hangs instead of throwing, so catch it.
    console.error('migration 234 failed:', err.message);
    process.exitCode = 1;
} finally {
    await db.end();
}
process.exit(process.exitCode || 0);
