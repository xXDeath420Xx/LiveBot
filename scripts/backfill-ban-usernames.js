/**
 * Backfill usernames in global_ban_entries from audit-import-ready.json
 */
import dotenv from 'dotenv';
dotenv.config();

import mysql from 'mysql2/promise';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    charset: 'utf8mb4'
});

// Ensure column supports emoji
await conn.execute('ALTER TABLE global_ban_entries MODIFY COLUMN username VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL');

const data = JSON.parse(readFileSync(join(__dirname, '..', 'audit-import-ready.json'), 'utf8'));

let updated = 0;
let failed = 0;
for (const row of data.rows) {
    if (row.username && row.username !== 'Unknown') {
        try {
            const [result] = await conn.execute(
                'UPDATE global_ban_entries SET username = ? WHERE user_id = ? AND username IS NULL',
                [row.username, row.user_id]
            );
            if (result.affectedRows > 0) updated++;
        } catch (err) {
            failed++;
        }
    }
}

console.log(`Backfilled ${updated} usernames out of ${data.rows.length} entries (${failed} failed)`);
await conn.end();
process.exit(0);
