/**
 * Fix duplicate welcome channels and configure welcome on verification
 */

import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';

async function main() {
    console.log('🔧 Fixing welcome channel setup...\n');

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

        // Find all welcome channels
        const welcomeChannels = guild.channels.cache.filter(c =>
            c.name.includes('welcome-growmies') || c.name.includes('welcome-growmie')
        );

        console.log(`Found ${welcomeChannels.size} welcome channel(s):`);
        welcomeChannels.forEach(c => console.log(`   - #${c.name} (${c.id})`));

        if (welcomeChannels.size > 1) {
            // Keep the first one, delete duplicates
            const channelsArray = Array.from(welcomeChannels.values());
            const keepChannel = channelsArray[0];
            console.log(`\n✅ Keeping: #${keepChannel.name} (${keepChannel.id})`);

            for (let i = 1; i < channelsArray.length; i++) {
                const dupChannel = channelsArray[i];
                console.log(`🗑️  Deleting duplicate: #${dupChannel.name} (${dupChannel.id})`);
                await dupChannel.delete('Removing duplicate welcome channel').catch(e =>
                    console.log(`   ⚠️  Could not delete: ${e.message}`)
                );
            }

            // Update database with correct channel
            await pool.execute(`
                UPDATE welcome_settings
                SET channel_id = ?
                WHERE guild_id = ?
            `, [keepChannel.id, GUILD_ID]);
            console.log('✅ Updated database with correct channel ID');
        }

        // Get the final welcome channel
        const welcomeChannel = guild.channels.cache.find(c => c.name.includes('welcome-growmies'));
        if (welcomeChannel) {
            console.log(`\n📋 Welcome channel: #${welcomeChannel.name} (${welcomeChannel.id})`);

            // Store in database for the event handler
            await pool.execute(`
                INSERT INTO welcome_settings (guild_id, channel_id, message)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    channel_id = VALUES(channel_id),
                    message = VALUES(message)
            `, [
                GUILD_ID,
                welcomeChannel.id,
                '🌱 **Welcome to the garden, {user}!**\n\nYou\'re now a verified Growmie! Feel free to explore the channels, introduce yourself, and share your grows!\n\nHappy growing! 🌿'
            ]);

            console.log('✅ Welcome message configured');
        }

        console.log('\n🎉 Done!');
        client.destroy();
        process.exit(0);
    });

    await client.login(decryptedToken);
}

main().catch(console.error);
