/**
 * Delete specific poll message and search all channels more thoroughly
 */

import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const ALLOWED_GUILD_ID = '1452972683867459657';

// Known poll messages to delete
const KNOWN_POLLS = [
    { guildId: '1396733259357880340', messageId: '1454899556750852116' }
];

async function deletePolls() {
    console.log('='.repeat(60));
    console.log('DELETING SPECIFIC POLL MESSAGES');
    console.log('='.repeat(60));

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent
        ]
    });

    await client.login(process.env.DISCORD_TOKEN);
    console.log(`Logged in as: ${client.user.tag} (${client.user.id})`);
    console.log('');

    // First, delete the known poll messages
    console.log('--- Deleting Known Poll Messages ---');
    for (const poll of KNOWN_POLLS) {
        const guild = client.guilds.cache.get(poll.guildId);
        if (!guild) {
            console.log(`Guild ${poll.guildId} not found`);
            continue;
        }

        console.log(`Looking for message ${poll.messageId} in ${guild.name || poll.guildId}`);

        // Search all text channels for the message
        for (const [channelId, channel] of guild.channels.cache) {
            if (!channel.isTextBased()) continue;

            try {
                const msg = await channel.messages.fetch(poll.messageId);
                if (msg) {
                    console.log(`  Found in #${channel.name}`);
                    console.log(`  Author: ${msg.author.tag}`);
                    console.log(`  Content: ${msg.content?.substring(0, 100) || 'No content'}`);
                    console.log(`  Has poll: ${!!msg.poll}`);

                    if (msg.poll) {
                        console.log(`  Poll question: ${msg.poll.question?.text}`);
                    }

                    try {
                        await msg.delete();
                        console.log(`  DELETED ✅`);
                    } catch (delErr) {
                        console.log(`  Failed to delete: ${delErr.message}`);
                    }
                    break;
                }
            } catch (err) {
                // Message not in this channel
            }
        }
    }

    // Now search ALL channels in ALL unauthorized guilds
    console.log('\n--- Comprehensive Search of All Channels ---');
    let totalFound = 0;
    let totalDeleted = 0;

    for (const [guildId, guild] of client.guilds.cache) {
        if (guildId === ALLOWED_GUILD_ID) {
            console.log(`\nSKIP (authorized): ${guild.name || guildId}`);
            continue;
        }

        console.log(`\nSearching: ${guild.name || guildId} (${guildId})`);

        for (const [channelId, channel] of guild.channels.cache) {
            if (!channel.isTextBased()) continue;

            try {
                // Fetch more messages this time
                const messages = await channel.messages.fetch({ limit: 100 });
                const botMsgs = messages.filter(m => m.author.id === client.user.id);

                if (botMsgs.size > 0) {
                    console.log(`  #${channel.name}: ${botMsgs.size} bot messages`);
                }

                for (const [msgId, msg] of botMsgs) {
                    let isGrowPoll = false;
                    let pollInfo = '';

                    // Check for poll
                    if (msg.poll) {
                        const qText = msg.poll.question?.text || '';
                        pollInfo = qText;

                        // Check for grow-related content
                        const lower = qText.toLowerCase();
                        if (lower.includes('🌿') ||
                            lower.includes('weekly poll') ||
                            lower.includes('growing') ||
                            lower.includes('medium') ||
                            lower.includes('soil') ||
                            lower.includes('coco') ||
                            lower.includes('hydro') ||
                            lower.includes('tent') ||
                            lower.includes('plant') ||
                            lower.includes('veg') ||
                            lower.includes('photos') ||
                            lower.includes('autos') ||
                            lower.includes('autoflower') ||
                            lower.includes('photoperiod') ||
                            lower.includes('light type') ||
                            lower.includes('led') ||
                            lower.includes('hps') ||
                            lower.includes('training') ||
                            lower.includes('topping') ||
                            lower.includes('lst') ||
                            lower.includes('scrog') ||
                            lower.includes('nutrient') ||
                            lower.includes('organic') ||
                            lower.includes('indoor') ||
                            lower.includes('outdoor') ||
                            lower.includes('harvest') ||
                            lower.includes('cure') ||
                            lower.includes('yield') ||
                            lower.includes('strain')) {
                            isGrowPoll = true;
                        }
                    }

                    // Check embeds
                    for (const embed of msg.embeds) {
                        const title = (embed.title || '').toLowerCase();
                        const desc = (embed.description || '').toLowerCase();

                        if ((title.includes('poll') || title.includes('community')) &&
                            (desc.includes('grow') || desc.includes('medium') || desc.includes('soil') ||
                             desc.includes('plant') || desc.includes('harvest'))) {
                            isGrowPoll = true;
                            pollInfo = embed.title || '';
                        }
                    }

                    if (isGrowPoll) {
                        totalFound++;
                        console.log(`    FOUND GROW POLL: "${pollInfo}"`);
                        console.log(`      Message ID: ${msgId}`);

                        try {
                            await msg.delete();
                            totalDeleted++;
                            console.log(`      DELETED ✅`);
                        } catch (delErr) {
                            console.log(`      Delete failed: ${delErr.message}`);
                        }
                    }
                }
            } catch (err) {
                // Skip inaccessible channels
            }
        }
    }

    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));
    console.log(`Grow polls found: ${totalFound}`);
    console.log(`Grow polls deleted: ${totalDeleted}`);

    await client.destroy();
    process.exit(0);
}

deletePolls().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
