import { Client, GatewayIntentBits } from 'discord.js';
import mysql from 'mysql2/promise';
import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const ENCRYPTION_KEY = process.env.BOT_ENCRYPTION_KEY;
function decrypt(encryptedData) {
    if (typeof encryptedData === 'string') encryptedData = JSON.parse(encryptedData);
    const { iv, encryptedData: data, authTag } = encryptedData;
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'hex'), Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));
    return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8');
}

const pool = await mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME
});

const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', ['1438889625388060723']);
const token = decrypt(rows[0].bot_token);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

client.once('ready', async () => {
    console.log('Connected, bulk deleting...');
    const channel = await client.channels.fetch('1415373602068496545');
    
    for (let i = 0; i < 5; i++) {
        const messages = await channel.messages.fetch({ limit: 100 });
        if (messages.size < 2) break;
        await channel.bulkDelete(messages).catch(e => console.log('Bulk delete error:', e.message));
        console.log('Deleted batch', i+1);
        await new Promise(r => setTimeout(r, 1000));
    }
    
    console.log('Done!');
    client.destroy();
    await pool.end();
    process.exit(0);
});

client.login(token);
