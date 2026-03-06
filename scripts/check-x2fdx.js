import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config({ path: '/root/discord_bots/CertiFriedUtility/.env' });

const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'CertiFriedDB',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'CertiFriedUtility'
});

console.log('\n🔍 Checking x2fdx status...\n');

const [announcements] = await conn.query(`
    SELECT la.id, la.guild_id, la.platform, la.username, la.message_id, la.channel_id, la.created_at,
           TIMESTAMPDIFF(HOUR, la.created_at, NOW()) as hours_old
    FROM live_announcements la
    WHERE la.username = 'x2fdx'
`);

console.log(`📡 Live Announcements for x2fdx: ${announcements.length}`);
if (announcements.length > 0) {
    console.table(announcements);
} else {
    console.log('   No active announcements found');
}

const [subscriptions] = await conn.query(`
    SELECT s.streamer_id, s.username, s.platform, sub.guild_id, sub.subscription_id
    FROM streamers s
    JOIN subscriptions sub ON s.streamer_id = sub.streamer_id
    WHERE s.username = 'x2fdx'
`);

console.log(`\n📋 Subscriptions for x2fdx: ${subscriptions.length}`);
if (subscriptions.length > 0) {
    console.table(subscriptions);
}

await conn.end();
process.exit(0);
