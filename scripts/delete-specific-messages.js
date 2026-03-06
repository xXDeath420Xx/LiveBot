/**
 * Delete specific stale Discord messages
 * These are the messages that were in the database before cleanup
 */

import 'dotenv/config';
import mysql from 'mysql2/promise';
import { Client, GatewayIntentBits } from 'discord.js';
import crypto from 'crypto';

// Decryption function for bot tokens
function decryptToken(encryptedToken) {
    if (!encryptedToken) return null;

    if (typeof encryptedToken === 'string' && !encryptedToken.startsWith('{')) {
        return encryptedToken;
    }

    try {
        const encryptedObj = typeof encryptedToken === 'string'
            ? JSON.parse(encryptedToken)
            : encryptedToken;

        if (!encryptedObj.iv || !encryptedObj.encryptedData || !encryptedObj.authTag) {
            return encryptedToken;
        }

        const key = Buffer.from(process.env.BOT_ENCRYPTION_KEY, 'hex');
        const iv = Buffer.from(encryptedObj.iv, 'hex');
        const authTag = Buffer.from(encryptedObj.authTag, 'hex');

        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(encryptedObj.encryptedData, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    } catch (error) {
        console.error('Failed to decrypt token:', error.message);
        return null;
    }
}

// The stale messages we need to delete
const STALE_MESSAGES = [
    {
        username: 'yhandor',
        platform: 'twitch',
        guild_id: '985116833193553930',
        channel_id: '1415373602068496545',
        message_id: '1443461428248842322',
        bot_id: '1438889625388060723'
    },
    {
        username: 'wiredkydd',
        platform: 'twitch',
        guild_id: '985116833193553930',
        channel_id: '1415373602068496545',
        message_id: '1444121990465323130',
        bot_id: '1438889625388060723'
    },
    {
        username: 'norserekkr',
        platform: 'twitch',
        guild_id: '953890977880358932',
        channel_id: '960325805685227580',
        message_id: '1442582882924364036',
        bot_id: '1439038573411045396'
    }
];

async function main() {
    console.log('='.repeat(60));
    console.log('Delete Specific Stale Discord Messages');
    console.log('='.repeat(60));

    const pool = mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    try {
        // Get custom bot tokens
        const [customBots] = await pool.execute(`
            SELECT bot_id, bot_token FROM custom_bots WHERE enabled = 1
        `);

        const botTokens = new Map();
        botTokens.set('main', process.env.DISCORD_TOKEN);
        for (const bot of customBots) {
            const decryptedToken = decryptToken(bot.bot_token);
            if (decryptedToken) {
                botTokens.set(bot.bot_id, decryptedToken);
            }
        }

        console.log(`\nLoaded ${botTokens.size} bot tokens\n`);

        // Group messages by bot
        const byBot = new Map();
        for (const msg of STALE_MESSAGES) {
            if (!byBot.has(msg.bot_id)) {
                byBot.set(msg.bot_id, []);
            }
            byBot.get(msg.bot_id).push(msg);
        }

        let deletedCount = 0;
        let failedCount = 0;

        for (const [botId, messages] of byBot) {
            console.log(`\nProcessing ${messages.length} message(s) for bot: ${botId}`);

            const token = botTokens.get(botId);
            if (!token) {
                console.log(`  ⚠️  No token found for bot ${botId}`);
                failedCount += messages.length;
                continue;
            }

            const client = new Client({
                intents: [GatewayIntentBits.Guilds]
            });

            try {
                await client.login(token);
                console.log(`  ✅ Logged in as ${client.user.tag}`);

                await new Promise(resolve => {
                    if (client.isReady()) resolve();
                    else client.once('ready', resolve);
                });

                for (const msg of messages) {
                    try {
                        const guild = client.guilds.cache.get(msg.guild_id);
                        if (!guild) {
                            console.log(`  ⚠️  Guild not found: ${msg.guild_id}`);
                            failedCount++;
                            continue;
                        }

                        const channel = guild.channels.cache.get(msg.channel_id);
                        if (!channel || !channel.isTextBased()) {
                            console.log(`  ⚠️  Channel not found: ${msg.channel_id}`);
                            failedCount++;
                            continue;
                        }

                        try {
                            const message = await channel.messages.fetch(msg.message_id);
                            await message.delete();
                            console.log(`  🗑️  Deleted message for ${msg.username} (${msg.platform})`);
                            deletedCount++;
                        } catch (msgErr) {
                            if (msgErr.code === 10008) {
                                console.log(`  ℹ️  Message already deleted for ${msg.username}`);
                                deletedCount++;
                            } else {
                                console.log(`  ⚠️  Could not delete message for ${msg.username}: ${msgErr.message}`);
                                failedCount++;
                            }
                        }
                    } catch (err) {
                        console.log(`  ❌ Failed to process ${msg.username}: ${err.message}`);
                        failedCount++;
                    }
                }

                await client.destroy();
            } catch (loginErr) {
                console.log(`  ❌ Failed to login: ${loginErr.message}`);
                failedCount += messages.length;
            }
        }

        console.log('\n' + '='.repeat(60));
        console.log('Summary');
        console.log('='.repeat(60));
        console.log(`✅ Deleted: ${deletedCount}`);
        console.log(`❌ Failed: ${failedCount}`);

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await pool.end();
    }
}

main().catch(console.error);
