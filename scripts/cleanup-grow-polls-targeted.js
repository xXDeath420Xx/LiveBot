/**
 * Targeted Cleanup Script: Delete Weekly Grow Polls
 * Based on logs from 2025-12-28 18:11 UTC
 */

import { Client, GatewayIntentBits, Partials } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const ALLOWED_GUILD_ID = '1452972683867459657';

// Servers that received polls according to logs
const AFFECTED_SERVERS = [
    'sub_o',
    'Practice 1.0',
    "Sage's Test Server",
    "s5pades's Stinky Squad",
    'Yu chan Clab',
    'CertiFried™',
    'CreatorBridge⸸',
    'Bunny Burrow',
    '⁴²⁰𝑅𝑒𝑒𝒇𝑒𝓇 𝑅𝑒𝒶𝓁𝓂⁷¹⁰'
];

// Poll questions that were sent
const POLL_QUESTIONS = [
    "What's your preferred growing medium?",
    "Do you grow photos or autos?",
    "What size tent/space do you grow in?",
    "Indoor or outdoor grower?",
    "How many plants do you typically run?",
    "How do you cure your harvest?",
    "Favorite training technique?",
    "What's your grow priority?",
    "How long do you typically veg?",
    "What's your preferred light type?",
    "What's your biggest grow challenge?",
    "What nutrient line do you use?"
];

async function cleanup() {
    console.log('='.repeat(60));
    console.log('TARGETED GROW POLL CLEANUP');
    console.log('='.repeat(60));
    console.log('Looking for polls in unauthorized servers...\n');

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent
        ],
        partials: [Partials.Message]
    });

    await client.login(process.env.DISCORD_TOKEN);
    console.log(`Logged in as ${client.user.tag} (${client.user.id})`);
    console.log(`Total guilds: ${client.guilds.cache.size}\n`);

    let totalDeleted = 0;
    let totalFound = 0;

    for (const [guildId, guild] of client.guilds.cache) {
        // Skip the authorized guild
        if (guildId === ALLOWED_GUILD_ID) {
            console.log(`✅ SKIPPING authorized guild: ${guild.name}`);
            continue;
        }

        console.log(`\n🔍 Checking: ${guild.name} (${guildId})`);

        // Look for channels that might have polls
        const textChannels = guild.channels.cache.filter(c =>
            c.isTextBased() && !c.isDMBased()
        );

        for (const [channelId, channel] of textChannels) {
            try {
                const perms = channel.permissionsFor(guild.members.me);
                if (!perms?.has('ReadMessageHistory')) continue;

                // Fetch messages from today
                const messages = await channel.messages.fetch({ limit: 50 });
                const botMessages = messages.filter(m => m.author.id === client.user.id);

                for (const [msgId, msg] of botMessages) {
                    let isGrowPoll = false;
                    let pollQuestion = '';

                    // Check for native Discord poll
                    if (msg.poll) {
                        const qText = msg.poll.question?.text || '';
                        if (qText.includes('🌿') || qText.toLowerCase().includes('weekly poll')) {
                            for (const pq of POLL_QUESTIONS) {
                                if (qText.includes(pq)) {
                                    isGrowPoll = true;
                                    pollQuestion = qText;
                                    break;
                                }
                            }
                        }
                    }

                    // Check embeds
                    for (const embed of msg.embeds) {
                        const title = embed.title || '';
                        const desc = embed.description || '';
                        if (title.includes('Weekly Poll') || title.includes('Community Poll')) {
                            for (const pq of POLL_QUESTIONS) {
                                if (desc.includes(pq)) {
                                    isGrowPoll = true;
                                    pollQuestion = pq;
                                    break;
                                }
                            }
                        }
                    }

                    if (isGrowPoll) {
                        totalFound++;
                        console.log(`   ❌ FOUND: "${pollQuestion}" in #${channel.name}`);

                        try {
                            if (perms?.has('ManageMessages')) {
                                await msg.delete();
                                totalDeleted++;
                                console.log(`      ✅ DELETED`);
                            } else {
                                console.log(`      ⚠️ No permission to delete`);
                            }
                        } catch (delErr) {
                            console.log(`      ⚠️ Delete failed: ${delErr.message}`);
                        }
                    }
                }
            } catch (err) {
                // Skip inaccessible channels
            }
        }
    }

    console.log('\n' + '='.repeat(60));
    console.log('CLEANUP SUMMARY');
    console.log('='.repeat(60));
    console.log(`Grow polls found: ${totalFound}`);
    console.log(`Grow polls deleted: ${totalDeleted}`);
    console.log('');

    await client.destroy();
    process.exit(0);
}

cleanup().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
