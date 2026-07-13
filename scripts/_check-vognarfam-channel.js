import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

try {
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', ['1476040458680406214']);
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    // Fetch recent messages from the channel
    const res = await fetch(`https://discord.com/api/v10/channels/1476147991122284711/messages?limit=20`, {
        headers: { 'Authorization': `Bot ${token}` }
    });

    if (!res.ok) {
        console.log('Failed to fetch messages:', res.status, await res.text());
        process.exit(1);
    }

    const messages = await res.json();
    console.log(`=== Last ${messages.length} messages in channel ===\n`);

    for (const msg of messages.reverse()) {
        const date = new Date(msg.timestamp).toISOString();
        const author = msg.author?.username || 'unknown';
        const isBot = msg.author?.bot ? ' [BOT]' : '';
        const isWebhook = msg.webhook_id ? ' [WEBHOOK]' : '';
        const embedCount = msg.embeds?.length || 0;
        const content = msg.content?.substring(0, 100) || '(no content)';

        console.log(`[${date}] ${author}${isBot}${isWebhook} (msg:${msg.id})`);
        if (embedCount > 0) {
            for (const e of msg.embeds) {
                console.log(`  EMBED: title="${e.title || '(none)'}" desc="${(e.description || '').substring(0, 80)}..."`);
            }
        } else {
            console.log(`  ${content}`);
        }
        console.log('');
    }

    // Also check pinned messages
    const pinRes = await fetch(`https://discord.com/api/v10/channels/1476147991122284711/pins`, {
        headers: { 'Authorization': `Bot ${token}` }
    });
    if (pinRes.ok) {
        const pins = await pinRes.json();
        console.log(`=== Pinned messages (${pins.length}) ===`);
        for (const pin of pins) {
            console.log(`  [${pin.id}] ${pin.author?.username}: embeds=${pin.embeds?.length || 0} content="${(pin.content || '').substring(0, 60)}"`);
            if (pin.embeds?.length > 0) {
                console.log(`    EMBED: "${pin.embeds[0].title || pin.embeds[0].description?.substring(0, 60) || '(no title)'}"`);
            }
        }
    }
} catch (err) {
    console.error('Error:', err.message);
}
process.exit(0);
