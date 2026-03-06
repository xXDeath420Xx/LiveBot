import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config({ path: '/root/discord_bots/CertiFriedUtility/.env' });

const guildId = '985116833193553930';

const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'CertiFriedDB',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'CertiFriedUtility'
});

console.log(`\n🔍 Checking appearance settings for guild ${guildId}...\n`);

const [config] = await conn.query(`
    SELECT bot_nickname, bot_avatar_url, embed_color
    FROM guild_config
    WHERE guild_id = ?
`, [guildId]);

if (config.length > 0) {
    console.log('✅ Guild config found in database:');
    console.table(config);
} else {
    console.log('❌ No guild config found in database');
    console.log('   This means no appearance settings have been saved yet');
}

await conn.end();
process.exit(0);
