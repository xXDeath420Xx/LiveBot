import dotenv from 'dotenv';
dotenv.config();

import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: 'utf8mb4',
  timezone: '+00:00'  // Same as db.js now
});

async function main() {
    console.log('=== TIMEZONE VERIFICATION ===\n');

    // Check current time comparison
    const [tzRows] = await pool.execute("SELECT NOW() as mysql_now");
    const mysqlNow = new Date(tzRows[0].mysql_now);
    const jsNow = new Date();

    console.log('MySQL NOW():', mysqlNow.toISOString());
    console.log('JS Date():', jsNow.toISOString());
    console.log('Difference (hours):', ((jsNow.getTime() - mysqlNow.getTime()) / (1000 * 60 * 60)).toFixed(2));

    // Check economy daily
    console.log('\n=== ECONOMY DAILY ===');
    const [econRows] = await pool.execute(`
        SELECT user_id, last_daily
        FROM user_economy
        WHERE last_daily IS NOT NULL
        ORDER BY last_daily DESC LIMIT 3
    `);

    for (const row of econRows) {
        const lastDaily = new Date(row.last_daily);
        const now = new Date();
        const hoursSince = (now.getTime() - lastDaily.getTime()) / (1000 * 60 * 60);
        const hoursLeft = Math.max(0, 24 - hoursSince);
        console.log(`  User ${row.user_id}:`);
        console.log(`    Hours since claim: ${hoursSince.toFixed(2)}`);
        console.log(`    Hours left (24h cooldown): ${hoursLeft.toFixed(2)}`);
        console.log(`    Can claim: ${hoursSince >= 24 ? 'YES' : 'NO'}`);
    }

    // Check daily joints
    console.log('\n=== DAILY JOINTS ===');
    const [jointRows] = await pool.execute(`
        SELECT user_id, last_claimed
        FROM daily_joints
        WHERE last_claimed IS NOT NULL
        ORDER BY last_claimed DESC LIMIT 3
    `);

    for (const row of jointRows) {
        const lastClaimed = new Date(row.last_claimed);
        const now = new Date();
        const hoursSince = (now.getTime() - lastClaimed.getTime()) / (1000 * 60 * 60);
        const hoursLeft = Math.max(0, 24 - hoursSince);
        console.log(`  User ${row.user_id}:`);
        console.log(`    Hours since claim: ${hoursSince.toFixed(2)}`);
        console.log(`    Hours left (24h cooldown): ${hoursLeft.toFixed(2)}`);
        console.log(`    Can claim: ${hoursSince >= 24 ? 'YES' : 'NO'}`);
    }

    await pool.end();
}

main().catch(console.error);
