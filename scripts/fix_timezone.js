import dotenv from 'dotenv';
dotenv.config();

import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: 'utf8mb4',
  timezone: '+00:00'  // Use UTC
});

async function main() {
    console.log('Fixing timezone offset in user_economy...');

    // The existing last_daily values were stored in PST but MySQL thinks they're UTC
    // We need to subtract 8 hours to convert them to actual UTC
    // BUT - since we're now connecting with timezone: '+00:00', MySQL will interpret
    // the values correctly. The issue was that the VALUES were stored using NOW()
    // which used server time (PST) but without timezone info.

    // Actually, let me check the current state first
    const [before] = await pool.execute(`
        SELECT user_id, last_daily, NOW() as db_now
        FROM user_economy
        WHERE last_daily IS NOT NULL
        ORDER BY last_daily DESC LIMIT 3
    `);

    console.log('Before fix (with timezone: +00:00):');
    for (const row of before) {
        const lastDaily = new Date(row.last_daily);
        const now = new Date();
        const hoursSince = (now.getTime() - lastDaily.getTime()) / (1000 * 60 * 60);
        console.log(`  User ${row.user_id}: last_daily=${row.last_daily}, hours_since=${hoursSince.toFixed(2)}`);
    }

    // The stored timestamps need to be adjusted by -8 hours since they were stored
    // using PST NOW() but will now be interpreted as UTC
    console.log('\nAdjusting timestamps by -8 hours...');

    const [result] = await pool.execute(`
        UPDATE user_economy
        SET last_daily = DATE_SUB(last_daily, INTERVAL 8 HOUR)
        WHERE last_daily IS NOT NULL
    `);

    console.log(`Updated ${result.affectedRows} rows`);

    const [after] = await pool.execute(`
        SELECT user_id, last_daily, NOW() as db_now
        FROM user_economy
        WHERE last_daily IS NOT NULL
        ORDER BY last_daily DESC LIMIT 3
    `);

    console.log('\nAfter fix:');
    for (const row of after) {
        const lastDaily = new Date(row.last_daily);
        const now = new Date();
        const hoursSince = (now.getTime() - lastDaily.getTime()) / (1000 * 60 * 60);
        console.log(`  User ${row.user_id}: last_daily=${row.last_daily}, hours_since=${hoursSince.toFixed(2)}`);
    }

    await pool.end();
}

main().catch(console.error);
