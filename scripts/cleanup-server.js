/**
 * Server Cleanup Script
 * Cleans up duplicate announcements and ensures live roles match actual live streamers
 *
 * Target Server: 985116833193553930
 * Bot Instance: 1438889625388060723
 * Channel: 1415373602068496545
 * Live Role: 1415371559966609552
 */

import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { Client, GatewayIntentBits } from 'discord.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Import encryption after dotenv is loaded
const encryptionModule = await import('../utils/encryption.js');
const encryptionService = encryptionModule.default;

const GUILD_ID = '985116833193553930';
const BOT_ID = '1438889625388060723';
const CHANNEL_ID = '1415373602068496545';
const LIVE_ROLE_ID = '1415371559966609552';

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
    // Get the custom bot token for this guild
    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [BOT_ID]
    );

    if (!bots.length) {
        throw new Error(`Custom bot ${BOT_ID} not found in database`);
    }

    // bot_token is stored as JSON with iv, encryptedData, authTag
    const tokenData = typeof bots[0].bot_token === 'string' ? JSON.parse(bots[0].bot_token) : bots[0].bot_token;
    const token = encryptionService.decrypt(tokenData);

    client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages
        ]
    });

    await client.login(token);
    console.log(`[Discord] Logged in as ${client.user.tag}`);

    // Wait for client to be ready
    await new Promise((resolve) => {
        if (client.isReady()) resolve();
        else client.once('ready', resolve);
    });
}

async function findDuplicateAnnouncements() {
    console.log('\n=== CHECKING FOR DUPLICATE ANNOUNCEMENTS ===\n');

    // Find duplicates in database (same streamer, same channel, multiple entries)
    const [duplicates] = await pool.execute(`
        SELECT
            guild_id, platform, username, channel_id,
            COUNT(*) as count,
            GROUP_CONCAT(id ORDER BY created_at DESC) as ids,
            GROUP_CONCAT(message_id ORDER BY created_at DESC) as message_ids
        FROM live_announcements
        WHERE guild_id = ?
        GROUP BY guild_id, platform, username, channel_id
        HAVING COUNT(*) > 1
    `, [GUILD_ID]);

    if (duplicates.length > 0) {
        console.log(`[DUPLICATES] Found ${duplicates.length} duplicate announcement entries:\n`);
        for (const dup of duplicates) {
            console.log(`  - ${dup.username} (${dup.platform}): ${dup.count} entries`);
            console.log(`    IDs: ${dup.ids}`);
            console.log(`    Message IDs: ${dup.message_ids}`);
        }
    } else {
        console.log('[DUPLICATES] No duplicate announcements found in database');
    }

    return duplicates;
}

async function findStaleAnnouncements() {
    console.log('\n=== CHECKING FOR STALE ANNOUNCEMENTS ===\n');

    // Find announcements that have been offline for too long
    const [stale] = await pool.execute(`
        SELECT *
        FROM live_announcements
        WHERE guild_id = ?
        AND (offline_check_count >= 4 OR created_at < DATE_SUB(NOW(), INTERVAL 6 HOUR))
    `, [GUILD_ID]);

    if (stale.length > 0) {
        console.log(`[STALE] Found ${stale.length} stale announcements:\n`);
        for (const ann of stale) {
            console.log(`  - ${ann.username} (${ann.platform}): offline_count=${ann.offline_check_count}, created=${ann.created_at}`);
        }
    } else {
        console.log('[STALE] No stale announcements found');
    }

    return stale;
}

async function getAllAnnouncements() {
    console.log('\n=== ALL ANNOUNCEMENTS FOR THIS SERVER ===\n');

    const [announcements] = await pool.execute(`
        SELECT la.*, s.discord_user_id
        FROM live_announcements la
        LEFT JOIN streamers s ON la.streamer_id = s.streamer_id
        WHERE la.guild_id = ?
        ORDER BY la.created_at DESC
    `, [GUILD_ID]);

    console.log(`[ANNOUNCEMENTS] Found ${announcements.length} total announcements:\n`);
    for (const ann of announcements) {
        console.log(`  ID: ${ann.id}`);
        console.log(`    Streamer: ${ann.username} (${ann.platform})`);
        console.log(`    Message ID: ${ann.message_id}`);
        console.log(`    Channel: ${ann.channel_id}`);
        console.log(`    Offline Count: ${ann.offline_check_count || 0}`);
        console.log(`    Created: ${ann.created_at}`);
        console.log(`    Discord User: ${ann.discord_user_id || 'N/A'}`);
        console.log('');
    }

    return announcements;
}

async function checkChannelMessages() {
    console.log('\n=== CHECKING CHANNEL MESSAGES ===\n');

    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(CHANNEL_ID);

    if (!channel || !channel.isTextBased()) {
        console.log('[ERROR] Could not fetch channel or channel is not text-based');
        return [];
    }

    // Fetch messages from channel
    const messages = await channel.messages.fetch({ limit: 100 });
    console.log(`[CHANNEL] Found ${messages.size} messages in channel ${CHANNEL_ID}\n`);

    // Get tracked message IDs from database
    const [tracked] = await pool.execute(`
        SELECT message_id, username, platform
        FROM live_announcements
        WHERE guild_id = ? AND channel_id = ?
    `, [GUILD_ID, CHANNEL_ID]);

    const trackedMessageIds = new Set(tracked.map(t => t.message_id));
    const trackedMap = new Map(tracked.map(t => [t.message_id, t]));

    const untrackedMessages = [];
    const trackedMessages = [];

    for (const [messageId, message] of messages) {
        const isTracked = trackedMessageIds.has(messageId);
        const isWebhook = !!message.webhookId;
        const isBot = message.author?.bot;

        if (isTracked) {
            const info = trackedMap.get(messageId);
            trackedMessages.push({ messageId, info, message });
            console.log(`  [TRACKED] ${messageId} - ${info.username} (${info.platform})`);
        } else if (isWebhook || isBot) {
            untrackedMessages.push({ messageId, message, isWebhook });
            console.log(`  [UNTRACKED] ${messageId} - ${isWebhook ? 'Webhook' : 'Bot'} message - "${message.content?.substring(0, 50) || message.embeds?.[0]?.title || 'No content'}..."`);
        }
    }

    console.log(`\n[SUMMARY] ${trackedMessages.length} tracked, ${untrackedMessages.length} untracked webhook/bot messages`);

    return { trackedMessages, untrackedMessages };
}

async function checkLiveStreamers() {
    console.log('\n=== CHECKING LIVE STREAMERS ===\n');

    // Get all subscriptions for this guild
    const [subscriptions] = await pool.execute(`
        SELECT sub.*, s.username, s.platform, s.discord_user_id
        FROM subscriptions sub
        JOIN streamers s ON sub.streamer_id = s.streamer_id
        WHERE sub.guild_id = ?
    `, [GUILD_ID]);

    console.log(`[SUBSCRIPTIONS] Found ${subscriptions.length} tracked streamers for this server\n`);

    // Get current announcements (these are live streamers)
    const [liveAnnouncements] = await pool.execute(`
        SELECT la.*, s.discord_user_id
        FROM live_announcements la
        JOIN streamers s ON la.streamer_id = s.streamer_id
        WHERE la.guild_id = ? AND la.offline_check_count < 4
    `, [GUILD_ID]);

    const liveDiscordUsers = new Set(
        liveAnnouncements
            .filter(a => a.discord_user_id)
            .map(a => a.discord_user_id)
    );

    console.log(`[LIVE] ${liveAnnouncements.length} streamers currently live with active announcements`);
    console.log(`[LIVE USERS] Discord users who should have live role: ${[...liveDiscordUsers].join(', ') || 'None'}\n`);

    return { subscriptions, liveAnnouncements, liveDiscordUsers };
}

async function checkLiveRoleAssignments(liveDiscordUsers) {
    console.log('\n=== CHECKING LIVE ROLE ASSIGNMENTS ===\n');

    const guild = await client.guilds.fetch(GUILD_ID);

    // Force fetch all members to ensure cache is populated
    console.log('[ROLE] Fetching all guild members to ensure cache is fresh...');
    await guild.members.fetch();

    const liveRole = await guild.roles.fetch(LIVE_ROLE_ID);

    if (!liveRole) {
        console.log('[ERROR] Could not fetch live role');
        return { shouldHave: [], shouldNotHave: [] };
    }

    console.log(`[ROLE] Live role: ${liveRole.name} (${LIVE_ROLE_ID})`);

    // Get all members with the live role
    const membersWithRole = liveRole.members;
    console.log(`[ROLE] ${membersWithRole.size} members currently have the live role\n`);

    const shouldHave = [];
    const shouldNotHave = [];
    const correctlyHave = [];

    // Check who has the role but shouldn't
    for (const [memberId, member] of membersWithRole) {
        if (liveDiscordUsers.has(memberId)) {
            correctlyHave.push({ memberId, tag: member.user.tag });
            console.log(`  [CORRECT] ${member.user.tag} (${memberId}) - IS live, HAS role`);
        } else {
            shouldNotHave.push({ memberId, tag: member.user.tag, member });
            console.log(`  [INCORRECT] ${member.user.tag} (${memberId}) - NOT live, HAS role`);
        }
    }

    // Check who should have the role but doesn't
    for (const discordUserId of liveDiscordUsers) {
        if (!membersWithRole.has(discordUserId)) {
            try {
                const member = await guild.members.fetch(discordUserId);
                shouldHave.push({ memberId: discordUserId, tag: member.user.tag, member });
                console.log(`  [MISSING] ${member.user.tag} (${discordUserId}) - IS live, NO role`);
            } catch (e) {
                console.log(`  [ERROR] Could not fetch member ${discordUserId}: ${e.message}`);
            }
        }
    }

    console.log(`\n[SUMMARY] ${correctlyHave.length} correct, ${shouldNotHave.length} should lose role, ${shouldHave.length} should gain role`);

    return { shouldHave, shouldNotHave, correctlyHave };
}

async function cleanupDuplicates(duplicates) {
    if (duplicates.length === 0) return;

    console.log('\n=== CLEANING UP DUPLICATES ===\n');

    const guild = await client.guilds.fetch(GUILD_ID);

    for (const dup of duplicates) {
        const ids = dup.ids.split(',');
        const messageIds = dup.message_ids.split(',');

        // Keep the first (most recent), delete the rest
        const [keepId, ...deleteIds] = ids;
        const [keepMsgId, ...deleteMsgIds] = messageIds;

        console.log(`[CLEANUP] ${dup.username}: Keeping ID ${keepId} (msg: ${keepMsgId}), deleting ${deleteIds.length} duplicates`);

        // Delete extra database entries
        for (const id of deleteIds) {
            await pool.execute('DELETE FROM live_announcements WHERE id = ?', [id]);
            console.log(`  - Deleted DB entry ${id}`);
        }

        // Delete extra Discord messages
        try {
            const channel = await guild.channels.fetch(dup.channel_id);
            for (const msgId of deleteMsgIds) {
                try {
                    const msg = await channel.messages.fetch(msgId);
                    await msg.delete();
                    console.log(`  - Deleted Discord message ${msgId}`);
                } catch (e) {
                    console.log(`  - Could not delete message ${msgId}: ${e.message}`);
                }
            }
        } catch (e) {
            console.log(`  - Could not access channel: ${e.message}`);
        }
    }
}

async function cleanupUntrackedMessages(untrackedMessages) {
    if (untrackedMessages.length === 0) return;

    console.log('\n=== CLEANING UP UNTRACKED MESSAGES ===\n');

    for (const { messageId, message, isWebhook } of untrackedMessages) {
        try {
            await message.delete();
            console.log(`  - Deleted untracked ${isWebhook ? 'webhook' : 'bot'} message ${messageId}`);
        } catch (e) {
            console.log(`  - Could not delete message ${messageId}: ${e.message}`);
        }
    }
}

async function cleanupStaleAnnouncements(stale) {
    if (stale.length === 0) return;

    console.log('\n=== CLEANING UP STALE ANNOUNCEMENTS ===\n');

    const guild = await client.guilds.fetch(GUILD_ID);

    for (const ann of stale) {
        try {
            // Delete from database
            await pool.execute('DELETE FROM live_announcements WHERE id = ?', [ann.id]);
            console.log(`  - Deleted DB entry ${ann.id} for ${ann.username}`);

            // Delete Discord message
            try {
                const channel = await guild.channels.fetch(ann.channel_id);
                const msg = await channel.messages.fetch(ann.message_id);
                await msg.delete();
                console.log(`  - Deleted Discord message ${ann.message_id}`);
            } catch (e) {
                console.log(`  - Could not delete message: ${e.message}`);
            }
        } catch (e) {
            console.log(`  - Error cleaning up ${ann.username}: ${e.message}`);
        }
    }
}

async function fixLiveRoles(shouldHave, shouldNotHave) {
    console.log('\n=== FIXING LIVE ROLE ASSIGNMENTS ===\n');

    const guild = await client.guilds.fetch(GUILD_ID);
    const liveRole = await guild.roles.fetch(LIVE_ROLE_ID);

    // Add role to those who should have it
    for (const { memberId, tag, member } of shouldHave) {
        try {
            await member.roles.add(liveRole);
            console.log(`  [ADDED] Added live role to ${tag} (${memberId})`);
        } catch (e) {
            console.log(`  [ERROR] Could not add role to ${tag}: ${e.message}`);
        }
    }

    // Remove role from those who shouldn't have it
    for (const { memberId, tag, member } of shouldNotHave) {
        try {
            await member.roles.remove(liveRole);
            console.log(`  [REMOVED] Removed live role from ${tag} (${memberId})`);
        } catch (e) {
            console.log(`  [ERROR] Could not remove role from ${tag}: ${e.message}`);
        }
    }
}

async function main() {
    console.log('=========================================');
    console.log('  SERVER CLEANUP SCRIPT');
    console.log(`  Guild: ${GUILD_ID}`);
    console.log(`  Bot: ${BOT_ID}`);
    console.log(`  Channel: ${CHANNEL_ID}`);
    console.log(`  Live Role: ${LIVE_ROLE_ID}`);
    console.log('=========================================\n');

    try {
        // Initialize
        await initDatabase();
        await initDiscordClient();

        // Analysis phase
        const duplicates = await findDuplicateAnnouncements();
        const stale = await findStaleAnnouncements();
        await getAllAnnouncements();
        const { untrackedMessages } = await checkChannelMessages();
        const { liveDiscordUsers } = await checkLiveStreamers();
        const { shouldHave, shouldNotHave } = await checkLiveRoleAssignments(liveDiscordUsers);

        // Ask for confirmation before cleanup
        console.log('\n=========================================');
        console.log('  CLEANUP SUMMARY');
        console.log('=========================================');
        console.log(`  Duplicate announcements to clean: ${duplicates.length}`);
        console.log(`  Stale announcements to clean: ${stale.length}`);
        console.log(`  Untracked messages to delete: ${untrackedMessages.length}`);
        console.log(`  Users to add live role: ${shouldHave.length}`);
        console.log(`  Users to remove live role: ${shouldNotHave.length}`);
        console.log('=========================================\n');

        // Check if --cleanup flag was passed
        if (process.argv.includes('--cleanup')) {
            console.log('[ACTION] Running cleanup...\n');

            await cleanupDuplicates(duplicates);
            await cleanupStaleAnnouncements(stale);
            await cleanupUntrackedMessages(untrackedMessages);
            await fixLiveRoles(shouldHave, shouldNotHave);

            console.log('\n[DONE] Cleanup complete!');
        } else {
            console.log('[INFO] Run with --cleanup flag to perform cleanup actions');
            console.log('       Example: node scripts/cleanup-server.js --cleanup');
        }

    } catch (error) {
        console.error('[ERROR]', error);
    } finally {
        if (client) client.destroy();
        if (pool) await pool.end();
    }
}

main();
