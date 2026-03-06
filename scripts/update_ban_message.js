import { Client, GatewayIntentBits, EmbedBuilder, AuditLogEvent } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const MESSAGE_ID = '1446116220674904064';
const CHANNEL_ID = '1290805808879108167';
const GUILD_ID = '985116833193553930';
const BOT_APP_ID = '1438889625388060723';

async function main() {
    // Get bot token
    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE client_id = ?',
        [BOT_APP_ID]
    );

    if (!bots.length) {
        console.error('Bot not found in database');
        process.exit(1);
    }

    // Parse and decrypt token
    const encryptedToken = JSON.parse(bots[0].bot_token);
    const token = encryption.decrypt(encryptedToken);
    console.log('Token decrypted successfully');

    // Create client
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildBans
        ]
    });

    client.once('ready', async () => {
        console.log(`Logged in as ${client.user.tag}`);

        try {
            const guild = await client.guilds.fetch(GUILD_ID);
            const channel = await guild.channels.fetch(CHANNEL_ID);
            const message = await channel.messages.fetch(MESSAGE_ID);

            console.log('Message found:', message.embeds[0]?.title);
            console.log('Current embed fields:');
            message.embeds[0]?.fields.forEach(f => console.log(`  ${f.name}: ${f.value}`));

            // Get the banned user ID from the embed
            const userField = message.embeds[0]?.fields.find(f => f.name === 'User');
            const userIdMatch = userField?.value.match(/\((\d+)\)/);
            const bannedUserId = userIdMatch ? userIdMatch[1] : null;

            console.log('\nBanned user ID:', bannedUserId);

            if (!bannedUserId) {
                console.error('Could not extract banned user ID from message');
                process.exit(1);
            }

            // Fetch recent ban audit logs to find the reason
            const auditLogs = await guild.fetchAuditLogs({
                type: AuditLogEvent.MemberBanAdd,
                limit: 50
            });

            const banEntry = auditLogs.entries.find(entry => entry.target?.id === bannedUserId);

            if (banEntry) {
                console.log('\nFound ban entry:');
                console.log('  Target:', banEntry.target?.tag);
                console.log('  Executor:', banEntry.executor?.tag);
                console.log('  Reason:', banEntry.reason || 'No reason in audit log');

                // Build updated embed
                const oldEmbed = message.embeds[0];
                const newEmbed = EmbedBuilder.from(oldEmbed)
                    .setFields(
                        { name: 'User', value: userField.value, inline: true },
                        { name: 'Moderator', value: oldEmbed.fields.find(f => f.name === 'Moderator')?.value || 'Unknown', inline: true },
                        { name: 'Reason', value: banEntry.reason || 'No reason provided', inline: false }
                    );

                await message.edit({ embeds: [newEmbed] });
                console.log('\n✅ Message updated successfully!');
                console.log('New reason:', banEntry.reason || 'No reason provided');
            } else {
                console.log('\n❌ Could not find ban entry in audit logs for user', bannedUserId);

                // List recent bans for debugging
                console.log('\nRecent bans in audit log:');
                auditLogs.entries.first(10).forEach(entry => {
                    console.log(`  - ${entry.target?.tag} (${entry.target?.id}): ${entry.reason || 'No reason'}`);
                });
            }

        } catch (error) {
            console.error('Error:', error);
        }

        client.destroy();
        process.exit(0);
    });

    await client.login(token);
}

main().catch(console.error);
