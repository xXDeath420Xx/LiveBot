import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config({ path: '/root/discord_bots/CertiFriedUtility/.env' });

const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'CertiFriedDB',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'CertiFriedUtility'
});

console.log('\n📋 Checking table structures...\n');

try {
    const [guildsColumns] = await conn.query("SHOW COLUMNS FROM guilds");
    console.log('✅ guilds table columns:');
    guildsColumns.forEach(col => console.log(`   - ${col.Field}`));
} catch (e) {
    console.log('❌ guilds table:', e.message);
}

console.log('');

try {
    const [guildConfigColumns] = await conn.query("SHOW COLUMNS FROM guild_config");
    console.log('✅ guild_config table columns:');
    guildConfigColumns.forEach(col => console.log(`   - ${col.Field}`));
} catch (e) {
    console.log('❌ guild_config table:', e.message);
}

console.log('\n📊 Checking data in both tables for guild 985116833193553930...\n');

try {
    const [guildsData] = await conn.query('SELECT * FROM guilds WHERE guild_id = ?', ['985116833193553930']);
    console.log('guilds table data:');
    console.table(guildsData);
} catch (e) {
    console.log('❌', e.message);
}

console.log('');

try {
    const [guildConfigData] = await conn.query('SELECT * FROM guild_config WHERE guild_id = ?', ['985116833193553930']);
    console.log('guild_config table data:');
    console.table(guildConfigData);
} catch (e) {
    console.log('❌', e.message);
}

await conn.end();
process.exit(0);
