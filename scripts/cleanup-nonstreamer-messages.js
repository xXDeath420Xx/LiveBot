/**
 * Cleanup Non-Streamer Messages
 * Deletes all messages in a channel from users who do NOT have the streamer role.
 * Uses individual DELETE requests (no bulk-delete) since messages are older than 14 days.
 *
 * Guild: 985116833193553930
 * Bot: 1438889625388060723
 * Channel: 986744555481210920
 * Streamer Role: 992538724720181259
 */

import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { Client, GatewayIntentBits } from 'discord.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const encryptionModule = await import('../utils/encryption.js');
const encryptionService = encryptionModule.default;

const GUILD_ID = '985116833193553930';
const BOT_ID = '1438889625388060723';
const CHANNEL_ID = '986744555481210920';
const STREAMER_ROLE_ID = '992538724720181259';

let pool;
let client;

async function initDatabase() {
    pool = mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        charset: 'utf8mb4',
        waitForConnections: true,
        connectionLimit: 5,
        timezone: '+00:00'
    });
    console.log('[DB] Connected to database');
}

async function initDiscordClient() {
    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [BOT_ID]
    );

    if (!bots.length) {
        throw new Error(`Custom bot ${BOT_ID} not found in database`);
    }

    const tokenData = typeof bots[0].bot_token === 'string' ? JSON.parse(bots[0].bot_token) : bots[0].bot_token;
    const token = encryptionService.decrypt(tokenData);

    client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent
        ]
    });

    await client.login(token);
    console.log(`[Discord] Logged in as ${client.user.tag}`);

    await new Promise((resolve) => {
        if (client.isReady()) resolve();
        else client.once('ready', resolve);
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function cleanup() {
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(CHANNEL_ID);

    if (!channel || !channel.isTextBased()) {
        throw new Error('Channel not found or not text-based');
    }

    console.log(`[Cleanup] Starting cleanup of #${channel.name} (${CHANNEL_ID})`);
    console.log(`[Cleanup] Will delete messages from users WITHOUT streamer role (${STREAMER_ROLE_ID})`);

    // Fetch all members with streamer role to build a set
    await guild.members.fetch();
    const streamerRole = await guild.roles.fetch(STREAMER_ROLE_ID);
    const streamerMemberIds = new Set(streamerRole.members.map(m => m.id));

    // Also keep bot messages (the bot itself)
    streamerMemberIds.add(BOT_ID);

    console.log(`[Cleanup] Found ${streamerMemberIds.size} members with streamer role (+ bot)`);

    let totalDeleted = 0;
    let totalSkipped = 0;
    let totalProcessed = 0;
    let lastMessageId = undefined;
    let hasMore = true;

    while (hasMore) {
        const options = { limit: 100 };
        if (lastMessageId) {
            options.before = lastMessageId;
        }

        const messages = await channel.messages.fetch(options);

        if (messages.size === 0) {
            hasMore = false;
            break;
        }

        console.log(`\n[Batch] Fetched ${messages.size} messages (total processed: ${totalProcessed})`);

        // Sort by ID descending (newest first) to paginate correctly
        const sorted = [...messages.values()].sort((a, b) => {
            if (a.id < b.id) return -1;
            if (a.id > b.id) return 1;
            return 0;
        });

        lastMessageId = sorted[0].id; // oldest message in this batch

        for (const msg of sorted) {
            totalProcessed++;

            if (streamerMemberIds.has(msg.author.id)) {
                totalSkipped++;
                continue;
            }

            // Non-streamer message - delete it
            try {
                await msg.delete();
                totalDeleted++;
                console.log(`  [DEL] Deleted message from ${msg.author.tag} (${msg.author.id}) | ${msg.createdAt.toISOString()} | "${msg.content?.substring(0, 50) || '[embed/attachment]'}"`);

                // Rate limit: Discord allows ~5 deletes per 5 seconds for old messages
                // Be conservative to avoid hitting rate limits
                await sleep(1100);
            } catch (err) {
                if (err.code === 10008) {
                    // Message already deleted
                    console.log(`  [SKIP] Message already deleted: ${msg.id}`);
                } else if (err.status === 429) {
                    // Rate limited - wait and retry
                    const retryAfter = err.retryAfter || 5000;
                    console.log(`  [RATE] Rate limited, waiting ${retryAfter}ms...`);
                    await sleep(retryAfter + 500);
                    try {
                        await msg.delete();
                        totalDeleted++;
                        console.log(`  [DEL] (retry) Deleted message from ${msg.author.tag}`);
                    } catch (retryErr) {
                        console.error(`  [ERR] Failed to delete message ${msg.id} on retry:`, retryErr.message);
                    }
                } else {
                    console.error(`  [ERR] Failed to delete message ${msg.id}:`, err.message);
                }
            }
        }

        if (messages.size < 100) {
            hasMore = false;
        }
    }

    console.log(`\n=== CLEANUP COMPLETE ===`);
    console.log(`Total messages processed: ${totalProcessed}`);
    console.log(`Total messages deleted (non-streamer): ${totalDeleted}`);
    console.log(`Total messages kept (streamer): ${totalSkipped}`);
}

async function main() {
    try {
        await initDatabase();
        await initDiscordClient();
        await cleanup();
    } catch (err) {
        console.error('[FATAL]', err);
    } finally {
        if (client) client.destroy();
        if (pool) await pool.end();
        process.exit(0);
    }
}

main();
