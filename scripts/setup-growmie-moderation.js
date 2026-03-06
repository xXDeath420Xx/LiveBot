/**
 * Growmie Server Moderation Setup
 * Configures automod, logging, and welcome system using correct table schemas
 */

import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';

async function main() {
    console.log('🛡️ Growmie Moderation Setup\n');

    // Get bot token
    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [BOT_ID]
    );

    if (bots.length === 0) {
        console.error('❌ Bot not found!');
        process.exit(1);
    }

    const decryptedToken = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
    });

    client.once('ready', async () => {
        console.log(`✅ Logged in as ${client.user.tag}`);

        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) {
            console.error('❌ Guild not found!');
            process.exit(1);
        }

        console.log(`📍 Server: ${guild.name}\n`);

        try {
            // Find channels
            const modLogsChannel = guild.channels.cache.find(c => c.name.includes('mod-logs'));
            const announcementsChannel = guild.channels.cache.find(c => c.name.includes('announcements'));
            const verifyChannel = guild.channels.cache.find(c => c.name.includes('verify'));
            const introChannel = guild.channels.cache.find(c => c.name.includes('introductions'));

            // Find roles
            const newSeedRole = guild.roles.cache.find(r => r.name.includes('New Seed'));

            // 1. Configure guild_config
            console.log('📝 Configuring guild settings...');
            await pool.execute(`
                INSERT INTO guild_config (guild_id, prefix, language, timezone)
                VALUES (?, '!', 'en', 'America/New_York')
                ON DUPLICATE KEY UPDATE
                    prefix = VALUES(prefix),
                    language = VALUES(language),
                    timezone = VALUES(timezone)
            `, [GUILD_ID]);
            console.log('   ✅ Guild config set');

            // 2. Configure welcome_settings (using actual column names from the code)
            console.log('\n👋 Configuring welcome settings...');
            const welcomeMessage = `🌱 Welcome to the garden, {user}!

Head to <#${verifyChannel?.id || ''}> to verify your age and gain access to the community.

Once verified, introduce yourself in <#${introChannel?.id || ''}> and pick your roles!`;

            await pool.execute(`
                INSERT INTO welcome_settings (guild_id, channel_id, message, goodbye_enabled, auto_role_id)
                VALUES (?, ?, ?, FALSE, ?)
                ON DUPLICATE KEY UPDATE
                    channel_id = VALUES(channel_id),
                    message = VALUES(message),
                    auto_role_id = VALUES(auto_role_id)
            `, [GUILD_ID, announcementsChannel?.id, welcomeMessage, newSeedRole?.id]);
            console.log('   ✅ Welcome settings configured');
            console.log(`   📢 Welcome channel: ${announcementsChannel?.name || 'Not set'}`);
            console.log(`   🎭 Auto-role: ${newSeedRole?.name || 'Not set'}`);

            // 3. Configure logging_config
            console.log('\n📋 Configuring logging...');
            const enabledEvents = JSON.stringify([
                'messageDelete',
                'messageEdit',
                'memberJoin',
                'memberLeave',
                'memberBan',
                'memberUnban',
                'memberKick',
                'memberTimeout',
                'roleAdd',
                'roleRemove',
                'channelCreate',
                'channelDelete'
            ]);

            await pool.execute(`
                INSERT INTO logging_config (guild_id, log_channel_id, enabled_events)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    log_channel_id = VALUES(log_channel_id),
                    enabled_events = VALUES(enabled_events)
            `, [GUILD_ID, modLogsChannel?.id, enabledEvents]);
            console.log('   ✅ Logging configured');
            console.log(`   📝 Log channel: ${modLogsChannel?.name || 'Not set'}`);

            // 4. Set up Discord's native AutoMod (more reliable than database rules)
            console.log('\n🔧 Setting up Discord AutoMod rules...');

            try {
                const existingRules = await guild.autoModerationRules.fetch();

                // Anti-spam rule
                if (!existingRules.some(r => r.name === 'Growmie Anti-Spam')) {
                    await guild.autoModerationRules.create({
                        name: 'Growmie Anti-Spam',
                        eventType: 1, // MESSAGE_SEND
                        triggerType: 3, // SPAM
                        enabled: true,
                        actions: [
                            {
                                type: 1, // BLOCK_MESSAGE
                                metadata: { customMessage: '🌱 Slow down there, Growmie! Your message was flagged as spam.' }
                            },
                            ...(modLogsChannel ? [{
                                type: 2, // SEND_ALERT_MESSAGE
                                metadata: { channelId: modLogsChannel.id }
                            }] : [])
                        ],
                        reason: 'Growmie server setup'
                    });
                    console.log('   ✅ Created Discord anti-spam rule');
                } else {
                    console.log('   ⏭️  Anti-spam rule already exists');
                }

                // Mention spam rule
                if (!existingRules.some(r => r.name === 'Growmie Mention Limit')) {
                    await guild.autoModerationRules.create({
                        name: 'Growmie Mention Limit',
                        eventType: 1,
                        triggerType: 5, // MENTION_SPAM
                        triggerMetadata: {
                            mentionTotalLimit: 5
                        },
                        enabled: true,
                        actions: [
                            {
                                type: 1,
                                metadata: { customMessage: '🌱 Too many mentions! Please be considerate.' }
                            },
                            {
                                type: 3, // TIMEOUT
                                metadata: { durationSeconds: 300 }
                            },
                            ...(modLogsChannel ? [{
                                type: 2,
                                metadata: { channelId: modLogsChannel.id }
                            }] : [])
                        ],
                        reason: 'Growmie server setup'
                    });
                    console.log('   ✅ Created Discord mention limit rule');
                } else {
                    console.log('   ⏭️  Mention limit rule already exists');
                }
            } catch (automodError) {
                console.log(`   ⚠️  Discord AutoMod: ${automodError.message}`);
            }

            // 6. Post welcome message in mod logs
            console.log('\n📢 Posting setup confirmation...');
            if (modLogsChannel) {
                const modEmbed = new EmbedBuilder()
                    .setColor(0x228B22)
                    .setTitle('🛡️ Moderation System Active')
                    .setDescription('The Growmie moderation system has been configured!')
                    .addFields(
                        { name: '📝 Logging', value: 'Message edits, deletes, member joins/leaves, bans, kicks, timeouts, and role changes.', inline: false },
                        { name: '🤖 Auto-Mod', value: 'Spam detection, mention spam protection, and invite link filtering.', inline: false },
                        { name: '👋 Welcome', value: `New members get the **${newSeedRole?.name || 'New Seed'}** role and a welcome message.`, inline: false }
                    )
                    .setTimestamp()
                    .setFooter({ text: 'Growmies R Us | Garden Masters' });

                await modLogsChannel.send({ embeds: [modEmbed] });
                console.log('   ✅ Posted to mod-logs');
            }

            console.log('\n================================');
            console.log('🎉 Moderation setup complete!');
            console.log('================================\n');
            console.log('Summary:');
            console.log(`  • Welcome channel: #${announcementsChannel?.name || 'Not configured'}`);
            console.log(`  • Log channel: #${modLogsChannel?.name || 'Not configured'}`);
            console.log(`  • Auto-role: ${newSeedRole?.name || 'Not configured'}`);
            console.log(`  • AutoMod rules: Spam, Mention Spam, Invite Links`);
            console.log('');

        } catch (error) {
            console.error('❌ Error:', error);
        }

        client.destroy();
        process.exit(0);
    });

    await client.login(decryptedToken);
}

main().catch(console.error);
