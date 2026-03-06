/**
 * Finalize VognarFam setup:
 * - Clean up old messages in rules channel (keep only our rules embed)
 * - List all channels for reference
 */
import dotenv from 'dotenv';
dotenv.config();

import { Client, GatewayIntentBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '902393911958470717';
const BOT_ID = '1476040458680406214';
const RULES_CHANNEL_ID = '903149773987667979';
const RULES_MESSAGE_ID = '1476141871217770518'; // Our rules embed

async function run() {
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    if (!bots.length) { console.error('Bot not found'); process.exit(1); }
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent
        ]
    });

    await client.login(token);
    await new Promise(r => client.once('ready', r));
    console.log(`Logged in as ${client.user.tag}`);

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) { console.error('Guild not found'); process.exit(1); }

    // ========== STEP 1: Clean Rules Channel ==========
    console.log('\n=== CLEANING RULES CHANNEL ===');

    const rulesChannel = guild.channels.cache.get(RULES_CHANNEL_ID);
    if (!rulesChannel) { console.error('Rules channel not found'); process.exit(1); }

    // Fetch all messages (up to 100 at a time)
    let deletedCount = 0;
    let keepCount = 0;
    let hasMore = true;
    let lastId = null;

    while (hasMore) {
        const options = { limit: 100 };
        if (lastId) options.before = lastId;

        const messages = await rulesChannel.messages.fetch(options);
        if (messages.size === 0) {
            hasMore = false;
            break;
        }

        for (const [msgId, msg] of messages) {
            lastId = msgId;

            // Keep our rules embed
            if (msgId === RULES_MESSAGE_ID) {
                keepCount++;
                console.log(`  KEEP: Our rules embed (${msgId})`);
                continue;
            }

            // Delete everything else
            try {
                const preview = msg.content ? msg.content.substring(0, 60) : (msg.embeds.length > 0 ? '[embed]' : '[no content]');
                const age = Math.floor((Date.now() - msg.createdTimestamp) / (1000 * 60 * 60 * 24));

                // Messages older than 14 days can't be bulk deleted, must use individual delete
                await msg.delete();
                deletedCount++;
                console.log(`  DELETED: ${msg.author?.tag || 'unknown'} (${age}d old) - "${preview}..."`);

                // Small delay to avoid rate limits
                await new Promise(r => setTimeout(r, 1000));
            } catch (err) {
                console.log(`  SKIP (can't delete): ${msgId} - ${err.message}`);
            }
        }

        if (messages.size < 100) hasMore = false;
    }

    console.log(`\nRules channel cleanup: deleted ${deletedCount}, kept ${keepCount}`);

    // ========== STEP 2: List Channels ==========
    console.log('\n=== GUILD CHANNELS ===');

    const categories = guild.channels.cache
        .filter(c => c.type === 4)
        .sort((a, b) => a.rawPosition - b.rawPosition);

    const textChannels = guild.channels.cache
        .filter(c => c.type === 0 || c.type === 5);

    for (const [, cat] of categories) {
        const children = textChannels
            .filter(c => c.parentId === cat.id)
            .sort((a, b) => a.rawPosition - b.rawPosition);

        if (children.size > 0) {
            console.log(`\n[${cat.name}]`);
            for (const [, ch] of children) {
                console.log(`  #${ch.name} (${ch.id})`);
            }
        }
    }

    // No-category channels
    const orphans = textChannels.filter(c => c.parentId === null);
    if (orphans.size > 0) {
        console.log('\n[No Category]');
        for (const [, ch] of orphans) {
            console.log(`  #${ch.name} (${ch.id})`);
        }
    }

    console.log('\n========================================');
    console.log('FINALIZATION COMPLETE');
    console.log('========================================');

    client.destroy();
    await pool.end();
    process.exit(0);
}

run().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
