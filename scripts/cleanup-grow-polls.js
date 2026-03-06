/**
 * Cleanup Script: Remove Weekly Grow Polls from Unauthorized Servers
 *
 * This script finds and deletes any "Weekly Poll" messages related to growing
 * from ALL servers EXCEPT the authorized Growmie server.
 *
 * Authorized Server: 1452972683867459657
 * Authorized Bot: 1452969400620683276
 */

import { Client, GatewayIntentBits, Partials } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const ALLOWED_GUILD_ID = '1452972683867459657';

// Keywords that indicate grow-related poll content
const GROW_KEYWORDS = [
    'growing medium', 'soil', 'coco coir', 'hydro', 'dwc', 'rockwool',
    'tent', 'grow', 'plants', 'veg', 'photoperiod', 'autoflower', 'auto',
    'pests', 'nutrients', 'feeding', 'environment', 'training', 'topping',
    'fim', 'lst', 'scrog', 'organic', 'living soil', 'indoor', 'outdoor',
    'cure', 'harvest', 'mason jar', 'grove bag', 'boveda', 'yield', 'strains',
    'light type', 'led', 'hps', 'hid', 'cmh', 'lec', 'sunlight',
    '🌿 weekly poll', 'weekly poll', '🌱'
];

// Check if content is grow-related
function isGrowRelated(content) {
    if (!content) return false;
    const lower = content.toLowerCase();
    return GROW_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

async function cleanupGrowPolls() {
    console.log('='.repeat(60));
    console.log('GROW POLL CLEANUP SCRIPT');
    console.log('='.repeat(60));
    console.log(`Authorized Guild ID: ${ALLOWED_GUILD_ID}`);
    console.log('');

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent
        ],
        partials: [Partials.Message]
    });

    await client.login(process.env.DISCORD_TOKEN);
    console.log(`Logged in as ${client.user.tag}`);
    console.log('');

    let totalDeleted = 0;
    let totalFound = 0;
    const deletedMessages = [];

    for (const [guildId, guild] of client.guilds.cache) {
        // Skip the authorized guild
        if (guildId === ALLOWED_GUILD_ID) {
            console.log(`✅ SKIPPING authorized guild: ${guild.name} (${guildId})`);
            continue;
        }

        console.log(`\n🔍 Scanning guild: ${guild.name} (${guildId})`);

        for (const [channelId, channel] of guild.channels.cache) {
            if (!channel.isTextBased() || channel.isDMBased()) continue;

            try {
                // Check if we can read message history
                const perms = channel.permissionsFor(guild.members.me);
                if (!perms?.has('ReadMessageHistory') || !perms?.has('ManageMessages')) {
                    continue;
                }

                // Fetch recent messages (last 100)
                const messages = await channel.messages.fetch({ limit: 100 });

                for (const [msgId, msg] of messages) {
                    // Only check messages from this bot
                    if (msg.author.id !== client.user.id) continue;

                    // Check embeds
                    let shouldDelete = false;
                    let reason = '';

                    // Check for native polls
                    if (msg.poll) {
                        const pollQuestion = msg.poll.question?.text || '';
                        if (isGrowRelated(pollQuestion)) {
                            shouldDelete = true;
                            reason = `Native poll: "${pollQuestion}"`;
                        }
                    }

                    // Check embeds
                    for (const embed of msg.embeds) {
                        const title = embed.title || '';
                        const desc = embed.description || '';

                        if (title.toLowerCase().includes('weekly poll') ||
                            title.toLowerCase().includes('community poll')) {
                            if (isGrowRelated(desc) || isGrowRelated(title)) {
                                shouldDelete = true;
                                reason = `Embed poll: "${title}"`;
                            }
                        }
                    }

                    // Check message content
                    if (msg.content && isGrowRelated(msg.content)) {
                        if (msg.content.toLowerCase().includes('poll') ||
                            msg.content.toLowerCase().includes('weekly')) {
                            shouldDelete = true;
                            reason = `Message content contains grow poll keywords`;
                        }
                    }

                    if (shouldDelete) {
                        totalFound++;
                        console.log(`   ❌ FOUND grow poll in #${channel.name}: ${reason}`);
                        console.log(`      Message ID: ${msgId}`);
                        console.log(`      Created: ${msg.createdAt.toISOString()}`);

                        try {
                            await msg.delete();
                            totalDeleted++;
                            deletedMessages.push({
                                guild: guild.name,
                                guildId: guildId,
                                channel: channel.name,
                                channelId: channelId,
                                messageId: msgId,
                                reason: reason,
                                createdAt: msg.createdAt.toISOString()
                            });
                            console.log(`      ✅ DELETED`);
                        } catch (deleteError) {
                            console.log(`      ⚠️ Failed to delete: ${deleteError.message}`);
                        }
                    }
                }
            } catch (err) {
                // Silently skip channels we can't access
            }
        }
    }

    console.log('\n' + '='.repeat(60));
    console.log('CLEANUP SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total grow polls found: ${totalFound}`);
    console.log(`Total grow polls deleted: ${totalDeleted}`);

    if (deletedMessages.length > 0) {
        console.log('\nDeleted messages:');
        for (const dm of deletedMessages) {
            console.log(`  - ${dm.guild} (#${dm.channel}): ${dm.reason}`);
        }
    }

    console.log('\n✅ Cleanup complete!');
    await client.destroy();
    process.exit(0);
}

cleanupGrowPolls().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
