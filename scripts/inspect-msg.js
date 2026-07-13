import 'dotenv/config';
import encryption from '../utils/encryption.js';
import pool from '../utils/db.js';

const BOT_ID = '1476040458680406214';
const CHANNEL_ID = '1318141825009319936';
const MESSAGE_ID = '1493172452677652541';

const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
const token = encryption.decrypt(JSON.parse(rows[0].bot_token));
const auth = { Authorization: `Bot ${token}` };

const res = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`, { headers: auth });
const m = await res.json();
console.log(JSON.stringify({
    id: m.id,
    content: m.content,
    author: m.author.username,
    timestamp: m.timestamp,
    edited_timestamp: m.edited_timestamp,
    type: m.type,
    flags: m.flags,
    mentions: m.mentions?.map(u => u.username),
    referenced_message: m.referenced_message?.id,
    message_reference: m.message_reference,
    interaction: m.interaction,
}, null, 2));
process.exit(0);
