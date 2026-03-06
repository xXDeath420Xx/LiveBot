/**
 * Check what the bot can access in a specific guild
 */

import { Client, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const TARGET_GUILD = '1396733259357880340';
const TARGET_MESSAGE = '1454899556750852116';

async function check() {
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

    // Fetch the guild with full data
    let guild;
    try {
        guild = await client.guilds.fetch(TARGET_GUILD);
        // Also fetch channels
        await guild.channels.fetch();
    } catch (err) {
        console.log(`Failed to fetch guild: ${err.message}`);
        guild = client.guilds.cache.get(TARGET_GUILD);
    }
    if (!guild) {
        console.log(`Guild ${TARGET_GUILD} NOT FOUND in cache`);
        console.log(`Available guilds: ${client.guilds.cache.map(g => g.id).join(', ')}`);
        await client.destroy();
        process.exit(1);
    }

    console.log(`Guild found: ${guild.name || guild.id}`);
    console.log(`Member count: ${guild.memberCount}`);
    console.log(`Channels: ${guild.channels.cache.size}`);

    // List all text channels
    console.log('\nText channels:');
    const textChannels = guild.channels.cache.filter(c => c.isTextBased() && !c.isVoiceBased());

    for (const [id, ch] of textChannels) {
        const perms = ch.permissionsFor(guild.members.me);
        const canRead = perms?.has(PermissionFlagsBits.ViewChannel);
        const canReadHistory = perms?.has(PermissionFlagsBits.ReadMessageHistory);
        const canManage = perms?.has(PermissionFlagsBits.ManageMessages);

        console.log(`  #${ch.name} (${id})`);
        console.log(`    View: ${canRead}, History: ${canReadHistory}, Manage: ${canManage}`);

        if (canRead && canReadHistory) {
            // Try to fetch the specific message
            try {
                const msg = await ch.messages.fetch(TARGET_MESSAGE);
                console.log(`    *** FOUND TARGET MESSAGE ***`);
                console.log(`    Author: ${msg.author.tag}`);
                console.log(`    Has poll: ${!!msg.poll}`);
                if (msg.poll) {
                    console.log(`    Poll: ${msg.poll.question?.text}`);
                }

                // Try to delete it
                if (canManage || msg.author.id === client.user.id) {
                    try {
                        await msg.delete();
                        console.log(`    DELETED SUCCESSFULLY!`);
                    } catch (delErr) {
                        console.log(`    Delete failed: ${delErr.message}`);
                    }
                }
            } catch {
                // Not in this channel
            }
        }
    }

    await client.destroy();
    process.exit(0);
}

check().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
