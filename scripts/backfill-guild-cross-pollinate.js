#!/usr/bin/env node
/**
 * One-time backfill: Cross-pollinate existing streamers into all guilds
 * that have announcement channels configured.
 *
 * Logs in default bot + all custom bots, then for each guild with an
 * announcement_channel_id, checks all tracked streamers with discord_user_ids
 * for membership via REST API.
 *
 * Usage: node scripts/backfill-guild-cross-pollinate.js
 */

import 'dotenv/config';
import mysql from 'mysql2/promise';
import { Client, GatewayIntentBits } from 'discord.js';

async function main() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    // Get all guilds with announcement channels
    const [guilds] = await pool.execute(
        "SELECT guild_id, announcement_channel_id FROM guilds WHERE announcement_channel_id IS NOT NULL AND announcement_channel_id != ''"
    );
    console.log(`Found ${guilds.length} guild(s) with announcement channels`);

    // Get all streamers with discord_user_ids
    const [streamers] = await pool.execute(
        'SELECT streamer_id, username, platform, discord_user_id FROM streamers WHERE discord_user_id IS NOT NULL'
    );
    console.log(`Found ${streamers.length} streamer(s) with Discord user IDs`);

    // Deduplicate by discord_user_id
    const uniqueUsers = new Map();
    for (const s of streamers) {
        if (!uniqueUsers.has(s.discord_user_id)) {
            uniqueUsers.set(s.discord_user_id, []);
        }
        uniqueUsers.get(s.discord_user_id).push(s);
    }
    console.log(`${uniqueUsers.size} unique Discord user(s) to check\n`);

    // Log in default bot
    console.log('Logging in default bot...');
    const defaultClient = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    });
    await defaultClient.login(process.env.DISCORD_TOKEN);
    await new Promise(resolve => defaultClient.once('ready', resolve));
    console.log(`Default bot online: ${defaultClient.user.tag}`);

    // Log in custom bots
    const clients = new Map();
    clients.set('default', defaultClient);

    const [customBots] = await pool.execute('SELECT bot_id, bot_token FROM custom_bots');
    const encMod = await import('../utils/encryption.js');
    const encryption = encMod.default;

    for (const bot of customBots) {
        try {
            let token;
            try {
                const parsed = JSON.parse(bot.bot_token);
                token = encryption.decrypt(parsed);
            } catch {
                token = bot.bot_token;
            }
            const client = new Client({
                intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
            });
            await client.login(token);
            await new Promise(resolve => client.once('ready', resolve));
            clients.set(bot.bot_id, client);
            console.log(`Custom bot online: ${client.user.tag}`);
        } catch (err) {
            console.error(`Failed to login bot ${bot.bot_id}: ${err.message}`);
        }
    }

    // For each guild, find the bot that serves it and check membership
    let totalCreated = 0;
    let totalChecked = 0;

    for (const { guild_id, announcement_channel_id } of guilds) {
        // Find a client that has this guild
        let guild = null;
        for (const [, client] of clients) {
            const g = client.guilds.cache.get(guild_id);
            if (g) { guild = g; break; }
        }

        if (!guild) {
            console.log(`\n[${guild_id}] Not found in any bot — skipping`);
            continue;
        }

        console.log(`\n[${guild_id}] ${guild.name} — checking members...`);
        let guildCreated = 0;

        for (const [discordUserId, userStreamers] of uniqueUsers) {
            totalChecked++;
            const isMember = await guild.members.fetch(discordUserId).then(() => true).catch(() => false);
            if (!isMember) continue;

            for (const streamer of userStreamers) {
                const [existing] = await pool.execute(
                    'SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ?',
                    [guild_id, streamer.streamer_id]
                );

                if (existing.length === 0) {
                    await pool.execute(
                        'INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)',
                        [guild_id, streamer.streamer_id, announcement_channel_id]
                    );
                    guildCreated++;
                    totalCreated++;
                    console.log(`  + ${streamer.username} (${streamer.platform})`);
                }
            }
        }

        console.log(`  => ${guildCreated} new subscription(s)`);
    }

    console.log(`\n=== Summary ===`);
    console.log(`Guilds processed: ${guilds.length}`);
    console.log(`Membership checks: ${totalChecked}`);
    console.log(`New subscriptions: ${totalCreated}`);

    // Cleanup
    for (const [, client] of clients) {
        client.destroy();
    }
    await pool.end();
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
