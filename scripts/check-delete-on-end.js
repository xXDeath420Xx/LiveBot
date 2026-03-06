import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config({ path: '/root/discord_bots/CertiFriedUtility/.env' });

const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'CertiFriedDB',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'CertiFriedUtility'
});

const [subscriptions] = await connection.query(`
    SELECT
        s.username,
        s.platform,
        sub.guild_id,
        sub.delete_on_end
    FROM subscriptions sub
    JOIN streamers s ON sub.streamer_id = s.streamer_id
    WHERE sub.guild_id = '844406178799943730'
    AND (s.username = 'cookiesays' OR s.username = 'jeffdank90' OR s.username = 'c00kiesays')
    ORDER BY s.username, s.platform
`);

console.log('\nDelete on end settings:');
console.table(subscriptions);

await connection.end();
