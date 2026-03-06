import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config({ path: '/root/discord_bots/CertiFriedUtility/.env' });

const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'CertiFriedDB',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'CertiFriedUtility'
});

const [announcements] = await connection.query(`
    SELECT
        la.id,
        la.guild_id,
        s.username,
        s.platform,
        la.message_id,
        la.channel_id,
        la.created_at
    FROM live_announcements la
    JOIN streamers s ON la.streamer_id = s.streamer_id
    WHERE la.guild_id = '844406178799943730'
    AND (s.username = 'cookiesays' OR s.username = 'jeffdank90' OR s.username = 'c00kiesays')
    ORDER BY s.username, s.platform
`);

console.log('\nLive announcements for cookiesays and jeffdank90:');
console.table(announcements);

await connection.end();
