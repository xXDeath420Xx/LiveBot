/**
 * Cleanup Grow Polls from ALL custom bots
 * This runs through each custom bot and cleans up their polls
 */

import { Client, GatewayIntentBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import dotenv from 'dotenv';

dotenv.config();

const ALLOWED_GUILD_ID = '1452972683867459657';

// Keywords that indicate grow-related poll content
const GROW_KEYWORDS = [
    '🌿', 'weekly poll', 'growing', 'medium', 'soil', 'coco', 'hydro', 'dwc',
    'rockwool', 'tent', 'plant', 'veg', 'photos', 'autos', 'autoflower',
    'photoperiod', 'light type', 'led', 'hps', 'training', 'topping', 'lst',
    'scrog', 'nutrient', 'organic', 'indoor', 'outdoor', 'harvest', 'cure',
    'yield', 'strain', 'mason jar', 'grove bag', 'boveda'
];

function isGrowRelated(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return GROW_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

async function cleanupForBot(botId, botName, token) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`BOT: ${botName} (${botId})`);
    console.log('='.repeat(60));

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMembers
        ]
    });

    try {
        await client.login(token);
        console.log(`Logged in as: ${client.user.tag}`);

        // Fetch all guilds properly
        const guilds = await client.guilds.fetch();
        console.log(`Guilds: ${guilds.size}`);

        let foundCount = 0;
        let deletedCount = 0;

        for (const [guildId, partialGuild] of guilds) {
            // Skip the authorized guild
            if (guildId === ALLOWED_GUILD_ID) {
                console.log(`  SKIP (authorized): ${guildId}`);
                continue;
            }

            let guild;
            try {
                guild = await client.guilds.fetch(guildId);
                await guild.channels.fetch();
            } catch (err) {
                console.log(`  Cannot fetch ${guildId}: ${err.message}`);
                continue;
            }

            console.log(`\n  Checking: ${guild.name || guildId}`);

            const textChannels = guild.channels.cache.filter(c =>
                c.isTextBased() && !c.isVoiceBased() && !c.isThread()
            );

            for (const [channelId, channel] of textChannels) {
                try {
                    const messages = await channel.messages.fetch({ limit: 100 });

                    for (const [msgId, msg] of messages) {
                        if (msg.author.id !== client.user.id) continue;

                        let shouldDelete = false;
                        let reason = '';

                        // Check native poll
                        if (msg.poll) {
                            const q = msg.poll.question?.text || '';
                            if (isGrowRelated(q)) {
                                shouldDelete = true;
                                reason = q;
                            }
                        }

                        // Check embeds
                        for (const embed of msg.embeds) {
                            const t = (embed.title || '').toLowerCase();
                            const d = embed.description || '';
                            if (t.includes('poll') && isGrowRelated(d)) {
                                shouldDelete = true;
                                reason = embed.title;
                            }
                        }

                        if (shouldDelete) {
                            foundCount++;
                            console.log(`    FOUND: "${reason}" in #${channel.name}`);

                            try {
                                await msg.delete();
                                deletedCount++;
                                console.log(`      DELETED ✅`);
                            } catch (delErr) {
                                console.log(`      Delete failed: ${delErr.message}`);
                            }
                        }
                    }
                } catch {}
            }
        }

        console.log(`\nResults for ${botName}: Found ${foundCount}, Deleted ${deletedCount}`);
        await client.destroy();
        return { found: foundCount, deleted: deletedCount };
    } catch (err) {
        console.log(`Login failed: ${err.message}`);
        try { await client.destroy(); } catch {}
        return { found: 0, deleted: 0 };
    }
}

async function main() {
    console.log('CLEANING UP GROW POLLS FROM ALL BOTS');
    console.log('Authorized server:', ALLOWED_GUILD_ID);

    // Get all custom bots
    const [bots] = await pool.execute('SELECT bot_id, bot_name, bot_token FROM custom_bots WHERE enabled = 1');
    console.log(`Found ${bots.length} enabled custom bots`);

    let totalFound = 0;
    let totalDeleted = 0;

    // Clean up using main bot first
    console.log('\n--- MAIN BOT ---');
    const mainResult = await cleanupForBot(
        'main',
        'CertiFried Utility',
        process.env.DISCORD_TOKEN
    );
    totalFound += mainResult.found;
    totalDeleted += mainResult.deleted;

    // Clean up using each custom bot
    for (const bot of bots) {
        let token;
        try {
            token = encryption.decrypt(bot.bot_token);
        } catch (err) {
            console.log(`\nSkipping ${bot.bot_name} - couldn't decrypt token: ${err.message}`);
            continue;
        }
        if (!token) {
            console.log(`\nSkipping ${bot.bot_name} - empty token`);
            continue;
        }

        const result = await cleanupForBot(bot.bot_id, bot.bot_name, token);
        totalFound += result.found;
        totalDeleted += result.deleted;
    }

    console.log('\n' + '='.repeat(60));
    console.log('FINAL SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total grow polls found: ${totalFound}`);
    console.log(`Total grow polls deleted: ${totalDeleted}`);

    await pool.end();
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
