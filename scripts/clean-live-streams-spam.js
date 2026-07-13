/**
 * Clean spam from #live-streams and reset live_announcements for Bunny Hugs.
 * Run while bot is STOPPED to avoid competing sessions.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '/home/death/CertiFriedUtility/.env' });
import { Client, GatewayIntentBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '869577842088878130';
const BOT_ID = '1481215496274579549';
const CHANNEL_ID = '1481232828732669985';

const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
const token = encryption.decrypt(JSON.parse(bots[0].bot_token));
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
await client.login(token);
await new Promise(r => client.once('ready', r));

// Step 1: Clear all live_announcements for this guild (clean slate)
const [before] = await pool.execute('SELECT COUNT(*) as cnt FROM live_announcements WHERE guild_id = ?', [GUILD_ID]);
console.log(`live_announcements rows before: ${before[0].cnt}`);
await pool.execute('DELETE FROM live_announcements WHERE guild_id = ?', [GUILD_ID]);
console.log('Cleared all live_announcements for guild');

// Step 2: Delete all messages from #live-streams
const ch = await client.channels.fetch(CHANNEL_ID);
const msgs = await ch.messages.fetch({ limit: 100 });
console.log(`Messages in channel: ${msgs.size}`);

let deleted = 0;
for (const [, m] of msgs) {
    try {
        await m.delete();
        deleted++;
    } catch (e) {
        console.log(`Failed to delete ${m.id}: ${e.message}`);
    }
}
console.log(`Deleted ${deleted} messages`);

const remaining = await ch.messages.fetch({ limit: 100 });
console.log(`Remaining: ${remaining.size}`);

client.destroy();
await pool.end();
console.log('Done. Start the bot with: pm2 start CertiFriedUtility');
