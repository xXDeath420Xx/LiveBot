#!/usr/bin/env node
/**
 * One-time script: Clone #self-promo channel, auto-track qualifying streamers
 * from last 24h of messages, update DB references, and delete old channel.
 *
 * Guild: 985116833193553930
 * Bot: 1438889625388060723
 * Old Channel: 986744555481210920
 * Streamer Role: 992538724720181259
 *
 * Usage: node scripts/clone-self-promo-channel.js
 */

import 'dotenv/config';
import mysql from 'mysql2/promise';
import { Client, GatewayIntentBits } from 'discord.js';
import { parseStreamUrl } from '../utils/stream-url-parser.js';

const GUILD_ID = '985116833193553930';
const BOT_ID = '1438889625388060723';
const OLD_CHANNEL_ID = '986744555481210920';
const STREAMER_ROLE_ID = '992538724720181259';

async function main() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    // Get bot token
    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [BOT_ID]
    );

    if (bots.length === 0) {
        console.error('Custom bot not found:', BOT_ID);
        process.exit(1);
    }

    // Decrypt token
    const encMod = await import('../utils/encryption.js');
    const encryption = encMod.default;
    let token;
    try {
        const parsed = JSON.parse(bots[0].bot_token);
        token = encryption.decrypt(parsed);
    } catch {
        token = bots[0].bot_token;
    }

    // Log in
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ],
    });

    await client.login(token);
    await new Promise(resolve => client.once('ready', resolve));
    console.log(`Logged in as ${client.user.tag}`);

    const guild = await client.guilds.fetch(GUILD_ID);
    if (!guild) {
        console.error('Guild not found');
        process.exit(1);
    }

    // Fetch members so role checks work
    await guild.members.fetch();

    const oldChannel = await guild.channels.fetch(OLD_CHANNEL_ID);
    if (!oldChannel) {
        console.error('Old channel not found');
        process.exit(1);
    }
    console.log(`Old channel: #${oldChannel.name} (pos: ${oldChannel.position})`);

    // Fetch last 24h of messages
    const cutoff = Date.now() - (24 * 60 * 60 * 1000);
    const qualifyingMessages = [];
    let lastMessageId = undefined;
    let done = false;

    console.log('Fetching messages from last 24 hours...');

    while (!done) {
        const options = { limit: 100 };
        if (lastMessageId) options.before = lastMessageId;

        const messages = await oldChannel.messages.fetch(options);
        if (messages.size === 0) break;

        for (const msg of messages.values()) {
            if (msg.createdTimestamp < cutoff) {
                done = true;
                break;
            }

            // Skip bots
            if (msg.author.bot) continue;

            // Check for streamer role
            const member = guild.members.cache.get(msg.author.id);
            if (!member || !member.roles.cache.has(STREAMER_ROLE_ID)) continue;

            const parsed = parseStreamUrl(msg.content);
            if (parsed) {
                qualifyingMessages.push({
                    userId: msg.author.id,
                    userTag: msg.author.tag,
                    ...parsed
                });
            }
        }

        lastMessageId = messages.last()?.id;
        if (messages.size < 100) break;
    }

    console.log(`Found ${qualifyingMessages.length} qualifying messages from streamers`);

    // Auto-track each qualifying user
    let tracked = 0;
    for (const msg of qualifyingMessages) {
        try {
            // Check if streamer already exists (by platform_user_id OR username)
            const [existing] = await pool.execute(
                'SELECT streamer_id FROM streamers WHERE platform = ? AND (platform_user_id = ? OR LOWER(username) = LOWER(?))',
                [msg.platform, msg.username, msg.username]
            );

            let streamerId;
            if (existing.length > 0) {
                streamerId = existing[0].streamer_id;
            } else {
                const [result] = await pool.execute(
                    'INSERT INTO streamers (platform, platform_user_id, username, discord_user_id) VALUES (?, ?, ?, ?)',
                    [msg.platform, msg.username, msg.username, msg.userId]
                );
                streamerId = result.insertId;
                console.log(`  Created streamer: ${msg.platform}/${msg.username} (${msg.userTag})`);
            }

            // Check if subscription exists for this guild
            const [existingSub] = await pool.execute(
                'SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ?',
                [GUILD_ID, streamerId]
            );

            if (existingSub.length === 0) {
                // Will use placeholder channel ID; updated below after clone
                await pool.execute(
                    'INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, delete_on_end) VALUES (?, ?, ?, 1)',
                    [GUILD_ID, streamerId, OLD_CHANNEL_ID]
                );
                tracked++;
                console.log(`  Tracked: ${msg.platform}/${msg.username} -> ${msg.userTag}`);
            } else {
                // Subscription exists - update it to point to self-promo channel
                await pool.execute(
                    'UPDATE subscriptions SET announcement_channel_id = ?, delete_on_end = 1 WHERE subscription_id = ?',
                    [OLD_CHANNEL_ID, existingSub[0].subscription_id]
                );
                tracked++;
                console.log(`  Updated existing sub: ${msg.platform}/${msg.username} -> ${msg.userTag}`);
            }
        } catch (error) {
            console.error(`  Error tracking ${msg.platform}/${msg.username}:`, error.message);
        }
    }

    console.log(`\nTracked ${tracked} new streamers`);

    // Clone the channel
    const newChannel = await oldChannel.clone({
        reason: 'Self-promo channel overhaul: recreating channel for auto-track system'
    });
    console.log(`New channel created: ${newChannel.id} (#${newChannel.name})`);

    // Move to same position
    await newChannel.setPosition(oldChannel.position).catch(() => {});

    // Update DB references: subscriptions pointing to old channel
    const [subResult] = await pool.execute(
        'UPDATE subscriptions SET announcement_channel_id = ? WHERE announcement_channel_id = ? AND guild_id = ?',
        [newChannel.id, OLD_CHANNEL_ID, GUILD_ID]
    );
    console.log(`Updated ${subResult.affectedRows} subscription(s) to new channel`);

    // Update DB references: live_announcements pointing to old channel
    const [laResult] = await pool.execute(
        'UPDATE live_announcements SET channel_id = ? WHERE channel_id = ? AND guild_id = ?',
        [newChannel.id, OLD_CHANNEL_ID, GUILD_ID]
    );
    console.log(`Updated ${laResult.affectedRows} live_announcement(s) to new channel`);

    // Delete old channel
    await oldChannel.delete('Self-promo channel overhaul: replaced with clean channel');
    console.log(`Old channel ${OLD_CHANNEL_ID} deleted`);

    console.log('\n=== Summary ===');
    console.log(`Old channel: ${OLD_CHANNEL_ID} (deleted)`);
    console.log(`New channel: ${newChannel.id}`);
    console.log(`Streamers tracked: ${tracked}`);
    console.log(`\n>>> UPDATE SELF_PROMO_CHANNEL_ID in core/self-promo-handler.js to: ${newChannel.id}`);

    await pool.end();
    client.destroy();
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
