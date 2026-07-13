import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const BOT_ID = '1476040458680406214';
const CHANNEL_ID = '1476147991122284711';
const GUILD_ID = '902393911958470717';

try {
    // Get bot token and avatar
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    // Get bot info
    const meRes = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { 'Authorization': `Bot ${token}` }
    });
    const botUser = await meRes.json();

    // Get subscription count
    const [subs] = await pool.execute(
        `SELECT COUNT(*) as count FROM subscriptions WHERE guild_id = ?`, [GUILD_ID]);
    const streamerCount = subs[0].count;

    // Get guild config
    const [guild] = await pool.execute(
        'SELECT announcement_channel_id, live_role_id, use_webhook_persona FROM guilds WHERE guild_id = ?', [GUILD_ID]);
    const config = guild[0];

    const liveRoleMention = config.live_role_id ? `<@&${config.live_role_id}>` : 'None';
    const webhookMode = config.use_webhook_persona ? 'Streamer persona (webhook)' : 'Bot-direct';

    const embed = {
        author: {
            name: `${botUser.username} — Live Stream Announcements`,
            icon_url: `https://cdn.discordapp.com/avatars/${botUser.id}/${botUser.avatar}.png`
        },
        color: 0x9146FF, // Twitch purple
        description: [
            'This channel is the **live stream announcement** hub for the server.',
            '',
            'When a tracked streamer goes live, an announcement embed is automatically posted here. When they go offline, the announcement is cleaned up.',
            '',
            '**How it works:**',
            '> The bot checks all tracked streamers every **60 seconds**. When someone goes live, a notification is posted. When the stream ends, the announcement is removed or edited.',
        ].join('\n'),
        fields: [
            {
                name: '\uD83D\uDCCA Tracked Streamers',
                value: `**${streamerCount}** streamers are being watched`,
                inline: true
            },
            {
                name: '\uD83C\uDFA8 Post Style',
                value: webhookMode,
                inline: true
            },
            {
                name: '\uD83C\uDFAD Live Role',
                value: liveRoleMention,
                inline: true
            },
            {
                name: '\u2699\uFE0F Management',
                value: [
                    '`/streamer add` — Track a new streamer',
                    '`/streamer remove` — Stop tracking a streamer',
                    '`/streamer list` — See all tracked streamers',
                    `[Dashboard](https://certifriedmultitool.com/manage/${GUILD_ID}?page=streamers) — Full management UI`
                ].join('\n'),
                inline: false
            }
        ],
        footer: {
            text: 'Announcements are automatic • Powered by CertiFried MultiTool'
        },
        timestamp: new Date().toISOString()
    };

    // Post the embed
    const postRes = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
        method: 'POST',
        headers: {
            'Authorization': `Bot ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ embeds: [embed] })
    });

    if (postRes.ok) {
        const msg = await postRes.json();
        console.log('Info embed posted! Message ID:', msg.id);

        // Pin it
        const pinRes = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/pins/${msg.id}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bot ${token}` }
        });
        if (pinRes.ok) {
            console.log('Message pinned!');
        } else {
            console.log('Failed to pin:', pinRes.status);
        }
    } else {
        const err = await postRes.json();
        console.log('Failed to post:', JSON.stringify(err));
    }
} catch (err) {
    console.error('Error:', err.message);
}
process.exit(0);
