/**
 * Comprehensive Grow Poll Cleanup - Proper version
 * Fetches all guilds and channels before searching
 */

import { Client, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const ALLOWED_GUILD_ID = '1452972683867459657';

// Keywords that indicate grow-related poll content
const GROW_KEYWORDS = [
    '🌿', 'weekly poll', 'growing', 'medium', 'soil', 'coco', 'hydro', 'dwc',
    'rockwool', 'tent', 'plant', 'veg', 'photos', 'autos', 'autoflower',
    'photoperiod', 'light type', 'led', 'hps', 'hid', 'cmh', 'lec', 'sunlight',
    'training', 'topping', 'fim', 'lst', 'scrog', 'nutrient', 'organic',
    'indoor', 'outdoor', 'greenhouse', 'harvest', 'cure', 'yield', 'strain',
    'mason jar', 'grove bag', 'boveda'
];

function isGrowRelated(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return GROW_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

async function cleanup() {
    console.log('='.repeat(70));
    console.log('COMPREHENSIVE GROW POLL CLEANUP');
    console.log('='.repeat(70));
    console.log(`Authorized server (SKIP): ${ALLOWED_GUILD_ID}`);
    console.log('');

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMembers
        ]
    });

    await client.login(process.env.DISCORD_TOKEN);
    console.log(`Bot: ${client.user.tag} (${client.user.id})`);
    console.log(`Guilds in cache: ${client.guilds.cache.size}`);
    console.log('');

    let totalFound = 0;
    let totalDeleted = 0;
    const results = [];

    // Fetch all guilds properly
    const guilds = await client.guilds.fetch();
    console.log(`Fetched ${guilds.size} guilds\n`);

    for (const [guildId, partialGuild] of guilds) {
        if (guildId === ALLOWED_GUILD_ID) {
            console.log(`✅ SKIP (authorized): ${guildId}`);
            continue;
        }

        let guild;
        try {
            guild = await client.guilds.fetch(guildId);
            await guild.channels.fetch();
        } catch (err) {
            console.log(`❌ Cannot fetch guild ${guildId}: ${err.message}`);
            continue;
        }

        console.log(`\n🔍 ${guild.name} (${guildId})`);
        console.log(`   Channels: ${guild.channels.cache.size}`);

        const textChannels = guild.channels.cache.filter(c =>
            c.isTextBased() && !c.isVoiceBased() && !c.isThread()
        );

        for (const [channelId, channel] of textChannels) {
            try {
                const perms = channel.permissionsFor(guild.members.me);
                if (!perms?.has(PermissionFlagsBits.ViewChannel) ||
                    !perms?.has(PermissionFlagsBits.ReadMessageHistory)) {
                    continue;
                }

                const messages = await channel.messages.fetch({ limit: 100 });
                const botMessages = messages.filter(m => m.author.id === client.user.id);

                for (const [msgId, msg] of botMessages) {
                    let isGrowPoll = false;
                    let pollText = '';

                    // Check native poll
                    if (msg.poll) {
                        const qText = msg.poll.question?.text || '';
                        if (isGrowRelated(qText)) {
                            isGrowPoll = true;
                            pollText = qText;
                        }
                    }

                    // Check embeds
                    for (const embed of msg.embeds) {
                        const title = embed.title || '';
                        const desc = embed.description || '';

                        if ((title.toLowerCase().includes('poll') ||
                             title.toLowerCase().includes('community')) &&
                            isGrowRelated(desc)) {
                            isGrowPoll = true;
                            pollText = title;
                        }
                    }

                    if (isGrowPoll) {
                        totalFound++;
                        console.log(`   ❌ FOUND in #${channel.name}: "${pollText}"`);

                        const canDelete = perms?.has(PermissionFlagsBits.ManageMessages) ||
                                          msg.author.id === client.user.id;

                        if (canDelete) {
                            try {
                                await msg.delete();
                                totalDeleted++;
                                console.log(`      ✅ DELETED`);
                                results.push({
                                    guild: guild.name,
                                    channel: channel.name,
                                    poll: pollText,
                                    status: 'deleted'
                                });
                            } catch (delErr) {
                                console.log(`      ⚠️ Delete failed: ${delErr.message}`);
                                results.push({
                                    guild: guild.name,
                                    channel: channel.name,
                                    poll: pollText,
                                    status: `failed: ${delErr.message}`
                                });
                            }
                        } else {
                            console.log(`      ⚠️ No permission to delete`);
                            results.push({
                                guild: guild.name,
                                channel: channel.name,
                                poll: pollText,
                                status: 'no permission'
                            });
                        }
                    }
                }
            } catch (err) {
                // Skip channels we can't access
            }
        }
    }

    console.log('\n' + '='.repeat(70));
    console.log('FINAL SUMMARY');
    console.log('='.repeat(70));
    console.log(`Total grow polls found: ${totalFound}`);
    console.log(`Total grow polls deleted: ${totalDeleted}`);

    if (results.length > 0) {
        console.log('\nDetails:');
        for (const r of results) {
            console.log(`  ${r.guild} #${r.channel}: "${r.poll}" - ${r.status}`);
        }
    }

    await client.destroy();
    process.exit(0);
}

cleanup().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
