/**
 * Disable welcome messages and delete redundant message
 */

import { Client, GatewayIntentBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';
const ANNOUNCEMENTS_CHANNEL_ID = '1452977951430934729';
const MESSAGE_TO_DELETE = '1452986318698053704';

async function main() {
    console.log('🔧 Fixing welcome settings...\n');

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

        // Delete the redundant message
        const announcementsChannel = guild.channels.cache.get(ANNOUNCEMENTS_CHANNEL_ID);
        if (announcementsChannel) {
            try {
                const msg = await announcementsChannel.messages.fetch(MESSAGE_TO_DELETE);
                await msg.delete();
                console.log('🗑️  Deleted redundant welcome message');
            } catch (e) {
                console.log(`⚠️  Message already deleted or not found: ${e.message}`);
            }
        }

        // Disable welcome messages in database
        await pool.execute(`
            UPDATE welcome_settings
            SET channel_id = NULL, message = NULL
            WHERE guild_id = ?
        `, [GUILD_ID]);
        console.log('✅ Disabled welcome channel announcements');

        // Also try deleting the row entirely to be sure
        await pool.execute(`
            DELETE FROM welcome_settings WHERE guild_id = ?
        `, [GUILD_ID]);
        console.log('✅ Removed welcome settings from database');

        console.log('\n🎉 Done! New members will NOT receive welcome announcements.');
        console.log('   They will only see #📜-rules until they verify.');

        client.destroy();
        process.exit(0);
    });

    await client.login(decryptedToken);
}

main().catch(console.error);
