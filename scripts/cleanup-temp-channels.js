import { Client, GatewayIntentBits } from 'discord.js';
import db from '../utils/db.js';
import dotenv from 'dotenv';

dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log('Cleaning up orphaned temporary voice channels...\n');

  try {
    // Get all temp channels from database
    const [rows] = await db.execute('SELECT * FROM temp_voice_channels');

    console.log(`Found ${rows.length} temp channels in database`);

    let deletedCount = 0;
    let errorCount = 0;

    for (const row of rows) {
      try {
        console.log(`\nChecking channel ${row.channel_id}...`);

        // Try to fetch the channel
        const channel = await client.channels.fetch(row.channel_id).catch(() => null);

        if (!channel) {
          // Channel doesn't exist in Discord anymore, remove from DB
          console.log(`  Channel ${row.channel_id} not found in Discord, removing from database`);
          await db.execute('DELETE FROM temp_voice_channels WHERE channel_id = ?', [row.channel_id]);
          deletedCount++;
          continue;
        }

        // Check if channel is empty
        if (channel.members.size === 0) {
          console.log(`  Channel "${channel.name}" is empty, deleting...`);

          // Delete from database
          await db.execute('DELETE FROM temp_voice_channels WHERE channel_id = ?', [row.channel_id]);

          // Delete the channel
          await channel.delete('Cleanup: Temporary channel empty');

          console.log(`  ✓ Deleted empty temp channel "${channel.name}"`);
          deletedCount++;
        } else {
          console.log(`  Channel "${channel.name}" has ${channel.members.size} member(s), keeping`);
        }
      } catch (error) {
        console.error(`  ✗ Error processing channel ${row.channel_id}:`, error.message);
        errorCount++;
      }
    }

    console.log(`\n========================================`);
    console.log(`Cleanup complete!`);
    console.log(`  Deleted: ${deletedCount}`);
    console.log(`  Errors: ${errorCount}`);
    console.log(`========================================\n`);

    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
});

client.login(process.env.DISCORD_TOKEN);
