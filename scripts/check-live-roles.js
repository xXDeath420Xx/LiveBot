import { Client, GatewayIntentBits } from 'discord.js';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const TARGET_GUILD_ID = '844406178799943730';
const LIVE_ROLE_ID = '1410143392687722496';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

async function checkLiveRoles() {
    try {
        // Connect to database
        const connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'CertiFriedDB',
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME || 'CertiFriedUtility'
        });

        // Login to Discord
        await client.login(process.env.DISCORD_TOKEN);
        console.log('✓ Discord connected');

        // Fetch the guild
        const guild = await client.guilds.fetch(TARGET_GUILD_ID);
        console.log(`✓ Guild: ${guild.name}\n`);

        // Get currently live streamers
        const [liveStreamers] = await connection.query(`
            SELECT DISTINCT s.username, s.platform, s.discord_user_id
            FROM live_announcements la
            JOIN streamers s ON la.streamer_id = s.streamer_id
            WHERE la.guild_id = ?
            AND s.discord_user_id IS NOT NULL
        `, [TARGET_GUILD_ID]);

        console.log(`Found ${liveStreamers.length} currently live streamers with Discord links:\n`);

        for (const streamer of liveStreamers) {
            console.log(`Checking: ${streamer.username} (${streamer.platform})`);
            console.log(`  Discord User ID: ${streamer.discord_user_id}`);

            try {
                const member = await guild.members.fetch(streamer.discord_user_id);
                const hasRole = member.roles.cache.has(LIVE_ROLE_ID);

                console.log(`  Member: ${member.user.tag}`);
                console.log(`  Has live role: ${hasRole ? '✓ YES' : '❌ NO'}`);

                if (!hasRole) {
                    console.log(`  ⚠️  MISSING LIVE ROLE!`);
                }
            } catch (error) {
                console.log(`  ❌ Could not fetch member: ${error.message}`);
            }
            console.log('');
        }

        await connection.end();
        client.destroy();
        process.exit(0);

    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

checkLiveRoles();
