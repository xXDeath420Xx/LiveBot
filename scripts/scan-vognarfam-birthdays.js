/**
 * Phase 1: Scan birthday channel to see message formats
 */
import dotenv from 'dotenv';
dotenv.config();

import { Client, GatewayIntentBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '902393911958470717';
const BOT_ID = '1476040458680406214';
const BDAY_CHANNEL = '1339623180087595089';

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

    if (!channel) { console.error('Channel not found'); process.exit(1); }

    // Fetch all messages
    const allMessages = [];
    let lastId = null;
    let hasMore = true;

    while (hasMore) {
        const options = { limit: 100 };
        if (lastId) options.before = lastId;

        const messages = await channel.messages.fetch(options);
        if (messages.size === 0) { hasMore = false; break; }

        for (const [msgId, msg] of messages) {
            lastId = msgId;
            allMessages.push({
                id: msgId,
                author: msg.author.tag,
                authorId: msg.author.id,
                isBot: msg.author.bot,
                content: msg.content,
                embeds: msg.embeds.length,
                timestamp: msg.createdAt.toISOString()
            });
        }

        if (messages.size < 100) hasMore = false;
    }

    // Sort chronologically
    allMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    console.log(`Total messages: ${allMessages.length}\n`);
    console.log('=== ALL MESSAGES ===\n');

    for (const msg of allMessages) {
        const bot = msg.isBot ? ' [BOT]' : '';
        console.log(`[${msg.timestamp.slice(0, 10)}] ${msg.author}${bot} (${msg.authorId}):`);
        if (msg.content) console.log(`  "${msg.content}"`);
        if (msg.embeds > 0) console.log(`  [${msg.embeds} embed(s)]`);
        console.log();
    }

    client.destroy();
    await pool.end();
    process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
