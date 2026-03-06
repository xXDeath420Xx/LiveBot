import dotenv from 'dotenv';
dotenv.config();

import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: 'utf8mb4',
  timezone: '+00:00'
});

async function main() {
    console.log('Fixing timezone offset in daily_joints...');

    const [before] = await pool.execute(`
        SELECT guild_id, user_id, last_claimed, streak
        FROM daily_joints
        WHERE last_claimed IS NOT NULL
        ORDER BY last_claimed DESC LIMIT 5
    `);

    console.log('Before fix:');
    for (const row of before) {
        const lastClaimed = new Date(row.last_claimed);
        const now = new Date();
        const hoursSince = (now.getTime() - lastClaimed.getTime()) / (1000 * 60 * 60);
        console.log(`  User ${row.user_id}: last_claimed=${row.last_claimed}, hours_since=${hoursSince.toFixed(2)}`);
    }

    // Adjust by -8 hours
    console.log('\nAdjusting timestamps by -8 hours...');

    const [result] = await pool.execute(`
        UPDATE daily_joints
        SET last_claimed = DATE_SUB(last_claimed, INTERVAL 8 HOUR)
        WHERE last_claimed IS NOT NULL
    `);

    console.log(`Updated ${result.affectedRows} rows`);

    const [after] = await pool.execute(`
        SELECT guild_id, user_id, last_claimed, streak
        FROM daily_joints
        WHERE last_claimed IS NOT NULL
        ORDER BY last_claimed DESC LIMIT 5
    `);

    console.log('\nAfter fix:');
    for (const row of after) {
        const lastClaimed = new Date(row.last_claimed);
        const now = new Date();
        const hoursSince = (now.getTime() - lastClaimed.getTime()) / (1000 * 60 * 60);
        console.log(`  User ${row.user_id}: last_claimed=${row.last_claimed}, hours_since=${hoursSince.toFixed(2)}`);
    }

    await pool.end();
}

main().catch(console.error);
