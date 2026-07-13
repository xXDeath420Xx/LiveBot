import 'dotenv/config';
import encryption from '../utils/encryption.js';
import pool from '../utils/db.js';

const BOT_ID = '1476040458680406214';
const CHANNEL_ID = '1318141825009319936';
const MESSAGE_ID = '1493172452677652541';

const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
const token = encryption.decrypt(JSON.parse(rows[0].bot_token));
const auth = { Authorization: `Bot ${token}` };

// Fetch messages around the original message time
const res = await fetch(
    `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages?around=${MESSAGE_ID}&limit=20`,
    { headers: auth }
);
const msgs = await res.json();

console.log(`Found ${msgs.length} messages around target:\n`);
for (const m of msgs.reverse()) {
    const isBot = m.author.bot ? '🤖' : '👤';
    const isRef = m.message_reference?.message_id === MESSAGE_ID ? ' [REPLY-TO-TARGET]' : '';
    const isTarget = m.id === MESSAGE_ID ? ' [<-- TARGET]' : '';
    const ts = new Date(parseInt(m.id) / 4194304 + 1420070400000).toISOString();
    const content = (m.content || '').slice(0, 80);
    const embeds = m.embeds?.length ? ` [${m.embeds.length} embed]` : '';
    console.log(`${ts} ${isBot} ${m.author.username}: ${content}${embeds}${isRef}${isTarget}`);
}

process.exit(0);
