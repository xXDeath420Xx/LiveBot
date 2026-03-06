/**
 * Find and Delete Grow Polls
 * More thorough search for native Discord polls
 */

import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const ALLOWED_GUILD_ID = '1452972683867459657';

async function findAndDelete() {
    console.log('='.repeat(60));
    console.log('GROW POLL FINDER AND DELETER');
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

    let totalFound = 0;
    let totalDeleted = 0;

    // List all guilds with their actual names
    console.log(`\nGuilds the bot is in:`);
    for (const [guildId, guild] of client.guilds.cache) {
        // Try to fetch the guild to get the name
        try {
            const fetchedGuild = await client.guilds.fetch(guildId);
            console.log(`  - ${fetchedGuild.name} (${guildId})${guildId === ALLOWED_GUILD_ID ? ' [AUTHORIZED - SKIP]' : ''}`);
        } catch {
            console.log(`  - [Unknown] (${guildId})`);
        }
    }

    console.log('\nSearching for grow-related polls...\n');

    for (const [guildId, guild] of client.guilds.cache) {
        if (guildId === ALLOWED_GUILD_ID) continue;

        let guildName = 'Unknown';
        try {
            const g = await client.guilds.fetch(guildId);
            guildName = g.name;
        } catch {}

        console.log(`\n--- ${guildName} (${guildId}) ---`);

        for (const [channelId, channel] of guild.channels.cache) {
            if (!channel.isTextBased()) continue;

            try {
                const messages = await channel.messages.fetch({ limit: 100 });

                for (const [msgId, msg] of messages) {
                    // Only check bot's own messages
                    if (msg.author.id !== client.user.id) continue;

                    let isPollToDelete = false;
                    let reason = '';

                    // Check for native poll
                    if (msg.poll) {
                        const qText = msg.poll.question?.text?.toLowerCase() || '';
                        if (qText.includes('weekly poll') ||
                            qText.includes('grow') ||
                            qText.includes('🌿') ||
                            qText.includes('plant') ||
                            qText.includes('tent') ||
                            qText.includes('veg') ||
                            qText.includes('autoflower') ||
                            qText.includes('hydro') ||
                            qText.includes('soil') ||
                            qText.includes('coco') ||
                            qText.includes('harvest') ||
                            qText.includes('cure') ||
                            qText.includes('indoor') ||
                            qText.includes('outdoor')) {
                            isPollToDelete = true;
                            reason = msg.poll.question?.text || 'Native poll';
                        }
                    }

                    // Check embeds
                    for (const embed of msg.embeds) {
                        const title = (embed.title || '').toLowerCase();
                        const desc = (embed.description || '').toLowerCase();

                        if (title.includes('weekly poll') || title.includes('community poll')) {
                            if (desc.includes('grow') || desc.includes('plant') ||
                                desc.includes('soil') || desc.includes('hydro') ||
                                desc.includes('veg') || desc.includes('harvest')) {
                                isPollToDelete = true;
                                reason = embed.title || 'Embed poll';
                            }
                        }
                    }

                    if (isPollToDelete) {
                        totalFound++;
                        console.log(`  FOUND in #${channel.name}: "${reason}"`);
                        console.log(`    Message: https://discord.com/channels/${guildId}/${channelId}/${msgId}`);
                        console.log(`    Created: ${msg.createdAt.toISOString()}`);

                        try {
                            await msg.delete();
                            totalDeleted++;
                            console.log(`    STATUS: DELETED ✅`);
                        } catch (err) {
                            console.log(`    STATUS: Failed to delete - ${err.message}`);
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
    console.log(`Total polls found: ${totalFound}`);
    console.log(`Total polls deleted: ${totalDeleted}`);

    await client.destroy();
    process.exit(0);
}

findAndDelete().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
