/**
 * Import birthdays from VognarFam birthday channel messages,
 * then clean the channel and post a pinned info embed.
 */
import dotenv from 'dotenv';
dotenv.config();

import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '902393911958470717';
const BOT_ID = '1476040458680406214';
const BDAY_CHANNEL = '1339623180087595089';

// Parsed from channel scan - only messages that contain actual birthday dates
// Excluding: happy birthday wishes, "thank u", etc.
const BIRTHDAYS = [
    { userId: '981422763438915584', username: 'mrsvognar', month: 2, day: 13 },
    { userId: '1065393117127262308', username: 'chaotictank942', month: 12, day: 20 },
    { userId: '355142909558784001', username: 'noahthegamer808', month: 7, day: 9 },
    { userId: '930728326140657704', username: 'midnit316', month: 3, day: 21 },
    { userId: '794724071702396938', username: 'ttvd1.braeden', month: 12, day: 10 },
    { userId: '832648280306352131', username: 'echo66', month: 6, day: 6 },
    { userId: '1203095325372579970', username: '0834990195', month: 7, day: 18 },
    { userId: '460316426268573696', username: 'rc_jev', month: 1, day: 8 },
    { userId: '482235308859981844', username: 'subl1me89vision', month: 7, day: 23 },
    { userId: '840243253998911510', username: 'outlawpegasus', month: 12, day: 15 },
    { userId: '1291620001568002059', username: 'kelbeangirl', month: 4, day: 10 }
];
// Note: chaotictank942 posted twice (Dec 20th and Dec 20 2006) - same date, deduped
// picklerick33's message was a birthday wish, not their own birthday
// mrsvognar's "Thank u" was a reply, not a birthday

async function run() {
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
    });

    await client.login(token);
    await new Promise(r => client.once('ready', r));
    console.log(`Logged in as ${client.user.tag}\n`);

    const guild = client.guilds.cache.get(GUILD_ID);
    const channel = guild.channels.cache.get(BDAY_CHANNEL);

    // ================================================================
    // STEP 1: Import birthdays to DB
    // ================================================================
    console.log('=== IMPORTING BIRTHDAYS ===');

    for (const bday of BIRTHDAYS) {
        await pool.execute(
            `INSERT INTO user_birthdays (user_id, guild_id, month, day)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE month = VALUES(month), day = VALUES(day)`,
            [bday.userId, GUILD_ID, bday.month, bday.day]
        );
        console.log(`  ${bday.username}: ${bday.month}/${bday.day}`);
    }
    console.log(`\nImported ${BIRTHDAYS.length} birthdays`);

    // ================================================================
    // STEP 2: Clean channel
    // ================================================================
    console.log('\n=== CLEANING CHANNEL ===');

    let deleted = 0;
    let hasMore = true;
    let lastId = null;

    while (hasMore) {
        const options = { limit: 100 };
        if (lastId) options.before = lastId;

        const messages = await channel.messages.fetch(options);
        if (messages.size === 0) { hasMore = false; break; }

        for (const [msgId, msg] of messages) {
            lastId = msgId;
            try {
                await msg.delete();
                deleted++;
                await new Promise(r => setTimeout(r, 500));
            } catch (e) {
                console.log(`  Skip: ${msgId} - ${e.message}`);
            }
        }

        if (messages.size < 100) hasMore = false;
    }
    console.log(`Deleted ${deleted} messages`);

    // ================================================================
    // STEP 3: Post info embed
    // ================================================================
    console.log('\n=== POSTING INFO EMBED ===');

    // Build list of imported birthdays sorted by month
    const sorted = [...BIRTHDAYS].sort((a, b) => a.month - b.month || a.day - b.day);
    const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const bdayList = sorted.map(b => `<@${b.userId}> \u2014 ${months[b.month]} ${b.day}`).join('\n');

    const embed = new EmbedBuilder()
        .setColor(0xFF69B4)
        .setTitle('\uD83C\uDF82 Community Birthdays')
        .setDescription(
            'Want your birthday celebrated? Use the command below to set yours!\n\n' +
            '```\n/engage birthday set month:<month> day:<day>\n```\n' +
            'When your birthday arrives, the bot will automatically post a celebration here!\n\n' +
            'Use `/engage birthday view` to check yours, or `/engage birthday upcoming` to see who\'s next.'
        )
        .addFields({
            name: '\uD83C\uDF89 Registered Birthdays',
            value: bdayList || 'None yet!',
            inline: false
        })
        .setFooter({ text: 'Birthdays are checked daily at midnight UTC' })
        .setTimestamp();

    const msg = await channel.send({ embeds: [embed] });
    await msg.pin();
    console.log(`Posted and pinned info embed: ${msg.id}`);

    // Delete the pin notification
    await new Promise(r => setTimeout(r, 2000));
    const recent = await channel.messages.fetch({ limit: 5 });
    for (const [, m] of recent) {
        if (m.type === 6) {
            await m.delete().catch(() => {});
            console.log('Deleted pin notification');
        }
    }

    // ================================================================
    // SUMMARY
    // ================================================================
    console.log('\n========================================');
    console.log('BIRTHDAY IMPORT COMPLETE');
    console.log('========================================');
    console.log(`Imported: ${BIRTHDAYS.length} birthdays`);
    console.log(`Cleaned: ${deleted} messages`);
    console.log('Info embed posted and pinned');

    client.destroy();
    await pool.end();
    process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
