import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const BOT_ID = '1439236669088727111';
const CHANNEL_ID = '1439252445078225037';
const MSG_IDS = ['1481933176036130816', '1481933177000820746'];

try {
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    // Check if the messages still exist or were deleted
    for (const msgId of MSG_IDS) {
        const res = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${msgId}`, {
            headers: { 'Authorization': `Bot ${token}` }
        });
        if (res.ok) {
            const msg = await res.json();
            console.log(`Message ${msgId}: EXISTS - author: ${msg.author?.username}, content: "${(msg.content || '').substring(0, 80)}"`);
        } else {
            const err = await res.json();
            console.log(`Message ${msgId}: ${res.status} - ${err.message || JSON.stringify(err)}`);
        }
    }

    // Check detection records
    const [detections] = await pool.execute(
        "SELECT * FROM phishing_detections WHERE guild_id = '1404239197987930114' ORDER BY id DESC LIMIT 5"
    );
    console.log('\n=== Detections ===');
    for (const d of detections) {
        console.log(`  [${d.id}] user:${d.user_id} domain:${d.matched_domain} action:${d.action_taken} url:${(d.matched_url || '').substring(0, 80)}`);
    }
} catch (err) {
    console.error('Error:', err.message);
}
process.exit(0);
