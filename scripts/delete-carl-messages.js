/**
 * Delete old Carl bot messages from Insomniac Crew
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { Client, GatewayIntentBits } from 'discord.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const encryptionModule = await import('../utils/encryption.js');
const encryptionService = encryptionModule.default;

const BOT_ID = '1469972857701273716';

const MESSAGES_TO_DELETE = [
    { channelId: '868256979343274014', messageId: '875775883359698974', desc: 'Carl rules message in #rules' },
    { channelId: '1407625323377590272', messageId: '1418500284879212606', desc: 'Carl platform embed in #roles' },
    { channelId: '1407625323377590272', messageId: '1418501228530368583', desc: 'krymzynfx text explanation in #roles' },
    { channelId: '1407625323377590272', messageId: '1418513103879929970', desc: 'Carl substance embed in #roles' }
];

async function main() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST, user: process.env.DB_USER,
        password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
        charset: 'utf8mb4', waitForConnections: true, connectionLimit: 5, timezone: '+00:00'
    });

    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    const tokenData = typeof bots[0].bot_token === 'string' ? JSON.parse(bots[0].bot_token) : bots[0].bot_token;
    const token = encryptionService.decrypt(tokenData);

    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
    await client.login(token);
    await new Promise(r => { if (client.isReady()) r(); else client.once('ready', r); });
    console.log(`Logged in as ${client.user.tag}\n`);

    for (const msg of MESSAGES_TO_DELETE) {
        try {
            const channel = await client.channels.fetch(msg.channelId);
            const message = await channel.messages.fetch(msg.messageId);
            await message.delete();
            console.log(`  Deleted: ${msg.desc} (${msg.messageId})`);
        } catch (err) {
            console.log(`  FAILED: ${msg.desc} (${msg.messageId}) - ${err.message}`);
        }
    }

    console.log('\nDone.');
    client.destroy();
    await pool.end();
}

main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
