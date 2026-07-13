import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const BOT_ID = '1476040458680406214';
const CHANNEL_ID = '1476147991122284711';
const GUILD_ID = '902393911958470717';

try {
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    // Get bot info for author
    const meRes = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { 'Authorization': `Bot ${token}` }
    });
    const botUser = await meRes.json();

    const embed = {
        author: {
            name: `${botUser.username} — Community Support & Auto-Shoutouts`,
            icon_url: `https://cdn.discordapp.com/avatars/${botUser.id}/${botUser.avatar}.png`
        },
        color: 0x9146FF,
        description: [
            'This channel features **automatic shoutouts** for the community\'s most supportive members!',
            '',
            'Every month, the **top 10 supporters** earn a spot here — their streams are automatically announced in this channel for the entire month.',
        ].join('\n'),
        fields: [
            {
                name: '\uD83C\uDF1F How to Get Featured',
                value: [
                    'Support other streamers in the community and earn points:',
                    '',
                    '**Raid a streamer** in <#1416534252547473459>',
                    '> \uD83D\uDFE3 Affiliate/Partner — **5 points**',
                    '> \uD83D\uDFE2 Non-affiliate — **10 points**',
                    '',
                    '**Support a streamer** in <#1318141825009319936>',
                    '> \uD83D\uDD35 **3 points** per support message',
                ].join('\n'),
                inline: false
            },
            {
                name: '\uD83D\uDCC5 Monthly Rotation',
                value: [
                    'On the **1st of each month**, points are tallied and the **top 10** supporters are:',
                    '> \u2022 Added to the auto-shoutout list for this channel',
                    '> \u2022 Their streams get announced here automatically when they go live',
                    '> \u2022 Featured for the entire month until the next rotation',
                ].join('\n'),
                inline: false
            },
            {
                name: '\uD83D\uDCCA Why Non-Affiliates Earn More',
                value: 'Non-affiliate streamers need more visibility to grow, so raiding them earns **double points** — encouraging the community to lift up smaller creators.',
                inline: false
            },
            {
                name: '\uD83D\uDD17 Twitch Links',
                value: [
                    'Make sure your Twitch is linked so the bot can track you:',
                    '> Affiliates/Partners: Post in <#902709263712018483>',
                    '> Non-affiliates: Post in <#902718842176933938>',
                ].join('\n'),
                inline: false
            },
        ],
        footer: {
            text: 'Top 10 supporters get auto-shoutouts \u2022 Points reset monthly'
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
        console.log('Support info embed posted! Message ID:', msg.id);

        // Pin it
        const pinRes = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/pins/${msg.id}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bot ${token}` }
        });
        console.log('Pinned:', pinRes.ok ? 'YES' : 'NO');
    } else {
        const err = await postRes.json();
        console.log('Failed to post:', JSON.stringify(err));
    }
} catch (err) {
    console.error('Error:', err.message);
}
process.exit(0);
