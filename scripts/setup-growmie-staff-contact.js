/**
 * Set up staff contact / report system for Growmie server
 */

import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';

async function main() {
    console.log('🔧 Setting up staff contact system...\n');

    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [BOT_ID]
    );

    const decryptedToken = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
    });

    client.once('ready', async () => {
        console.log(`✅ Logged in as ${client.user.tag}\n`);

        const guild = client.guilds.cache.get(GUILD_ID);

        // Find or create a support/contact channel
        let contactChannel = guild.channels.cache.find(c =>
            c.name.includes('support') ||
            c.name.includes('contact') ||
            c.name.includes('help')
        );

        if (!contactChannel) {
            // Create a contact-staff channel
            contactChannel = await guild.channels.create({
                name: '📩-contact-staff',
                type: ChannelType.GuildText,
                topic: 'Click the buttons below to privately contact staff or report an issue',
                reason: 'Staff contact system setup'
            });
            console.log(`✅ Created channel: #${contactChannel.name}`);
        } else {
            console.log(`ℹ️  Using existing channel: #${contactChannel.name}`);
        }

        // Find or create staff reports channel (private)
        let reportsChannel = guild.channels.cache.find(c =>
            c.name.includes('reports') ||
            c.name.includes('staff-inbox')
        );

        if (!reportsChannel) {
            // Find staff category
            const staffCategory = guild.channels.cache.find(c =>
                c.type === ChannelType.GuildCategory &&
                (c.name.toUpperCase().includes('STAFF') || c.name.toUpperCase().includes('MOD'))
            );

            reportsChannel = await guild.channels.create({
                name: '📬-member-reports',
                type: ChannelType.GuildText,
                parent: staffCategory?.id,
                topic: 'Incoming reports and contact requests from members',
                permissionOverwrites: [
                    {
                        id: guild.roles.everyone.id,
                        deny: [PermissionFlagsBits.ViewChannel]
                    }
                ],
                reason: 'Staff reports channel'
            });
            console.log(`✅ Created staff channel: #${reportsChannel.name}`);
        } else {
            console.log(`ℹ️  Using existing reports channel: #${reportsChannel.name}`);
        }

        // Get verified role for permissions
        const verifiedRole = guild.roles.cache.find(r => r.name.includes('Verified Growmie'));

        // Set contact channel permissions - verified can see but not send regular messages
        await contactChannel.permissionOverwrites.edit(guild.roles.everyone, {
            ViewChannel: false
        });
        if (verifiedRole) {
            await contactChannel.permissionOverwrites.edit(verifiedRole, {
                ViewChannel: true,
                ReadMessageHistory: true,
                SendMessages: false // Can only use buttons
            });
        }

        // Delete old bot messages in contact channel
        const oldMessages = await contactChannel.messages.fetch({ limit: 20 });
        for (const msg of oldMessages.values()) {
            if (msg.author.id === client.user.id) {
                await msg.delete().catch(() => {});
            }
        }

        // Create the contact embed
        const contactEmbed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('📩 Contact Staff')
            .setDescription(
                `Need to reach out to the staff team? Use the buttons below!\n\n` +
                `All submissions are **private** and only visible to staff members.`
            )
            .addFields(
                {
                    name: '🚨 Report User',
                    value: 'Report suspicious activity, scammers, rule violations, or harassment.',
                    inline: true
                },
                {
                    name: '💬 General Contact',
                    value: 'Questions, suggestions, feedback, or anything else for the staff team.',
                    inline: true
                },
                {
                    name: '🛡️ Anonymous Option',
                    value: 'All reports can be submitted anonymously if you prefer.',
                    inline: false
                }
            )
            .setFooter({ text: 'Your privacy is respected. Staff will follow up if needed.' })
            .setTimestamp();

        // Create buttons
        const buttons = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('staff_report_user')
                    .setLabel('Report User')
                    .setEmoji('🚨')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('staff_report_scam')
                    .setLabel('Report Scam')
                    .setEmoji('⚠️')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('staff_contact')
                    .setLabel('Contact Staff')
                    .setEmoji('💬')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('staff_suggestion')
                    .setLabel('Suggestion')
                    .setEmoji('💡')
                    .setStyle(ButtonStyle.Secondary)
            );

        const contactMessage = await contactChannel.send({
            embeds: [contactEmbed],
            components: [buttons]
        });

        console.log(`✅ Posted contact message: ${contactMessage.id}`);

        // Save to database for the interaction handler
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS staff_contact_config (
                guild_id VARCHAR(20) PRIMARY KEY,
                contact_channel_id VARCHAR(20),
                reports_channel_id VARCHAR(20),
                contact_message_id VARCHAR(20),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.execute(`
            INSERT INTO staff_contact_config (guild_id, contact_channel_id, reports_channel_id, contact_message_id)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                contact_channel_id = VALUES(contact_channel_id),
                reports_channel_id = VALUES(reports_channel_id),
                contact_message_id = VALUES(contact_message_id)
        `, [GUILD_ID, contactChannel.id, reportsChannel.id, contactMessage.id]);

        console.log('✅ Saved configuration to database');

        console.log('\n' + '═'.repeat(50));
        console.log('🎉 STAFF CONTACT SYSTEM SETUP COMPLETE');
        console.log('═'.repeat(50));
        console.log(`\n📩 Contact channel: #${contactChannel.name}`);
        console.log(`📬 Reports channel: #${reportsChannel.name}`);
        console.log('\nMembers can now:');
        console.log('  • Report users for rule violations');
        console.log('  • Report scams or suspicious activity');
        console.log('  • Contact staff privately');
        console.log('  • Submit suggestions');

        client.destroy();
        process.exit(0);
    });

    await client.login(decryptedToken);
}

main().catch(console.error);
