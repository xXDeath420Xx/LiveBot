/**
 * Post and pin an informational message in the VognarFam auto-shoutout channel
 * explaining how users earn points for the auto-shoutout system
 */
import dotenv from 'dotenv';
dotenv.config();

import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '902393911958470717';
const BOT_ID = '1476040458680406214';
const SHOUTOUT_CHANNEL_ID = '1476147991122284711';

async function run() {
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
    });

    await client.login(token);
    await new Promise(r => client.once('ready', r));
    console.log(`Logged in as ${client.user.tag}`);

    const guild = client.guilds.cache.get(GUILD_ID);
    const channel = guild.channels.cache.get(SHOUTOUT_CHANNEL_ID);

    const embed = new EmbedBuilder()
        .setColor(0x9146FF)
        .setTitle('\uD83C\uDF1F Community Auto-Shoutout System')
        .setDescription(
            'This channel features **automatic go-live announcements** for our top community supporters! ' +
            'When a featured streamer goes live, you\'ll see their announcement here.\n\n' +
            'Want to get featured? Here\'s how to earn your spot:'
        )
        .addFields(
            {
                name: '\uD83D\uDEE1\uFE0F Raid Support',
                value: 'Post in <#1416534252547473459> when you raid someone!\n' +
                       '\u2022 Raid a **Non-Affiliate** streamer: **+10 points**\n' +
                       '\u2022 Raid an **Affiliate** streamer: **+5 points**\n' +
                       '_Include their Twitch link or @username in your message_',
                inline: false
            },
            {
                name: '\uD83D\uDC9A Stream Support',
                value: 'Post in <#1318141825009319936> when you support a streamer!\n' +
                       '\u2022 Each supported streamer: **+3 points**\n' +
                       '_Include their Twitch link or @username in your message_',
                inline: false
            },
            {
                name: '\uD83C\uDFC6 Monthly Rotation',
                value: 'At the start of each month, the **Top 10** point earners are automatically added to this channel\'s shoutout list.\n\n' +
                       'Their streams will be announced here for the entire month!\n' +
                       'Points reset monthly \u2014 everyone starts fresh.',
                inline: false
            },
            {
                name: '\uD83D\uDCA1 Tips',
                value: '\u2022 Supporting **Non-Affiliate** streamers earns more raid points \u2014 help the little guys grow!\n' +
                       '\u2022 You can support multiple streamers per message (just include each link)\n' +
                       '\u2022 The bot will react with \u2705 to confirm your entry was tracked',
                inline: false
            }
        )
        .setFooter({ text: 'Community Support Tracker \u2022 Points reset on the 1st of each month' })
        .setTimestamp();

    const msg = await channel.send({ embeds: [embed] });
    await msg.pin();
    console.log(`Posted and pinned info message: ${msg.id}`);

    // Delete the "pinned a message" system message
    await new Promise(r => setTimeout(r, 2000));
    const recent = await channel.messages.fetch({ limit: 5 });
    for (const [, m] of recent) {
        if (m.type === 6) { // MessageType.ChannelPinnedMessage
            await m.delete().catch(() => {});
            console.log('Deleted pin notification');
        }
    }

    client.destroy();
    await pool.end();
    process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
