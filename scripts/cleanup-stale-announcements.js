/**
 * Cleanup Stale Live Announcements
 *
 * This script cleans up stale live announcements by:
 * 1. Deleting Discord messages for stale announcements
 * 2. Removing stale entries from the database
 *
 * A stale announcement is one where:
 * - updated_at is older than 6 hours, OR
 * - offline_check_count > 100 (checked many times but never cleaned up)
 *
 * Usage:
 *   node scripts/cleanup-stale-announcements.js           # Run cleanup
 *   node scripts/cleanup-stale-announcements.js --dry-run # Preview only
 */

import 'dotenv/config';
import mysql from 'mysql2/promise';
import { Client, GatewayIntentBits } from 'discord.js';
import crypto from 'crypto';

// Decryption function for bot tokens
function decryptToken(encryptedToken) {
    if (!encryptedToken) return null;

    // If it's a plain string (not encrypted), return as-is
    if (typeof encryptedToken === 'string' && !encryptedToken.startsWith('{')) {
        return encryptedToken;
    }

    try {
        const encryptedObj = typeof encryptedToken === 'string'
            ? JSON.parse(encryptedToken)
            : encryptedToken;

        if (!encryptedObj.iv || !encryptedObj.encryptedData || !encryptedObj.authTag) {
            return encryptedToken; // Not encrypted, return as-is
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

const STALE_HOURS = 6;
const MAX_OFFLINE_CHECKS = 100;
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
    console.log('='.repeat(60));
    console.log('Stale Live Announcements Cleanup Script');
    console.log('='.repeat(60));

    if (DRY_RUN) {
        console.log('\n⚠️  DRY RUN MODE - No changes will be made\n');
    }

    // Create database pool
    const pool = mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    try {
        // Get all stale announcements
        const [staleAnnouncements] = await pool.execute(`
            SELECT
                la.id, la.username, la.platform, la.guild_id, la.channel_id, la.message_id,
                la.stream_started_at, la.updated_at, la.offline_check_count, la.delete_on_end,
                TIMESTAMPDIFF(HOUR, la.updated_at, NOW()) as hours_since_update,
                gbm.bot_id
            FROM live_announcements la
            LEFT JOIN guild_bot_mapping gbm ON la.guild_id = gbm.guild_id
            WHERE
                TIMESTAMPDIFF(HOUR, la.updated_at, NOW()) > ?
                OR la.offline_check_count > ?
            ORDER BY la.updated_at ASC
        `, [STALE_HOURS, MAX_OFFLINE_CHECKS]);

        console.log(`\nFound ${staleAnnouncements.length} stale announcement(s):\n`);

        if (staleAnnouncements.length === 0) {
            console.log('✅ No stale announcements to clean up!');
            await pool.end();
            return;
        }

        // Group by bot (null = main bot, otherwise custom bot ID)
        const byBot = new Map();
        for (const ann of staleAnnouncements) {
            const botKey = ann.bot_id || 'main';
            if (!byBot.has(botKey)) {
                byBot.set(botKey, []);
            }
            byBot.get(botKey).push(ann);
        }

        // Print summary
        for (const ann of staleAnnouncements) {
            const botId = ann.bot_id || 'main';
            console.log(`  [${ann.platform}] ${ann.username}`);
            console.log(`    Guild: ${ann.guild_id}, Channel: ${ann.channel_id}`);
            console.log(`    Message ID: ${ann.message_id}`);
            console.log(`    Last update: ${ann.hours_since_update}h ago`);
            console.log(`    Offline checks: ${ann.offline_check_count}`);
            console.log(`    Bot: ${botId}`);
            console.log('');
        }

        if (DRY_RUN) {
            console.log('DRY RUN - Would delete these announcements and their Discord messages.');
            await pool.end();
            return;
        }

        // Get bot tokens
        const mainToken = process.env.DISCORD_TOKEN;

        // Get custom bot tokens
        const [customBots] = await pool.execute(`
            SELECT bot_id, bot_token FROM custom_bots WHERE enabled = 1
        `);

        const botTokens = new Map();
        botTokens.set('main', mainToken);
        for (const bot of customBots) {
            const decryptedToken = decryptToken(bot.bot_token);
            if (decryptedToken) {
                botTokens.set(bot.bot_id, decryptedToken);
            }
        }

        // Process each bot's announcements
        let deletedCount = 0;
        let failedCount = 0;

        for (const [botKey, announcements] of byBot) {
            console.log(`\nProcessing ${announcements.length} announcement(s) for bot: ${botKey}`);

            const token = botTokens.get(botKey);
            if (!token) {
                console.log(`  ⚠️  No token found for bot ${botKey}, skipping Discord deletion but will remove from DB`);

                // Still remove from database
                for (const ann of announcements) {
                    try {
                        await pool.execute('DELETE FROM live_announcements WHERE id = ?', [ann.id]);
                        console.log(`  🗑️  Removed from DB: ${ann.username} (${ann.platform})`);
                        deletedCount++;
                    } catch (err) {
                        console.log(`  ❌ Failed to remove from DB: ${ann.username} - ${err.message}`);
                        failedCount++;
                    }
                }
                continue;
            }

            // Create Discord client for this bot
            const client = new Client({
                intents: [GatewayIntentBits.Guilds]
            });

            try {
                await client.login(token);
                console.log(`  ✅ Logged in as ${client.user.tag}`);

                // Wait for client to be ready
                await new Promise(resolve => {
                    if (client.isReady()) resolve();
                    else client.once('ready', resolve);
                });

                for (const ann of announcements) {
                    try {
                        // Try to delete the Discord message
                        const guild = client.guilds.cache.get(ann.guild_id);
                        if (guild) {
                            const channel = guild.channels.cache.get(ann.channel_id);
                            if (channel && channel.isTextBased()) {
                                try {
                                    const message = await channel.messages.fetch(ann.message_id);
                                    await message.delete();
                                    console.log(`  🗑️  Deleted Discord message for ${ann.username}`);
                                } catch (msgErr) {
                                    if (msgErr.code === 10008) {
                                        console.log(`  ℹ️  Message already deleted for ${ann.username}`);
                                    } else {
                                        console.log(`  ⚠️  Could not delete message: ${msgErr.message}`);
                                    }
                                }
                            } else {
                                console.log(`  ⚠️  Channel not found for ${ann.username}`);
                            }
                        } else {
                            console.log(`  ⚠️  Guild not found for ${ann.username}`);
                        }

                        // Remove from database
                        await pool.execute('DELETE FROM live_announcements WHERE id = ?', [ann.id]);
                        console.log(`  ✅ Removed from DB: ${ann.username} (${ann.platform})`);
                        deletedCount++;
                    } catch (err) {
                        console.log(`  ❌ Failed to process ${ann.username}: ${err.message}`);
                        failedCount++;
                    }
                }

                await client.destroy();
            } catch (loginErr) {
                console.log(`  ❌ Failed to login bot ${botKey}: ${loginErr.message}`);

                // Still try to remove from database
                for (const ann of announcements) {
                    try {
                        await pool.execute('DELETE FROM live_announcements WHERE id = ?', [ann.id]);
                        console.log(`  🗑️  Removed from DB (no Discord): ${ann.username}`);
                        deletedCount++;
                    } catch (err) {
                        failedCount++;
                    }
                }
            }
        }

        console.log('\n' + '='.repeat(60));
        console.log('Cleanup Summary');
        console.log('='.repeat(60));
        console.log(`✅ Successfully cleaned: ${deletedCount}`);
        console.log(`❌ Failed: ${failedCount}`);

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await pool.end();
    }
}

main().catch(console.error);
