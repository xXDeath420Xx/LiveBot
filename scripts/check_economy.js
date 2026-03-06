import dotenv from 'dotenv';
dotenv.config();

import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: 'utf8mb4'
});

async function main() {
    // Check timezone
    const [tzRows] = await pool.execute("SELECT @@global.time_zone as global_tz, @@session.time_zone as session_tz, NOW() as mysql_now");
    console.log('MySQL Timezone:', tzRows[0]);
    console.log('JS Now:', new Date().toISOString());
    console.log('JS Local Now:', new Date().toString());

    // Check economy records
    const [rows] = await pool.execute(`
        SELECT user_id, last_daily, NOW() as db_now
        FROM user_economy
        WHERE last_daily IS NOT NULL
        ORDER BY last_daily DESC LIMIT 5
    `);

    console.log('\nRecent last_daily records:');
    for (const row of rows) {
        const lastDaily = new Date(row.last_daily);
        const now = new Date();
        const hoursSince = (now.getTime() - lastDaily.getTime()) / (1000 * 60 * 60);
        console.log(`  User: ${row.user_id}`);
        console.log(`    last_daily raw: ${row.last_daily}`);
        console.log(`    last_daily as Date: ${lastDaily.toISOString()}`);
        console.log(`    JS now: ${now.toISOString()}`);
        console.log(`    hours since: ${hoursSince.toFixed(2)}`);
        console.log(`    db_now: ${row.db_now}`);
        console.log('');
    }

    await pool.end();
}

main().catch(console.error);
