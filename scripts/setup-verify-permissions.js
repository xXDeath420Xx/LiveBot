/**
 * Set up permissions so new users only see rules channel until verified
 */

import { Client, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';

async function main() {
    console.log('🔒 Setting up verification permissions...\n');

    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [BOT_ID]
    );

    const decryptedToken = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [GatewayIntentBits.Guilds]
    });

    client.once('ready', async () => {
        console.log(`✅ Logged in as ${client.user.tag}`);

        const guild = client.guilds.cache.get(GUILD_ID);

        const rulesChannel = guild.channels.cache.find(c => c.name === '📜-rules');
        const verifiedRole = guild.roles.cache.find(r => r.name.includes('Verified Growmie'));
        const newSeedRole = guild.roles.cache.find(r => r.name.includes('New Seed'));
        const everyoneRole = guild.roles.everyone;

        console.log(`📜 Rules channel: ${rulesChannel?.name}`);
        console.log(`🌱 Verified role: ${verifiedRole?.name}`);
        console.log(`🌰 New Seed role: ${newSeedRole?.name}`);

        // Set rules channel permissions - everyone can see and read, but not send
        if (rulesChannel) {
            await rulesChannel.permissionOverwrites.set([
                {
                    id: everyoneRole.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
                    deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions].filter(p => p !== PermissionFlagsBits.AddReactions)
                },
                {
                    id: everyoneRole.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AddReactions],
                    deny: [PermissionFlagsBits.SendMessages]
                }
            ]);
            console.log('✅ Rules channel: Everyone can view + react, cannot send');
        }

        // Hide ALL other channels from @everyone, show only to Verified Growmie
        let updated = 0;
        for (const [id, channel] of guild.channels.cache) {
            if (channel.id === rulesChannel?.id) continue; // Skip rules channel
            if (!channel.isTextBased() && !channel.isVoiceBased()) continue;

            // Check if it's a staff channel
            const isStaffChannel = channel.name.includes('staff') ||
                                   channel.name.includes('mod-logs') ||
                                   channel.name.includes('reports');

            try {
                if (isStaffChannel) {
                    // Staff channels - hide from everyone including verified
                    // (Staff roles should already have access from category permissions)
                    continue;
                }

                // Regular channels - hide from @everyone, show to verified
                await channel.permissionOverwrites.edit(everyoneRole, {
                    ViewChannel: false
                });

                if (verifiedRole) {
                    await channel.permissionOverwrites.edit(verifiedRole, {
                        ViewChannel: true,
                        SendMessages: true,
                        ReadMessageHistory: true
                    });
                }
                updated++;
            } catch (e) {
                // Skip channels we can't edit (categories handled separately)
            }
        }

        console.log(`✅ Updated ${updated} channels - hidden from unverified users`);

        // Also update category permissions
        for (const [id, channel] of guild.channels.cache) {
            if (channel.type !== 4) continue; // Only categories
            if (channel.name.includes('STAFF')) continue; // Skip staff category
            if (channel.name.includes('WELCOME')) {
                // Welcome category - special handling
                await channel.permissionOverwrites.edit(everyoneRole, {
                    ViewChannel: false
                });
                if (verifiedRole) {
                    await channel.permissionOverwrites.edit(verifiedRole, {
                        ViewChannel: true
                    });
                }
                continue;
            }

            try {
                await channel.permissionOverwrites.edit(everyoneRole, {
                    ViewChannel: false
                });
                if (verifiedRole) {
                    await channel.permissionOverwrites.edit(verifiedRole, {
                        ViewChannel: true
                    });
                }
            } catch (e) {}
        }

        // Make sure rules channel is visible to everyone
        if (rulesChannel) {
            await rulesChannel.permissionOverwrites.edit(everyoneRole, {
                ViewChannel: true,
                ReadMessageHistory: true,
                AddReactions: true,
                SendMessages: false
            });
            console.log('✅ Rules channel permissions finalized');
        }

        console.log('\n🎉 Done! New users will only see #📜-rules until they verify.');

        client.destroy();
        process.exit(0);
    });

    await client.login(decryptedToken);
}

main().catch(console.error);
