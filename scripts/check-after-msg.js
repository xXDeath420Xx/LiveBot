import 'dotenv/config';
import encryption from '../utils/encryption.js';
import pool from '../utils/db.js';

const BOT_ID = '1476040458680406214';
const CHANNEL_ID = '1318141825009319936';
const MESSAGE_ID = '1493172452677652541';

const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
const token = encryption.decrypt(JSON.parse(rows[0].bot_token));
const auth = { Authorization: `Bot ${token}` };

const res = await fetch(
    `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages?after=${MESSAGE_ID}&limit=10`,
    { headers: auth }
);
const msgs = await res.json();
console.log(`Messages AFTER target: ${msgs.length}`);
for (const m of msgs.reverse()) {
    const ts = new Date(parseInt(m.id) / 4194304 + 1420070400000).toISOString();
    const isBot = m.author.bot ? '🤖' : '👤';
    const ref = m.message_reference?.message_id;
    console.log(`${ts} ${isBot} ${m.author.username}: ${(m.content||'').slice(0,60)} ${ref ? `[reply-to:${ref}]` : ''}`);
}
process.exit(0);
