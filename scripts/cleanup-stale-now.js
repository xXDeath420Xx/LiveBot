import { Client, GatewayIntentBits } from 'discord.js';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config({ path: '/root/discord_bots/CertiFriedUtility/.env' });

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'CertiFriedDB',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'CertiFriedUtility'
});

await client.login(process.env.DISCORD_TOKEN);
console.log('🔗 Connected to Discord\n');

const staleIds = [26736, 23036, 21352, 20771, 20533, 20123, 20121, 20118];
const [anns] = await conn.query('SELECT id, message_id, channel_id FROM live_announcements WHERE id IN (?)', [staleIds]);

console.log(`🗑️  Deleting ${anns.length} stale announcements...\n`);

for (const a of anns) {
    try {
        const ch = await client.channels.fetch(a.channel_id).catch(() => null);
        if (ch && ch.isTextBased()) {
            await ch.messages.delete(a.message_id).catch(() =>
                console.log(`   ⚠️  Message ${a.message_id} not found or already deleted`)
            );
            console.log(`   ✓ Deleted Discord message ${a.message_id}`);
        }

        await conn.query('DELETE FROM live_announcements WHERE id = ?', [a.id]);
        console.log(`   ✓ Deleted announcement ID ${a.id} from database\n`);
    } catch (e) {
        console.log(`   ❌ Error with ID ${a.id}: ${e.message}\n`);
    }
}

console.log(`✅ Cleanup complete!`);

await conn.end();
client.destroy();
process.exit(0);
