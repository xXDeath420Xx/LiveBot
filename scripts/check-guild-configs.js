import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config({ path: '/root/discord_bots/CertiFriedUtility/.env' });

const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'CertiFriedDB',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'CertiFriedUtility'
});

console.log('Checking guild configurations...\n');

// Check guilds table
const [guilds] = await connection.query(`
    SELECT guild_id, announcement_channel_id AS guild_channel_id, live_role_id AS guild_role_id
    FROM guilds
    WHERE guild_id IN ('844406178799943730', '985116833193553930', '1342779579168981065')
`);

console.log('Guild Default Configurations:');
console.table(guilds);

// Check subscriptions for these guilds
const [subs] = await connection.query(`
    SELECT
        s.username,
        s.platform,
        s.discord_user_id,
        sub.guild_id,
        sub.announcement_channel_id AS sub_channel_id,
        sub.live_role_id AS sub_role_id
    FROM subscriptions sub
    JOIN streamers s ON sub.streamer_id = s.streamer_id
    WHERE sub.guild_id IN ('844406178799943730', '985116833193553930', '1342779579168981065')
    ORDER BY sub.guild_id, s.username
`);

console.log('\nSubscriptions:');
console.table(subs);

// Show the resolution logic
console.log('\nRole Resolution Logic:');
console.log('finalRoleId = sub.sub_role_id || team?.team_role_id || guildDefault.guild_role_id');
console.log('\nThis means:');
console.log('1. If subscription has a role configured, use that');
console.log('2. Else if subscription is part of a team with a role, use team role');
console.log('3. Else use the guild default role');
console.log('4. If all are null, no role is assigned\n');

await connection.end();
