import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const BOT_ID = '1438889625388060723';
const CHANNEL_ID = '1474951572914966618';
const MESSAGE_ID = '1481597646362906654';

async function main() {
    // Get custom bot token
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    if (!bots.length) {
        console.log('Bot not found');
        process.exit(1);
    }

    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    // Fetch webhooks for the channel
    const whRes = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/webhooks`, {
        headers: { 'Authorization': `Bot ${token}` }
    });
    const webhooks = await whRes.json();
    console.log('Webhooks found:', webhooks.length);

    // Fetch the message to get its webhook_id
    const msgRes = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`, {
        headers: { 'Authorization': `Bot ${token}` }
    });
    const msg = await msgRes.json();
    console.log('Message webhook_id:', msg.webhook_id);
    console.log('Message author:', msg.author?.username);
    console.log('Existing embed title:', msg.embeds?.[0]?.title);
    console.log('Existing embed author:', msg.embeds?.[0]?.author?.name);
    console.log('Existing embed url:', msg.embeds?.[0]?.url);

    // Find matching webhook
    const webhook = webhooks.find(w => w.id === msg.webhook_id);
    if (!webhook) {
        console.log('No matching webhook found — trying bot edit instead');
        // Try direct bot edit as fallback
        const editRes = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bot ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [buildEndedEmbed(msg)] })
        });
        if (editRes.ok) {
            console.log('Successfully edited via bot token!');
        } else {
            console.log('Bot edit failed:', await editRes.json());
        }
        await pool.end();
        return;
    }

    console.log('Webhook token available:', !!webhook.token);

    const embed = buildEndedEmbed(msg);

    // Edit via webhook
    const editRes = await fetch(`https://discord.com/api/v10/webhooks/${webhook.id}/${webhook.token}/messages/${MESSAGE_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] })
    });

    if (editRes.ok) {
        console.log('Successfully edited message to stream-ended!');
    } else {
        const err = await editRes.json();
        console.log('Edit failed:', JSON.stringify(err));
    }

    await pool.end();
}

function buildEndedEmbed(msg) {
    const existingEmbed = msg.embeds?.[0];
    const username = msg.author?.username || 'Unknown';

    let platform = 'Unknown';
    const url = existingEmbed?.url || '';
    if (url.includes('twitch')) platform = 'Twitch';
    else if (url.includes('kick')) platform = 'Kick';
    else if (url.includes('youtube')) platform = 'YouTube';
    else if (url.includes('tiktok')) platform = 'TikTok';

    return {
        color: 0x808080,
        author: { name: `${username} was LIVE on ${platform}`, url: url || undefined },
        title: 'Stream has ended',
        description: 'This streamer does not have VODs enabled \u2014 sorry you missed the stream!',
        timestamp: new Date().toISOString()
    };
}

main().catch(err => {
    console.error('Error:', err);
    pool.end();
    process.exit(1);
});
