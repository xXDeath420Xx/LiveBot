/**
 * Move help/contact channel to its own prominent category
 */

import { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';

async function main() {
    console.log('🔧 Moving help channel to its own category...\n');

    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [BOT_ID]
    );

    const decryptedToken = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [GatewayIntentBits.Guilds]
    });

    client.once('ready', async () => {
        console.log(`✅ Logged in as ${client.user.tag}\n`);

        const guild = client.guilds.cache.get(GUILD_ID);

        // Get verified role
        const verifiedRole = guild.roles.cache.find(r => r.name.includes('Verified Growmie'));

        // Create a new prominent category for help/support
        const helpCategory = await guild.channels.create({
            name: '🆘 NEED HELP?',
            type: ChannelType.GuildCategory,
            position: 1, // Near the top, right after rules
            permissionOverwrites: [
                {
                    id: guild.roles.everyone.id,
                    deny: [PermissionFlagsBits.ViewChannel]
                },
                ...(verifiedRole ? [{
                    id: verifiedRole.id,
                    allow: [PermissionFlagsBits.ViewChannel]
                }] : [])
            ],
            reason: 'Creating prominent help category'
        });
        console.log(`✅ Created category: ${helpCategory.name}`);

        // Find the existing help channel
        let helpChannel = guild.channels.cache.find(c =>
            c.name.includes('grow-help') ||
            c.name.includes('contact-staff') ||
            c.name.includes('support')
        );

        if (helpChannel) {
            // Move it to the new category
            await helpChannel.setParent(helpCategory.id, { lockPermissions: false });

            // Rename it to be more prominent
            await helpChannel.setName('📩-contact-staff');

            // Update permissions
            await helpChannel.permissionOverwrites.set([
                {
                    id: guild.roles.everyone.id,
                    deny: [PermissionFlagsBits.ViewChannel]
                },
                ...(verifiedRole ? [{
                    id: verifiedRole.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.ReadMessageHistory
                    ],
                    deny: [PermissionFlagsBits.SendMessages] // Can only use buttons
                }] : [])
            ]);

            console.log(`✅ Moved and renamed channel to: #${helpChannel.name}`);
        } else {
            // Create new channel in the category
            helpChannel = await guild.channels.create({
                name: '📩-contact-staff',
                type: ChannelType.GuildText,
                parent: helpCategory.id,
                topic: '🆘 Need help? Click the buttons below to privately contact staff!',
                permissionOverwrites: [
                    {
                        id: guild.roles.everyone.id,
                        deny: [PermissionFlagsBits.ViewChannel]
                    },
                    ...(verifiedRole ? [{
                        id: verifiedRole.id,
                        allow: [
                            PermissionFlagsBits.ViewChannel,
                            PermissionFlagsBits.ReadMessageHistory
                        ],
                        deny: [PermissionFlagsBits.SendMessages]
                    }] : [])
                ],
                reason: 'Staff contact channel'
            });
            console.log(`✅ Created channel: #${helpChannel.name}`);
        }

        // Update the database with new channel ID
        await pool.execute(`
            UPDATE staff_contact_config
            SET contact_channel_id = ?
            WHERE guild_id = ?
        `, [helpChannel.id, GUILD_ID]);

        // Move the category to position 1 (near top)
        await helpCategory.setPosition(1);
        console.log(`✅ Moved category to position 1 (near top)`);

        console.log('\n🎉 Done! The help category is now prominent near the top of the channel list.');

        client.destroy();
        process.exit(0);
    });

    await client.login(decryptedToken);
}

main().catch(console.error);
