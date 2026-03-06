import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { getCycleTLSInstance } from '../utils/tls-manager.js';
import * as kickApi from '../utils/platforms/kick.js';
import * as twitchApi from '../utils/platforms/twitch.js';

dotenv.config({ path: '/root/discord_bots/CertiFriedUtility/.env' });

const platformModules = {
    twitch: twitchApi,
    kick: kickApi
};

async function checkStaleAnnouncements(guildId) {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'CertiFriedDB',
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME || 'CertiFriedUtility'
    });

    console.log(`\n🔍 Checking announcements in guild ${guildId}...\n`);

    const [announcements] = await connection.query(`
        SELECT
            la.id,
            la.message_id,
            la.channel_id,
            la.created_at,
            s.username,
            s.platform,
            s.streamer_id,
            TIMESTAMPDIFF(HOUR, la.created_at, NOW()) as hours_old
        FROM live_announcements la
        JOIN streamers s ON la.streamer_id = s.streamer_id
        WHERE la.guild_id = ?
        ORDER BY la.created_at DESC
    `, [guildId]);

    console.log(`Found ${announcements.length} total announcements\n`);

    const results = {
        live: [],
        offline: [],
        errors: []
    };

    for (const ann of announcements) {
        try {
            const api = platformModules[ann.platform];
            if (!api) {
                results.errors.push({ ...ann, error: 'No API module' });
                continue;
            }

            const isLive = await api.isStreamerLive(ann.username);

            if (isLive) {
                results.live.push(ann);
                console.log(`✅ LIVE: ${ann.platform.padEnd(7)} | ${ann.username.padEnd(20)} | ${ann.hours_old}h old`);
            } else {
                results.offline.push(ann);
                console.log(`❌ OFFLINE: ${ann.platform.padEnd(7)} | ${ann.username.padEnd(20)} | ${ann.hours_old}h old | 🗑️  STALE`);
            }
        } catch (error) {
            results.errors.push({ ...ann, error: error.message });
            console.log(`⚠️  ERROR: ${ann.platform.padEnd(7)} | ${ann.username.padEnd(20)} | ${error.message}`);
        }
    }

    console.log(`\n📊 Summary:`);
    console.log(`   Live: ${results.live.length}`);
    console.log(`   Offline (STALE): ${results.offline.length}`);
    console.log(`   Errors: ${results.errors.length}`);

    if (results.offline.length > 0) {
        console.log(`\n🗑️  Stale announcements to clean up:`);
        results.offline.forEach(ann => {
            console.log(`   ID ${ann.id}: ${ann.platform}/${ann.username} (${ann.hours_old}h old) - Message: ${ann.message_id}`);
        });
    }

    await connection.end();
    return results;
}

// Check both guilds
const TARGET_GUILDS = ['985116833193553930', '844406178799943730'];

for (const guildId of TARGET_GUILDS) {
    await checkStaleAnnouncements(guildId);
}

process.exit(0);
