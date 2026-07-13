/**
 * Retroactive Orientation Post Script
 * Posts the orientation/guide message to all guilds that don't have one yet.
 * Logs in as main bot + all custom bots, skips YYZ Studio (961514092848382043).
 *
 * Usage: node scripts/post-orientation-all-guilds.js [--dry-run]
 */

import { Client, GatewayIntentBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import { postOrientationMessage, findSuitableChannel } from '../core/orientation-manager.js';
import dotenv from 'dotenv';

dotenv.config();

const SKIP_GUILDS = new Set(['961514092848382043']); // YYZ Studio
const DRY_RUN = process.argv.includes('--dry-run');
const DELAY_MS = 1500; // Rate limit safety

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function postForClient(client, label) {
    const guilds = client.guilds.cache;
    let posted = 0, skipped = 0, failed = 0, alreadyHas = 0;

    console.log(`\n[${ label }] Processing ${guilds.size} guild(s)...`);

    for (const [guildId, guild] of guilds) {
        if (SKIP_GUILDS.has(guildId)) {
            console.log(`  SKIP (excluded): ${guild.name} (${guildId})`);
            skipped++;
            continue;
        }

        // Check if already has orientation
        const [existing] = await pool.execute(
            'SELECT message_id FROM orientation_config WHERE guild_id = ?',
            [guildId]
        );
        if (existing.length > 0 && existing[0].message_id) {
            console.log(`  ALREADY HAS: ${guild.name} (${guildId})`);
            alreadyHas++;
            continue;
        }

        // Fetch channels (not cached on fresh login)
        try {
            await guild.channels.fetch();
        } catch (error) {
            console.log(`  FETCH FAILED: ${guild.name} (${guildId}) — ${error.message}`);
            failed++;
            continue;
        }

        const channel = findSuitableChannel(guild);
        if (!channel) {
            console.log(`  NO CHANNEL: ${guild.name} (${guildId}) — no suitable text channel found`);
            failed++;
            continue;
        }

        if (DRY_RUN) {
            console.log(`  DRY RUN: Would post in ${guild.name} → #${channel.name}`);
            posted++;
            continue;
        }

        try {
            await postOrientationMessage(client, guildId, channel.id);
            console.log(`  POSTED: ${guild.name} → #${channel.name}`);
            posted++;
            await sleep(DELAY_MS);
        } catch (error) {
            console.log(`  FAILED: ${guild.name} (${guildId}) — ${error.message}`);
            failed++;
        }
    }

    console.log(`\n[${label}] Results: ${posted} posted, ${alreadyHas} already had, ${skipped} skipped, ${failed} failed`);
    return { posted, skipped, failed, alreadyHas };
}

async function main() {
    console.log(`=== Orientation Retroactive Post${DRY_RUN ? ' (DRY RUN)' : ''} ===\n`);

    const totals = { posted: 0, skipped: 0, failed: 0, alreadyHas: 0 };
    const clients = [];

    // 1. Main bot
    const mainClient = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
    });
    await mainClient.login(process.env.DISCORD_TOKEN);
    console.log(`Main bot logged in: ${mainClient.user.tag}`);
    clients.push(mainClient);

    const mainResult = await postForClient(mainClient, 'Main Bot');
    Object.keys(totals).forEach(k => totals[k] += mainResult[k]);

    // 2. Custom bots
    const [customBots] = await pool.execute(
        'SELECT bot_id, bot_name, bot_token FROM custom_bots WHERE enabled = 1'
    );

    for (const bot of customBots) {
        let token;
        try {
            token = encryption.decrypt(JSON.parse(bot.bot_token));
        } catch (error) {
            console.log(`\n[${bot.bot_name}] Failed to decrypt token: ${error.message}`);
            continue;
        }

        const customClient = new Client({
            intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
        });

        try {
            await customClient.login(token);
            console.log(`\nCustom bot logged in: ${customClient.user.tag} (${bot.bot_id})`);
            clients.push(customClient);

            const result = await postForClient(customClient, bot.bot_name);
            Object.keys(totals).forEach(k => totals[k] += result[k]);
        } catch (error) {
            console.log(`\n[${bot.bot_name}] Login failed: ${error.message}`);
        }
    }

    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('TOTALS:');
    console.log(`  Posted: ${totals.posted}`);
    console.log(`  Already had: ${totals.alreadyHas}`);
    console.log(`  Skipped: ${totals.skipped}`);
    console.log(`  Failed: ${totals.failed}`);

    // Cleanup
    for (const client of clients) {
        client.destroy();
    }

    await pool.end();
    process.exit(0);
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
