/**
 * Fix Growmie server permissions and set up marketplace
 *
 * 1. Ensure New Seed / @everyone only sees rules channel
 * 2. Set up marketplace with trader role requirements
 * 3. Verify reaction role setup
 */

import { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType, EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';
const RULES_CHANNEL_ID = '1452977946217418826';
const INTRO_CHANNEL_ID = '1452977953376960585';
const MARKETPLACE_RULES_CHANNEL_ID = '1452977991440269374';

async function main() {
    console.log('🔧 Fixing Growmie permissions and marketplace...\n');

    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [BOT_ID]
    );

    const decryptedToken = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMembers
        ]
    });

    client.once('ready', async () => {
        console.log(`✅ Logged in as ${client.user.tag}\n`);

        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) {
            console.error('❌ Guild not found!');
            process.exit(1);
        }

        // Get key roles
        const everyoneRole = guild.roles.everyone;
        const verifiedRole = guild.roles.cache.find(r => r.name.includes('Verified Growmie'));
        const newSeedRole = guild.roles.cache.find(r => r.name.includes('New Seed'));

        console.log(`📋 Roles found:`);
        console.log(`   @everyone: ${everyoneRole.id}`);
        console.log(`   Verified Growmie: ${verifiedRole?.name || 'NOT FOUND'} (${verifiedRole?.id})`);
        console.log(`   New Seed: ${newSeedRole?.name || 'NOT FOUND'} (${newSeedRole?.id})`);

        // Get key channels
        const rulesChannel = guild.channels.cache.get(RULES_CHANNEL_ID);
        const introChannel = guild.channels.cache.get(INTRO_CHANNEL_ID);
        const marketplaceRulesChannel = guild.channels.cache.get(MARKETPLACE_RULES_CHANNEL_ID);

        console.log(`\n📁 Channels found:`);
        console.log(`   Rules: ${rulesChannel?.name || 'NOT FOUND'}`);
        console.log(`   Intro: ${introChannel?.name || 'NOT FOUND'}`);
        console.log(`   Marketplace Rules: ${marketplaceRulesChannel?.name || 'NOT FOUND'}`);

        // =========================================
        // STEP 1: Fix channel permissions
        // =========================================
        console.log('\n' + '═'.repeat(50));
        console.log('📝 STEP 1: Fixing channel permissions');
        console.log('═'.repeat(50));

        // Make rules channel visible to everyone
        if (rulesChannel) {
            await rulesChannel.permissionOverwrites.edit(everyoneRole, {
                ViewChannel: true,
                ReadMessageHistory: true,
                AddReactions: true,
                SendMessages: false
            });
            console.log('✅ Rules channel: Everyone can view + react, cannot send');
        }

        // Hide intro channel from @everyone, show to verified
        if (introChannel) {
            await introChannel.permissionOverwrites.edit(everyoneRole, {
                ViewChannel: false
            });
            if (verifiedRole) {
                await introChannel.permissionOverwrites.edit(verifiedRole, {
                    ViewChannel: true,
                    SendMessages: true,
                    ReadMessageHistory: true
                });
            }
            console.log('✅ Intro channel: Hidden from @everyone, visible to Verified');
        }

        // Hide ALL other channels from @everyone
        let hiddenCount = 0;
        for (const [id, channel] of guild.channels.cache) {
            if (id === RULES_CHANNEL_ID) continue; // Skip rules
            if (channel.type === ChannelType.GuildCategory) continue; // Handle categories separately

            try {
                // Get current @everyone override
                const currentOverwrite = channel.permissionOverwrites.cache.get(everyoneRole.id);
                const currentlyDenied = currentOverwrite?.deny.has(PermissionFlagsBits.ViewChannel);

                if (!currentlyDenied) {
                    await channel.permissionOverwrites.edit(everyoneRole, {
                        ViewChannel: false
                    });

                    // Grant access to verified role
                    if (verifiedRole) {
                        await channel.permissionOverwrites.edit(verifiedRole, {
                            ViewChannel: true
                        });
                    }
                    hiddenCount++;
                }
            } catch (e) {
                // Skip channels we can't edit
            }
        }
        console.log(`✅ Hidden ${hiddenCount} additional channels from @everyone`);

        // Also update category permissions
        for (const [id, channel] of guild.channels.cache) {
            if (channel.type !== ChannelType.GuildCategory) continue;
            if (channel.name.includes('STAFF')) continue; // Skip staff category

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
        console.log('✅ Updated category permissions');

        // =========================================
        // STEP 2: Create Trader role if it doesn't exist
        // =========================================
        console.log('\n' + '═'.repeat(50));
        console.log('📝 STEP 2: Setting up Trader role');
        console.log('═'.repeat(50));

        let traderRole = guild.roles.cache.find(r => r.name.includes('Trader') || r.name.includes('trader'));
        if (!traderRole) {
            traderRole = await guild.roles.create({
                name: '💰 Trusted Trader',
                color: 0xF1C40F, // Gold
                hoist: false,
                mentionable: true,
                reason: 'Marketplace trader role'
            });
            console.log(`✅ Created Trader role: ${traderRole.name}`);
        } else {
            console.log(`ℹ️  Trader role already exists: ${traderRole.name}`);
        }

        // Find marketplace channels
        const marketplaceChannels = guild.channels.cache.filter(c =>
            c.name.toLowerCase().includes('marketplace') ||
            c.name.toLowerCase().includes('trade') ||
            c.name.toLowerCase().includes('sell') ||
            c.name.toLowerCase().includes('buy')
        );

        console.log(`\n📦 Found ${marketplaceChannels.size} marketplace-related channels`);

        // =========================================
        // STEP 3: Set up marketplace rules message
        // =========================================
        console.log('\n' + '═'.repeat(50));
        console.log('📝 STEP 3: Setting up marketplace rules');
        console.log('═'.repeat(50));

        if (marketplaceRulesChannel) {
            // Clear existing messages in the channel
            try {
                const existingMessages = await marketplaceRulesChannel.messages.fetch({ limit: 10 });
                for (const msg of existingMessages.values()) {
                    if (msg.author.id === client.user.id) {
                        await msg.delete().catch(() => {});
                    }
                }
            } catch (e) {}

            // Create marketplace rules embed
            const marketplaceEmbed = new EmbedBuilder()
                .setColor(0xF1C40F)
                .setTitle('💰 Marketplace Rules & Guidelines')
                .setDescription(
                    `Welcome to the Growmie Marketplace! To protect our community, please follow these rules carefully.\n\n` +
                    `**React with 💰 below to agree to these rules and gain access to trading channels.**`
                )
                .addFields(
                    {
                        name: '📜 General Rules',
                        value:
                            `1️⃣ **No scamming** - Scammers will be permanently banned\n` +
                            `2️⃣ **Be honest** - Accurately describe all items\n` +
                            `3️⃣ **Price fairly** - No price gouging or lowballing\n` +
                            `4️⃣ **Use proper channels** - Post in the correct category\n` +
                            `5️⃣ **One bump per 24h** - No excessive reposting`,
                        inline: false
                    },
                    {
                        name: '🔒 Safety Guidelines',
                        value:
                            `• **Never share personal info** publicly\n` +
                            `• **Use secure payment methods** when trading\n` +
                            `• **Document everything** - Screenshots protect you\n` +
                            `• **Meet in public** if doing local trades\n` +
                            `• **Report suspicious behavior** to staff`,
                        inline: false
                    },
                    {
                        name: '📋 Listing Requirements',
                        value:
                            `• Clear photos of the item\n` +
                            `• Accurate description and condition\n` +
                            `• Price (or "OBO" / "Trade Only")\n` +
                            `• Shipping availability/preferences\n` +
                            `• Payment methods accepted`,
                        inline: false
                    },
                    {
                        name: '⚠️ Prohibited Items',
                        value:
                            `• Live plants or seeds (check local laws)\n` +
                            `• Illegal substances or paraphernalia\n` +
                            `• Counterfeit or stolen goods\n` +
                            `• Anything violating Discord ToS`,
                        inline: false
                    },
                    {
                        name: '✅ Agreement',
                        value:
                            `By reacting with 💰 below, you agree to:\n` +
                            `• Follow all marketplace rules\n` +
                            `• Trade honestly and fairly\n` +
                            `• Accept responsibility for your trades\n` +
                            `• Report rule violations to staff`,
                        inline: false
                    }
                )
                .setFooter({ text: 'React with 💰 to unlock trading channels!' })
                .setTimestamp();

            const marketplaceMessage = await marketplaceRulesChannel.send({ embeds: [marketplaceEmbed] });
            await marketplaceMessage.react('💰');
            console.log(`✅ Posted marketplace rules message: ${marketplaceMessage.id}`);

            // Set up reaction role for trader
            // First check if panel exists
            const [existingPanels] = await pool.execute(
                'SELECT * FROM reaction_role_panels WHERE channel_id = ?',
                [MARKETPLACE_RULES_CHANNEL_ID]
            );

            if (existingPanels.length > 0) {
                // Delete old panel
                await pool.execute('DELETE FROM reaction_role_mappings WHERE panel_id = ?', [existingPanels[0].id]);
                await pool.execute('DELETE FROM reaction_role_panels WHERE id = ?', [existingPanels[0].id]);
            }

            // Create new panel
            const [panelResult] = await pool.execute(`
                INSERT INTO reaction_role_panels
                (guild_id, channel_id, message_id, panel_name, panel_mode, interaction_type)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [GUILD_ID, MARKETPLACE_RULES_CHANNEL_ID, marketplaceMessage.id, 'Marketplace Access', 'normal', 'reaction']);

            const panelId = panelResult.insertId;

            // Add role mapping
            await pool.execute(`
                INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id)
                VALUES (?, ?, ?)
            `, [panelId, traderRole.id, '💰']);

            console.log(`✅ Created reaction role panel for Trader: panel_id=${panelId}`);

            // Set marketplace rules channel permissions
            await marketplaceRulesChannel.permissionOverwrites.edit(everyoneRole, {
                ViewChannel: false
            });
            if (verifiedRole) {
                await marketplaceRulesChannel.permissionOverwrites.edit(verifiedRole, {
                    ViewChannel: true,
                    ReadMessageHistory: true,
                    AddReactions: true,
                    SendMessages: false
                });
            }
            console.log('✅ Set marketplace rules permissions: Verified can view + react only');
        }

        // Set up other marketplace channels - require Trader role
        for (const [id, channel] of marketplaceChannels) {
            if (id === MARKETPLACE_RULES_CHANNEL_ID) continue;

            try {
                await channel.permissionOverwrites.edit(everyoneRole, {
                    ViewChannel: false
                });
                await channel.permissionOverwrites.edit(traderRole, {
                    ViewChannel: true,
                    SendMessages: true,
                    AttachFiles: true,
                    EmbedLinks: true,
                    ReadMessageHistory: true
                });
                // Verified but not trader - can view but not post
                if (verifiedRole) {
                    await channel.permissionOverwrites.edit(verifiedRole, {
                        ViewChannel: false // Only traders can see marketplace
                    });
                }
                console.log(`✅ ${channel.name}: Trader access only`);
            } catch (e) {
                console.log(`⚠️  Could not update ${channel.name}: ${e.message}`);
            }
        }

        // =========================================
        // Summary
        // =========================================
        console.log('\n' + '═'.repeat(50));
        console.log('🎉 SETUP COMPLETE');
        console.log('═'.repeat(50));
        console.log('\n📋 Current Flow:');
        console.log('   1. New member joins → Only sees #📜-rules');
        console.log('   2. Reacts ✅ in rules → Gets Verified Growmie role');
        console.log('   3. Now sees all community channels including intro');
        console.log('   4. Goes to marketplace-rules → Reacts 💰');
        console.log('   5. Gets Trusted Trader role → Access to trading channels');

        client.destroy();
        process.exit(0);
    });

    await client.login(decryptedToken);
}

main().catch(console.error);
