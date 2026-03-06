#!/usr/bin/env node
/**
 * One-time backfill: Cross-pollinate existing tracked streamers.
 *
 * Logs in the default bot + custom bots, then for each streamer with
 * a discord_user_id, checks which guilds they're a member of via
 * guild.members.fetch() (REST API), and creates subscriptions for
 * guilds that have announcement channels configured.
 *
 * Usage:  node scripts/backfill-cross-pollinate.js [--dry-run]
 */

import 'dotenv/config';
import mysql from 'mysql2/promise';
import { Client, GatewayIntentBits } from 'discord.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    // Log in default bot
    console.log('Logging in default bot...');
    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    });
    await client.login(process.env.DISCORD_TOKEN);
    await new Promise(resolve => {
        if (client.isReady()) return resolve();
        client.once('ready', resolve);
    });
    console.log(`Default bot ready: ${client.user.tag} (${client.guilds.cache.size} guilds)`);

    // Log in custom bots
    let encryption;
    try {
        const mod = await import('../utils/encryption.js');
        encryption = mod.default;
    } catch (e) {
        console.warn('Could not import encryption:', e.message);
    }

    const [customBots] = await pool.execute(
        'SELECT bot_id, bot_token, bot_name FROM custom_bots WHERE approved = 1 AND enabled = 1'
    );

    const extraClients = [];
    for (const bot of customBots) {
        try {
            let token = bot.bot_token;
            if (encryption) {
                try {
                    const parsed = JSON.parse(token);
                    token = encryption.decrypt(parsed);
                } catch {
                    // token might not be encrypted
                }
            }
            const c = new Client({
                intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
            });
            await c.login(token);
            await new Promise(resolve => {
                if (c.isReady()) return resolve();
                c.once('ready', resolve);
            });
            console.log(`  Custom bot ${bot.bot_name} ready (${c.guilds.cache.size} guilds)`);
            extraClients.push(c);
        } catch (e) {
            console.warn(`  Failed to login ${bot.bot_name}: ${e.message}`);
        }
    }

    const allClients = [client, ...extraClients];

    // Build a map of all unique guilds across all bots -> { guildId: guildObj }
    const allGuilds = new Map();
    for (const c of allClients) {
        for (const [guildId, guild] of c.guilds.cache) {
            if (!allGuilds.has(guildId)) allGuilds.set(guildId, guild);
        }
    }
    console.log(`Total unique guilds across all bots: ${allGuilds.size}`);

    try {
        // Get streamers with discord_user_id
        const [streamers] = await pool.execute(
            'SELECT streamer_id, username, discord_user_id FROM streamers WHERE discord_user_id IS NOT NULL'
        );
        console.log(`Streamers with Discord IDs: ${streamers.length}`);

        // Get guilds with announcement channels
        const [guildsWithAnn] = await pool.execute(
            `SELECT guild_id, announcement_channel_id FROM guilds
             WHERE announcement_channel_id IS NOT NULL AND announcement_channel_id != ''`
        );
        const annMap = new Map(guildsWithAnn.map(g => [g.guild_id, g.announcement_channel_id]));
        console.log(`Guilds with announcements: ${guildsWithAnn.length} (${[...annMap.keys()].join(', ')})\n`);

        // Preload existing subscriptions
        const [existingSubs] = await pool.execute('SELECT guild_id, streamer_id FROM subscriptions');
        const subSet = new Set(existingSubs.map(s => `${s.guild_id}:${s.streamer_id}`));

        let created = 0;
        let apiCalls = 0;

        // Deduplicate by discord_user_id — multiple streamer records may share one
        const userStreamers = new Map(); // discord_user_id -> [{ streamer_id, username }]
        for (const s of streamers) {
            if (!userStreamers.has(s.discord_user_id)) userStreamers.set(s.discord_user_id, []);
            userStreamers.get(s.discord_user_id).push(s);
        }
        console.log(`Unique Discord users: ${userStreamers.size}\n`);

        for (const [discordUserId, streamerRecords] of userStreamers) {
            // For each guild with announcements, check if user is a member
            for (const [guildId, channelId] of annMap) {
                // Check if ALL streamer records for this user already have subs in this guild
                const allHaveSubs = streamerRecords.every(s => subSet.has(`${guildId}:${s.streamer_id}`));
                if (allHaveSubs) continue;

                // Check guild membership via API
                const guild = allGuilds.get(guildId);
                if (!guild) continue;

                let isMember = false;
                try {
                    apiCalls++;
                    await guild.members.fetch(discordUserId);
                    isMember = true;
                } catch {
                    // Not a member (404) or other error — skip
                }

                if (!isMember) continue;

                // Create subscriptions for all streamer records of this user in this guild
                for (const { streamer_id, username } of streamerRecords) {
                    const key = `${guildId}:${streamer_id}`;
                    if (subSet.has(key)) continue;

                    if (!DRY_RUN) {
                        await pool.execute(
                            'INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)',
                            [guildId, streamer_id, channelId]
                        );
                    }
                    subSet.add(key);
                    created++;
                    console.log(`  ${DRY_RUN ? '[DRY] ' : ''}${username} (${streamer_id}) -> guild ${guildId}`);
                }
            }
        }

        console.log(`\n--- Summary ---`);
        console.log(`Unique users checked: ${userStreamers.size}`);
        console.log(`API membership checks: ${apiCalls}`);
        console.log(`New subscriptions ${DRY_RUN ? 'would be ' : ''}created: ${created}`);

    } finally {
        client.destroy();
        for (const c of extraClients) c.destroy();
        await pool.end();
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
