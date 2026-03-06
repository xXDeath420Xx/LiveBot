import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config({ path: '/root/discord_bots/CertiFriedUtility/.env' });

const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'CertiFriedDB',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'CertiFriedUtility'
});

const [result] = await conn.query(`
    SELECT id, platform, username, message_id, channel_id, created_at
    FROM live_announcements
    WHERE guild_id = ? AND platform = ? AND username = ?
`, ['985116833193553930', 'kick', 'vorzs']);

if (result.length > 0) {
    console.log('✅ vorzs (kick) announcement FOUND!\n');
    console.table(result);
    console.log(`\nMessage ID: ${result[0].message_id}`);
    console.log(`Channel ID: ${result[0].channel_id}`);
    console.log(`Created: ${result[0].created_at}`);
} else {
    console.log('❌ No announcement found for vorzs (kick) yet');
    console.log('\nThis could mean:');
    console.log('1. Still being processed (check in 60 seconds)');
    console.log('2. vorzs is not live on Kick');
    console.log('3. API check failed');
}

await conn.end();
process.exit(0);
